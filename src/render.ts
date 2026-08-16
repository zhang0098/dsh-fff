import type {
  GenericCallView,
  SearchFileMatches,
  SearchMatchesResultView,
  SearchPathsResultView,
} from '@deepseek-ai/dsh-tools'
import type { FffFindResult, FffGlobResult, FffGrepResult, FffMatch, FffPathItem } from './types.ts'

/**
 * Pending-state card for every dsh-fff search call: a generic card with the
 * `search` icon kind. The structured search card exists only after execution.
 * @param title - short, always-visible label.
 * @param rawInput - the salient input to show in the expanded view.
 */
export function presentSearchCall(title: string, rawInput: unknown): GenericCallView {
  return { card: 'generic', kind: 'search', title, rawInput }
}

/** Presentation payload for `ff_find` / `ff_glob`: a flat path list. */
export interface FffPathsMeta {
  paths: string[]
  truncated: boolean
  total: number
}

/** Derive the replayable paths payload from a canonical find/glob value. */
export function pathsMeta(value: FffFindResult | FffGlobResult): FffPathsMeta {
  const paths = 'paths' in value ? value.paths : value.items.map((item: FffPathItem) => item.path)
  return { paths, truncated: value.hasMore, total: value.totalMatched }
}

/** Presentation payload for `ff_grep` / `ff_multi_grep`: matches grouped by file. */
export interface FffMatchesMeta {
  files: SearchFileMatches[]
  truncated: boolean
  total: number
}

/** Derive the replayable grouped-matches payload from a canonical grep value. */
export function matchesMeta(value: FffGrepResult): FffMatchesMeta {
  const files: SearchFileMatches[] = []
  const byPath = new Map<string, SearchFileMatches>()
  for (const match of value.matches) {
    let group = byPath.get(match.path)
    if (group === undefined) {
      group = { path: match.path, matches: [] }
      byPath.set(match.path, group)
      files.push(group)
    }
    group.matches.push({ lineNumber: match.lineNumber, line: match.content })
  }
  return { files, truncated: value.truncated, total: value.totalMatched }
}

/** Completed `ff_find` / `ff_glob` card: a flat path list (search card). */
export function presentPathsResult(meta: FffPathsMeta): SearchPathsResultView {
  return { card: 'search', shape: 'paths', paths: meta.paths, truncated: meta.truncated, total: meta.total }
}

/** Completed `ff_grep` / `ff_multi_grep` card: matches grouped by file (search card). */
export function presentMatchesResult(meta: FffMatchesMeta): SearchMatchesResultView {
  return {
    card: 'search',
    shape: 'matches',
    files: meta.files,
    truncated: meta.truncated,
    total: meta.total,
  }
}

/** Render a canonical path item as one model-facing list line. */
export function renderPathLine(item: FffPathItem): string {
  const marker = item.type === 'directory' ? '/' : ''
  const git = item.gitStatus === 'clean' ? '' : ` [${item.gitStatus}]`
  return `${item.path}${marker}${git}`
}

/** Render a canonical grep match as one model-facing `path:line: content` line. */
export function renderMatchLine(match: FffMatch): string {
  const def = match.isDefinition === true ? ' (definition)' : ''
  return `${match.path}:${match.lineNumber}:${match.content}${def}`
}
