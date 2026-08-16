/**
 * Canonical (model-facing) value types for the dsh-fff tools. These are the
 * JSON values `execute` returns and `output.schema` declares; `output.render`
 * converts them to model-facing text and the presentation projections drive
 * the UI search cards.
 */

/** One indexed file or directory surfaced by `ff_find` / `ff_glob`. */
export interface FffPathItem {
  /** Path relative to the indexed root. */
  path: string
  /** `file` or `directory`. */
  type: 'file' | 'directory'
  /** Git status annotation: clean / modified / untracked / staged_* / ignored. */
  gitStatus: string
  /** Combined frecency score (access + modification recency/frequency). */
  frecencyScore: number
  /** File size in bytes (0 for directories). */
  size: number
  /** Last-modified Unix timestamp in seconds. */
  modified: number
}

/** Canonical value of `ff_find`. */
export interface FffFindResult {
  /** The effective query sent to the engine (constraints included). */
  query: string
  /** Total matching files. */
  totalMatched: number
  /** Total indexed files. */
  totalFiles: number
  /** Total indexed directories. */
  totalDirs: number
  /** Page of matched items. */
  items: FffPathItem[]
  /** 0-based page index. */
  pageIndex: number
  /** Page size used. */
  pageSize: number
  /** Whether more pages exist. */
  hasMore: boolean
}

/** Canonical value of `ff_glob`: a flat page of matching paths. */
export interface FffGlobResult {
  /** The glob pattern used. */
  pattern: string
  /** Total matching files. */
  totalMatched: number
  /** Total indexed files. */
  totalFiles: number
  /** Page of relative paths. */
  paths: string[]
  /** 0-based page index. */
  pageIndex: number
  /** Page size used. */
  pageSize: number
  /** Whether more pages exist. */
  hasMore: boolean
}

/** One content match surfaced by `ff_grep` / `ff_multi_grep`. */
export interface FffMatch {
  /** Path relative to the indexed root. */
  path: string
  /** 1-based line number of the match. */
  lineNumber: number
  /** 0-based byte column of the first match start. */
  column: number
  /** The matched line text (possibly truncated). */
  content: string
  /** Git status of the containing file. */
  gitStatus: string
  /** Whether the line was classified as a code definition (when enabled). */
  isDefinition?: boolean
  /** Lines before the match (when context was requested). */
  contextBefore?: string[]
  /** Lines after the match (when context was requested). */
  contextAfter?: string[]
}

/** Canonical value of `ff_grep` and `ff_multi_grep`. */
export interface FffGrepResult {
  /** The pattern searched (the effective query for `ff_grep`). */
  pattern: string
  /** Engine mode used: plain | regex | fuzzy. */
  mode: string
  /** Total matches on this page. */
  totalMatched: number
  /** Files opened and searched in this call. */
  totalFilesSearched: number
  /** Total indexed files (before filtering). */
  totalFiles: number
  /** Whether the result was capped (`nextCursor` then holds the next page). */
  truncated: boolean
  /**
   * Opaque pagination token; pass it back as `cursor` to fetch the next
   * page, or `null` when no more eligible files remain.
   */
  nextCursor: string | null
  /** Matches on this page. */
  matches: FffMatch[]
}

/** Canonical value of `ff_health`. */
export interface FffHealthResult {
  /** Native library version. */
  version: string
  /** Indexed root. */
  basePath: string
  /** Whether the native picker for this root is initialized. */
  initialized: boolean
  /** Whether a scan is in progress. */
  isScanning: boolean
  /** Number of indexed files (when known). */
  indexedFiles?: number
  /** Whether the content-index warmup completed. */
  warmupComplete: boolean
  /** Git integration status. */
  git: {
    available: boolean
    repositoryFound: boolean
    workdir?: string
  }
  /** Frecency database status. */
  frecency: {
    initialized: boolean
    dbPath?: string
    diskSize?: number
  }
}
