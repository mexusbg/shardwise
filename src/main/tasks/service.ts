import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { ConnectResult, JobProgress } from '@shared/api'
import type { ConnectionConfig } from '@shared/connection'
import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import { advanceSchedule, nextRunAfter, validateSchedule } from '@shared/taskSchedule'
import type { SyncRequest } from '@shared/compareApi'
import type { Task, TaskCreate, TaskInfo, TaskJob, TaskJobInput, TaskRun, TaskRunStatus, TaskSettings, TasksApi, TaskTrigger } from '@shared/tasksApi'
import type { Transfers } from '../transfer/jobs'
import type { Comparisons } from '../compare/compare'
import type { Migrations } from '../sql/migrations'
import type { Masking } from '../masking/masking'
import { jobConfigIds, toLiveJob, toSavedJob } from './convert'
import type { JobWatcher } from './jobWatcher'
import { assertJobWritable } from '../mongo/readOnly'

export const TICK_MS = 30_000
/** A due run handled later than this (computer asleep, app busy) counts as missed. */
export const MISSED_GRACE_MS = 3 * 60_000
export const MAX_RUNS_PER_TASK = 50
const MAX_LOG_LINES = 200

/** What the service needs from the connection manager (ConnectionManager satisfies it). */
export interface TaskConnections {
  connect(cfg: ConnectionConfig): Promise<ConnectResult>
  disconnect(connId: string): Promise<void>
  liveConnections(): { connId: string; configId: string }[]
  config(connId: string): ConnectionConfig
}

export interface TaskRunners {
  transfers: Pick<Transfers, 'startExport' | 'startImport' | 'cancel'>
  comparisons: Pick<Comparisons, 'start' | 'summary' | 'plan' | 'startSync' | 'cancel' | 'dispose'>
  migrations: Pick<Migrations, 'startToSql' | 'startFromSql' | 'cancel'>
  masking: Pick<Masking, 'start' | 'cancel'>
}

export interface TaskNotification {
  taskId: string
  title: string
  body: string
  ok: boolean
}

export interface TaskServiceOptions {
  userData: string
  connections: TaskConnections
  /** Saved connection (with secrets) by config id. */
  getConnection(configId: string): Promise<ConnectionConfig>
  runners: TaskRunners
  watcher: JobWatcher
  notify?: (n: TaskNotification) => void
  /** A task, its run state or its history changed (null: the list). */
  emit?: (taskId: string | null) => void
  tickMs?: number
}

interface Active {
  run: TaskRun
  jobId: string | null
  step: string
  cancelled: boolean
  cancelJob: (() => void) | null
  log: string[]
  promise: Promise<void>
}

class Cancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US')
const jobOf = (t: Task): TaskJob => ({ kind: t.kind, request: t.request }) as TaskJob

export class TaskService {
  private tasks: Task[] = []
  private runs: Record<string, TaskRun[]> = {}
  private loading: Promise<void> | null = null
  private active = new Map<string, Active>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private firstTick = true
  private writing: Promise<void> = Promise.resolve()

  constructor(private o: TaskServiceOptions) {}

