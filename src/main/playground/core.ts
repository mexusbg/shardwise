import vm from 'vm'
import { performance } from 'perf_hooks'
import * as bson from 'bson'
import mongoose from 'mongoose'
import type { MongoClient } from 'mongodb'
import type { PlaygroundLanguage, PlaygroundLog } from '@shared/api'
import type { ShellOp } from '@shared/shellOptions'
import { RESULT_LIMIT } from './protocol'
import type { ExecResult } from './protocol'
import { codeFrame, prepare, PlaygroundSyntaxError, RESULT_FN } from './transpile'
import type { Prepared } from './transpile'
import { isDriverCursor, ShellCursor, shellDb } from './shell'
import type { ShellEnv } from './shell'
import { Models } from './models'
import { formatArgs, shape, toPlain } from './serialize'

const MAX_LOGS = 5000
const MAX_LOG_CHARS = 100_000

export interface ExecOptions {
  /** A connected client. */
  client: MongoClient
  db: string
  code: string
  language: PlaygroundLanguage
  onLog: (log: PlaygroundLog) => void
  /** Shell startup scripts run before the code (Settings → Shell & Playground → also for the playground). */
  startup?: StartupScript[]
  /** Startup scripts that could not be loaded, logged as warnings. */
  startupErrors?: string[]
}

/** A startup script and where it came from (shown in errors). */
export interface StartupScript {
  label: string
  code: string
}

type Ctor = new (...args: never[]) => unknown

/** BSON classes callable without `new`, like in mongosh (`ObjectId()`). */
function callable<T extends Ctor>(C: T, map: (args: unknown[]) => unknown[] = (a) => a): T {
  return new Proxy(C, {
    apply: (t, _this, args: unknown[]) => new (t as unknown as new (...a: unknown[]) => unknown)(...map(args)),
    construct: (t, args: unknown[]) => new (t as unknown as new (...a: unknown[]) => object)(...map(args))
  })
}

function bsonGlobals(): Record<string, unknown> {
  const { Binary, Decimal128, Int32, Long } = bson
  return {
    ObjectId: callable(bson.ObjectId),
    UUID: callable(bson.UUID),
    Long: callable(bson.Long),
    Int32: callable(bson.Int32),
    Double: callable(bson.Double),
    Decimal128: callable(bson.Decimal128),
    Binary: callable(bson.Binary),
    Code: callable(bson.Code),
    DBRef: callable(bson.DBRef),
    MinKey: callable(bson.MinKey),
    MaxKey: callable(bson.MaxKey),
    BSONRegExp: callable(bson.BSONRegExp),
    Timestamp: callable(bson.Timestamp, (a) => (typeof a[0] === 'number' && typeof a[1] === 'number' ? [{ t: a[0], i: a[1] }] : a)),
    ISODate: (s?: string | number | Date) => (s === undefined ? new Date() : new Date(s)),
    NumberLong: (v: string | number = 0) => (typeof v === 'string' ? Long.fromString(v) : Long.fromNumber(Number(v))),
    NumberInt: (v: string | number = 0) => new Int32(Number(v)),
    NumberDecimal: (v: string | number = '0') => Decimal128.fromString(String(v)),
    BinData: (sub: number, base64: string) => new Binary(Buffer.from(base64, 'base64'), sub),
    HexData: (sub: number, hex: string) => new Binary(Buffer.from(hex, 'hex'), sub),
    EJSON: bson.EJSON
  }
}

