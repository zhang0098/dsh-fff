/**
 * Keyless smoke test for dsh-fff: drives the compiled plugin through a fake
 * Cordis context, runs every tool's `execute` against a real FFF index over a
 * temporary fixture workspace, and verifies the render / presentation
 * projections. Needs no DeepSeek key and no running harness.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'

const plugin = await import('../dist/index.js')
assert.deepEqual(Object.keys(plugin).sort(), ['Config', 'apply', 'inject', 'name'])
assert.equal(plugin.name, 'dsh-fff')
assert.deepEqual(plugin.inject, ['tools'])

// ── fixture workspace ───────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'dsh-fff-smoke-'))
const dataDir = join(root, '.fff-data')
mkdirSync(dataDir)
mkdirSync(join(root, 'src', 'util'), { recursive: true })
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(join(root, 'src', 'main.ts'), 'export function main() {\n  return \'hello fff\'\n}\n')
writeFileSync(join(root, 'src', 'util', 'helper.ts'), 'export const HELPER = \'HELPER_VALUE\'\n')
writeFileSync(join(root, 'test', 'demo.spec.ts'), 'it(\'works\', () => {\n  expect(true).toBe(true)\n})\n')
writeFileSync(join(root, 'README.md'), '# demo project\nhello world\n')

after(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── fake Cordis context (only what apply() touches) ────────────────────────

const registered = new Map()
let disposer = undefined
const ctx = {
  tools: { register: (def) => { registered.set(def.name, def) } },
  agents: { list: () => [] },
  effect: (body) => { disposer = body() },
}

plugin.apply(ctx, { basePath: root, dataDir, watch: false, contentIndexing: false, indexReadyTimeoutMs: 20000 })

const exec = { signal: new AbortController().signal }

// ── helpers ─────────────────────────────────────────────────────────────────

async function runTool(name, args) {
  const def = registered.get(name)
  assert.ok(def, `tool ${name} registered`)
  const value = await def.execute(args, exec)
  const blocks = def.output.render(args, value)
  const meta = def.output.presentationMeta?.(args, value)
  const view = def.presentResult?.(args, { content: blocks, isError: false, meta })
  return { def, value, blocks, meta, view }
}

const text = (blocks) => blocks.map((b) => b.text).join('\n')

test('plugin registers all five tools', () => {
  for (const name of ['ff_find', 'ff_grep', 'ff_multi_grep', 'ff_glob', 'ff_health']) {
    assert.ok(registered.has(name), `${name} registered`)
  }
})

test('ff_find: fuzzy name search finds the file and renders a paths card', async () => {
  const { value, blocks, view } = await runTool('ff_find', { query: 'main' })
  assert.ok(value.items.some((i) => i.path === 'src/main.ts'), 'finds src/main.ts')
  assert.equal(value.totalFiles >= 4, true, 'indexed all fixture files')
  assert.ok(text(blocks).includes('src/main.ts'))
  assert.equal(view.card, 'search')
  assert.equal(view.shape, 'paths')
  assert.ok(view.paths.includes('src/main.ts'))
})

test('ff_find: whole-path fuzzy matching narrows by terms', async () => {
  const { value } = await runTool('ff_find', { query: 'test demo' })
  assert.ok(value.items.some((i) => i.path === 'test/demo.spec.ts'), 'terms narrow to test/demo.spec.ts')
  assert.ok(!value.items.some((i) => i.path === 'src/main.ts'), 'src/main.ts excluded')
})

test('ff_grep: plain mode finds content across files', async () => {
  const { value, blocks, view } = await runTool('ff_grep', { pattern: 'hello' })
  const paths = new Set(value.matches.map((m) => m.path))
  assert.ok(paths.has('README.md'), 'README.md matches')
  assert.ok(paths.has('src/main.ts'), 'src/main.ts matches')
  assert.equal(view.card, 'search')
  assert.equal(view.shape, 'matches')
  const group = view.files.find((f) => f.path === 'README.md')
  assert.ok(group?.matches.some((m) => m.lineNumber === 2), 'README.md line 2 matched')
  assert.ok(text(blocks).includes('README.md:2'))
})

test('ff_grep: regex mode and path constraint', async () => {
  const { value } = await runTool('ff_grep', { pattern: 'function \\w+', mode: 'regex', path: 'src' })
  assert.ok(value.matches.some((m) => m.path === 'src/main.ts'), 'regex matches main.ts')
  assert.ok(!value.matches.some((m) => m.path.startsWith('test/')), 'path constraint applied')
})

test('ff_grep: cursor pagination round-trips', async () => {
  const first = await runTool('ff_grep', { pattern: 'e', pageSize: 2 })
  assert.equal(first.value.matches.length, 2)
  assert.ok(first.value.nextCursor !== null, 'has nextCursor')
  const second = await runTool('ff_grep', { pattern: 'e', pageSize: 2, cursor: first.value.nextCursor })
  assert.equal(second.value.matches.length >= 1, true, 'next page has matches')
  assert.notDeepEqual(
    second.value.matches.map((m) => m.path + m.lineNumber),
    first.value.matches.map((m) => m.path + m.lineNumber),
    'pages do not overlap',
  )
})

test('ff_multi_grep: OR search over literal patterns', async () => {
  const { value } = await runTool('ff_multi_grep', { patterns: ['HELPER', 'works'] })
  const paths = new Set(value.matches.map((m) => m.path))
  assert.ok(paths.has('src/util/helper.ts'), 'HELPER matched')
  assert.ok(paths.has('test/demo.spec.ts'), 'works matched')
})

test('ff_multi_grep: rejects empty patterns', async () => {
  await assert.rejects(() => runTool('ff_multi_grep', { patterns: [] }), /at least 1/)
})

test('ff_glob: npm-glob-compatible matching', async () => {
  const { value } = await runTool('ff_glob', { pattern: '**/*.ts' })
  const paths = new Set(value.paths)
  assert.ok(paths.has('src/main.ts'))
  assert.ok(paths.has('src/util/helper.ts'))
  assert.ok(paths.has('test/demo.spec.ts'))
})

test('ff_health: reports the indexed workspace', async () => {
  const { value, blocks } = await runTool('ff_health', {})
  assert.equal(value.basePath, root)
  assert.equal(value.initialized, true)
  assert.equal(typeof value.version, 'string')
  assert.ok(text(blocks).includes('fff'))
})

test('enable* flags gate tool registration', () => {
  const gated = new Map()
  plugin.apply(
    { tools: { register: (def) => gated.set(def.name, def) }, agents: { list: () => [] }, effect: () => {} },
    { basePath: root, dataDir, enableFind: false, enableGrep: true, enableHealth: false, watch: false },
  )
  assert.ok(!gated.has('ff_find'), 'ff_find disabled')
  assert.ok(gated.has('ff_grep'), 'ff_grep enabled')
  assert.ok(!gated.has('ff_health'), 'ff_health disabled')
})

test('teardown disposer destroys native indexes', () => {
  assert.equal(typeof disposer, 'function')
  disposer()
})
