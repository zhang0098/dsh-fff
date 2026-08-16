import type { GrepCursor, GrepMode } from '@ff-labs/fff-node'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolRunContext, ToolResult } from '@deepseek-ai/dsh-tools'
import type { ResolvedFffConfig } from './config.ts'
import { resolveRoot, type FffRegistry } from './registry.ts'
import {
  matchesMeta,
  pathsMeta,
  presentMatchesResult,
  presentPathsResult,
  presentSearchCall,
  renderMatchLine,
  renderPathLine,
  type FffMatchesMeta,
  type FffPathsMeta,
} from './render.ts'
import type {
  FffFindResult,
  FffGlobResult,
  FffGrepResult,
  FffHealthResult,
  FffMatch,
  FffPathItem,
} from './types.ts'

/** Regex metacharacters; presence in a pattern selects regex mode (`auto`). */
const REGEX_META = /[.*+?^${}()|[\]\\]/

/**
 * Mark a value-schema spec as a required output property. Output schemas use
 * per-property `required: true` (not an array); the helper keeps the literal
 * from widening to `boolean`.
 */
function req<T extends object>(spec: T): T & { required: true } {
  return { ...spec, required: true }
}

/**
 * Normalize a `path` constraint to fff query-language form: glob patterns
 * pass through, bare directory names gain a trailing `/` (`src` → `src/`).
 */
function normalizeConstraint(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '') return trimmed
  if (/[*?[\]{}]/.test(trimmed)) return trimmed
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/** Resolve the effective grep query: an optional constraint prefix + pattern. */
function effectiveQuery(path: string | undefined, pattern: string): string {
  return path === undefined || path.trim() === '' ? pattern : `${normalizeConstraint(path)} ${pattern}`
}

/** Opaque stringified offset → native grep cursor. */
function parseCursor(cursor: string | undefined, signal?: AbortSignal): GrepCursor | null {
  if (cursor === undefined || cursor === '') return null
  if (signal?.aborted ?? false) throw abortError()
  const offset = Number.parseInt(cursor, 10)
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`invalid cursor "${cursor}": pass a nextCursor value from a previous ff_grep/ff_multi_grep call`)
  }
  return { __brand: 'GrepCursor' as const, _offset: offset } as unknown as GrepCursor
}

/** Serialize a native cursor to the opaque model-facing string. */
function serializeCursor(cursor: GrepCursor | null): string | null {
  return cursor === null ? null : String(cursor._offset)
}

/** Standard tool-call-aborted error the runtime recognizes. */
function abortError(): HarnessError {
  return new HarnessError('tool call aborted', TOOL_ABORTED)
}

/** Guard a synchronous native call against a cancelled tool call. */
function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted ?? false) throw abortError()
}

/** Get the live finder for the calling agent, throwing on failure or abort. */
async function finderFor(
  registry: FffRegistry,
  exec: ToolRunContext,
): Promise<import('@ff-labs/fff-node').FileFinder> {
  checkAborted(exec.signal)
  const entry = await registry.acquire(exec.agent, exec.signal)
  checkAborted(exec.signal)
  if (entry.finder === undefined) throw new Error(entry.error ?? 'fff index unavailable')
  return entry.finder
}

/** Map a native grep result to the canonical value. */
function toGrepResult(
  pattern: string,
  mode: GrepMode,
  result: ReturnType<import('@ff-labs/fff-node').FileFinder['grep']>,
): FffGrepResult {
  if (!result.ok) throw new Error(`fff grep failed: ${result.error}`)
  const matches: FffMatch[] = result.value.items.map((match) => ({
    path: match.relativePath,
    lineNumber: match.lineNumber,
    column: match.col,
    content: match.lineContent,
    gitStatus: match.gitStatus,
    ...match.isDefinition !== undefined ? { isDefinition: match.isDefinition } : {},
    ...match.contextBefore !== undefined && match.contextBefore.length > 0 ? { contextBefore: match.contextBefore } : {},
    ...match.contextAfter !== undefined && match.contextAfter.length > 0 ? { contextAfter: match.contextAfter } : {},
  }))
  return {
    pattern,
    mode,
    totalMatched: result.value.totalMatched,
    totalFilesSearched: result.value.totalFilesSearched,
    totalFiles: result.value.totalFiles,
    truncated: result.value.nextCursor !== null,
    nextCursor: serializeCursor(result.value.nextCursor),
    matches,
  }
}

