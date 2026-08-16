import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { FileFinder } from '@ff-labs/fff-node'
import type { WatchEvent } from '@ff-labs/fff-node'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveConfig, type FffConfig, type ResolvedFffConfig } from './config.ts'

/** One live FileFinder plus its lifecycle bookkeeping, per indexed root. */
export interface FinderEntry {
  /** Canonical absolute indexed root. */
  readonly root: string
  /** The native finder; `undefined` when creation failed. */
  readonly finder?: FileFinder
  /** Creation failure, rethrown on every acquire. */
  readonly error?: string
  /** Settles once the initial scan (and optional warmup) finished or timed out. */
  readonly ready: Promise<void>
}

/**
 * Resolve the default data directory: `$DSH_HOME/fff` when the Harness home
 * is set, otherwise `~/.dsh-fff`.
 */
export function defaultDataDir(): string {
  const dshHome = process.env.DSH_HOME
  return dshHome !== undefined && dshHome !== ''
    ? join(dshHome, 'fff')
    : join(homedir(), '.dsh-fff')
}

/**
 * Resolve the indexed root for a tool call: the calling session's workspace
 * first, then the configured `basePath`, then `process.cwd()`.
 * @param agent - the calling agent (from `exec.agent`), when available.
 * @param config - plugin config.
 * @returns a canonical absolute directory.
 */
