/**
 * dsh-fff — fast, frecency-ranked file and content search for DeepSeek
 * Harness, powered by FFF (`@ff-labs/fff-node`).
 *
 * A single Cordis function plugin: owns one long-lived FFF index per indexed
 * workspace (created lazily on first use, kept warm by the native watcher,
 * destroyed on teardown) and registers the five read-only model-facing tools
 * (`ff_find`, `ff_grep`, `ff_multi_grep`, `ff_glob`, `ff_health`).
 *
 * Function plugin contract: named exports `name` / `inject` / `Config` /
 * `apply`, no default export (a default export makes the Loader discard the
 * plugin's `inject`).
 */

import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { FffConfig, resolveConfig, type FffConfig as FffConfigType } from './config.ts'
import { FffRegistry } from './registry.ts'
import { registerTools } from './tools.ts'

export const name = 'dsh-fff'

/** Required services: the scoped tool registry. */
export const inject = ['tools']

/** Runtime configuration schema (see {@link FffConfigType}). */
export const Config = FffConfig

/**
 * Mount the dsh-fff plugin on the current context.
 * @param ctx - plugin context with the `tools` service.
 * @param config - resolved row config, validated against {@link Config} by the Loader.
 */
export function apply(ctx: Context, config: FffConfigType = {}): void {
  const resolved = resolveConfig(config)
  const registry = new FffRegistry(resolved)

  // File-change notices: watch-inject feeds compact change summaries into the
  // next request of every live agent whose session workspace matches an
  // indexed root. Opt-in via `watchInject`; it is durable context, not a wake-up.
  registry.onChanges = (root, summary) => {
    for (const agent of ctx.agents.list()) {
      const sessionCwd = agent.session.header.cwd
      if (sessionCwd === undefined || cwdMatches(sessionCwd, root)) {
        try {
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: summary }],
            source: { kind: 'plugin', plugin: 'dsh-fff' },
          }))
        } catch {
          // Agent disposed between list() and inject(); the notice is best-effort.
        }
      }
    }
  }

  registerTools(ctx, registry, resolved)

  // Teardown: destroy every native index. Registrations made through
  // `ctx.tools.register` are effects and unwind automatically with this fiber.
  ctx.effect(() => {
    return () => {
      registry.dispose()
    }
  })
}

/** Compare a session cwd against the canonical indexed root. */
function cwdMatches(cwd: string, root: string): boolean {
  if (cwd === root) return true
  try {
    return realpathSync(cwd) === root
  } catch {
    return false
  }
}
