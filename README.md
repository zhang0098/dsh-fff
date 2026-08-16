# dsh-fff

English | [中文](README.zh.md)

Fast, frecency-ranked file and content search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), powered by [FFF](https://github.com/dmtrKovalenko/fff) (`@ff-labs/fff-node`).

FFF keeps a native in-process index of the workspace (paths + content) with a background watcher, so every search after the first is sub-10ms — dramatically cheaper than spawning `ripgrep` per call, with typo-resistant fuzzy matching, frecency ranking (files you open rank higher), and git-status annotations for free.

## AI-generated code notice

This plugin's code was written by **DeepSeek V4 Flash** (`deepseek-v4-flash`) through the DeepSeek Harness agent runtime. **It has not been reviewed by a human.** Automated checks (unit tests, a real-harness boot, and a live model round-trip) pass, but automation is not a substitute for human review. Review the source before using it in production; use at your own risk.

## Install

Install into a profile with the `dsh` CLI (needs Node 22.19+):

```sh
# from npm
dsh plugin --profile web add dsh-fff

# or from a local checkout / tarball
dsh plugin --profile web add ./dsh-fff
dsh plugin --profile web add ./dsh-fff-0.1.0.tgz

# or straight from git (author ships a prepare script; you must allowlist the build)
dsh plugin --profile web add github:you/dsh-fff
```

Then start the profile. The plugin inserts one row (`id: fff`) into the composition; `dsh --profile web --dump-config` shows it.

## Tools

| Tool | What it does |
|---|---|
| `ff_find` | Fuzzy, frecency-ranked file/directory search by name (typo-resistant; whole-path matching; AND fuzzy terms) |
| `ff_grep` | Content search: plain / regex / fuzzy, with path constraints, context lines, and cursor pagination |
| `ff_multi_grep` | Content search for lines matching ANY of several literal patterns (SIMD Aho-Corasick) |
| `ff_glob` | Exact npm-glob-compatible path matching, no fuzzy ranking |
| `ff_health` | Index diagnostics: file count, scan/warmup state, git + frecency status |

Every tool resolves its workspace from the calling session's `cwd` (or the configured `basePath`), is read-only, and is concurrency-safe. Grep results carry git status and optional definition classification; UI rendering uses the harness `search` cards (`matches` / `paths` shapes).

### Why not just the fff MCP server?

You can, trivially: add `@deepseek-ai/dsh-mcp-client` with the `fff-mcp` command. The plugin differs by running FFF **in-process** (no separate MCP process, no JSON-RPC round-trips, one shared index), giving typed canonical results with native harness UI cards, plus the optional watch-inject integration below.

## Config

All fields have defaults; override through a later patch layer (replace the row's whole `config`):

```yaml
# in your profile's cordis.patch.yml or via --patch
- id: fff
  config:
    basePath: /absolute/workspace   # fixed root to index; default: per-session cwd
    dataDir: ~/.dsh-fff             # frecency/history DBs; default $DSH_HOME/fff or ~/.dsh-fff
    aiMode: true                    # FFF agent optimizations
    watch: true                     # background watcher keeps the index warm
    contentIndexing: true           # in-memory content index for grep
    mmapCache: true                 # warm the content cache after scan
    allowRootScan: false            # never index / unless set
    allowHomeScan: false            # never index ~ unless set
    defaultPageSize: 20
    maxFileSizeMb: 10               # grep skips larger files
    maxMatchesPerFile: 200
    grepTimeBudgetMs: 0             # 0 = unlimited
    classifyDefinitions: false      # tag code-definition lines in grep results
    enableFind: true                # per-tool enable flags
    enableGrep: true
    enableMultiGrep: true
    enableGlob: true
    enableHealth: true
    watchInject: false              # inject file-change notices into matching sessions
    watchInjectDebounceMs: 2000
    watchInjectMaxPaths: 20
    indexReadyTimeoutMs: 15000
```

### watch-inject (opt-in)

With `watchInject: true`, the FFF watcher feeds compact file-change notices into the **next request** of every live agent whose session workspace matches an indexed root (e.g. `[dsh-fff] 3 file changes (2 modified, 1 created) in /path: src/a.ts (modified), src/b.ts (created)`). This is durable injected context, not a wake-up — the agent sees it when its next turn starts. Debounced and path-capped to keep token cost small.

## Design

A single Cordis function plugin (`name` / `inject: ['tools']` / `Config` / `apply`, no default export):

- `src/registry.ts` — `FffRegistry` owns one long-lived `FileFinder` per indexed root, created lazily on first use, kept warm by the native watcher, destroyed on plugin teardown (`ctx.effect`). Root/home scanning is refused unless opted in. Frecency and query-history DBs live per-root in `dataDir`.
- `src/tools.ts` — the five `defineTool` registrations; canonical JSON values, pure `render` / `presentCall` / `presentResult` projections (harness `search` cards), opaque `nextCursor` pagination, `TOOL_ABORTED` on cancellation.
- `src/config.ts` — Schemastery schema + `resolveConfig` (defaults kept in sync).

The plugin indexes by session workspace; sessions sharing a root share the index. Frecency warms automatically from git touch history and search usage.

## Known Limitations and Deferred Work

- **`ff_find` cannot take a path/glob constraint** — the fff Node SDK does not parse `src/`-style constraints on the fuzzy-search path (only the MCP server's `QueryParser` does); use `ff_grep`'s `path` constraint or `ff_glob` for constrained searches. (`ff_multi_grep`'s native `constraints` field is likewise unparsed, so the tool omits it.)
- **First call pays the scan** — creating the index on a large workspace blocks the first tool call up to `indexReadyTimeoutMs`; subsequent calls are warm.
- **Memory** — FFF keeps the index + content cache resident (~26 MB for a 14k-file repo, a few hundred MB for Chromium-scale). Disable `contentIndexing`/`mmapCache` to trade speed for memory.
- **The index is per-process** — indexes disappear with the dsh process (frecency DBs persist in `dataDir`); there is no cross-process shared index.
- **watch-inject matches by canonical cwd only** — agents whose session cwd is not the indexed root (or not yet realpath-normalized) do not receive notices.
- **Native dependency** — `@ff-labs/fff-node` ships platform binaries; install needs the `@ff-labs/fff-bin-*` platform package (or a postinstall fallback download from GitHub releases).

## Model Experience

### Tool schemas

#### What the model sees

The five `ff_*` schemas described above whenever the corresponding `enable*` flag is on. The `ff_grep` description teaches constraint syntax (`"*.ts TODO"`, `"src/ TODO"`) and mode auto-detection; `ff_find` teaches whole-path AND-fuzzy semantics.

#### Token effect

Fixed schema cost per request in tool views that include these definitions.

#### KV Cache effect

Prefix-stable while the tool set is unchanged; toggling an `enable*` flag changes the schema prefix and may invalidate reuse from the first changed token.

### Tool-call history and results

#### What the model sees

Search results as canonical JSON (`items`/`matches` with path, line, content, git status, frecency) plus the rendered text; `nextCursor`/`pageIndex` continuation values remain valid within a session. Watch-inject notices (when enabled) appear as injected context in later requests.

#### Token effect

Data-dependent; pages are bounded by `pageSize` and `maxMatchesPerFile`.

#### KV Cache effect

Append-only; result content follows the reusable request prefix.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test               # keyless smoke tests over a real FFF index
npm pack               # tarball for dsh plugin add
```

The smoke tests (`tests/smoke.test.mjs`) drive the compiled plugin through a fake Cordis context against a temporary fixture workspace — no model key or harness needed.

For a **real-harness check**, install the published `@deepseek-ai/dsh` CLI, create a profile with this plugin, and run `npm run test:real` (see `tests/real-harness.mjs`): it boots the actual profile composition through the real app-boot Loader and calls the `ff_*` tools on the real `ctx.tools` — no API key required.
