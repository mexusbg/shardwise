import type { ExportRequest, ImportRequest } from './api'
import type { CompareRequest, CompareSide, SyncRequest } from './compareApi'
import type { FromSqlRequest, ToSqlRequest } from './migrationApi'
import type { MaskRequest, MaskSource, MaskTarget } from './maskingApi'

/**
 * Tasks & scheduler contract: saved import / export / compare-sync / SQL migration / masking jobs, run on demand
 * or on a schedule while the app runs. Implemented by `tasksHandlers()` in src/main/tasks/service.ts.
 *
 * Saved tasks reference saved connections by config id; live connection ids are mapped when saving and again
 * (connecting when needed) at run time.
 */

export type TaskKind = 'export' | 'import' | 'compareSync' | 'sqlExport' | 'sqlImport' | 'mask'

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  export: 'Export',
  import: 'Import',
  compareSync: 'Compare & sync',
  sqlExport: 'Migrate to SQL',
  sqlImport: 'Import from SQL',
  mask: 'Data masking'
}

/** Days of the week as `Date.getDay()`: 0 = Sunday. Times are local `HH:MM`. */
export type TaskSchedule =
  | { kind: 'none' }
  | { kind: 'once'; at: Date }
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }

/** Runs missed while the app was closed (or the computer asleep): skip them, or run once at startup. */
export type CatchUpPolicy = 'skip' | 'runOnce'

export interface TaskNotify {
  success: boolean
  failure: boolean
}

export type SyncOptions = Omit<SyncRequest, 'compareJobId'>

type WithConfig<T> = Omit<T, 'connId'> & { configId: string }

// Requests as the job starters take them (live connection ids).

export interface CompareSyncRequest {
  compare: CompareRequest
  sync: SyncOptions
  /** Compare and compute the sync plan without writing. */
  dryRun: boolean
}

export type TaskJobInput =
  | { kind: 'export'; request: ExportRequest }
  | { kind: 'import'; request: ImportRequest }
  | { kind: 'compareSync'; request: CompareSyncRequest }
  | { kind: 'sqlExport'; request: ToSqlRequest }
  | { kind: 'sqlImport'; request: FromSqlRequest }
  | { kind: 'mask'; request: MaskRequest }

// Saved requests (connection config ids).

export type SavedCompareSide = WithConfig<CompareSide>

export interface SavedCompareSync {
  compare: Omit<CompareRequest, 'source' | 'target'> & { source: SavedCompareSide; target: SavedCompareSide }
  sync: SyncOptions
  dryRun: boolean
}

export type SavedMaskTarget = Exclude<MaskTarget, { kind: 'collection' }> | WithConfig<Extract<MaskTarget, { kind: 'collection' }>>

export interface SavedMask {
  source: WithConfig<MaskSource>
  rules: MaskRequest['rules']
  salt: string
  target: SavedMaskTarget
}

export type TaskJob =
  | { kind: 'export'; request: WithConfig<ExportRequest> }
  | { kind: 'import'; request: WithConfig<ImportRequest> }
  | { kind: 'compareSync'; request: SavedCompareSync }
  | { kind: 'sqlExport'; request: WithConfig<ToSqlRequest> }
  | { kind: 'sqlImport'; request: WithConfig<FromSqlRequest> }
  | { kind: 'mask'; request: SavedMask }

export interface TaskSettings {
  name: string
  schedule: TaskSchedule
  enabled: boolean
  catchUp: CatchUpPolicy
  notify: TaskNotify
}

export type Task = TaskSettings &
  TaskJob & {
    id: string
    createdAt: Date
    updatedAt: Date
    /** Next scheduled run; null when the task is disabled, manual or a past one-off. */
    nextRunAt: Date | null
  }

export type TaskRunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'skipped'
export type TaskTrigger = 'manual' | 'schedule' | 'catchUp'

export interface TaskRun {
  id: string
  taskId: string
  trigger: TaskTrigger
  status: TaskRunStatus
  startedAt: Date
  endedAt?: Date
  summary: string
  /** Last lines of the job logs. */
  log: string[]
}

export interface TaskRunning {
  runId: string
  startedAt: Date
  /** Job currently running (its progress arrives as `job:progress`). */
  jobId: string | null
  step: string
}

export type TaskInfo = Task & {
  /** Saved connections the task uses. */
  configIds: string[]
  lastRun: TaskRun | null
  running: TaskRunning | null
}

export interface TaskCreate extends TaskSettings {
  job: TaskJobInput
}

/** Push events (spread into ApiEvents). */
export interface TasksEvents {
  'tasks:changed': { taskId: string | null }
}

/** Renderer-callable methods; implemented by `tasksHandlers()` in src/main/tasks/service.ts. */
export interface TasksApi {
  tasksList(): TaskInfo[]
  tasksCreate(t: TaskCreate): TaskInfo
  tasksUpdate(id: string, patch: Partial<TaskSettings>): TaskInfo
  tasksDuplicate(id: string): TaskInfo
  tasksDelete(id: string): void
  /** Starts a run in the background; resolves with the run id. */
  tasksRunNow(id: string): string
  tasksCancel(id: string): void
  tasksRuns(id: string): TaskRun[]
  tasksClearRuns(id: string): void
}
