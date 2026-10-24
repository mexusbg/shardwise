import type { Doc } from './api'

/**
 * Change History contract: "before" images of documents changed through Shardwise, kept in a local SQLite file,
 * browsable per collection and restorable.
 */

export type ChangeOp = 'update' | 'replace' | 'delete' | 'insert' | 'drop'
export type ChangeSource = 'edit' | 'bulk' | 'delete' | 'sync' | 'reschema' | 'mask' | 'mcp' | 'import' | 'restore'

export const CHANGE_OPS: ChangeOp[] = ['update', 'replace', 'delete', 'insert', 'drop']
export const CHANGE_SOURCES: ChangeSource[] = ['edit', 'bulk', 'delete', 'sync', 'reschema', 'mask', 'mcp', 'import', 'restore']

export interface ChangeHistorySettings {
  enabled: boolean
  /** Records older than this are pruned (on startup and periodically). */
  retentionDays: number
  /** Oldest records are pruned when the stored images exceed this. */
  maxSizeMB: number
  /** Before images captured per operation; bigger multi-document writes fail unless run without history. */
  maxDocsPerOp: number
}

export const DEFAULT_CHANGE_SETTINGS: ChangeHistorySettings = { enabled: true, retentionDays: 30, maxSizeMB: 512, maxDocsPerOp: 10_000 }

/** Optional last argument of the multi-document editing methods. */
export interface WriteOptions {
  /** Run even when the write affects more documents than Change History captures per operation. */
  allowWithoutHistory?: boolean
  /** Do not record this write (Update Documents dialog: "Record in Change History" unticked). */
  skipHistory?: boolean
}

/** Error messages of writes refused because of the per-operation cap start with this code. */
export const HISTORY_CAP_CODE = 'HISTORY_CAP'
export const isHistoryCapError = (e: unknown): boolean => String((e as Error)?.message ?? e).includes(`${HISTORY_CAP_CODE}:`)
export const historyCapText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^.*?HISTORY_CAP:\s*/, '')

export interface ChangeHistoryStats {
  count: number
  /** Sum of the stored images. */
  bytes: number
  /** Size of the database file. */
  fileBytes: number
  oldest?: Date
  /** Last capture failure (writes still ran). */
  lastError?: { at: Date; message: string }
}

export interface ChangeQuery {
  db: string
  /** Omit for every collection of the database. */
  coll?: string
  op?: ChangeOp
  source?: ChangeSource
  from?: Date
  to?: Date
  /** Substring of the _id as canonical Extended JSON (e.g. an ObjectId hex string). */
  text?: string
  limit?: number
  offset?: number
}

/** One operation (batch) with the records matching the query. */
export interface ChangeBatchInfo {
  batchId: string
  at: Date
  last: Date
  db: string
  coll: string
  source: ChangeSource
  label?: string
  connName: string
  ops: Partial<Record<ChangeOp, number>>
  count: number
  bytes: number
}

export interface ChangeRecordInfo {
  id: number
  at: Date
  batchId: string
  db: string
  coll: string
  op: ChangeOp
  source: ChangeSource
  docId: unknown
  label?: string
  hasBefore: boolean
  hasAfter: boolean
  size: number
}

export interface ChangePathDiff {
  path: string
  kind: 'added' | 'removed' | 'changed'
}

export interface ChangeRecordDetail {
  record: ChangeRecordInfo
  before: Doc | null
  after: Doc | null
  /** Document as stored now; null = missing; undefined = could not be read (see currentError). */
  current?: Doc | null
  currentError?: string
  /** before → after (the recorded change). */
  changed: ChangePathDiff[]
  /** after → current: edits made since (conflicts on restore). Empty without an after image. */
  since: ChangePathDiff[]
  /** current → before: what restoring this record changes. */
  revert: ChangePathDiff[]
  /** Why restoring would conflict (current differs from the after image, or exists again after a delete). */
  conflict?: string
}

export interface RestoreSelection {
  ids?: number[]
  batchIds?: string[]
}

export type RestoreAction = 'replace' | 'reinsert' | 'remove'

export interface RestoreIssue {
  id: number
  coll: string
  docId: unknown
  reason: string
}

export interface RestorePlan {
  /** Records selected. */
  records: number
  /** Documents affected (several records of one document collapse into one restore). */
  documents: number
  actions: Record<RestoreAction, number>
  conflicts: RestoreIssue[]
  skipped: RestoreIssue[]
}

export interface RestoreResult {
  restored: number
  skipped: RestoreIssue[]
  conflicts: RestoreIssue[]
  failed: RestoreIssue[]
  /** Batches recording the restore itself (undo the restore from there). */
  batchIds: string[]
}

export type PurgeRequest =
  | { kind: 'ids'; ids: number[] }
  | { kind: 'batches'; batchIds: string[] }
  | { kind: 'olderThan'; before: Date; db?: string; coll?: string }
  | { kind: 'scope'; db?: string; coll?: string }

/** Renderer-callable methods; implemented by `changeHistoryHandlers()` in src/main/changes/handlers.ts. */
export interface ChangeHistoryApi {
  changesGetSettings(): ChangeHistorySettings
  changesSaveSettings(p: Partial<ChangeHistorySettings>): ChangeHistorySettings
  changesStats(): ChangeHistoryStats
  /** Batches of the connection's saved config, newest first. */
  changesBatches(connId: string, q: ChangeQuery): ChangeBatchInfo[]
  /** Records of one batch (matching the query's filters), newest first. */
  changesRecords(connId: string, batchId: string, q: ChangeQuery): ChangeRecordInfo[]
  changesDetail(connId: string, id: number): ChangeRecordDetail
  changesRestorePlan(connId: string, sel: RestoreSelection): RestorePlan
  changesRestore(connId: string, sel: RestoreSelection, force: boolean): RestoreResult
  /** Removes records of the connection's saved config; returns how many. */
  changesPurge(connId: string, req: PurgeRequest): number
}
