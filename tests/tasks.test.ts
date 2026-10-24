// Schedule math runs in a zone with DST; must be set before any Date is created.
process.env.TZ = 'Europe/Rome'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Int32 } from 'bson'
import type { ConnectResult, JobProgress } from '@shared/api'
import { parseUri } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import { advanceSchedule, nextRunAfter, scheduleText, upcomingRuns, validateSchedule } from '@shared/taskSchedule'
import type { TaskCreate, TaskJobInput, TaskSchedule } from '@shared/tasksApi'
import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import { ConnectionManager } from '../src/main/mongo/manager'
import { DEFAULT_SETTINGS } from '../src/main/store'
import { Transfers } from '../src/main/transfer/jobs'
import { Comparisons } from '../src/main/compare/compare'
import { JobWatcher } from '../src/main/tasks/jobWatcher'
import { jobConfigIds, toLiveJob, toSavedJob } from '../src/main/tasks/convert'
import { MAX_RUNS_PER_TASK, TaskService } from '../src/main/tasks/service'
import type { TaskConnections, TaskNotification, TaskRunners } from '../src/main/tasks/service'

const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi)
const HOUR = 3_600_000

describe('schedule math (Europe/Rome, local time)', () => {
  it('runs in a DST zone', () => {
    expect(local(2026, 1, 15, 12).getTimezoneOffset()).toBe(-60)
    expect(local(2026, 7, 15, 12).getTimezoneOffset()).toBe(-120)
  })

  it('none and once', () => {
    expect(nextRunAfter({ kind: 'none' }, new Date())).toBeNull()
    const at = local(2026, 10, 21, 15, 30)
    expect(nextRunAfter({ kind: 'once', at }, local(2026, 10, 21, 9))).toEqual(at)
    expect(nextRunAfter({ kind: 'once', at }, at)).toBeNull()
    expect(nextRunAfter({ kind: 'once', at }, local(2026, 10, 22))).toBeNull()
  })

  it('every N minutes / hours', () => {
    const t = local(2026, 10, 21, 9, 10)
    expect(nextRunAfter({ kind: 'interval', every: 15, unit: 'minutes' }, t)).toEqual(local(2026, 10, 21, 9, 25))
    expect(nextRunAfter({ kind: 'interval', every: 2, unit: 'hours' }, t)).toEqual(local(2026, 10, 21, 11, 10))
    // Intervals stay aligned to their slots when a run is handled late.
    const s: TaskSchedule = { kind: 'interval', every: 15, unit: 'minutes' }
    const due = local(2026, 10, 21, 10)
    expect(advanceSchedule(s, due, new Date(due.getTime() + 20_000))).toEqual(local(2026, 10, 21, 10, 15))
    expect(advanceSchedule(s, due, local(2026, 10, 21, 10, 47))).toEqual(local(2026, 10, 21, 11))
    expect(advanceSchedule(s, due, local(2026, 10, 21, 10, 45))).toEqual(local(2026, 10, 21, 11))
  })

  it('daily at HH:MM', () => {
    const s: TaskSchedule = { kind: 'daily', time: '09:00' }
    expect(nextRunAfter(s, local(2026, 10, 21, 8, 59))).toEqual(local(2026, 10, 21, 9))
    expect(nextRunAfter(s, local(2026, 10, 21, 9))).toEqual(local(2026, 10, 22, 9))
    expect(nextRunAfter(s, local(2026, 12, 31, 23))).toEqual(local(2027, 1, 1, 9))
  })

  it('daily keeps the wall-clock time across DST changes', () => {
    const s: TaskSchedule = { kind: 'daily', time: '12:00' }
    // Spring forward (29 March 2026): the day has 23 hours.
    const a = nextRunAfter(s, local(2026, 3, 28, 12))!
    expect([a.getDate(), a.getHours(), a.getMinutes()]).toEqual([29, 12, 0])
    expect(a.getTime() - local(2026, 3, 28, 12).getTime()).toBe(23 * HOUR)
    // Fall back (25 October 2026): 25 hours.
    const b = nextRunAfter(s, local(2026, 10, 24, 12))!
    expect([b.getDate(), b.getHours()]).toEqual([25, 12])
    expect(b.getTime() - local(2026, 10, 24, 12).getTime()).toBe(25 * HOUR)
  })

  it('daily inside the skipped / repeated hour', () => {
    // 02:30 does not exist on 29 March: runs at 03:30 that day.
    const gap = nextRunAfter({ kind: 'daily', time: '02:30' }, local(2026, 3, 29, 0))!
    expect([gap.getDate(), gap.getHours(), gap.getMinutes()]).toEqual([29, 3, 30])
    // 02:30 happens twice on 25 October: one run, the next is on the 26th.
    const s: TaskSchedule = { kind: 'daily', time: '02:30' }
    const first = nextRunAfter(s, local(2026, 10, 25, 0))!
    expect([first.getDate(), first.getHours(), first.getMinutes()]).toEqual([25, 2, 30])
    const second = nextRunAfter(s, first)!
    expect([second.getDate(), second.getHours(), second.getMinutes()]).toEqual([26, 2, 30])
    expect(nextRunAfter(s, new Date(first.getTime() + HOUR))!.getDate()).toBe(26)
  })

  it('weekly on days at HH:MM', () => {
    const s: TaskSchedule = { kind: 'weekly', days: [1, 3], time: '08:00' }
    // Monday 19 October 2026
    expect(nextRunAfter(s, local(2026, 10, 19, 7))).toEqual(local(2026, 10, 19, 8))
    expect(nextRunAfter(s, local(2026, 10, 19, 9))).toEqual(local(2026, 10, 21, 8))
    // Across the DST change on Sunday the 25th: still 08:00 on Monday.
    const n = nextRunAfter(s, local(2026, 10, 21, 9))!
    expect([n.getDate(), n.getDay(), n.getHours()]).toEqual([26, 1, 8])
    expect(upcomingRuns({ kind: 'weekly', days: [0], time: '10:00' }, local(2026, 10, 19), 3).map((d) => d.getDate())).toEqual([25, 1, 8])
  })

  it('validation and labels', () => {
    expect(validateSchedule({ kind: 'daily', time: '25:00' })).toBeTruthy()
    expect(validateSchedule({ kind: 'weekly', days: [], time: '08:00' })).toBeTruthy()
    expect(validateSchedule({ kind: 'interval', every: 0, unit: 'minutes' })).toBeTruthy()
    expect(validateSchedule({ kind: 'interval', every: 5, unit: 'minutes' })).toBeNull()
    expect(scheduleText({ kind: 'weekly', days: [5, 1, 2, 3, 4], time: '08:00' })).toBe('Weekdays at 08:00')
    expect(scheduleText({ kind: 'interval', every: 1, unit: 'hours' })).toBe('Every hour')
    expect(scheduleText({ kind: 'interval', every: 15, unit: 'minutes' })).toBe('Every 15 minutes')
  })
})

