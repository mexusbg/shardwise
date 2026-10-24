import type { Doc } from './api'

/**
 * Diff & Sync contract. Two collections are streamed sorted by a key
 * field and merge-joined; differing documents get a field-level diff.
 */

export interface CompareSide {
  connId: string
  db: string
  coll: string
  /** Applied to this side only; {} = whole collection. */
  filter: Doc
}

export type FieldMode = 'all' | 'include' | 'exclude'

export interface CompareRequest {
  source: CompareSide
  target: CompareSide
  /** Unique key field used to pair documents (dot path), default `_id`. */
  key: string
  /** Compare all fields, only `paths`, or everything except `paths`. */
  fields: { mode: FieldMode; paths: string[] }
  /** Always ignored (e.g. `updatedAt`, `__v`). */
  ignore: string[]
  /** Compare only the first N source documents by key (and target documents in the same key range); 0 = all. */
  sample: number
}

export type CompareCategory = 'onlySource' | 'onlyTarget' | 'different' | 'identical'

/**
 * One differing path, read from source to target: `added` exists only in the target, `removed` only in the
 * source, `changed` in both with different values (canonical EJSON, so Int32(1) ≠ Double(1)).
 */
export interface FieldDiff {
  path: string
  kind: 'added' | 'removed' | 'changed'
  source?: unknown
  target?: unknown
}

export interface CompareEntry {
  key: unknown
  diffs?: FieldDiff[]
  /** Diffs beyond the per-document cap. */
  more?: number
}

export interface CompareCounts {
  sourceCount: number
  targetCount: number
  onlySource: number
  onlyTarget: number
  different: number
  identical: number
}

export interface CompareSummary extends CompareCounts {
  jobId: string
  state: 'running' | 'done' | 'error' | 'cancelled'
  request: CompareRequest
  startedAt: Date
  ms: number
  /** Total documents expected (both sides), when known. */
  total?: number
  /** Categories whose entry list hit the in-memory cap (counts stay exact). */
  truncated: CompareCategory[]
  /** Maximum entries kept per category. */
  cap: number
  /** Sample mode stopped before the end of the source. */
  sampled: boolean
  error?: string
  /** A sync ran after this comparison: the results may be outdated. */
  stale: boolean
}

export interface CompareResultPage {
  category: CompareCategory
  entries: CompareEntry[]
  /** Entries stored for this category (≤ cap). */
  stored: number
  offset: number
}

export type SyncDirection = 'sourceToTarget' | 'targetToSource'

export interface SyncRequest {
  compareJobId: string
  direction: SyncDirection
  insertMissing: boolean
  /** Delete documents that exist only on the receiving side. */
  deleteExtra: boolean
  /** Overwrite different documents: replace the whole document or `$set` / `$unset` only the differing paths. */
  overwrite: 'none' | 'replace' | 'set'
}

export interface SyncOperation {
  op: 'insert' | 'delete' | 'replace' | 'update'
  key: unknown
  /** For `update`: the `$set` / `$unset` document. */
  update?: Doc
}

/** Dry run: what a sync would do, computed from the stored comparison results. */
export interface SyncPlan {
  /** Namespace written to. */
  into: { connId: string; db: string; coll: string }
  from: { connId: string; db: string; coll: string }
  inserts: number
  deletes: number
  updates: number
  /** First operations, for display. */
  sample: SyncOperation[]
  /** The comparison kept only the first `cap` entries of some categories: those beyond are not synced. */
  truncated: boolean
  cap: number
}

/** Renderer-callable methods; implemented by `compareHandlers()` in src/main/compare/compare.ts. */
export interface CompareApi {
  compareStart(req: CompareRequest): string
  compareSummary(jobId: string): CompareSummary
  compareResult(jobId: string, category: CompareCategory, offset: number, limit: number): CompareResultPage
  /** Both documents of a key, read now (null when missing on that side). */
  compareDocs(jobId: string, key: unknown): { source: Doc | null; target: Doc | null }
  compareSyncPlan(req: SyncRequest): SyncPlan
  compareSyncStart(req: SyncRequest): string
  compareCancel(jobId: string): void
  compareDispose(jobId: string): void
}