export interface Source {
  code: string
  file: string
  /** Where `return __mgResult(` was inserted (columns after it are shifted). */
  rewrite?: Prepared['rewrite']
  /** Columns match the user's code (false for TypeScript, whose types were stripped). */
  exactColumns: boolean
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Frames in the user's script only, with columns mapped back to the user's code. */
function userFrames(stack: string, src: Source): { frames: string[]; line?: number; column?: number } {
  let line: number | undefined
  let column: number | undefined
  const frames: string[] = []
  const lastLine = src.code.split('\n').length
  const fileRe = new RegExp(`${escapeRe(src.file)}:(\\d+)(?::(\\d+))?`, 'g')
  for (const l of stack.split('\n')) {
    if (!/^\s+at /.test(l) || !l.includes(src.file)) continue
    // The wrapper's closing line `})()` comes after the user's code.
    if (Number(new RegExp(fileRe.source).exec(l)?.[1]) > lastLine) continue
    frames.push(
      l.replace(/async \(?.*?\)? \(/, '(').replace(fileRe, (_m, ln: string, col?: string) => {
        let c = col ? Number(col) : undefined
        const rw = src.rewrite
        if (c !== undefined && rw && Number(ln) === rw.line && c - 1 >= rw.column + rw.length) c -= rw.length
        if (line === undefined) {
          line = Number(ln)
          column = c
        }
        return `${src.file}:${ln}${c !== undefined ? `:${c}` : ''}`
      })
    )
  }
  if (line === undefined) {
    // Compile errors have no frames but name the location in the first line.
    const m = new RegExp(fileRe.source).exec(stack)
    if (m) line = Number(m[1])
  }
  return { frames, line, column }
}

export function errorResult(e: unknown, src: Source, ms: number): ExecResult {
  if (e instanceof PlaygroundSyntaxError) return { ok: false, valueKind: 'undefined', error: `SyntaxError: ${e.message}`, stack: e.frame, ms }
  const isErr = !!e && typeof e === 'object' && 'message' in e
  const err = (isErr ? e : { name: 'Uncaught', message: typeof e === 'string' ? e : String(e) }) as Error
  const { frames, line, column } = userFrames(typeof err.stack === 'string' ? err.stack : '', src)
  const parts = [frames.join('\n'), line ? codeFrame(src.code, line, src.exactColumns && column ? column - 1 : undefined) : ''].filter(Boolean)
  return {
    ok: false,
    valueKind: 'undefined',
    error: `${err.name || 'Error'}: ${err.message}${line ? ` (line ${line})` : ''}`,
    stack: parts.join('\n\n') || undefined,
    ms
  }
}

/** Console logger capping the number and size of lines. */
export function cappedLogger(onLog: (log: PlaygroundLog) => void, elapsed: () => number): (level: PlaygroundLog['level'], text: string) => void {
  let logs = 0
  return (level, text) => {
    if (++logs > MAX_LOGS) {
      if (logs === MAX_LOGS + 1) onLog({ level: 'warn', text: `Console output truncated after ${MAX_LOGS} lines`, at: elapsed() })
      return
    }
    onLog({ level, text: text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}… (${text.length} chars)` : text, at: elapsed() })
  }
}

export interface RuntimeOptions {
  /** A connected client. */
  client: MongoClient
  db: string
  log: (level: PlaygroundLog['level'], text: string) => void
  /** Receives the value of the last expression (cursors become documents here). */
  finalValue: (v: unknown) => Promise<unknown>
  /** Approves writes of the db / collection wrappers (shell confirmations). */
  guard?: (op: ShellOp) => Promise<void>
  /** Text of console.log / print arguments (default: shell syntax). */
  format?: (args: unknown[]) => string
}

/** A vm context with the playground globals (db, client, mongoose, BSON helpers, console…). */
export interface Runtime {
  ctx: vm.Context
  sandbox: Record<string, unknown>
  mongoose: mongoose.Mongoose
  models: Models
  /** Current database (changed by use()). */
  db(): string
  use(name: string): string
  /** Defines auto-models for unknown capitalised names, then runs prepared code in the context. */
  run(prepared: Prepared, file: string): Promise<unknown>
}

export function createRuntime(o: RuntimeOptions): Runtime {
  let current = o.db
  const env: ShellEnv = { client: o.client, getDb: (n) => shellDb(env, n), guard: o.guard }
  const m = new mongoose.Mongoose()
  const models = new Models(m, o.client, () => current)
  const format = o.format ?? ((args: unknown[]) => formatArgs(args))
  const out = (level: PlaygroundLog['level']) => (...args: unknown[]) => o.log(level, format(args))
  const use = (name: string): string => {
    current = String(name)
    sandbox.db = shellDb(env, current)
    return `switched to db ${current}`
  }

  const sandbox: Record<string, unknown> = {
    ...bsonGlobals(),
    db: shellDb(env, current),
    client: o.client,
    mongoose: models.facade(),
    Schema: m.Schema,
    model: models.model.bind(models),
    use,
    print: out('log'),
    printjson: (...args: unknown[]) => o.log('log', format(args)),
    console: { log: out('log'), info: out('info'), warn: out('warn'), error: out('error'), debug: out('log'), dir: out('log'), table: out('log'), trace: out('log') },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Number(ms) || 0)),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    structuredClone,
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController
  }
  Object.defineProperty(sandbox, RESULT_FN, { value: o.finalValue })
  const ctx = vm.createContext(sandbox, { name: 'Playground', codeGeneration: { strings: true, wasm: false } })
  const global = vm.runInContext('globalThis', ctx) as Record<string, unknown>

  return {
    ctx,
    sandbox,
    mongoose: m,
    models,
    db: () => current,
    use,
    async run(prepared, file) {
      const autoNames = [...prepared.references].filter((n) => /^[A-Z]/.test(n) && !prepared.bindings.has(n) && !(n in global))
      if (autoNames.length) {
        await models.preload(o.client, [current, ...prepared.dbNames])
        for (const n of autoNames) Object.defineProperty(sandbox, n, { get: () => models.auto(n), configurable: true })
      }
      const script = new vm.Script(`(async () => {\n${prepared.js}\n})()`, { filename: file, lineOffset: -1 })
      return script.runInContext(ctx)
    }
  }
}

/** Runs playground code against `client` in a fresh vm context and shapes the result. */
export async function execute(o: ExecOptions): Promise<ExecResult> {
  const t0 = performance.now()
  const elapsed = (): number => Math.round(performance.now() - t0)
  const file = o.language === 'typescript' ? 'playground.ts' : 'playground.js'
  const log = cappedLogger(o.onLog, elapsed)

  const src: Source = { code: o.code, file, exactColumns: o.language === 'javascript' }
  let prepared: Prepared
  try {
    prepared = await prepare(o.code, o.language)
  } catch (e) {
    return errorResult(e, src, elapsed())
  }
  src.rewrite = prepared.rewrite

  let more = false
  const finalValue = async (v: unknown): Promise<unknown> => {
    if (v instanceof ShellCursor) {
      const r = await v._fetch(RESULT_LIMIT)
      more = r.more
      return r.value
    }
    if (isDriverCursor(v)) {
      const docs: unknown[] = []
      for (let d = await v.next(); d !== null; d = docs.length < RESULT_LIMIT ? await v.next() : null) docs.push(d)
      more = docs.length >= RESULT_LIMIT && (await v.hasNext())
      await v.close().catch(() => {})
      return docs
    }
    if (v instanceof rt.mongoose.Query) {
      const q = v as InstanceType<typeof rt.mongoose.Query> & { op?: string }
      if (q.op === 'find' && q.getOptions().limit == null) {
        q.limit(RESULT_LIMIT + 1)
        const docs = (await q) as unknown[]
        more = docs.length > RESULT_LIMIT
        return docs.slice(0, RESULT_LIMIT)
      }
    }
    return v
  }
  const rt = createRuntime({ client: o.client, db: o.db, log, finalValue })
  for (const e of o.startupErrors ?? []) log('warn', e)
  for (const s of o.startup ?? []) {
    try {
      // Hoisted so the script's variables and functions are visible to the playground code.
      await rt.run(await prepare(s.code, 'javascript', { hoist: true }), 'startup.js')
    } catch (e) {
      const r = errorResult(e, { code: s.code, file: 'startup.js', exactColumns: true }, elapsed())
      log('error', [`Startup script (${s.label}) failed: ${r.error}`, r.stack].filter(Boolean).join('\n'))
    }
  }

  try {
    const raw = await rt.run(prepared, file)
    const shaped = shape(toPlain(raw), RESULT_LIMIT)
    if (shaped.truncatedFrom) log('info', `Showing the first ${RESULT_LIMIT} of ${shaped.truncatedFrom} items`)
    else if (more) log('info', `Showing the first ${RESULT_LIMIT} documents; there are more (use .skip() / .limit() to page)`)
    return { ok: true, value: shaped.value, valueKind: shaped.valueKind, ms: elapsed() }
  } catch (e) {
    return errorResult(e, src, elapsed())
  }
}