describe('connection id mapping', () => {
  it('saves config ids and maps them back', () => {
    const cfgOf: Record<string, string> = { c1: 'cfgA', c2: 'cfgB' }
    const job: TaskJobInput = {
      kind: 'mask',
      request: { source: { connId: 'c1', db: 'd', coll: 'x', filter: {} }, rules: [], salt: 's', target: { kind: 'collection', connId: 'c2', db: 'd', coll: 'y', dropFirst: true } }
    }
    const saved = toSavedJob(job, (id) => cfgOf[id])
    expect(JSON.stringify(saved)).not.toContain('connId')
    expect(jobConfigIds(saved)).toEqual(['cfgA', 'cfgB'])
    expect(toLiveJob(saved, (id) => (id === 'cfgA' ? 'L1' : 'L2'))).toEqual({
      kind: 'mask',
      request: { source: { connId: 'L1', db: 'd', coll: 'x', filter: {} }, rules: [], salt: 's', target: { kind: 'collection', connId: 'L2', db: 'd', coll: 'y', dropFirst: true } }
    })
    const cmp: TaskJobInput = {
      kind: 'compareSync',
      request: {
        compare: { source: { connId: 'c1', db: 'a', coll: 'x', filter: {} }, target: { connId: 'c1', db: 'b', coll: 'x', filter: {} }, key: '_id', fields: { mode: 'all', paths: [] }, ignore: [], sample: 0 },
        sync: { direction: 'sourceToTarget', insertMissing: true, deleteExtra: false, overwrite: 'set' },
        dryRun: false
      }
    }
    const s2 = toSavedJob(cmp, (id) => cfgOf[id])
    expect(jobConfigIds(s2)).toEqual(['cfgA'])
    expect(toLiveJob(s2, () => 'L')).toMatchObject({ request: { compare: { source: { connId: 'L' }, target: { connId: 'L' } } } })
  })
})

