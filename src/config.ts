import z from '@deepseek-ai/schemastery'

/**
 * Runtime configuration for the dsh-fff plugin. Every field is optional at
 * the interface level; the schema applies defaults, and {@link resolveConfig}
 * fills the same defaults for code paths that receive a partial object.
 * Deployment-varying values are set through the cordis.yml row config.
 */
export interface FffConfig {
  /**
   * Fixed directory to index. When omitted, each tool call indexes the
   * calling session's workspace (`session.header.cwd`), falling back to
   * `process.cwd()`.
   */
  basePath?: string
  /**
   * Directory for the FFF frecency and query-history databases. Defaults to
   * `$DSH_HOME/fff` when `DSH_HOME` is set, otherwise `~/.dsh-fff`.
   */
  dataDir?: string
  /** Optimize the native index for agent workloads (default true). */
  aiMode?: boolean
  /** Keep the background file-system watcher on (default true). */
  watch?: boolean
  /** Build the in-memory content index after the scan (default true). */
  contentIndexing?: boolean
  /** Warm the mmap content cache after the scan (default true). */
  mmapCache?: boolean
  /** Follow symlinked directories while indexing (default false). */
  followSymlinks?: boolean
  /** Permit indexing the filesystem root `/` (default false). */
  allowRootScan?: boolean
  /** Permit indexing the user's home directory (default false). */
  allowHomeScan?: boolean
  /** Default page size for search tools (default 20). */
  defaultPageSize?: number
  /** Maximum file size to grep, in megabytes (default 10). */
  maxFileSizeMb?: number
  /** Maximum matching lines collected from one file (default 200). */
  maxMatchesPerFile?: number
  /** Wall-clock budget for one grep call in ms; 0 = unlimited (default 0). */
  grepTimeBudgetMs?: number
  /** Classify matched lines as code definitions (`isDefinition`, default false). */
  classifyDefinitions?: boolean
  /** Expose the `ff_find` tool (default true). */
  enableFind?: boolean
  /** Expose the `ff_grep` tool (default true). */
  enableGrep?: boolean
  /** Expose the `ff_multi_grep` tool (default true). */
  enableMultiGrep?: boolean
  /** Expose the `ff_glob` tool (default true). */
  enableGlob?: boolean
  /** Expose the `ff_health` tool (default true). */
  enableHealth?: boolean
  /**
   * Inject compact file-change notices into agents whose session workspace
   * matches an indexed root (default false). Adds durable context for the
   * next request; it is not a wake-up.
   */
  watchInject?: boolean
  /** Debounce window for watch-inject notices in ms (default 2000). */
  watchInjectDebounceMs?: number
  /** Max paths named in one watch-inject notice (default 20). */
  watchInjectMaxPaths?: number
  /** Timeout for waiting on the initial index, in ms (default 15000). */
  indexReadyTimeoutMs?: number
}

/** Configuration with every defaulted field resolved; `basePath`/`dataDir` stay optional. */
export type ResolvedFffConfig = Omit<Required<FffConfig>, 'basePath' | 'dataDir'> & {
  basePath?: string
  dataDir?: string
}

/** Runtime configuration schema for the dsh-fff plugin. */
export const FffConfig: z<FffConfig> = z.object({
  basePath: z.string(),
  dataDir: z.string(),
  aiMode: z.boolean().default(true),
  watch: z.boolean().default(true),
  contentIndexing: z.boolean().default(true),
  mmapCache: z.boolean().default(true),
  followSymlinks: z.boolean().default(false),
  allowRootScan: z.boolean().default(false),
  allowHomeScan: z.boolean().default(false),
  defaultPageSize: z.number().default(20),
  maxFileSizeMb: z.number().default(10),
  maxMatchesPerFile: z.number().default(200),
  grepTimeBudgetMs: z.number().default(0),
  classifyDefinitions: z.boolean().default(false),
  enableFind: z.boolean().default(true),
  enableGrep: z.boolean().default(true),
  enableMultiGrep: z.boolean().default(true),
  enableGlob: z.boolean().default(true),
  enableHealth: z.boolean().default(true),
  watchInject: z.boolean().default(false),
  watchInjectDebounceMs: z.number().default(2000),
  watchInjectMaxPaths: z.number().default(20),
  indexReadyTimeoutMs: z.number().default(15000),
})

/**
 * Fill every defaulted field for a possibly partial config. The values MUST
 * stay in sync with the schema defaults above (the Loader applies those for
 * composed rows; this resolver covers direct construction and tests).
 */
export function resolveConfig(config: FffConfig): ResolvedFffConfig {
  return {
    basePath: config.basePath,
    dataDir: config.dataDir,
    aiMode: config.aiMode ?? true,
    watch: config.watch ?? true,
    contentIndexing: config.contentIndexing ?? true,
    mmapCache: config.mmapCache ?? true,
    followSymlinks: config.followSymlinks ?? false,
    allowRootScan: config.allowRootScan ?? false,
    allowHomeScan: config.allowHomeScan ?? false,
    defaultPageSize: config.defaultPageSize ?? 20,
    maxFileSizeMb: config.maxFileSizeMb ?? 10,
    maxMatchesPerFile: config.maxMatchesPerFile ?? 200,
    grepTimeBudgetMs: config.grepTimeBudgetMs ?? 0,
    classifyDefinitions: config.classifyDefinitions ?? false,
    enableFind: config.enableFind ?? true,
    enableGrep: config.enableGrep ?? true,
    enableMultiGrep: config.enableMultiGrep ?? true,
    enableGlob: config.enableGlob ?? true,
    enableHealth: config.enableHealth ?? true,
    watchInject: config.watchInject ?? false,
    watchInjectDebounceMs: config.watchInjectDebounceMs ?? 2000,
    watchInjectMaxPaths: config.watchInjectMaxPaths ?? 20,
    indexReadyTimeoutMs: config.indexReadyTimeoutMs ?? 15000,
  }
}
