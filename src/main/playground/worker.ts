import { parentPort, workerData } from 'worker_threads'
import { MongoClient } from 'mongodb'
import { encodeIpc } from '@shared/ipcCodec'
import { execute } from './core'
import { readOnlyClient } from '../mongo/readOnly'
import { runSession } from './session'
import type { ExecResult, SessionInit, WorkerInit, WorkerMessage } from './protocol'

const post = (m: WorkerMessage): void => parentPort?.postMessage(m)
const start = Date.now()
const report = (level: 'warn' | 'error', text: string): void => post({ t: 'log', log: { level, text, at: Date.now() - start } })

async function main(): Promise<void> {
  // Promises the code forgot to await must not kill the run.
  process.on('unhandledRejection', (e) => report('error', `Unhandled promise rejection: ${(e as Error)?.stack ?? String(e)}`))
  process.on('uncaughtException', (e) => report('error', `Uncaught exception: ${e?.stack ?? String(e)}`))
  const init = workerData as WorkerInit
  let client: MongoClient | undefined
  let result: ExecResult
  try {
    client = new MongoClient(init.uri, init.options)
    try {
      await client.connect()
    } catch (e) {
      throw new Error(`Could not connect: ${(e as Error).message}`)
    }
    const name = init.readOnly
    result = await execute({ client: name ? readOnlyClient(client, () => name) : client, db: init.db, code: init.code, language: init.language, onLog: (log) => post({ t: 'log', log }), startup: init.startup, startupErrors: init.startupErrors })
  } catch (e) {
    result = { ok: false, valueKind: 'undefined', error: (e as Error).message ?? String(e), ms: Date.now() - start }
  }
  if (client) await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 1000))])
  let data: string
  try {
    data = encodeIpc(result)
  } catch (e) {
    data = encodeIpc({ ok: false, valueKind: 'undefined', error: `Could not serialize the result: ${(e as Error).message}`, ms: result.ms })
  }
  post({ t: 'done', data })
}

// One bundle serves both the one-shot playground runs and the long-lived shell sessions.
if ((workerData as Partial<SessionInit> | undefined)?.mode === 'session') void runSession(workerData as SessionInit)
else void main()
