/**
 * Real-harness test for dsh-fff: boots the ACTUAL profile composition
 * ("real" profile with @deepseek-ai/dsh-base + dsh-fff bundles) through the
 * published dsh app-boot Loader, then calls the ff_* tools on the REAL
 * ctx.tools registry inside that process. No model key needed — the tree
 * (LLM adapter, session, persistence, our plugin) mounts for real.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { boot, healProfilesModuleFallback, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const require = createRequire(import.meta.url)
const NAME = 'dsh'
// Point DSH_HOME at a dsh-home containing a "real" profile with dsh-fff
// installed, or create one with: dsh plugin --profile real add <this repo>
const DSH_HOME = process.env.DSH_HOME ?? join(process.cwd(), 'dsh-home')
const FIXTURE = process.env.DSH_FFF_FIXTURE ?? join(DSH_HOME, '..', 'fixture')
const ANCHOR = require.resolve('@deepseek-ai/dsh/package.json')

healProfilesModuleFallback(ANCHOR, DSH_HOME)
const profile = loadProfile(NAME, 'real', ANCHOR, DSH_HOME, { userLayer: true })

const rootConfig = join(profile.dir, 'cordis.yml')
if (!existsSync(rootConfig)) writeFileSync(rootConfig, '[]\n')

// Same patch stack the CLI composes: bundle layers, profile user layer, plus
// a telemetry opt-out (the CLI applies the same switch).
const allPatches = [
  ...profile.layers.flatMap((layer) => layer.patches),
  ...profile.patches,
  { id: 'session-telemetry-otel', disabled: true },
]

let ctx
try {
  ctx = await boot(NAME, rootConfig, structuredClone(allPatches), (host) => {
    host.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
    provideCmdline(host, { args: [], exit: (code) => { process.exitCode = code } })
  })
} catch (error) {
  console.error('BOOT FAILED:', error?.message)
  console.error(error?.stack)
  process.exit(1)
}

console.log('=== REAL HARNESS BOOTED ===')

const tools = ctx.tools
const expected = ['ff_find', 'ff_grep', 'ff_multi_grep', 'ff_glob', 'ff_health']
const missing = expected.filter((name) => tools.get(name) === undefined)
console.log(`tools registered: ${expected.filter((n) => tools.get(n) !== undefined).length}/${expected.length}${missing.length ? ` MISSING: ${missing.join(', ')}` : ''}`)
if (missing.length > 0) process.exit(1)

const exec = { signal: new AbortController().signal }
let failures = 0
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// ff_health
const health = await tools.get('ff_health').execute({}, exec)
check('ff_health indexes the fixture', health.basePath === FIXTURE && health.initialized, JSON.stringify(health).slice(0, 160))

// ff_find
const find = await tools.get('ff_find').execute({ query: 'main' }, exec)
check('ff_find finds src/main.ts', find.items.some((i) => i.path === 'src/main.ts'), find.items.map((i) => i.path).join(', '))
const find2 = await tools.get('ff_find').execute({ query: 'test demo' }, exec)
check('ff_find whole-path terms narrow', find2.items.some((i) => i.path === 'tests/demo.spec.ts'))

// ff_grep (path constraint exercised here, real harness)
const grep = await tools.get('ff_grep').execute({ pattern: 'hello', path: 'src' }, exec)
check('ff_grep "hello" in src/', grep.matches.some((m) => m.path === 'src/main.ts') && !grep.matches.some((m) => m.path.startsWith('tests/')), grep.matches.map((m) => `${m.path}:${m.lineNumber}`).join(', '))
const grepR = await tools.get('ff_grep').execute({ pattern: 'function \\w+', mode: 'regex' }, exec)
check('ff_grep regex mode', grepR.matches.some((m) => m.path === 'src/main.ts'))

// pagination
const page1 = await tools.get('ff_grep').execute({ pattern: 'e', pageSize: 2 }, exec)
const page2 = page1.nextCursor !== null
  ? await tools.get('ff_grep').execute({ pattern: 'e', pageSize: 2, cursor: page1.nextCursor }, exec)
  : { matches: [] }
check('ff_grep cursor pagination', page1.matches.length === 2 && page1.nextCursor !== null && page2.matches.length >= 1)

// ff_multi_grep
const multi = await tools.get('ff_multi_grep').execute({ patterns: ['HELPER', 'works'] }, exec)
const multiPaths = new Set(multi.matches.map((m) => m.path))
check('ff_multi_grep OR search', multiPaths.has('src/util/helper.ts') && multiPaths.has('tests/demo.spec.ts'), [...multiPaths].join(', '))

// ff_glob
const glob = await tools.get('ff_glob').execute({ pattern: '**/*.ts' }, exec)
check('ff_glob finds all ts files', ['src/main.ts', 'src/util/helper.ts', 'tests/demo.spec.ts'].every((p) => glob.paths.includes(p)), glob.paths.join(', '))

// render + presentation projections through the real definition
const findDef = tools.get('ff_find')
const blocks = findDef.output.render({ query: 'main' }, find)
check('render produces text', Array.isArray(blocks) && typeof blocks[0]?.text === 'string', blocks[0]?.text?.slice(0, 60))
const view = findDef.presentResult({ query: 'main' }, { content: blocks, isError: false, meta: findDef.output.presentationMeta({ query: 'main' }, find) })
check('presentResult returns search card', view?.card === 'search' && view?.shape === 'paths', JSON.stringify(view).slice(0, 80))

console.log(failures === 0 ? '=== ALL REAL-HARNESS CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`)
await ctx.fiber.dispose()
console.log('=== context disposed cleanly ===')
process.exit(failures === 0 ? 0 : 1)
