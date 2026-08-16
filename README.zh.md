# dsh-fff

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供快速、带 frecency 排序的文件与内容搜索,底层由 [FFF](https://github.com/dmtrKovalenko/fff)(`@ff-labs/fff-node`)驱动。

FFF 在进程内维护一个常驻的原生工作区索引(路径 + 内容)和后台文件监听器,因此第一次搜索之后,每次查询都在 10ms 以内——远比每次调用都 fork 一个 `ripgrep` 进程便宜。它自带容错模糊匹配、frecency 排序(你常打开的文件排名更高)、以及 git 状态标注。

## AI 生成声明

本插件代码由 **DeepSeek V4 Flash**(`deepseek-v4-flash`)通过 DeepSeek Harness agent 运行时生成,**未经人工审查**。自动化检查(单元测试、真实 harness 启动、真实模型回合)均已通过,但自动化不能替代人工审查。生产环境使用前请自行审阅源码;使用风险自负。

## 安装

通过 `dsh` CLI 安装到 profile(需要 Node 22.19+):

```sh
# 从 GitHub(推荐;固定到 v0.1.0 tag)
dsh plugin --profile web add github:zhang0098/dsh-fff#v0.1.0
```

git 安装拉取的是源码,因此插件会在安装时通过 `prepare` 脚本构建。pnpm ≥10 默认阻止该构建,直到你放行:第一次 `add` 会失败并打印一个精确的 key——把它复制到 profile 的 `pnpm-workspace.yaml` 再重新运行:

```yaml
allowBuilds:
  dsh-fff@https://codeload.github.com/zhang0098/dsh-fff/tar.gz/<sha>: true
```

请把该放行视为安装期的代码执行:只放行你信任源码的包,并优先使用固定的 tag(`#v0.1.0`)而不是裸分支。

本地目录 / tarball 安装无需放行:

```sh
dsh plugin --profile web add ./dsh-fff
dsh plugin --profile web add ./dsh-fff-0.1.0.tgz
```

然后启动该 profile。插件会在组合中插入一行(`id: fff`);用 `dsh --profile web --dump-config` 可以查看。(npm 发布已在计划中;`dsh-fff` 上架 registry 后 `dsh plugin add dsh-fff` 即可用。)

## 工具

| 工具 | 作用 |
|---|---|
| `ff_find` | 按文件名模糊、frecency 排序搜索文件/目录(容错;整路径匹配;词元按 AND 收敛) |
| `ff_grep` | 内容搜索:plain / regex / fuzzy,支持路径约束、上下文行、游标分页 |
| `ff_multi_grep` | 匹配任意多个字面量模式之一的内容搜索(SIMD Aho-Corasick) |
| `ff_glob` | 精确的 npm-glob 兼容路径匹配,无模糊排序 |
| `ff_health` | 索引诊断:文件数、扫描/预热状态、git 与 frecency 状态 |

每个工具都以调用会话的 `cwd`(或配置的 `basePath`)为工作区,只读、可并发安全。grep 结果携带 git 状态与可选的代码定义分类;UI 渲染复用 harness 的 `search` 卡片(`matches` / `paths` 两种形态)。

### 为什么不直接用 fff 的 MCP server?

当然可以:加一行 `@deepseek-ai/dsh-mcp-client` 配 `fff-mcp` 命令即可。本插件的区别在于让 FFF **在进程内运行**(没有独立的 MCP 进程、没有 JSON-RPC 往返、共享同一个索引),返回带类型的规范 JSON 结果、接入原生 harness UI 卡片,并额外提供下文的 watch-inject 集成。

## 配置

所有字段都有默认值;通过更后层的 patch 覆写(整行替换该行的 `config`):

```yaml
# 放在 profile 的 cordis.patch.yml,或用 --patch 传入
- id: fff
  config:
    basePath: /absolute/workspace   # 固定索引根;默认:按会话 cwd
    dataDir: ~/.dsh-fff             # frecency/history 数据库;默认 $DSH_HOME/fff 或 ~/.dsh-fff
    aiMode: true                    # FFF 面向 agent 的优化
    watch: true                     # 后台监听器保持索引热更新
    contentIndexing: true           # 内存内容索引(供 grep 使用)
    mmapCache: true                 # 扫描后预热内容缓存
    allowRootScan: false            # 除非显式开启,绝不索引 /
    allowHomeScan: false            # 除非显式开启,绝不索引 ~
    defaultPageSize: 20
    maxFileSizeMb: 10               # grep 跳过更大的文件
    maxMatchesPerFile: 200
    grepTimeBudgetMs: 0             # 0 = 不限时
    classifyDefinitions: false      # 在 grep 结果中标注代码定义行
    enableFind: true                # 逐工具开关
    enableGrep: true
    enableMultiGrep: true
    enableGlob: true
    enableHealth: true
    watchInject: false              # 向匹配的会话注入文件变更通知
    watchInjectDebounceMs: 2000
    watchInjectMaxPaths: 20
    indexReadyTimeoutMs: 15000
```

### watch-inject(可选)

设置 `watchInject: true` 后,FFF 监听器会把紧凑的文件变更摘要注入**下一个请求**——注入对象是所有会话工作区与某个索引根匹配的存活 agent(例如 `[dsh-fff] 3 file changes (2 modified, 1 created) in /path: src/a.ts (modified), src/b.ts (created)`)。这是持久的注入上下文,不是唤醒:agent 在其下一个回合开始时才会看到。带防抖和路径数量上限,控制 token 开销。

## 设计

单个 Cordis 函数插件(`name` / `inject: ['tools']` / `Config` / `apply`,无默认导出):

- `src/registry.ts` — `FffRegistry` 为每个索引根持有一个长生命周期 `FileFinder`:首次使用时懒创建、由原生监听器保持热更新、插件卸载时销毁(`ctx.effect`)。除非显式开启,拒绝索引根目录和 home。frecency 与查询历史数据库按根分文件存放在 `dataDir`。
- `src/tools.ts` — 五个 `defineTool` 注册;规范 JSON 值、纯函数 `render` / `presentCall` / `presentResult` 投影(harness `search` 卡片)、不透明 `nextCursor` 分页、取消时抛 `TOOL_ABORTED`。
- `src/config.ts` — Schemastery schema + `resolveConfig`(默认值保持一致)。

插件按会话工作区建立索引;共享同一根目录的会话共享索引。frecency 自动从 git touch 历史与搜索使用中预热。

## 已知限制与待办

- **`ff_find` 无法接受 path/glob 约束** — fff Node SDK 在模糊搜索路径上不解析 `src/` 式约束(只有 MCP server 的 `QueryParser` 支持);需要约束时请用 `ff_grep` 的 `path` 参数或 `ff_glob`。(`ff_multi_grep` 的原生 `constraints` 字段同样不被解析,故工具不暴露该参数。)
- **首次调用承担扫描成本** — 在大工作区创建索引时,第一次工具调用最多阻塞 `indexReadyTimeoutMs`;之后即热。
- **内存占用** — FFF 常驻索引 + 内容缓存(14k 文件仓库约 26 MB,Chromium 量级为数百 MB)。可关闭 `contentIndexing`/`mmapCache` 以内存换速度。
- **索引按进程存活** — 索引随 dsh 进程消失(frecency 数据库持久化在 `dataDir`);没有跨进程共享索引。
- **watch-inject 仅按规范化 cwd 匹配** — 会话 cwd 不是索引根(或尚未 realpath 归一化)的 agent 收不到通知。
- **原生依赖** — `@ff-labs/fff-node` 分发平台二进制;安装需要对应的 `@ff-labs/fff-bin-*` 平台包(或安装后从 GitHub releases 回退下载)。

## Model Experience

### 工具 schema

#### 模型看到什么

上述五个 `ff_*` schema(对应 `enable*` 开关开启时)。`ff_grep` 的描述教会约束语法(`"*.ts TODO"`、`"src/ TODO"`)与模式自动检测;`ff_find` 描述整路径 AND 模糊语义。

#### Token 影响

在包含这些定义的工具视图中,每个请求有固定的 schema 成本。

#### KV Cache 影响

工具集不变时前缀稳定;切换 `enable*` 开关会改变 schema 前缀,可能从第一个变化 token 起使复用失效。

### 工具调用历史与结果

#### 模型看到什么

规范 JSON 搜索结果(`items`/`matches`,含路径、行号、内容、git 状态、frecency)加渲染文本;`nextCursor`/`pageIndex` 续查值在会话内有效。启用 watch-inject 时,通知作为注入上下文出现在后续请求中。

#### Token 影响

随数据变化;每页受 `pageSize` 与 `maxMatchesPerFile` 约束。

#### KV Cache 影响

追加式;结果内容跟在可复用的请求前缀之后。

## 开发

```sh
npm install
npm run typecheck
npm run build
npm test               # 无 key 冒烟测试:在真实 FFF 索引上运行
npm pack               # 生成 dsh plugin add 用的 tarball
```

冒烟测试(`tests/smoke.test.mjs`)通过一个假的 Cordis context 驱动编译产物,在临时夹具工作区上运行——不需要模型 key 或 harness。

如需**真实 harness 检查**:安装发布的 `@deepseek-ai/dsh` CLI,建一个包含本插件的 profile,再运行 `npm run test:real`(见 `tests/real-harness.mjs`):它会用真实的 app-boot Loader 挂载实际 profile 组合,并在真实 `ctx.tools` 上调用 `ff_*` 工具——不需要 API key。
