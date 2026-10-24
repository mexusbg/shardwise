import type { Doc } from './api'

/**
 * Copy / paste of collections and databases, possibly across connections. Documents are streamed in batches;
 * indexes, collection options and views are recreated on the target.
 */

/** What to do when a target collection already exists. */
export type CopyConflict = 'abort' | 'drop' | 'merge' | 'replace'

export const COPY_CONFLICT_LABELS: Record<CopyConflict, string> = {
  abort: 'Abort',
  drop: 'Drop target first',
  merge: 'Merge (skip duplicates)',
  replace: 'Replace duplicates'
}

export interface CopyOptions {
  documents: boolean
  indexes: boolean
  /** Validator, collation, capped / time-series / clustered options (applied when the target is created). */
  collectionOptions: boolean
  /** Recreate views with the same pipeline (views are created last). */
  views: boolean
  conflict: CopyConflict
  batchSize: number
}

export interface CopyItem {
  source: string
  target: string
  /** Only for a single collection: copy the matching documents. */
  filter?: Doc
}

export interface CopyRequest {
  source: { connId: string; db: string }
  target: { connId: string; db: string }
  /** Collections and views to copy; omitted = every collection and view of the source database. */
  items?: CopyItem[]
  options: CopyOptions
}

export interface CopyPlanEntry {
  source: string
  target: string
  type: 'collection' | 'view' | 'timeseries'
  /** The target namespace already exists. */
  exists: boolean
  /** Estimated documents (-1 = unknown, 0 for views). */
  count: number
  viewOn?: string
}

export interface CopyPlan {
  entries: CopyPlanEntry[]
  targetDbExists: boolean
  /** Source names that were requested but do not exist. */
  missing: string[]
}

/** Renderer-callable methods; implemented by `copyHandlers()` in src/main/copy/copy.ts. */
export interface CopyApi {
  copyPlan(req: CopyRequest): CopyPlan
  copyStart(req: CopyRequest): string
  copyCancel(jobId: string): void
}
