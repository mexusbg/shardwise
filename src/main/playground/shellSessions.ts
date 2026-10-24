import { randomUUID } from 'crypto'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { buildUri } from '@shared/connection'
import { decodeIpc } from '@shared/ipcCodec'
import type { PlaygroundLog } from '@shared/api'
import type { ShellResult } from '@shared/shell'
import type { ShellConfirmRequest, ShellEvalOptions, ShellStartupReport } from '@shared/shellOptions'
import { clientOptions } from '../mongo/manager'
import type { ConnectionManager } from '../mongo/manager'
import type { SessionInit, SessionMessage, SessionRequest, ShellExecResult } from './protocol'
import type { StartupScript } from './core'
import type { StartupPlan } from './startup'
import { duration, stopServerOps } from './runner'

interface Pending {
  id: number
  logs: PlaygroundLog[]
  started: number
  timer?: ReturnType<typeof setTimeout>
  timeoutMS: number
  /** When the time limit runs out (the clock stops while a command waits for approval). */
  deadline?: number
  remaining?: number
  resolve: (r: ShellResult) => void
}

interface Session {
  id: string
  connId: string
  db: string
  appName: string
  worker?: Worker
  /** Settles when the current worker is connected (rejects when it could not connect). */
  ready?: Promise<void>
  seq: number
  pending?: Pending
  /** An interrupt / timeout is restarting the worker. */
  aborting?: boolean
  closed?: boolean
  /** Why the worker is gone (crash or failed restart); the next command tries to start it again. */
  lost?: string
  /** Startup script reports of the last (re)start, handed out once. */
  startup?: ShellStartupReport[]
  /** Approvals the running command waits for, by request id. */
  confirms: Map<string, (ok: boolean) => void>
}

export interface ShellHooks {
  /** Startup scripts of a new session of this connection and how long they may run (0 = no limit). */
  startup?: (connId: string) => Promise<StartupPlan & { timeoutMS: number }>
  /** A command waits for the user's approval; answer with confirmReply(). Without it such commands are declined. */
  onConfirm?: (req: ShellConfirmRequest) => void
}

class StartupTimeout extends Error {}

const CLOSE_WAIT_MS = 1000

/**
 * Interactive shell sessions: one long-lived worker per session holding one vm context and MongoClient, so
 * variables survive between commands. Interrupting terminates the worker, kills its server operations and
 * starts a fresh worker (variables are reset). Every (re)start runs the startup scripts.
 */
export class ShellSessions {
  private sessions = new Map<string, Session>()

  constructor(
    private mgr: ConnectionManager,
    private onLog: (sessionId: string, log: PlaygroundLog) => void,
    private workerPath = join(__dirname, 'playgroundWorker.js'),
    private hooks: ShellHooks = {}
  ) {}

  /** Number of open sessions. */
  get size(): number {
    return this.sessions.size
  }

  /** Whether the session has a live worker (for tests). */
  hasWorker(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.worker
  }

  async open(connId: string, db: string): Promise<string> {
    const s: Session = { id: randomUUID(), connId, db, appName: '', seq: 0, confirms: new Map() }
    this.sessions.set(s.id, s)
    try {
      await this.spawn(s)
    } catch (e) {
      this.sessions.delete(s.id)
      throw e
    }
    return s.id
  }

  /** Startup script reports of the session's start (once; later restarts attach them to the command's result). */
  takeStartup(sessionId: string): ShellStartupReport[] | undefined {
    const s = this.sessions.get(sessionId)
    const r = s?.startup
    if (s) s.startup = undefined
    return r
  }

  private spawn(s: Session, skipStartup = false): Promise<void> {
    s.lost = undefined
    s.ready = this.start(s, skipStartup)
    s.ready.catch(() => {})
    return s.ready
  }