/** Map a native mixed-search result to canonical path items. */
function toPathItems(
  result: ReturnType<import('@ff-labs/fff-node').FileFinder['mixedSearch']>,
): { items: FffPathItem[]; totalFiles: number; totalDirs: number } {
  if (!result.ok) throw new Error(`fff search failed: ${result.error}`)
  const items: FffPathItem[] = result.value.items.map((entry) => {
    if (entry.type === 'file') {
      const item = entry.item
      return {
        path: item.relativePath,
        type: 'file',
        gitStatus: item.gitStatus,
        frecencyScore: item.totalFrecencyScore,
        size: item.size,
        modified: item.modified,
      }
    }
    const item = entry.item
    return {
      path: item.relativePath,
      type: 'directory',
      gitStatus: 'clean',
      frecencyScore: item.maxAccessFrecency,
      size: 0,
      modified: 0,
    }
  })
  return { items, totalFiles: result.value.totalFiles, totalDirs: result.value.totalDirs }
}

/**
 * Output value schema (dsh ValueSchemaSpec DSL): objects declare
 * `additionalProperties` and mark each property `required: true` individually.
 */
const stringProp = { type: 'string' as const }
const numberProp = { type: 'number' as const }
const booleanProp = { type: 'boolean' as const }
const stringArrayProp = { type: 'array' as const, items: { type: 'string' as const } }

const pathItemSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    path: req({ type: 'string' as const }),
    type: req({ type: 'string' as const, enum: ['file' as const, 'directory' as const] }),
    gitStatus: req({ type: 'string' as const }),
    frecencyScore: req({ type: 'number' as const }),
    size: req({ type: 'number' as const }),
    modified: req({ type: 'number' as const }),
  },
}

const matchSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    path: req({ type: 'string' as const }),
    lineNumber: req({ type: 'number' as const }),
    column: req({ type: 'number' as const }),
    content: req({ type: 'string' as const }),
    gitStatus: req({ type: 'string' as const }),
    isDefinition: booleanProp,
    contextBefore: stringArrayProp,
    contextAfter: stringArrayProp,
  },
}

const grepResultSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    pattern: req({ type: 'string' as const }),
    mode: req({ type: 'string' as const }),
    totalMatched: req({ type: 'number' as const }),
    totalFilesSearched: req({ type: 'number' as const }),
    totalFiles: req({ type: 'number' as const }),
    truncated: req({ type: 'boolean' as const }),
    nextCursor: req({ oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const }),
    matches: req({ type: 'array' as const, items: matchSchema }),
  },
}

const findResultSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    query: req({ type: 'string' as const }),
    totalMatched: req({ type: 'number' as const }),
    totalFiles: req({ type: 'number' as const }),
    totalDirs: req({ type: 'number' as const }),
    items: req({ type: 'array' as const, items: pathItemSchema }),
    pageIndex: req({ type: 'number' as const }),
    pageSize: req({ type: 'number' as const }),
    hasMore: req({ type: 'boolean' as const }),
  },
}

const globResultSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    pattern: req({ type: 'string' as const }),
    totalMatched: req({ type: 'number' as const }),
    totalFiles: req({ type: 'number' as const }),
    paths: req({ type: 'array' as const, items: { type: 'string' as const } }),
    pageIndex: req({ type: 'number' as const }),
    pageSize: req({ type: 'number' as const }),
    hasMore: req({ type: 'boolean' as const }),
  },
}

const healthResultSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    version: req({ type: 'string' as const }),
    basePath: req({ type: 'string' as const }),
    initialized: req({ type: 'boolean' as const }),
    isScanning: req({ type: 'boolean' as const }),
    indexedFiles: numberProp,
    warmupComplete: req({ type: 'boolean' as const }),
    git: {
      type: 'object' as const,
      additionalProperties: true,
      properties: {
        available: req({ type: 'boolean' as const }),
        repositoryFound: req({ type: 'boolean' as const }),
        workdir: stringProp,
      },
    },
    frecency: {
      type: 'object' as const,
      additionalProperties: true,
      properties: {
        initialized: req({ type: 'boolean' as const }),
        dbPath: stringProp,
        diskSize: numberProp,
      },
    },
  },
}

/**
 * Register the five dsh-fff tools on `ctx.tools`. All searches are read-only
 * and concurrency-safe, so the runtime may run sibling calls in parallel.
 * @param ctx - plugin context.
 * @param registry - the shared FFF index registry.
 * @param config - resolved plugin config.
 */
export function registerTools(ctx: Context, registry: FffRegistry, config: ResolvedFffConfig): void {
  const tools = ctx.tools
  const pageSize = config.defaultPageSize
  const grepLimits = {
    maxFileSize: config.maxFileSizeMb * 1024 * 1024,
    maxMatchesPerFile: config.maxMatchesPerFile,
    timeBudgetMs: config.grepTimeBudgetMs,
  }
  // Per-tool enable flags gate registration; schemas join prompt assembly
  // only for registered tools.
  const defs: { enabled: boolean; definition: import('@deepseek-ai/dsh-tools').ToolDefinition }[] = []
  const add = (enabled: boolean, definition: import('@deepseek-ai/dsh-tools').ToolDefinition): void => {
    defs.push({ enabled, definition })
  }

  add(config.enableFind, defineTool({
    name: 'ff_find',
    description:
      'Fuzzy file and directory search by NAME (not content) over the session workspace, '
      + 'ranked by frecency (files you open rank higher) and annotated with git status. '
      + 'Typo-resistant: "typescropt.ts" finds typescript.ts. Matches the whole '
      + 'workspace-relative path, not just the filename; multiple query terms are AND '
      + 'fuzzy terms that each narrow the result ("src main" finds files under src '
      + 'matching main). Keep queries short (1-2 terms). Use ff_grep for content search '
      + 'with path constraints, ff_glob for exact glob matching.',
    parameters: {
      query: { type: 'string', required: true, description: 'File name query (fuzzy, typo-resistant). Terms are AND-ed; matches against the whole workspace-relative path.' },
      pageIndex: { type: 'number', description: '0-based page index (default 0).' },
      pageSize: { type: 'number', description: `Page size (default ${pageSize}).` },
    },
    output: {
      schema: findResultSchema,
      render: (args, value: FffFindResult) => {
        if (value.items.length === 0) {
          return [{ type: 'text', text: `0 matches for "${value.query}" (${value.totalFiles} files indexed)` }]
        }
        const lines = value.items.map(renderPathLine)
        const tail = value.hasMore
          ? `\n(${value.items.length}/${value.totalMatched} shown; pass pageIndex ${value.pageIndex + 1} for the next page)`
          : ''
        return [{ type: 'text', text: [`${value.totalMatched} match(es) for "${value.query}":`, ...lines].join('\n') + tail }]
      },
      presentationMeta: (_args, value: FffFindResult) => pathsMeta(value) as unknown as JsonValue,
    },
    async execute(args, exec) {
      const finder = await finderFor(registry, exec)
      const result = finder.mixedSearch(args.query, {
        pageIndex: args.pageIndex ?? 0,
        pageSize: args.pageSize ?? pageSize,
      })
      checkAborted(exec.signal)
      if (!result.ok) throw new Error(`fff search failed: ${result.error}`)
      const { items, totalFiles, totalDirs } = toPathItems(result)
      const pageIndex = args.pageIndex ?? 0
      const pageSizeUsed = args.pageSize ?? pageSize
      const value: FffFindResult = {
        query: args.query,
        totalMatched: result.value.totalMatched,
        totalFiles,
        totalDirs,
        items,
        pageIndex,
        pageSize: pageSizeUsed,
        hasMore: pageIndex * pageSizeUsed + items.length < result.value.totalMatched,
      }
      return value
    },
    presentCall: (args) => presentSearchCall(`ff_find ${args.query}`, args.query),
    presentResult: (_args, result: ToolResult) => {
      if (result.isError || result.meta === undefined) return undefined
      return presentPathsResult(result.meta as unknown as FffPathsMeta)
    },
    isConcurrencySafe: () => true,
  }))

  add(config.enableGrep, defineTool({
    name: 'ff_grep',
    description:
      'Fast content search (grep) over the session workspace: plain literal, regex, or '
      + 'fuzzy mode; auto mode picks regex when the pattern contains regex metacharacters '
      + 'and falls back to plain otherwise. Results carry git status and optional context '
      + 'lines; paginate with the opaque nextCursor. Constrain with "path" or inline '
      + 'constraints in the pattern ("*.ts TODO", "src/ TODO"). Multi-pattern OR search '
      + 'is ff_multi_grep; multi-variant names are faster there.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Text to find. Plain literal preferred; may carry constraint prefixes such as "*.ts " or "src/ ". Auto-detects regex.' },
      path: { type: 'string', description: 'Constrain to this path prefix or glob (e.g. "src", "*.ts").' },
      mode: { type: 'string', enum: ['auto', 'plain', 'regex', 'fuzzy'], description: 'Search mode (default auto: regex when the pattern has regex metacharacters, else plain).' },
      caseSensitive: { type: 'boolean', description: 'Force case-sensitive matching (default smart-case: insensitive when the pattern is all lowercase).' },
      beforeContext: { type: 'number', description: 'Context lines before each match (default 0).' },
      afterContext: { type: 'number', description: 'Context lines after each match (default 0).' },
      pageSize: { type: 'number', description: `Max matches on this page (default ${pageSize}).` },
      cursor: { type: 'string', description: 'Opaque nextCursor from a previous ff_grep call, to fetch the next page.' },
      classifyDefinitions: { type: 'boolean', description: 'Tag matched lines that look like code definitions (default false).' },
    },
    output: {
      schema: grepResultSchema,
      render: renderGrep,
      presentationMeta: (_args, value: FffGrepResult) => matchesMeta(value) as unknown as JsonValue,
    },
    async execute(args, exec) {
      const finder = await finderFor(registry, exec)
      const mode = resolveMode(args.mode, args.pattern)
      const result = finder.grep(effectiveQuery(args.path, args.pattern), {
        mode,
        smartCase: !(args.caseSensitive === true),
        ...grepLimits,
        pageSize: args.pageSize ?? pageSize,
        cursor: parseCursor(args.cursor, exec.signal),
        beforeContext: args.beforeContext ?? 0,
        afterContext: args.afterContext ?? 0,
        classifyDefinitions: args.classifyDefinitions ?? config.classifyDefinitions,
      })
      checkAborted(exec.signal)
      return toGrepResult(args.pattern, mode, result)
    },
    presentCall: (args) => presentSearchCall(`ff_grep ${args.pattern}`, args.pattern),
    presentResult: (_args, result: ToolResult) => {
      if (result.isError || result.meta === undefined) return undefined
      return presentMatchesResult(result.meta as unknown as FffMatchesMeta)
    },
    isConcurrencySafe: () => true,
  }))

  add(config.enableMultiGrep, defineTool({
    name: 'ff_multi_grep',
    description:
      'Content search for lines matching ANY of several literal patterns (OR logic) using '
      + 'SIMD Aho-Corasick — faster than regex alternation or repeated ff_grep calls for '
      + 'multi-variant identifiers (e.g. ["Profile", "profile", "user_profile"]). Patterns '
      + 'are literal text, never escaped. For a path-constrained content search use ff_grep '
+ 'with its path parameter instead.',
    parameters: {
      patterns: { type: 'array', items: { type: 'string' }, required: true, description: 'Literal patterns; a line matches when it contains ANY of them (at least 1).' },
      caseSensitive: { type: 'boolean', description: 'Force case-sensitive matching (default smart-case).' },
      beforeContext: { type: 'number', description: 'Context lines before each match (default 0).' },
      afterContext: { type: 'number', description: 'Context lines after each match (default 0).' },
      pageSize: { type: 'number', description: `Max matches on this page (default ${pageSize}).` },
      cursor: { type: 'string', description: 'Opaque nextCursor from a previous ff_multi_grep call.' },
      classifyDefinitions: { type: 'boolean', description: 'Tag matched lines that look like code definitions (default false).' },
    },
    output: {
      schema: grepResultSchema,
      render: renderGrep,
      presentationMeta: (_args, value: FffGrepResult) => matchesMeta(value) as unknown as JsonValue,
    },
    async execute(args, exec) {
      if (args.patterns.length === 0) {
        throw new Error('ff_multi_grep: patterns must contain at least 1 literal pattern')
      }
      const finder = await finderFor(registry, exec)
      const result = finder.multiGrep({
        patterns: args.patterns,
        smartCase: !(args.caseSensitive === true),
        ...grepLimits,
        pageSize: args.pageSize ?? pageSize,
        cursor: parseCursor(args.cursor, exec.signal),
        beforeContext: args.beforeContext ?? 0,
        afterContext: args.afterContext ?? 0,
        classifyDefinitions: args.classifyDefinitions ?? config.classifyDefinitions,
      })
      checkAborted(exec.signal)
      return toGrepResult(args.patterns.join(' | '), 'plain', result)
    },
    presentCall: (args) => presentSearchCall(`ff_multi_grep ${args.patterns.join(' | ')}`, args.patterns),
    presentResult: (_args, result: ToolResult) => {
      if (result.isError || result.meta === undefined) return undefined
      return presentMatchesResult(result.meta as unknown as FffMatchesMeta)
    },
    isConcurrencySafe: () => true,
  }))

  add(config.enableGlob, defineTool({
    name: 'ff_glob',
    description:
      'Glob-only path search over the session workspace: exact npm-glob-compatible pattern '
      + 'matching with no fuzzy ranking (e.g. "src/**/*.ts", "**/*.{ts,tsx}"). Use ff_find '
      + 'when you want fuzzy, frecency-ranked name search instead.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern matched against workspace-relative paths (npm glob semantics).' },
      pageIndex: { type: 'number', description: '0-based page index (default 0).' },
      pageSize: { type: 'number', description: `Page size (default ${pageSize}).` },
    },
    output: {
      schema: globResultSchema,
      render: (args, value: FffGlobResult) => {
        if (value.paths.length === 0) {
          return [{ type: 'text', text: `0 files match "${value.pattern}"` }]
        }
        const tail = value.hasMore
          ? `\n(${value.paths.length}/${value.totalMatched} shown; pass pageIndex ${value.pageIndex + 1} for the next page)`
          : ''
        return [{ type: 'text', text: value.paths.join('\n') + tail }]
      },
      presentationMeta: (_args, value: FffGlobResult) => pathsMeta(value) as unknown as JsonValue,
    },
    async execute(args, exec) {
      const finder = await finderFor(registry, exec)
      const result = finder.glob(args.pattern, {
        pageIndex: args.pageIndex ?? 0,
        pageSize: args.pageSize ?? pageSize,
      })
      checkAborted(exec.signal)
      if (!result.ok) throw new Error(`fff glob failed: ${result.error}`)
      const paths = result.value.items.map((item) => item.relativePath)
      const pageIndex = args.pageIndex ?? 0
      const pageSizeUsed = args.pageSize ?? pageSize
      const value: FffGlobResult = {
        pattern: args.pattern,
        totalMatched: result.value.totalMatched,
        totalFiles: result.value.totalFiles,
        paths,
        pageIndex,
        pageSize: pageSizeUsed,
        hasMore: pageIndex * pageSizeUsed + paths.length < result.value.totalMatched,
      }
      return value
    },
    presentCall: (args) => presentSearchCall(`ff_glob ${args.pattern}`, args.pattern),
    presentResult: (_args, result: ToolResult) => {
      if (result.isError || result.meta === undefined) return undefined
      return presentPathsResult(result.meta as unknown as FffPathsMeta)
    },
    isConcurrencySafe: () => true,
  }))

  add(config.enableHealth, defineTool({
    name: 'ff_health',
    description: 'Report the FFF index health for the session workspace: indexed file count, scan and warmup state, git integration, and frecency database status. Use it before searching a freshly opened workspace.',
    parameters: {},
    output: {
      schema: healthResultSchema,
      render: (_args, value: FffHealthResult) => {
        const lines = [
          `fff ${value.version} — ${value.basePath}`,
          `index: ${value.initialized ? 'initialized' : 'unavailable'}${value.isScanning ? ' (scanning)' : ''}`,
          `files: ${value.indexedFiles ?? 'unknown'}`,
          `warmup: ${value.warmupComplete ? 'complete' : 'in progress'}`,
          `git: ${value.git.available && value.git.repositoryFound ? value.git.workdir ?? 'repository' : value.git.available ? 'no repository' : 'unavailable'}`,
          `frecency: ${value.frecency.initialized ? value.frecency.dbPath ?? 'enabled' : 'disabled'}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const finder = await finderFor(registry, exec)
      const progress = finder.getScanProgress()
      const health = finder.healthCheck()
      checkAborted(exec.signal)
      if (!health.ok) throw new Error(`fff health check failed: ${health.error}`)
      const value: FffHealthResult = {
        version: health.value.version,
        basePath: health.value.filePicker.basePath ?? resolveRoot(exec.agent, config),
        initialized: health.value.filePicker.initialized,
        isScanning: progress.ok ? progress.value.isScanning : false,
        ...health.value.filePicker.indexedFiles !== undefined ? { indexedFiles: health.value.filePicker.indexedFiles } : {},
        warmupComplete: progress.ok ? progress.value.isWarmupComplete : false,
        git: {
          available: health.value.git.available,
          repositoryFound: health.value.git.repositoryFound,
          ...health.value.git.workdir !== undefined ? { workdir: health.value.git.workdir } : {},
        },
        frecency: {
          initialized: health.value.frecency.initialized,
          ...health.value.frecency.dbHealthcheck !== undefined ? {
            dbPath: health.value.frecency.dbHealthcheck.path,
            diskSize: health.value.frecency.dbHealthcheck.diskSize,
          } : {},
        },
      }
      return value
    },
    presentCall: () => presentSearchCall('ff_health', undefined),
    isConcurrencySafe: () => true,
  }))

  for (const { enabled, definition } of defs) {
    if (enabled) tools.register(definition)
  }
}

/** Resolve the tool's requested mode; `auto` picks regex when the pattern has metacharacters. */
function resolveMode(mode: 'auto' | 'plain' | 'regex' | 'fuzzy' | undefined, pattern: string): GrepMode {
  if (mode === undefined || mode === 'auto') {
    return REGEX_META.test(pattern) ? 'regex' : 'plain'
  }
  return mode
}

/** Shared model-facing renderer for ff_grep / ff_multi_grep results. */
function renderGrep(args: { pattern?: string; patterns?: string[] }, value: FffGrepResult): { type: 'text'; text: string }[] {
  const displayPattern = args.pattern ?? args.patterns?.join(' | ') ?? value.pattern
  if (value.matches.length === 0) {
    return [{ type: 'text', text: `0 matches for "${displayPattern}"` }]
  }
  const lines = value.matches.map(renderMatchLine)
  const tail = value.nextCursor !== null
    ? `\n(${value.matches.length}/${value.totalMatched} shown; pass cursor "${value.nextCursor}" for the next page)`
    : value.truncated ? '\n(results capped)' : ''
  return [{ type: 'text', text: [`${value.totalMatched} match(es):`, ...lines].join('\n') + tail }]
}