  static paths(userData: string): { tasks: string; runs: string } {
    return { tasks: join(userData, 'tasks.json'), runs: join(userData, 'task-runs.json') }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const p = TaskService.paths(this.o.userData)
        const tasks = await readFile<{ tasks?: Task[] }>(p.tasks)
        const runs = await readFile<{ runs?: Record<string, TaskRun[]> }>(p.runs)
        this.tasks = Array.isArray(tasks?.tasks) ? tasks.tasks : []
        this.runs = runs?.runs && typeof runs.runs === 'object' ? runs.runs : {}
      })()
      // A failed read (e.g. a locked file) is retried by the next call instead of failing forever.
      this.loading.catch(() => (this.loading = null))
    }
    return this.loading
  }

  private save(which: 'tasks' | 'runs'): Promise<void> {
    const file = TaskService.paths(this.o.userData)[which]
    const text = encodeIpc(which === 'tasks' ? { version: 1, tasks: this.tasks } : { version: 1, runs: this.runs })
    // The queue survives a failed write; the caller still sees the failure (a task the user saved must not vanish silently).
    const p = this.writing.then(() => writeAtomic(file, text))
    this.writing = p.catch(() => {})
    return p
  }

  /** For writes nobody waits on (scheduler bookkeeping). */
  private saveQuietly(which: 'tasks' | 'runs'): Promise<void> {
    return this.save(which).catch((e) => console.warn(`Could not save ${which === 'tasks' ? 'the tasks' : 'the task runs'}:`, (e as Error)?.message ?? e))
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Loads the tasks, handles runs missed while the app was closed, then checks every 30 s. */
  async start(): Promise<void> {
    // tick() loads the tasks and never throws, so the timer is always installed.
    await this.tick()
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of this.active.keys()) this.cancel(id)
  }

  /** Resolves once no run is in progress and every write has landed. */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()].map((a) => a.promise))
    await this.writing
  }

  private changed(taskId: string | null): void {
    this.o.emit?.(taskId)
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  private find(id: string): Task {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) throw new Error('This task no longer exists')
    return t
  }

  private info(t: Task): TaskInfo {
    const a = this.active.get(t.id)
    return {
      ...t,
      configIds: jobConfigIds(jobOf(t)),
      lastRun: this.runs[t.id]?.[0] ?? null,
      running: a ? { runId: a.run.id, startedAt: a.run.startedAt, jobId: a.jobId, step: a.step } : null
    }
  }

  async list(): Promise<TaskInfo[]> {
    await this.load()
    return this.tasks.map((t) => this.info(t))
  }

  private checkSettings(s: TaskSettings): void {
    if (!s.name.trim()) throw new Error('Enter a task name')
    const err = validateSchedule(s.schedule)
    if (err) throw new Error(err)
  }

  async create(input: TaskCreate): Promise<TaskInfo> {
    await this.load()
    const { job, ...settings } = input
    this.checkSettings(settings)
    const saved = toSavedJob(job, (connId) => this.o.connections.config(connId).id)
    const now = new Date()
    const t = {
      ...settings,
      ...saved,
      name: settings.name.trim(),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      nextRunAt: settings.enabled ? nextRunAfter(settings.schedule, now) : null
    } as Task
    this.tasks.push(t)
    await this.save('tasks')
    this.changed(null)
    return this.info(t)
  }

  async update(id: string, patch: Partial<TaskSettings>): Promise<TaskInfo> {
    await this.load()
    const t = this.find(id)
    const next: TaskSettings = {
      name: patch.name ?? t.name,
      schedule: patch.schedule ?? t.schedule,
      enabled: patch.enabled ?? t.enabled,
      catchUp: patch.catchUp ?? t.catchUp,
      notify: patch.notify ?? t.notify
    }
    this.checkSettings(next)
    const reschedule = patch.schedule !== undefined || (patch.enabled !== undefined && patch.enabled !== t.enabled)
    Object.assign(t, next, { name: next.name.trim(), updatedAt: new Date() })
    if (reschedule) t.nextRunAt = t.enabled ? nextRunAfter(t.schedule, new Date()) : null
    await this.save('tasks')
    this.changed(id)
    return this.info(t)
  }

  async duplicate(id: string): Promise<TaskInfo> {
    await this.load()
    const src = this.find(id)
    const now = new Date()
    // The copy starts disabled so a scheduled task does not suddenly run twice; the codec round trip keeps BSON values.
    const t = { ...(decodeIpc(encodeIpc(src)) as Task), id: randomUUID(), name: `${src.name} (copy)`, enabled: false, nextRunAt: null, createdAt: now, updatedAt: now } as Task
    this.tasks.splice(this.tasks.indexOf(src) + 1, 0, t)
    await this.save('tasks')
    this.changed(null)
    return this.info(t)
  }

  async remove(id: string): Promise<void> {
    await this.load()
    this.cancel(id)
    this.tasks = this.tasks.filter((t) => t.id !== id)
    delete this.runs[id]
    await Promise.all([this.save('tasks'), this.save('runs')])
    this.changed(null)
  }

  async runsOf(id: string): Promise<TaskRun[]> {
    await this.load()
    const a = this.active.get(id)
    const done = this.runs[id] ?? []
    return a ? [{ ...a.run, log: a.log.slice(-MAX_LOG_LINES) }, ...done] : done
  }

  async clearRuns(id: string): Promise<void> {
    await this.load()
    delete this.runs[id]
    await this.save('runs')
    this.changed(id)
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /** Starts every due task. The first tick treats overdue runs as missed and applies the catch-up policy. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    const startup = this.firstTick
    try {
      await this.load()
      const now = new Date()
      let dirty = false
      for (const t of this.tasks) {
        if (!t.enabled || !t.nextRunAt || t.nextRunAt.getTime() > now.getTime()) continue
        const due = t.nextRunAt
        const missed = startup || now.getTime() - due.getTime() > MISSED_GRACE_MS
        dirty = true
        try {
          t.nextRunAt = advanceSchedule(t.schedule, due, now)
          if (this.active.has(t.id)) {
            this.skip(t, 'schedule', 'Skipped: the previous run was still in progress')
          } else if (missed && t.catchUp === 'skip') {
            this.skip(t, 'catchUp', `Skipped the run missed at ${due.toLocaleString()}`)
          } else {
            this.begin(t, missed ? 'catchUp' : 'schedule')
          }
        } catch (e) {
          // One broken task (e.g. a damaged schedule in tasks.json) must not block the others or retry every tick.
          t.nextRunAt = null
          console.warn(`Task "${t.name}" could not be scheduled:`, (e as Error)?.message ?? e)
        }
      }
      // Writes are queued, not awaited: a slow disk must not delay or overlap the next tick.
      if (dirty) {
        void this.saveQuietly('tasks')
        this.changed(null)
      }
    } catch (e) {
      // Runs from setInterval: an exception here would be an unhandled rejection in the main process.
      console.warn('Task scheduler tick failed:', (e as Error)?.message ?? e)
    } finally {
      this.firstTick = false
      this.ticking = false
    }
  }

  private skip(t: Task, trigger: TaskTrigger, summary: string): void {
    const now = new Date()
    void this.record({ id: randomUUID(), taskId: t.id, trigger, status: 'skipped', startedAt: now, endedAt: now, summary, log: [] })
  }

  private async record(run: TaskRun): Promise<void> {
    if (!this.tasks.some((t) => t.id === run.taskId)) return
    this.runs[run.taskId] = [run, ...(this.runs[run.taskId] ?? [])].slice(0, MAX_RUNS_PER_TASK)
    await this.saveQuietly('runs')
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  async runNow(id: string): Promise<string> {
    await this.load()
    return this.begin(this.find(id), 'manual').id
  }

  cancel(id: string): void {
    const a = this.active.get(id)
    if (!a) return
    a.cancelled = true
    a.cancelJob?.()
  }

  private begin(t: Task, trigger: TaskTrigger): TaskRun {
    if (this.active.has(t.id)) throw new Error('This task is already running')
    const run: TaskRun = { id: randomUUID(), taskId: t.id, trigger, status: 'running', startedAt: new Date(), summary: '', log: [] }
    const a: Active = { run, jobId: null, step: 'Starting…', cancelled: false, cancelJob: null, log: [], promise: Promise.resolve() }
    this.active.set(t.id, a)
    a.promise = (async () => {
      let status: TaskRunStatus = 'success'
      let summary: string
      try {
        summary = await this.execute(t, a)
      } catch (e) {
        status = a.cancelled || e instanceof Cancelled ? 'cancelled' : 'error'
        summary = status === 'cancelled' ? 'Cancelled' : (e as Error)?.message || String(e)
        a.log.push(status === 'cancelled' ? 'Cancelled' : `Error: ${summary}`)
      }
      const done: TaskRun = { ...run, status, summary, endedAt: new Date(), log: a.log.slice(-MAX_LOG_LINES) }
      this.active.delete(t.id)
      await this.record(done)
      this.notifyDone(t, done)
      this.changed(t.id)
    })()
    this.changed(t.id)
    return run
  }

  private notifyDone(t: Task, run: TaskRun): void {
    const ok = run.status === 'success'
    if (run.status !== 'success' && run.status !== 'error') return
    if (ok ? !t.notify.success : !t.notify.failure) return
    try {
      this.o.notify?.({ taskId: t.id, ok, title: ok ? `Task “${t.name}” finished` : `Task “${t.name}” failed`, body: run.summary })
    } catch {
      // A failing notifier must not break the run bookkeeping.
    }
  }

  private step(a: Active, text: string): void {
    a.step = text
    a.log.push(text)
    this.changed(a.run.taskId)
  }

  private async execute(t: Task, a: Active): Promise<string> {
    const opened: string[] = []
    const conns = new Map<string, string>()
    try {
      for (const configId of jobConfigIds(jobOf(t))) {
        const live = this.o.connections.liveConnections().find((l) => l.configId === configId)
        if (live) {
          conns.set(configId, live.connId)
          continue
        }
        const cfg = await this.o.getConnection(configId).catch(() => {
          throw new Error('A saved connection used by this task no longer exists')
        })
        this.step(a, `Connecting to ${cfg.name || 'MongoDB'}…`)
        const r = await this.o.connections.connect(cfg)
        opened.push(r.connId)
        conns.set(configId, r.connId)
        if (a.cancelled) throw new Cancelled()
      }
      return await this.dispatch(toLiveJob(jobOf(t), (id) => conns.get(id)!), a)
    } finally {
      for (const id of opened) await this.o.connections.disconnect(id).catch(() => {})
      if (opened.length) a.log.push(`Closed ${opened.length === 1 ? 'the connection' : `${opened.length} connections`} opened for this run`)
    }
  }

  private async job(a: Active, title: string, start: () => string, cancel: (jobId: string) => void): Promise<JobProgress> {
    if (a.cancelled) throw new Cancelled()
    this.step(a, title)
    const jobId = start()
    a.jobId = jobId
    a.cancelJob = () => cancel(jobId)
    this.changed(a.run.taskId)
    const p = await this.o.watcher.wait(jobId)
    a.jobId = null
    a.cancelJob = null
    if (p.log?.length) a.log.push(...p.log)
    if (p.state === 'cancelled') throw new Cancelled()
    if (p.state === 'error') throw new Error(p.error || p.message || 'The job failed')
    return p
  }

  private async dispatch(j: TaskJobInput, a: Active): Promise<string> {
    const { transfers, comparisons, migrations, masking } = this.o.runners
    if (j.kind === 'import' || j.kind === 'sqlImport' || j.kind === 'mask') assertJobWritable(j, (connId) => this.o.connections.config(connId))
    const tCancel = (id: string): void => transfers.cancel(id)
    switch (j.kind) {
      case 'export':
        return (await this.job(a, 'Exporting…', () => transfers.startExport(j.request), tCancel)).message ?? 'Export finished'
      case 'import':
        return (await this.job(a, 'Importing…', () => transfers.startImport(j.request), tCancel)).message ?? 'Import finished'
      case 'sqlExport':
        return (await this.job(a, 'Migrating to SQL…', () => migrations.startToSql(j.request), (id) => migrations.cancel(id))).message ?? 'Migration finished'
      case 'sqlImport':
        return (await this.job(a, 'Importing from SQL…', () => migrations.startFromSql(j.request), (id) => migrations.cancel(id))).message ?? 'Import finished'
      case 'mask':
        return (await this.job(a, 'Masking…', () => masking.start(j.request), (id) => masking.cancel(id))).message ?? 'Masking finished'
      case 'compareSync': {
        const r = j.request
        const cCancel = (id: string): void => comparisons.cancel(id)
        const cmp = await this.job(a, 'Comparing…', () => comparisons.start(r.compare), cCancel)
        try {
          const s = comparisons.summary(cmp.jobId)
          const counts = `${fmt(s.different)} different, ${fmt(s.onlySource)} only in source, ${fmt(s.onlyTarget)} only in target, ${fmt(s.identical)} identical`
          a.log.push(`Compared: ${counts}`)
          const req: SyncRequest = { ...r.sync, compareJobId: cmp.jobId }
          if (!req.insertMissing && !req.deleteExtra && req.overwrite === 'none') return `Compared: ${counts}`
          const plan = await comparisons.plan(req)
          const planText = `${fmt(plan.inserts)} inserts, ${fmt(plan.updates)} overwrites, ${fmt(plan.deletes)} deletes`
          a.log.push(`Sync plan: ${planText}${plan.truncated ? ` (only the first ${fmt(plan.cap)} per category)` : ''}`)
          if (r.dryRun) return `Dry run: ${planText}; nothing written (${counts})`
          if (!plan.inserts && !plan.updates && !plan.deletes) return `Already in sync (${counts})`
          const sync = await this.job(a, 'Syncing…', () => comparisons.startSync(req), cCancel)
          return sync.message ?? `Synced: ${planText}`
        } finally {
          comparisons.dispose(cmp.jobId)
        }
      }
    }
  }
}

async function readFile<T>(path: string): Promise<T | null> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    return decodeIpc(text) as T
  } catch {
    // Keep the unreadable file for inspection instead of overwriting it.
    await fs.rename(path, `${path}.bad-${Date.now()}`).catch(() => {})
    return null
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, path)
}

type Handlers = { [K in keyof TasksApi]: (...args: Parameters<TasksApi[K]>) => Promise<ReturnType<TasksApi[K]>> | ReturnType<TasksApi[K]> }

/** IPC handlers for the tasks methods; spread into createApi()'s result. */
export function tasksHandlers(s: TaskService): Handlers {
  return {
    tasksList: () => s.list(),
    tasksCreate: (t) => s.create(t),
    tasksUpdate: (id, patch) => s.update(id, patch),
    tasksDuplicate: (id) => s.duplicate(id),
    tasksDelete: (id) => s.remove(id),
    tasksRunNow: (id) => s.runNow(id),
    tasksCancel: (id) => s.cancel(id),
    tasksRuns: (id) => s.runsOf(id),
    tasksClearRuns: (id) => s.clearRuns(id)
  }
}