  /** Loads the startup scripts and starts a worker; scripts that run too long are dropped for this start. */
  private async start(s: Session, skipStartup: boolean): Promise<void> {
    let plan: StartupPlan & { timeoutMS: number } = { scripts: [], errors: [], timeoutMS: 0 }
    if (!skipStartup && this.hooks.startup) {
      try {
        plan = await this.hooks.startup(s.connId)
      } catch (e) {
        plan.errors.push(`Could not load the startup scripts: ${(e as Error).message}`)
      }
    }
    const reports: ShellStartupReport[] = plan.errors.map((error) => ({ label: 'startup script', ok: false, error, ms: 0, logs: [] }))
    try {
      reports.push(...((await this.launch(s, plan.scripts, plan.timeoutMS)) ?? []))
    } catch (e) {
      if (!(e instanceof StartupTimeout)) throw e
      await stopServerOps(this.mgr, s.connId, e.message)
      await this.launch(s, [], 0)
      const labels = plan.scripts.map((x) => x.label).join(', ')
      reports.push({ label: labels, ok: false, error: `The startup script did not finish within ${duration(plan.timeoutMS)} and was stopped; the session started without it.`, ms: plan.timeoutMS, logs: [] })
    }
    s.startup = reports.length ? reports : undefined
  }

  private launch(s: Session, startup: StartupScript[], startupTimeoutMS: number): Promise<ShellStartupReport[] | undefined> {
    if (s.closed) return Promise.reject(new Error('The shell session is closed'))
    const cfg = this.mgr.config(s.connId)
    s.appName = `Shardwise Shell ${randomUUID()}`
    const appName = s.appName
    const init: SessionInit = {
      mode: 'session',
      uri: buildUri(cfg, true),
      options: { ...clientOptions(cfg, this.mgr.tunnelFor(s.connId)), appName },
      db: s.db,
      readOnly: cfg.readOnly ? cfg.name : undefined,
      startup: startup.length ? startup : undefined
    }
    const worker = new Worker(this.workerPath, { workerData: init, name: `shell ${s.id}` })
    s.worker = worker
    const current = (): boolean => s.worker === worker
    return new Promise<ShellStartupReport[] | undefined>((resolve, reject) => {
      let started = false
      const timer =
        startup.length && startupTimeoutMS > 0
          ? setTimeout(() => {
              if (started || !current()) return
              s.worker = undefined
              void worker.terminate()
              reject(new StartupTimeout(appName))
            }, startupTimeoutMS)
          : undefined
      worker.on('message', (m: SessionMessage) => {
        if (!current()) return
        switch (m.t) {
          case 'ready':
            started = true
            clearTimeout(timer)
            resolve(m.startup)
            break
          case 'fatal':
            clearTimeout(timer)
            s.worker = undefined
            s.lost = m.error
            void worker.terminate()
            reject(new Error(m.error))
            break
          case 'log':
            s.pending?.logs.push(m.log)
            this.onLog(s.id, m.log)
            break
          case 'confirm':
            this.confirm(s, worker, m.id, m.ask)
            break
          case 'done': {
            const p = s.pending
            if (!p || p.id !== m.id) return
            const r = decodeIpc(m.data) as ShellExecResult
            if (r.db) s.db = r.db
            this.settle(s, { ...r, runId: s.id, logs: p.logs })
            break
          }
        }
      })
      const gone = (why: string): void => {
        if (!current()) return
        clearTimeout(timer)
        s.worker = undefined
        s.lost = why
        if (!started) return reject(new Error(why))
        this.settle(s, this.fail(s, `${why}. The session will restart on the next command; variables were reset.`, { reset: true }))
      }
      worker.on('error', (e) => gone(`The shell session crashed: ${e.message}`))
      worker.on('exit', (code) => gone(`The shell session stopped unexpectedly (exit code ${code})`))
    })
  }

  /** Forwards an approval request of the running command; the time limit pauses until it is answered. */
  private confirm(s: Session, worker: Worker, workerId: number, ask: Extract<SessionMessage, { t: 'confirm' }>['ask']): void {
    const reply = (ok: boolean): void => {
      if (s.worker === worker) worker.postMessage({ t: 'confirmed', id: workerId, ok } satisfies SessionRequest)
    }
    const p = s.pending
    if (!p || !this.hooks.onConfirm) return reply(false)
    const id = randomUUID()
    if (p.timer && p.deadline) {
      clearTimeout(p.timer)
      p.timer = undefined
      p.remaining = Math.max(0, p.deadline - Date.now())
    }
    s.confirms.set(id, (ok) => {
      s.confirms.delete(id)
      if (s.pending === p && !s.confirms.size && p.remaining !== undefined) {
        p.deadline = Date.now() + p.remaining
        p.timer = setTimeout(() => void this.abort(s, `Timed out after ${duration(p.timeoutMS)}`), p.remaining)
        p.remaining = undefined
      }
      reply(ok)
    })
    this.hooks.onConfirm({ id, sessionId: s.id, ...ask })
  }

