import { performance } from 'perf_hooks'
import type { Document, MongoClient } from 'mongodb'
import type { PlaygroundLog } from '@shared/api'
import { parseCommand, SHELL_BATCH, SHELL_HELP } from '@shared/shell'
import type { ShellCommand } from '@shared/shell'
import { applyPrintDates, SHELL_BATCH_MAX } from '@shared/shellOptions'
import type { ShellEvalOptions, ShellOp, ShellPrintOptions } from '@shared/shellOptions'
import { cappedLogger, createRuntime, errorResult } from './core'
import type { Runtime, Source } from './core'
import { RESULT_LIMIT } from './protocol'
import type { ShellExecResult } from './protocol'
import { prepare } from './transpile'
import { isDriverCursor, RAW, ShellCursor } from './shell'
import { formatArgs, shape, toPlain } from './serialize'

const FILE = 'shell.js'

/** Lazily reads documents from a cursor-like source, one batch at a time, looking one document ahead. */
class Pager {
  private ahead: unknown[] = []
  private done = false

  constructor(
    private next: () => Promise<unknown>,
    private closeFn: () => Promise<unknown>
  ) {}

  async page(n: number): Promise<{ docs: unknown[]; more: boolean }> {
    const docs: unknown[] = []
    while (docs.length < n && !this.done) {
      const d = this.ahead.length ? this.ahead.shift() : await this.next()
      if (d === null || d === undefined) this.done = true
      else docs.push(d)
    }
    if (!this.done && !this.ahead.length) {
      const d = await this.next()
      if (d === null || d === undefined) this.done = true
      else this.ahead.push(d)
    }
    if (this.done) await this.close()
    return { docs, more: !this.done }
  }

  async close(): Promise<void> {
    this.done = true
    this.ahead = []
    await this.closeFn().catch(() => {})
  }
}

function fmtSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}

/**
 * A persistent REPL session: one vm context and client for many evaluations. Top-level declarations are hoisted
 * onto the context global so they survive between commands; cursors are shown in batches (`it` for more).
 */
export class Repl {
  private rt: Runtime
  private pager?: Pager
  private more = false
  private t0 = 0
  private log: (level: PlaygroundLog['level'], text: string) => void = () => {}
  private batch = SHELL_BATCH
  private print?: ShellPrintOptions
  /** Options of the running evaluation (the session's guard reads the confirmation mode). */
  current: ShellEvalOptions = {}

  constructor(
    private client: MongoClient,
    db: string,
    private onLog: (log: PlaygroundLog) => void,
    guard?: (op: ShellOp) => Promise<void>
  ) {
    this.rt = createRuntime({
      client,
      db,
      log: (level, text) => this.log(level, text),
      finalValue: (v) => this.finalValue(v),
      guard,
      format: (args) => formatArgs(args, this.print)
    })
  }

  get db(): string {
    return this.rt.db()
  }

  private elapsed = (): number => Math.round(performance.now() - this.t0)

  private async page(p: Pager): Promise<unknown[]> {
    if (this.pager && this.pager !== p) void this.pager.close()
    const { docs, more } = await p.page(this.batch)
    this.pager = more ? p : undefined
    this.more = more
    return docs
  }

  private async finalValue(v: unknown): Promise<unknown> {
    if (v instanceof ShellCursor) {
      if (v['_explain']) return v.explain(v['_explain'])
      return this.page(new Pager(() => v._cursor.next(), () => v._cursor.close()))
    }
    if (isDriverCursor(v)) return this.page(new Pager(() => v.next(), () => v.close()))
    if (v instanceof this.rt.mongoose.Query) {
      const q = v as InstanceType<typeof this.rt.mongoose.Query> & { op?: string }
      if (q.op === 'find' && q.getOptions().limit == null) {
        const c = q.cursor()
        return this.page(new Pager(() => c.next(), () => c.close()))
      }
    }
    return v
  }

  private async command(cmd: ShellCommand): Promise<unknown> {
    const db = this.client.db(this.db)
    switch (cmd.kind) {
      case 'use':
        if (cmd.db === this.db) return `already on db ${cmd.db}`
        return this.rt.use(cmd.db)
      case 'it':
        if (!this.pager) return 'no cursor'
        return this.page(this.pager)
      case 'help':
        return SHELL_HELP
      case 'cls':
      case 'exit':
        return undefined
      case 'show':
        switch (cmd.what) {
          case 'dbs':
          case 'databases': {
            const admin = this.client.db('admin')
            const r = await admin.command({ listDatabases: 1 }).catch(() => admin.command({ listDatabases: 1, authorizedDatabases: true }))
            const list = (r.databases as { name: string; sizeOnDisk?: number }[]).sort((a, b) => a.name.localeCompare(b.name))
            const width = Math.max(0, ...list.map((d) => d.name.length)) + 3
            return list.map((d) => `${d.name.padEnd(width)}${fmtSize(Number(d.sizeOnDisk ?? 0))}`).join('\n') || undefined
          }
          case 'collections':
          case 'tables': {
            const list = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()
            return list.map((c) => c.name).sort().join('\n') || undefined
          }
          case 'users':
            return ((await db.command({ usersInfo: 1 })).users as Document[]) ?? []
          case 'roles':
            return ((await db.command({ rolesInfo: 1, showPrivileges: false, showBuiltinRoles: true })).roles as Document[]) ?? []
          case 'profile': {
            const docs = await db.collection('system.profile').find({ millis: { $gt: 0 } }, RAW).sort({ $natural: -1 }).limit(5).toArray()
            return docs.length ? docs : `db.system.profile is empty\nUse db.setProfilingLevel(2) to enable profiling (or level 1 with slowms for slow operations only)`
          }
          default:
            throw new Error(`Don't know how to show "${cmd.what}". Try: dbs, collections, users, roles, profile`)
        }
    }
  }

  async evaluate(code: string, opts: ShellEvalOptions = {}, file = FILE): Promise<ShellExecResult> {
    this.t0 = performance.now()
    this.more = false
    this.log = cappedLogger(this.onLog, this.elapsed)
    this.current = opts
    this.batch = Math.min(SHELL_BATCH_MAX, Math.max(1, Math.round(opts.batchSize ?? SHELL_BATCH) || SHELL_BATCH))
    this.print = opts.print
    applyPrintDates(opts.print)
    const src: Source = { code, file, exactColumns: true }
    try {
      const cmd = parseCommand(code)
      let raw: unknown
      if (cmd) {
        raw = await this.command(cmd)
      } else {
        const prepared = await prepare(code, 'javascript', { hoist: true })
        src.rewrite = prepared.rewrite
        raw = await this.rt.run(prepared, file)
      }
      const shaped = shape(toPlain(raw), RESULT_LIMIT)
      if (shaped.truncatedFrom) this.log('info', `Showing the first ${RESULT_LIMIT} of ${shaped.truncatedFrom} items`)
      return { ok: true, value: shaped.value, valueKind: shaped.valueKind, ms: this.elapsed(), db: this.db, more: this.more || undefined }
    } catch (e) {
      return { ...errorResult(e, src, this.elapsed()), db: this.db }
    }
  }

  async close(): Promise<void> {
    await this.pager?.close()
  }

  /** Forgets the last cursor (a startup script's cursor must not be what `it` continues). */
  async dropCursor(): Promise<void> {
    const p = this.pager
    this.pager = undefined
    await p?.close()
  }
}