// ---------------------------------------------------------------------------
// Service with fake job runners
// ---------------------------------------------------------------------------

interface FakeEnv {
  svc: TaskService
  dir: string
  watcher: JobWatcher
  started: { jobId: string; kind: string }[]
  /** 'auto' finishes jobs right away with `autoState`; 'manual' waits for finish(). */
  mode: { value: 'auto' | 'manual'; autoState: JobProgress['state']; error?: string }
  finish: (jobId: string, state?: JobProgress['state'], error?: string) => void
  notes: TaskNotification[]
  conns: { live: Map<string, string>; connected: string[]; disconnected: string[] }
  make: () => TaskService
}

async function fakeEnv(dir?: string): Promise<FakeEnv> {
  const d = dir ?? (await fs.mkdtemp(join(tmpdir(), 'shardwise-tasks-')))
  const watcher = new JobWatcher()
  const started: FakeEnv['started'] = []
  const mode: FakeEnv['mode'] = { value: 'auto', autoState: 'done' }
  let seq = 0
  const finish = (jobId: string, state: JobProgress['state'] = 'done', error?: string): void =>
    watcher.feed({ jobId, title: 't', done: 1, state, error, message: state === 'done' ? `finished ${jobId}` : undefined, log: [`log of ${jobId}`] })
  const start = (kind: string) => (): string => {
    const jobId = `job${++seq}`
    started.push({ jobId, kind })
    if (mode.value === 'auto') {
      const { autoState, error } = mode
      queueMicrotask(() => finish(jobId, autoState, error))
    }
    return jobId
  }
  const runners = {
    transfers: { startExport: start('export'), startImport: start('import'), cancel: (id: string) => finish(id, 'cancelled') },
    comparisons: { start: start('compare'), startSync: start('sync'), cancel: (id: string) => finish(id, 'cancelled'), dispose: () => {}, summary: () => ({}), plan: async () => ({}) },
    migrations: { startToSql: start('toSql'), startFromSql: start('fromSql'), cancel: () => {} },
    masking: { start: start('mask'), cancel: () => {} }
  } as unknown as TaskRunners
  const conns: FakeEnv['conns'] = { live: new Map([['live1', 'cfg1']]), connected: [], disconnected: [] }
  const connections: TaskConnections = {
    connect: async (cfg: ConnectionConfig): Promise<ConnectResult> => {
      const connId = `opened-${cfg.id}`
      conns.connected.push(cfg.id)
      conns.live.set(connId, cfg.id)
      return { connId, serverVersion: '8', topology: 'Standalone' }
    },
    disconnect: async (connId) => {
      conns.disconnected.push(connId)
      conns.live.delete(connId)
    },
    liveConnections: () => [...conns.live].map(([connId, configId]) => ({ connId, configId })),
    config: (connId) => {
      const id = conns.live.get(connId)
      if (!id) throw new Error('Not connected')
      return { id, name: id } as ConnectionConfig
    }
  }
  const notes: TaskNotification[] = []
  const make = (): TaskService =>
    new TaskService({
      userData: d,
      connections,
      getConnection: async (id) => {
        if (id === 'gone') throw new Error('not found')
        return { id, name: `Saved ${id}` } as ConnectionConfig
      },
      runners,
      watcher,
      notify: (n) => notes.push(n),
      tickMs: 30_000
    })
  return { svc: make(), dir: d, watcher, started, mode, finish, notes, conns, make }
}

const exportInput = (o: Partial<TaskCreate> = {}, connId = 'live1'): TaskCreate => ({
  name: 'Nightly export',
  schedule: { kind: 'none' },
  enabled: true,
  catchUp: 'skip',
  notify: { success: false, failure: true },
  job: { kind: 'export', request: { connId, db: 'shop', collections: ['items'], format: 'json', target: '/tmp/x.json', query: { filter: { qty: { $gte: new Int32(5) } } } } },
  ...o
})