  /** The user's answer to a confirmation request (unknown / stale ids are ignored). */
  confirmReply(sessionId: string, requestId: string, approved: boolean): void {
    this.sessions.get(sessionId)?.confirms.get(requestId)?.(approved)
  }

  private fail(s: Session, error: string, extra: Partial<ShellResult> = {}): ShellResult {
    const p = s.pending
    return { runId: s.id, ok: false, valueKind: 'undefined', logs: p?.logs ?? [], ms: p ? Date.now() - p.started : 0, error, db: s.db, ...extra }
  }

  private settle(s: Session, r: ShellResult): void {
    const p = s.pending
    if (!p) return
    clearTimeout(p.timer)
    s.pending = undefined
    s.confirms.clear()
    const startup = s.startup
    s.startup = undefined
    p.resolve(startup ? { ...r, startup } : r)
  }

  private get(sessionId: string): Session {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('The shell session is closed')
    return s
  }

  async evaluate(sessionId: string, code: string, timeoutMS = 0, opts?: ShellEvalOptions): Promise<ShellResult> {
    const s = this.get(sessionId)
    if (s.pending || s.aborting) return this.fail(s, 'Another command is still running')
    if (!s.worker) {
      try {
        await this.spawn(s)
      } catch (e) {
        return this.fail(s, `Not connected: ${(e as Error).message}`, { lost: true })
      }
    }
    try {
      await s.ready
    } catch (e) {
      return this.fail(s, `Not connected: ${(e as Error).message}`, { lost: true })
    }
    if (s.closed) return this.fail(s, 'The shell session is closed')
    if (s.pending) return this.fail(s, 'Another command is still running')
    const worker = s.worker!
    return new Promise<ShellResult>((resolve) => {
      const p: Pending = { id: ++s.seq, logs: [], started: Date.now(), timeoutMS, resolve }
      s.pending = p
      if (timeoutMS > 0) {
        p.deadline = Date.now() + timeoutMS
        p.timer = setTimeout(() => void this.abort(s, `Timed out after ${duration(timeoutMS)}`), timeoutMS)
      }
      worker.postMessage({ t: 'eval', id: p.id, code, opts } satisfies SessionRequest)
    })
  }

  /** Stops the running command: terminate the worker, kill its server operations, start a fresh session. */
  private async abort(s: Session, reason: string): Promise<void> {
    if (s.aborting || !s.pending) return
    s.aborting = true
    const old = s.worker
    const appName = s.appName
    s.worker = undefined
    s.confirms.clear()
    try {
      await old?.terminate().catch(() => {})
      await stopServerOps(this.mgr, s.connId, appName)
      if (s.closed) return this.settle(s, this.fail(s, 'The shell session is closed', { cancelled: true }))
      let note = 'The session was restarted; variables were reset.'
      let lost = false
      try {
        await this.spawn(s)
      } catch (e) {
        note = `Could not restart the session: ${(e as Error).message}`
        lost = true
      }
      this.settle(s, this.fail(s, `${reason}. ${note}`, { cancelled: true, reset: true, lost: lost || undefined }))
    } finally {
      s.aborting = false
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (s) await this.abort(s, 'Interrupted')
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.sessions.delete(sessionId)
    s.closed = true
    const worker = s.worker
    s.worker = undefined
    const running = !!s.pending
    this.settle(s, this.fail(s, 'The shell session is closed', { cancelled: true }))
    if (!worker) return
    if (running) {
      await worker.terminate().catch(() => {})
      await stopServerOps(this.mgr, s.connId, s.appName)
      return
    }
    // Let the worker close its client cleanly, but never wait long.
    const exited = new Promise((r) => worker.once('exit', r))
    worker.postMessage({ t: 'close' } satisfies SessionRequest)
    await Promise.race([exited, new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))])
    await worker.terminate().catch(() => {})
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) void this.close(id)
  }
}
