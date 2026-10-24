import { parentPort } from 'worker_threads'
import { MongoClient } from 'mongodb'
import type { PlaygroundLog } from '@shared/api'
import { encodeIpc } from '@shared/ipcCodec'
import { shellText } from '@shared/bsonValue'
import { classifyShellOp, needsConfirm } from '@shared/shellOptions'
import type { ShellOp, ShellStartupReport } from '@shared/shellOptions'
import { Repl } from './repl'
import { toPlain } from './serialize'
import { readOnlyClient } from '../mongo/readOnly'
import type { ConfirmAsk, SessionInit, SessionMessage, SessionRequest, ShellExecResult } from './protocol'

const OP_TEXT_MAX = 600

/** Shell-syntax text of a wrapper call for the approval dialog, e.g. `shop.orders.deleteMany({})`. */
export function opText(op: ShellOp): string {
  let args: string
  try {
    args = op.args.map((a) => (a === undefined ? 'undefined' : shellText(toPlain(a)).replace(/\s*\n\s*/g, ' '))).join(', ')
  } catch {
    args = '…'
  }
  const target = op.target === 'collection' ? `db.getSiblingDB('${op.db}').getCollection('${op.coll}')` : `db.getSiblingDB('${op.db}')`
  const text = `${target}.${op.method}(${args})`
  return text.length > OP_TEXT_MAX ? `${text.slice(0, OP_TEXT_MAX)}…` : text
}

/** Raised in the sandbox when the user declines a command. */
class DeclinedError extends Error {
  constructor(summary: string) {
    super(`Not run: "${summary}" was declined.`)
    this.name = 'Declined'
  }
}

/** Worker side of a shell session: connects once, then evaluates commands one after another in one context. */
export async function runSession(init: SessionInit): Promise<void> {
  const post = (m: SessionMessage): void => parentPort?.postMessage(m)
  const report = (level: 'warn' | 'error', text: string): void => post({ t: 'log', log: { level, text, at: 0 } })
  process.on('unhandledRejection', (e) => report('error', `Unhandled promise rejection: ${(e as Error)?.stack ?? String(e)}`))
  process.on('uncaughtException', (e) => report('error', `Uncaught exception: ${e?.stack ?? String(e)}`))

  const client = new MongoClient(init.uri, init.options)
  try {
    await client.connect()
  } catch (e) {
    post({ t: 'fatal', error: `Could not connect: ${(e as Error).message}` })
    await client.close().catch(() => {})
    return
  }

  // Approvals: the main process answers each 'confirm' with a 'confirmed' message.
  let confirmSeq = 0
  const waiting = new Map<number, (ok: boolean) => void>()
  const ask = (a: ConfirmAsk): Promise<boolean> =>
    new Promise((resolve) => {
      const id = ++confirmSeq
      waiting.set(id, resolve)
      post({ t: 'confirm', id, ask: a })
    })
  let repl: Repl | undefined
  const guard = async (op: ShellOp): Promise<void> => {
    // A read-only connection refuses the write anyway; asking first would only add a click.
    if (init.readOnly || !repl) return
    const cls = classifyShellOp(op)
    if (!cls || !needsConfirm(repl.current.confirm, cls.level)) return
    if (!(await ask({ level: cls.level, summary: cls.summary, op: opText(op) }))) throw new DeclinedError(cls.summary)
  }

  /** Where the REPL's console output goes: the main process, or a startup script's report. */
  let sink = (log: PlaygroundLog): void => post({ t: 'log', log })
  const name = init.readOnly
  repl = new Repl(name ? readOnlyClient(client, () => name) : client, init.db, (log) => sink(log), guard)

  let busy = Promise.resolve()
  parentPort?.on('message', (m: SessionRequest) => {
    if (m.t === 'confirmed') {
      waiting.get(m.id)?.(m.ok)
      waiting.delete(m.id)
      return
    }
    if (m.t === 'close') {
      void (async () => {
        await repl?.close().catch(() => {})
        await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 1000))])
        process.exit(0)
      })()
      return
    }
    busy = busy.then(async () => {
      const result = await repl!.evaluate(m.code, m.opts)
      let data: string
      try {
        data = encodeIpc(result)
      } catch (e) {
        data = encodeIpc({ ok: false, valueKind: 'undefined', error: `Could not serialize the result: ${(e as Error).message}`, ms: result.ms, db: result.db } satisfies ShellExecResult)
      }
      post({ t: 'done', id: m.id, data })
    })
  })

  // Startup scripts: errors are reported with the session, which starts anyway.
  const reports: ShellStartupReport[] = []
  for (const s of init.startup ?? []) {
    const logs: PlaygroundLog[] = []
    sink = (log) => logs.push(log)
    const r = await repl.evaluate(s.code, {}, 'startup.js')
    reports.push({ label: s.label, ok: r.ok, error: r.error, stack: r.stack, ms: r.ms, logs })
  }
  sink = (log) => post({ t: 'log', log })
  if (reports.length) await repl.dropCursor()
  post({ t: 'ready', startup: reports.length ? reports : undefined })
}