describe('task service (fake jobs)', () => {
  let env: FakeEnv

  beforeEach(async () => {
    env = await fakeEnv()
  })

  afterEach(async () => {
    env.svc.stop()
    vi.useRealTimers()
    await env.svc.idle()
    await fs.rm(env.dir, { recursive: true, force: true }).catch(() => {})
  })

  it('persists tasks with config ids and BSON values', async () => {
    const t = await env.svc.create(exportInput())
    expect(t.configIds).toEqual(['cfg1'])
    expect(t.nextRunAt).toBeNull()
    await env.svc.idle()
    const raw = await fs.readFile(join(env.dir, 'tasks.json'), 'utf8')
    expect(raw).not.toContain('live1')
    const fromDisk = decodeIpc(raw) as { tasks: { request: { configId: string } }[] }
    expect(fromDisk.tasks[0].request.configId).toBe('cfg1')

    const again = await env.make().list()
    expect(again).toHaveLength(1)
    expect(again[0].createdAt).toBeInstanceOf(Date)
    expect(again[0].kind).toBe('export')
    const q = (again[0].request as unknown as { query: { filter: { qty: { $gte: Int32 } } } }).query
    expect(q.filter.qty.$gte).toBeInstanceOf(Int32)

    const upd = await env.svc.update(t.id, { name: '  Renamed ', schedule: { kind: 'daily', time: '23:30' } })
    expect(upd.name).toBe('Renamed')
    expect(upd.nextRunAt).toBeInstanceOf(Date)
    expect(upd.nextRunAt!.getHours()).toBe(23)
    await expect(env.svc.update(t.id, { schedule: { kind: 'daily', time: 'x' } })).rejects.toThrow(/HH:MM/)

    const dup = await env.svc.duplicate(t.id)
    expect(dup.name).toBe('Renamed (copy)')
    expect(dup.enabled).toBe(false)
    expect(dup.nextRunAt).toBeNull()
    expect((dup.request as unknown as { query: { filter: { qty: { $gte: unknown } } } }).query.filter.qty.$gte).toBeInstanceOf(Int32)

    await env.svc.remove(t.id)
    await env.svc.idle()
    expect((await env.make().list()).map((x) => x.id)).toEqual([dup.id])
  })

  it('keeps the last 50 runs per task', async () => {
    const t = await env.svc.create(exportInput())
    for (let i = 0; i < MAX_RUNS_PER_TASK + 5; i++) {
      await env.svc.runNow(t.id)
      await env.svc.idle()
    }
    const runs = await env.make().runsOf(t.id)
    expect(runs).toHaveLength(MAX_RUNS_PER_TASK)
    expect(runs[0].status).toBe('success')
    expect(runs[0].summary).toMatch(/^finished job\d+$/)
    expect(runs[0].log).toContain(`log of ${env.started.at(-1)!.jobId}`)
    expect(runs[0].startedAt).toBeInstanceOf(Date)
    expect((await env.svc.list())[0].lastRun?.id).toBe(runs[0].id)
  })

  it('runs a daily task when due (30 s ticks)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(local(2026, 10, 21, 8, 59))
    const t = await env.svc.create(exportInput({ schedule: { kind: 'daily', time: '09:00' } }))
    expect(t.nextRunAt).toEqual(local(2026, 10, 21, 9))
    await env.svc.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(env.started).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(env.started).toHaveLength(1)
    await env.svc.idle()
    const [info] = await env.svc.list()
    expect(info.lastRun).toMatchObject({ status: 'success', trigger: 'schedule' })
    expect(info.nextRunAt).toEqual(local(2026, 10, 22, 9))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(env.started).toHaveLength(1)
  })

  it('every N minutes, skipping ticks while the previous run is still going', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(local(2026, 10, 21, 10))
    env.mode.value = 'manual'
    const t = await env.svc.create(exportInput({ schedule: { kind: 'interval', every: 1, unit: 'minutes' } }))
    await env.svc.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(env.started).toHaveLength(1)
    expect((await env.svc.list())[0].running).toMatchObject({ jobId: 'job1' })
    await expect(env.svc.runNow(t.id)).rejects.toThrow(/already running/)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(env.started).toHaveLength(1)
    let runs = await env.svc.runsOf(t.id)
    expect(runs.map((r) => r.status)).toEqual(['running', 'skipped'])
    expect(runs[1].summary).toMatch(/still in progress/)
    env.finish('job1')
    await env.svc.idle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(env.started).toHaveLength(2)
    env.finish('job2')
    await env.svc.idle()
    runs = await env.svc.runsOf(t.id)
    expect(runs.map((r) => r.status)).toEqual(['success', 'success', 'skipped'])
    expect((await env.svc.list())[0].nextRunAt).toEqual(local(2026, 10, 21, 10, 4))
  })

  it('catch-up policy for runs missed while the app was closed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(local(2026, 10, 21, 8))
    const once = await env.svc.create(exportInput({ name: 'catch up', catchUp: 'runOnce', schedule: { kind: 'interval', every: 1, unit: 'hours' } }))
    const skip = await env.svc.create(exportInput({ name: 'skip', catchUp: 'skip', schedule: { kind: 'daily', time: '09:00' } }))
    await env.svc.idle()
    // "Restart" five and a half hours later.
    vi.setSystemTime(local(2026, 10, 21, 13, 30))
    const svc = env.make()
    env.svc = svc
    await svc.start()
    await svc.idle()
    expect(env.started).toHaveLength(1)
    const list = await svc.list()
    const a = list.find((x) => x.id === once.id)!
    const b = list.find((x) => x.id === skip.id)!
    expect(a.lastRun).toMatchObject({ status: 'success', trigger: 'catchUp' })
    expect(a.nextRunAt).toEqual(local(2026, 10, 21, 14))
    expect(b.lastRun).toMatchObject({ status: 'skipped', trigger: 'catchUp' })
    expect(b.nextRunAt).toEqual(local(2026, 10, 22, 9))
    // One run only, even though five slots were missed.
    expect(await svc.runsOf(once.id)).toHaveLength(1)
  })

  it('a run handled very late counts as missed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(local(2026, 10, 21, 8, 59))
    const t = await env.svc.create(exportInput({ catchUp: 'skip', schedule: { kind: 'daily', time: '09:00' } }))
    await env.svc.start()
    // Asleep: the clock jumps without ticks.
    vi.setSystemTime(local(2026, 10, 21, 9, 20))
    await env.svc.tick()
    await env.svc.idle()
    expect(env.started).toHaveLength(0)
    expect((await env.svc.runsOf(t.id))[0]).toMatchObject({ status: 'skipped' })
  })

  it('failure: status, summary and notifier', async () => {
    env.mode.autoState = 'error'
    env.mode.error = 'disk full'
    const t = await env.svc.create(exportInput({ notify: { success: true, failure: true } }))
    await env.svc.runNow(t.id)
    await env.svc.idle()
    const [run] = await env.svc.runsOf(t.id)
    expect(run).toMatchObject({ status: 'error', summary: 'disk full', trigger: 'manual' })
    expect(env.notes).toEqual([{ taskId: t.id, ok: false, title: 'Task “Nightly export” failed', body: 'disk full' }])

    env.mode.autoState = 'done'
    await env.svc.runNow(t.id)
    await env.svc.idle()
    expect(env.notes[1]).toMatchObject({ ok: true, title: 'Task “Nightly export” finished' })

    await env.svc.update(t.id, { notify: { success: false, failure: false } })
    env.mode.autoState = 'error'
    await env.svc.runNow(t.id)
    await env.svc.idle()
    expect(env.notes).toHaveLength(2)
  })

  it('a task with a damaged schedule does not stop the scheduler or the other tasks', async () => {
    const t = await env.svc.create(exportInput({ catchUp: 'runOnce' }))
    await env.svc.idle()
    const raw = decodeIpc(await fs.readFile(join(env.dir, 'tasks.json'), 'utf8')) as { tasks: Record<string, unknown>[] }
    const past = new Date(Date.now() - 60_000)
    // A weekly schedule without `days` (hand-edited / damaged file) made schedule math throw.
    const broken = { ...raw.tasks[0], id: 'broken', name: 'broken', schedule: { kind: 'weekly', time: '09:00' }, nextRunAt: past }
    await fs.writeFile(join(env.dir, 'tasks.json'), encodeIpc({ version: 1, tasks: [broken, { ...raw.tasks[0], nextRunAt: past }] }))
    const svc = env.make()
    await expect(svc.tick()).resolves.toBeUndefined()
    await svc.idle()
    expect(env.started).toHaveLength(1)
    const list = await svc.list()
    expect(list.find((x) => x.id === 'broken')!.nextRunAt).toBeNull()
    expect(list.find((x) => x.id === t.id)!.lastRun).toMatchObject({ status: 'success', trigger: 'catchUp' })
  })

  it('reports a task that could not be saved', async () => {
    await env.svc.list()
    // A folder where tasks.json should be: the atomic rename fails.
    await fs.mkdir(join(env.dir, 'tasks.json'))
    await expect(env.svc.create(exportInput())).rejects.toThrow()
    // The write queue keeps working afterwards.
    await fs.rm(join(env.dir, 'tasks.json'), { recursive: true })
    await expect(env.svc.create(exportInput())).resolves.toMatchObject({ name: 'Nightly export' })
  })

  it('cancel', async () => {
    env.mode.value = 'manual'
    const t = await env.svc.create(exportInput({ notify: { success: true, failure: true } }))
    await env.svc.runNow(t.id)
    await vi.waitFor(() => expect(env.started).toHaveLength(1))
    env.svc.cancel(t.id)
    await env.svc.idle()
    expect((await env.svc.runsOf(t.id))[0]).toMatchObject({ status: 'cancelled' })
    expect(env.notes).toHaveLength(0)
  })

  it('opens a connection that is not live and closes it afterwards', async () => {
    const t = await env.svc.create(exportInput())
    env.conns.live.clear()
    await env.svc.runNow(t.id)
    await env.svc.idle()
    expect(env.conns.connected).toEqual(['cfg1'])
    expect(env.conns.disconnected).toEqual(['opened-cfg1'])
    expect(env.conns.live.size).toBe(0)
    const [run] = await env.svc.runsOf(t.id)
    expect(run.status).toBe('success')
    expect(run.log[0]).toBe('Connecting to Saved cfg1…')

    // A live connection is reused and left open.
    env.conns.live.set('mine', 'cfg1')
    await env.svc.runNow(t.id)
    await env.svc.idle()
    expect(env.conns.connected).toEqual(['cfg1'])
    expect(env.conns.live.get('mine')).toBe('cfg1')
  })

  it('a deleted saved connection fails the run', async () => {
    env.conns.live.set('l-gone', 'gone')
    const t = await env.svc.create(exportInput({}, 'l-gone'))
    env.conns.live.clear()
    await env.svc.runNow(t.id)
    await env.svc.idle()
    expect((await env.svc.runsOf(t.id))[0]).toMatchObject({ status: 'error', summary: expect.stringMatching(/no longer exists/) })
  })
})

