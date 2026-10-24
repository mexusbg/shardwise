import { randomUUID } from 'crypto'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { buildUri } from '@shared/connection'
import { decodeIpc } from '@shared/ipcCodec'
import type { PlaygroundLog, PlaygroundResult, PlaygroundRunRequest } from '@shared/api'
import type { Document, MongoClient } from 'mongodb'
import { clientOptions } from '../mongo/manager'
import type { ConnectionManager } from '../mongo/manager'
import type { ExecResult, WorkerInit, WorkerMessage } from './protocol'
import type { StartupPlan } from './startup'

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${+(ms / 1000).toFixed(1)} s`
  const m = ms / 60_000
  return `${+m.toFixed(1)} min`
}

/** Longest a cancelled run waits for its server operations to be killed. */
export const KILL_WAIT_MS = 2000

/**
 * Best effort: kill the server operations of a client identified by its appName, then wait (until
 * `deadline`) for them to stop. Returns the number of operations killed.
 */
export async function killOpsByAppName(client: MongoClient, appName: string, deadline = Date.now() + KILL_WAIT_MS): Promise<number> {
  const admin = client.db('admin')
  const list = (allUsers: boolean): Promise<Document[]> =>
    admin
      .aggregate([
        { $currentOp: { allUsers, idleConnections: false, idleSessions: false } },
        { $match: { appName } },
        { $project: { opid: 1, killPending: 1 } }
      ])
      .toArray()
  const ops = (): Promise<Document[]> => list(true).catch(() => list(false))
  let killed = 0
  for (let found = await ops(); found.length && Date.now() < deadline; found = await ops()) {
    for (const op of found) {
      if (op.opid === undefined || op.killPending) continue
      await admin.command({ killOp: 1, op: op.opid }).then(
        () => killed++,
        () => {}
      )
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return killed
}

/** Terminating a worker does not stop what it started on the server: kill those operations too (best effort). */
export async function stopServerOps(mgr: ConnectionManager, connId: string, appName: string): Promise<void> {
  const deadline = Date.now() + KILL_WAIT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const client = mgr.get(connId)
    const timeout = new Promise((r) => (timer = setTimeout(r, KILL_WAIT_MS + 100)))
    await Promise.race([killOpsByAppName(client, appName, deadline).catch(() => {}), timeout])
  } catch {
    // not connected any more
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs playground scripts. Every run gets its own worker thread with its own MongoClient, so a run can be
 * stopped at any point (infinite loops included) by terminating the worker.
 */
export class Playground {
  private runs = new Map<string, () => void>()

  constructor(
    private mgr: ConnectionManager,
    private onLog: (runId: string, log: PlaygroundLog) => void,
    private workerPath = join(__dirname, 'playgroundWorker.js'),
    /** Shell startup scripts to run before each script (null when the preference is off). */
    private startup?: (connId: string) => Promise<StartupPlan | null>
  ) {}

  private stopServerOps(connId: string, appName: string): Promise<void> {
    return stopServerOps(this.mgr, connId, appName)
  }

  async run(req: PlaygroundRunRequest): Promise<PlaygroundResult> {
    let plan: StartupPlan | null = null
    try {
      plan = (await this.startup?.(req.connId)) ?? null
    } catch (e) {
      plan = { scripts: [], errors: [`Could not load the startup scripts: ${(e as Error).message}`] }
    }
    return this.start(req, plan)
  }

  private start(req: PlaygroundRunRequest, plan: StartupPlan | null): Promise<PlaygroundResult> {
    const started = Date.now()
    const logs: PlaygroundLog[] = []
    const fail = (error: string, extra: Partial<PlaygroundResult> = {}): PlaygroundResult => ({
      runId: req.runId,
      ok: false,
      valueKind: 'undefined',
      logs,
      ms: Date.now() - started,
      error,
      ...extra
    })
    let init: WorkerInit
    const appName = `Shardwise Playground ${randomUUID()}`
    try {
      const cfg = this.mgr.config(req.connId)
      const options = { ...clientOptions(cfg, this.mgr.tunnelFor(req.connId)), appName }
      init = {
        uri: buildUri(cfg, true),
        options,
        db: req.db,
        code: req.code,
        language: req.language,
        readOnly: cfg.readOnly ? cfg.name : undefined,
        startup: plan?.scripts.length ? plan.scripts : undefined,
        startupErrors: plan?.errors.length ? plan.errors : undefined
      }
    } catch (e) {
      return Promise.resolve(fail((e as Error).message))
    }
    this.runs.get(req.runId)?.()

    return new Promise((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const worker = new Worker(this.workerPath, { workerData: init, name: `playground ${req.runId}` })
      const finish = (r: PlaygroundResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.runs.delete(req.runId)
        const terminated = worker.terminate().catch(() => {})
        if (!r.cancelled) return resolve(r)
        void terminated.then(() => this.stopServerOps(req.connId, appName)).then(() => resolve(r))
      }
      worker.on('message', (m: WorkerMessage) => {
        if (done) return
        if (m.t === 'log') {
          logs.push(m.log)
          this.onLog(req.runId, m.log)
        } else if (m.t === 'done') {
          finish({ ...(decodeIpc(m.data) as ExecResult), runId: req.runId, logs })
        }
      })
      worker.on('error', (e) => finish(fail(e.message, { stack: e.stack })))
      worker.on('exit', (code) => finish(fail(`The playground worker stopped unexpectedly (exit code ${code})`)))
      if (req.timeoutMS > 0) timer = setTimeout(() => finish(fail(`Timed out after ${duration(req.timeoutMS)}`, { cancelled: true })), req.timeoutMS)
      this.runs.set(req.runId, () => finish(fail('Cancelled', { cancelled: true })))
    })
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.()
  }

  cancelAll(): void {
    for (const cancel of [...this.runs.values()]) cancel()
  }
}