export function resolveRoot(agent: Agent | undefined, config: FffConfig): string {
  const sessionCwd = agent?.session.header.cwd
  const chosen = sessionCwd ?? config.basePath ?? process.cwd()
  const absolute = resolve(chosen)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/**
 * Registry of long-lived FFF indexes, one per indexed root, owned by the
 * dsh-fff plugin fiber. Indexes are created lazily on first use, kept warm
 * for the plugin lifetime (native watcher keeps them current), and destroyed
 * on plugin teardown.
 */
export class FffRegistry {
  private readonly entries = new Map<string, FinderEntry>()
  private readonly pending = new Map<string, Promise<FinderEntry>>()
  private readonly config: ResolvedFffConfig
  private disposed = false
  /** Assigned by the plugin entry; called with debounced change summaries. */
  onChanges: ((root: string, summary: string) => void) | undefined

  constructor(config: FffConfig) {
    this.config = resolveConfig(config)
  }

  /**
   * Get the finder for the calling agent's workspace, creating the native
   * index on first use and waiting (up to `indexReadyTimeoutMs`) for the
   * initial scan.
   * @param agent - the calling agent, when available.
   * @param signal - optional tool-call cancellation signal.
   * @returns the ready finder entry; creation errors are thrown.
   */
  async acquire(agent: Agent | undefined, _signal?: AbortSignal): Promise<FinderEntry> {
    if (this.disposed) throw new Error('dsh-fff: registry disposed')
    const root = resolveRoot(agent, this.config)
    let entry = this.entries.get(root)
    if (entry === undefined) {
      entry = await this.create(root)
    }
    // The initial scan is bounded by `indexReadyTimeoutMs`; tool cancellation
    // is enforced by the caller's checkAborted before and after this await.
    await entry.ready
    if (entry.error !== undefined) throw new Error(entry.error)
    return entry
  }

  /** Destroy every native index. Idempotent; safe on plugin teardown. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.finder?.destroy()
    }
    this.entries.clear()
    this.pending.clear()
  }

  private async create(root: string): Promise<FinderEntry> {
    const existing = this.entries.get(root)
    if (existing !== undefined) return existing
    const inFlight = this.pending.get(root)
    if (inFlight !== undefined) return inFlight

    const promise = this.build(root).then((entry) => {
      this.entries.set(root, entry)
      this.pending.delete(root)
      return entry
    })
    this.pending.set(root, promise)
    return promise
  }

  private async build(root: string): Promise<FinderEntry> {
    this.assertScanAllowed(root)
    const dataDir = this.config.dataDir ?? defaultDataDir()
    if (!existsSync(dataDir)) {
      try {
        mkdirSync(dataDir, { recursive: true })
      } catch (error) {
        return { root, error: `failed to create dataDir ${dataDir}: ${String(error)}`, ready: Promise.resolve() }
      }
    }
    const hash = createHash('sha1').update(root).digest('hex').slice(0, 12)
    const created = FileFinder.create({
      basePath: root,
      frecencyDbPath: join(dataDir, `frecency-${hash}.mdb`),
      historyDbPath: join(dataDir, `history-${hash}.mdb`),
      aiMode: this.config.aiMode,
      disableWatch: !this.config.watch,
      disableContentIndexing: !this.config.contentIndexing,
      disableMmapCache: !this.config.mmapCache,
      followSymlinks: this.config.followSymlinks,
      enableFsRootScanning: this.config.allowRootScan,
      enableHomeDirScanning: this.config.allowHomeScan,
    })
    if (!created.ok) {
      return { root, error: `fff failed to index ${root}: ${created.error}`, ready: Promise.resolve() }
    }
    const finder = created.value
    const ready = finder.waitForIndexReady(this.config.indexReadyTimeoutMs).then(
      () => undefined,
      () => undefined,
    )
    if (this.config.watchInject && this.config.watch) {
      this.subscribeWatch(root, finder)
    }
    return { root, finder, ready }
  }

  /**
   * Refuse indexing the filesystem root or the user's home unless the
   * corresponding opt-in flag is set. FFF indexes and watches the whole tree;
   * an accidental scan of `/` or `~` consumes unbounded memory.
   */
  private assertScanAllowed(root: string): void {
    if (!this.config.allowRootScan && root === resolve('/')) {
      throw new Error('dsh-fff: refusing to index filesystem root "/" (set allowRootScan to override)')
    }
    if (!this.config.allowHomeScan) {
      const home = resolve(homedir())
      if (root === home) {
        throw new Error('dsh-fff: refusing to index home directory (set allowHomeScan to override)')
      }
    }
  }

  /** Subscribe to whole-tree change events and debounce them into notices. */
  private subscribeWatch(root: string, finder: FileFinder): void {
    let pendingEvents: WatchEvent[] = []
    let timer: NodeJS.Timeout | undefined
    const flush = (): void => {
      timer = undefined
      if (this.disposed) return
      const events = pendingEvents
      pendingEvents = []
      if (events.length === 0 || this.onChanges === undefined) return
      const maxPaths = Math.max(1, this.config.watchInjectMaxPaths)
      const counts = new Map<string, number>()
      for (const event of events) {
        const label = event.kind === 'rescan' ? 'rescan' : `${event.kind}`
        counts.set(label, (counts.get(label) ?? 0) + 1)
      }
      const parts: string[] = []
      const seen = new Set<string>()
      for (const event of events) {
        if (seen.size >= maxPaths) break
        const rel = relativeDisplay(root, event.path)
        if (seen.has(rel)) continue
        seen.add(rel)
        parts.push(`${rel} (${event.kind})`)
      }
      const more = events.length - seen.size
      const tail = more > 0 ? `, +${more} more` : ''
      const total = events.length
      const kinds = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ')
      this.onChanges(root, `[dsh-fff] ${total} file change${total === 1 ? '' : 's'} (${kinds}) in ${root}: ${parts.join(', ')}${tail}`)
    }
    // Whole-tree subscription; finder.destroy() tears every watcher down on
    // plugin teardown, so the unsubscribe handle needs no explicit storage.
    finder.watch((events) => {
      pendingEvents = pendingEvents.concat(events)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(flush, this.config.watchInjectDebounceMs)
    })
  }
}

/** Shorten an absolute watched path to its root-relative display form. */
function relativeDisplay(root: string, path: string): string {
  const rel = path.startsWith(root) ? path.slice(root.length) : path
  return rel.replace(/^[/\\]+/, '') || path
}