// ---------------------------------------------------------------------------
// End to end with MongoDB
// ---------------------------------------------------------------------------

describe('task service (MongoDB)', () => {
  let server: MongoMemoryServer
  let client: MongoClient
  let mgr: ConnectionManager
  let watcher: JobWatcher
  let svc: TaskService
  let dir: string
  let cfg: ConnectionConfig

  beforeAll(async () => {
    server = await MongoMemoryServer.create()
    client = await MongoClient.connect(server.getUri())
    await client
      .db('shop')
      .collection('items')
      .insertMany(Array.from({ length: 10 }, (_, i) => ({ _id: new Int32(i) as never, n: new Int32(i), name: `item ${i}` })))
    dir = await fs.mkdtemp(join(tmpdir(), 'shardwise-tasks-e2e-'))
    cfg = { ...parseUri(server.getUri()), id: 'cfg-mem', name: 'Memory' }
    mgr = new ConnectionManager()
    watcher = new JobWatcher()
    const transfers = new Transfers(mgr, { getSettings: async () => DEFAULT_SETTINGS }, join(dir, 'userData'), watcher.feed)
    const comparisons = new Comparisons(mgr, watcher.feed)
    svc = new TaskService({
      userData: join(dir, 'userData'),
      connections: mgr,
      getConnection: async (id) => {
        if (id !== cfg.id) throw new Error('not found')
        return cfg
      },
      runners: { transfers, comparisons, migrations: { startToSql: () => '', startFromSql: () => '', cancel: () => {} }, masking: { start: () => '', cancel: () => {} } } as unknown as TaskRunners,
      watcher
    })
  })

  afterAll(async () => {
    svc?.stop()
    await svc?.idle()
    await mgr?.closeAll()
    await client?.close()
    await server?.stop()
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('export task: connects, exports with the saved query, disconnects', async () => {
    const { connId } = await mgr.connect(cfg)
    const target = join(dir, 'out', 'items.json')
    const t = await svc.create(
      exportInput({
        job: {
          kind: 'export',
          request: { connId, db: 'shop', collections: ['items'], format: 'json', target, json: { flavor: 'canonical', layout: 'lines', pretty: false }, query: { filter: { n: { $gte: new Int32(4) } } } }
        }
      })
    )
    await mgr.disconnect(connId)
    expect(mgr.liveConnections()).toHaveLength(0)
    const connect = vi.spyOn(mgr, 'connect')
    const disconnect = vi.spyOn(mgr, 'disconnect')

    await svc.runNow(t.id)
    await svc.idle()
    const [run] = await svc.runsOf(t.id)
    expect(run.status, run.summary).toBe('success')
    expect(connect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(mgr.liveConnections()).toHaveLength(0)
    expect(existsSync(target)).toBe(true)
    const lines = (await fs.readFile(target, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain('"$numberInt":"4"')
    connect.mockRestore()
    disconnect.mockRestore()
  })

  it('import task: reuses the live connection', async () => {
    const { connId } = await mgr.connect(cfg)
    const source = join(dir, 'out', 'items.json')
    const t = await svc.create({
      name: 'Load items',
      schedule: { kind: 'none' },
      enabled: true,
      catchUp: 'skip',
      notify: { success: false, failure: false },
      job: { kind: 'import', request: { connId, db: 'shop', collection: 'copy', format: 'json', source, mode: 'insert', dropFirst: true, stopOnError: true } }
    })
    const connect = vi.spyOn(mgr, 'connect')
    await svc.runNow(t.id)
    await svc.idle()
    const [run] = await svc.runsOf(t.id)
    expect(run.status, run.summary).toBe('success')
    expect(connect).not.toHaveBeenCalled()
    expect(mgr.liveConnections()).toEqual([{ connId, configId: cfg.id }])
    expect(await client.db('shop').collection('copy').countDocuments()).toBe(6)
    // dropFirst makes the task repeatable.
    await svc.runNow(t.id)
    await svc.idle()
    expect(await client.db('shop').collection('copy').countDocuments()).toBe(6)
    connect.mockRestore()
  })

  it('compare & sync task (dry run, then sync)', async () => {
    const { connId } = await mgr.connect(cfg)
    await client.db('shop').collection('copy').deleteMany({ n: { $gte: 8 } })
    const job: TaskJobInput = {
      kind: 'compareSync',
      request: {
        compare: { source: { connId, db: 'shop', coll: 'items', filter: {} }, target: { connId, db: 'shop', coll: 'copy', filter: {} }, key: '_id', fields: { mode: 'all', paths: [] }, ignore: [], sample: 0 },
        sync: { direction: 'sourceToTarget', insertMissing: true, deleteExtra: false, overwrite: 'none' },
        dryRun: true
      }
    }
    const base = { schedule: { kind: 'none' } as TaskSchedule, enabled: true, catchUp: 'skip' as const, notify: { success: false, failure: false } }
    const dry = await svc.create({ ...base, name: 'dry', job })
    await svc.runNow(dry.id)
    await svc.idle()
    expect((await svc.runsOf(dry.id))[0]).toMatchObject({ status: 'success', summary: expect.stringMatching(/^Dry run: 6 inserts/) })
    expect(await client.db('shop').collection('copy').countDocuments()).toBe(4)

    const real = await svc.create({ ...base, name: 'sync', job: { ...job, request: { ...job.request, dryRun: false } } as TaskJobInput })
    await svc.runNow(real.id)
    await svc.idle()
    const [run] = await svc.runsOf(real.id)
    expect(run.status, run.summary).toBe('success')
    expect(await client.db('shop').collection('copy').countDocuments()).toBe(10)
    await svc.runNow(real.id)
    await svc.idle()
    expect((await svc.runsOf(real.id))[0].summary).toMatch(/^Already in sync/)
  })
})
