import type { AppSettings, PlaygroundLog, ShellConfirmMode } from './api'
import { bsonTypeOf, shellText } from './bsonValue'
import { dataDateText, setDataDateDisplay } from './dateFormat'
import type { DataDateDisplay } from './dateFormat'

/**
 * Shell behaviour shared by the main process (session worker) and the renderer: limits of the shell settings,
 * which commands need a confirmation, command history, output clipping and how values are printed.
 */

// ---------------------------------------------------------------------------
// Setting limits
// ---------------------------------------------------------------------------

export const SHELL_BATCH_MIN = 1
export const SHELL_BATCH_MAX = 1000
export const SHELL_OUTPUT_LINES_MIN = 10
export const SHELL_OUTPUT_LINES_MAX = 100_000
export const SHELL_OUTPUT_CHARS_MIN = 1000
export const SHELL_OUTPUT_CHARS_MAX = 10_000_000
export const SHELL_DEPTH_MIN = 1
export const SHELL_DEPTH_MAX = 40
export const SHELL_HISTORY_MIN = 10
export const SHELL_HISTORY_MAX = 10_000
/** Longest a shell startup script may run when no shell timeout is set. */
export const SHELL_STARTUP_TIMEOUT_MS = 60_000

/** Shell keys of AppSettings. */
export type ShellSettings = Pick<
  AppSettings,
  | 'shellStartupSource'
  | 'shellStartupScript'
  | 'shellStartupFile'
  | 'playgroundRunStartup'
  | 'shellBatchSize'
  | 'shellMaxOutputLines'
  | 'shellMaxOutputChars'
  | 'shellPrintDepth'
  | 'shellNumberDisplay'
  | 'shellDateDisplay'
  | 'shellConfirm'
  | 'shellHistoryLimit'
  | 'shellHistoryDedupe'
  | 'shellHistoryScope'
  | 'shellTimeoutMS'
  | 'playgroundTimeoutMS'
  | 'mongoshPath'
>

export const SHELL_DEFAULTS: ShellSettings = {
  shellStartupSource: 'inline',
  shellStartupScript: '',
  shellStartupFile: '',
  playgroundRunStartup: false,
  shellBatchSize: 20,
  shellMaxOutputLines: 500,
  shellMaxOutputChars: 100_000,
  shellPrintDepth: 6,
  shellNumberDisplay: 'typed',
  shellDateDisplay: 'iso',
  shellConfirm: 'destructive',
  shellHistoryLimit: 1000,
  shellHistoryDedupe: true,
  shellHistoryScope: 'connection',
  shellTimeoutMS: 0,
  playgroundTimeoutMS: 0,
  mongoshPath: ''
}

/** Longest default time limit of shell commands / playground runs (24 h). */
export const SHELL_TIMEOUT_MAX = 86_400_000

function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

/** Valid shell settings from stored values: wrong types and out-of-range numbers get defaults / are clamped. */
export function normalizeShellSettings(raw: Partial<Record<keyof ShellSettings, unknown>>): ShellSettings {
  const d = SHELL_DEFAULTS
  return {
    shellStartupSource: pick(raw.shellStartupSource, ['inline', 'file'], d.shellStartupSource),
    shellStartupScript: str(raw.shellStartupScript, d.shellStartupScript),
    shellStartupFile: str(raw.shellStartupFile, d.shellStartupFile).trim(),
    playgroundRunStartup: typeof raw.playgroundRunStartup === 'boolean' ? raw.playgroundRunStartup : d.playgroundRunStartup,
    shellBatchSize: int(raw.shellBatchSize, SHELL_BATCH_MIN, SHELL_BATCH_MAX, d.shellBatchSize),
    shellMaxOutputLines: int(raw.shellMaxOutputLines, SHELL_OUTPUT_LINES_MIN, SHELL_OUTPUT_LINES_MAX, d.shellMaxOutputLines),
    shellMaxOutputChars: int(raw.shellMaxOutputChars, SHELL_OUTPUT_CHARS_MIN, SHELL_OUTPUT_CHARS_MAX, d.shellMaxOutputChars),
    shellPrintDepth: int(raw.shellPrintDepth, SHELL_DEPTH_MIN, SHELL_DEPTH_MAX, d.shellPrintDepth),
    shellNumberDisplay: pick(raw.shellNumberDisplay, ['typed', 'plain'], d.shellNumberDisplay),
    shellDateDisplay: pick(raw.shellDateDisplay, ['iso', 'data'], d.shellDateDisplay),
    shellConfirm: pick<ShellConfirmMode>(raw.shellConfirm, ['off', 'destructive', 'writes'], d.shellConfirm),
    shellHistoryLimit: int(raw.shellHistoryLimit, SHELL_HISTORY_MIN, SHELL_HISTORY_MAX, d.shellHistoryLimit),
    shellHistoryDedupe: typeof raw.shellHistoryDedupe === 'boolean' ? raw.shellHistoryDedupe : d.shellHistoryDedupe,
    shellHistoryScope: pick(raw.shellHistoryScope, ['connection', 'global'], d.shellHistoryScope),
    shellTimeoutMS: int(raw.shellTimeoutMS, 0, SHELL_TIMEOUT_MAX, d.shellTimeoutMS),
    playgroundTimeoutMS: int(raw.playgroundTimeoutMS, 0, SHELL_TIMEOUT_MAX, d.playgroundTimeoutMS),
    mongoshPath: str(raw.mongoshPath, d.mongoshPath).trim()
  }
}

/** Print options of the shell settings (the renderer adds its date display). */
export function printOptions(s: Pick<ShellSettings, 'shellPrintDepth' | 'shellNumberDisplay' | 'shellDateDisplay'>, dateDisplay?: Partial<DataDateDisplay>): ShellPrintOptions {
  return { depth: s.shellPrintDepth, numbers: s.shellNumberDisplay, dates: s.shellDateDisplay, dateDisplay }
}

// ---------------------------------------------------------------------------
// Session / evaluation contract
// ---------------------------------------------------------------------------

/** How values are printed in the shell (console output in the worker, results in the renderer). */
export interface ShellPrintOptions {
  /** Nesting levels shown expanded; deeper objects print as `[Object]` (logs) or start folded (results). */
  depth: number
  /** typed = `NumberInt('5')`, `NumberLong('7')`…; plain = `5`, `7`. */
  numbers: 'typed' | 'plain'
  /** iso = `ISODate('…')`; data = the "Dates & times" display of database dates. */
  dates: 'iso' | 'data'
  /** The renderer's date display, applied in the worker when `dates` is 'data'. */
  dateDisplay?: Partial<DataDateDisplay>
}

export const DEFAULT_PRINT: ShellPrintOptions = { depth: 6, numbers: 'typed', dates: 'iso' }

/** Per-evaluation options sent with every shell command. */
export interface ShellEvalOptions {
  /** Documents per cursor batch (`it`). */
  batchSize?: number
  /** Which commands ask for approval before they run. */
  confirm?: ShellConfirmMode
  print?: ShellPrintOptions
}

/** Outcome of one startup script run when a shell session starts. */
export interface ShellStartupReport {
  /** Where the script came from, e.g. "Settings" or `connection "Local"`. */
  label: string
  ok: boolean
  error?: string
  stack?: string
  ms: number
  logs: PlaygroundLog[]
}

export interface ShellOpenResult {
  sessionId: string
  /** Startup scripts that ran (or failed to load); absent when none are configured. */
  startup?: ShellStartupReport[]
}

/** A shell command waiting for the user's approval (main → renderer). */
export interface ShellConfirmRequest {
  /** Answer with shellConfirmReply(sessionId, id, approved). */
  id: string
  sessionId: string
  level: ShellOpLevel
  /** One line, e.g. "Drop the collection shop.orders with all its documents and indexes". */
  summary: string
  /** The call in shell syntax, e.g. `shop.orders.drop()`. */
  op: string
}

// ---------------------------------------------------------------------------
// Destructive / write command detection
// ---------------------------------------------------------------------------

/** A call on a shell `db` or collection wrapper. */
export interface ShellOp {
  target: 'collection' | 'database'
  db: string
  coll?: string
  method: string
  args: unknown[]
}

export type ShellOpLevel = 'destructive' | 'write'

export interface ShellOpClass {
  level: ShellOpLevel
  summary: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A filter that matches every document: missing, null or `{}`. */
export function isEmptyFilter(f: unknown): boolean {
  if (f === undefined || f === null) return true
  return isObj(f) && Object.keys(f).length === 0
}

const COLLECTION_WRITES: Record<string, string> = {
  insertOne: 'Insert a document into',
  insertMany: 'Insert documents into',
  insert: 'Insert into',
  updateOne: 'Update a document in',
  updateMany: 'Update documents in',
  replaceOne: 'Replace a document in',
  deleteOne: 'Delete a document from',
  deleteMany: 'Delete documents from',
  remove: 'Remove documents from',
  findOneAndUpdate: 'Update a document in',
  findOneAndReplace: 'Replace a document in',
  findOneAndDelete: 'Delete a document from',
  bulkWrite: 'Run a bulk write on',
  createIndex: 'Create an index on',
  createIndexes: 'Create indexes on',
  dropIndex: 'Drop an index of'
}

/** Server commands that remove data, collections, indexes or users wholesale. */
const DESTRUCTIVE_COMMANDS = new Set(['drop', 'dropdatabase', 'dropindexes', 'deleteindexes', 'renamecollection', 'dropallusersfromdatabase', 'dropallrolesfromdatabase', 'shutdown'])
/** Server commands that change data or configuration. */
const WRITE_COMMANDS = new Set([
  'insert',
  'update',
  'delete',
  'findandmodify',
  'create',
  'createindexes',
  'collmod',
  'converttocapped',
  'clonecollectionascapped',
  'compact',
  'createuser',
  'updateuser',
  'dropuser',
  'createrole',
  'updaterole',
  'droprole',
  'grantrolestouser',
  'revokerolesfromuser',
  'grantrolestorole',
  'revokerolesfromrole',
  'grantprivilegestorole',
  'revokeprivilegesfromrole',
  'setfeaturecompatibilityversion',
  'setparameter',
  'profile',
  'enablesharding',
  'shardcollection',
  'reshardcollection',
  'movechunk',
  'killop'
])

function commandName(cmd: unknown): string | undefined {
  if (typeof cmd === 'string') return cmd
  if (isObj(cmd)) return Object.keys(cmd)[0]
  return undefined
}

/** Whether a `delete` / `update` command touches every document of the collection. */
function wholeCollectionCommand(name: string, cmd: Record<string, unknown>): boolean {
  if (name === 'delete' && Array.isArray(cmd.deletes)) return cmd.deletes.some((d) => isObj(d) && isEmptyFilter(d.q) && Number(d.limit ?? 0) === 0)
  if (name === 'update' && Array.isArray(cmd.updates)) return cmd.updates.some((u) => isObj(u) && isEmptyFilter(u.q) && u.multi === true)
  return false
}

function classifyCommand(op: ShellOp): ShellOpClass | null {
  const cmd = op.args[0]
  const raw = commandName(cmd)
  if (!raw) return null
  const name = raw.toLowerCase()
  const where = op.method === 'adminCommand' ? 'admin' : op.db
  const target = isObj(cmd) && typeof cmd[raw] === 'string' ? ` ${cmd[raw]}` : ''
  if (DESTRUCTIVE_COMMANDS.has(name)) return { level: 'destructive', summary: `Run the "${raw}" command${target} on ${where}` }
  if (isObj(cmd) && wholeCollectionCommand(name, cmd)) {
    return { level: 'destructive', summary: `Run "${raw}" on every document of ${where}${target ? `.${String(cmd[raw])}` : ''}` }
  }
  if (WRITE_COMMANDS.has(name)) return { level: 'write', summary: `Run the "${raw}" command${target} on ${where}` }
  return null
}

function bulkTouchesAll(ops: unknown): boolean {
  if (!Array.isArray(ops)) return false
  return ops.some((o) => {
    if (!isObj(o)) return false
    const many = (o.deleteMany ?? o.updateMany) as unknown
    return isObj(many) && isEmptyFilter(many.filter)
  })
}

/**
 * Whether a call on a shell wrapper changes anything, and whether it is destructive: drops, renames, index drops
 * and deletes / updates with an empty filter. Reads (and unknown methods) give null.
 */
export function classifyShellOp(op: ShellOp): ShellOpClass | null {
  const a = op.args
  if (op.target === 'database') {
    switch (op.method) {
      case 'dropDatabase':
        return { level: 'destructive', summary: `Drop the database ${op.db} with all its collections` }
      case 'runCommand':
      case 'adminCommand':
        return classifyCommand(op)
      case 'createCollection':
        return { level: 'write', summary: `Create the collection ${op.db}.${String(a[0])}` }
      case 'createView':
        return { level: 'write', summary: `Create the view ${op.db}.${String(a[0])}` }
      case 'setProfilingLevel':
        return { level: 'write', summary: `Change the profiling level of ${op.db}` }
      default:
        return null
    }
  }
  const ns = `${op.db}.${op.coll ?? ''}`
  switch (op.method) {
    case 'drop':
      return { level: 'destructive', summary: `Drop the collection ${ns} with all its documents and indexes` }
    case 'dropIndexes':
      return { level: 'destructive', summary: a[0] === undefined || a[0] === '*' ? `Drop every index of ${ns} (except _id)` : `Drop indexes of ${ns}` }
    case 'dropIndex':
      return a[0] === '*' ? { level: 'destructive', summary: `Drop every index of ${ns} (except _id)` } : { level: 'write', summary: `Drop an index of ${ns}` }
    case 'renameCollection':
      return { level: 'destructive', summary: `Rename ${ns} to ${op.db}.${String(a[0])}${a[1] === true ? ', replacing that collection if it exists' : ''}` }
    case 'deleteMany':
      return isEmptyFilter(a[0]) ? { level: 'destructive', summary: `Delete every document in ${ns}` } : { level: 'write', summary: `Delete documents from ${ns}` }
    case 'remove': {
      const justOne = a[1] === true || (isObj(a[1]) && a[1].justOne === true)
      return isEmptyFilter(a[0]) && !justOne ? { level: 'destructive', summary: `Remove every document in ${ns}` } : { level: 'write', summary: `Remove documents from ${ns}` }
    }
    case 'updateMany':
      return isEmptyFilter(a[0]) ? { level: 'destructive', summary: `Update every document in ${ns}` } : { level: 'write', summary: `Update documents in ${ns}` }
    case 'bulkWrite':
      return bulkTouchesAll(a[0]) ? { level: 'destructive', summary: `Bulk write on ${ns} that deletes or updates every document` } : { level: 'write', summary: `Run a bulk write on ${ns}` }
    default: {
      const what = COLLECTION_WRITES[op.method]
      return what ? { level: 'write', summary: `${what} ${ns}` } : null
    }
  }
}

/** Whether a classified call has to be approved under `mode`. */
export function needsConfirm(mode: ShellConfirmMode | undefined, level: ShellOpLevel | undefined): boolean {
  if (!level || !mode || mode === 'off') return false
  return mode === 'writes' || level === 'destructive'
}

// ---------------------------------------------------------------------------
// Command history
// ---------------------------------------------------------------------------

export interface HistoryOptions {
  limit: number
  /** Skip a command identical to the previous one. */
  dedupe: boolean
}

/** The history after running `code`: appended (unless it repeats the last entry and dedupe is on), oldest dropped. */
export function pushHistory(list: readonly string[], code: string, o: HistoryOptions): string[] {
  const next = o.dedupe && list[list.length - 1] === code ? [...list] : [...list, code]
  return trimHistory(next, o.limit)
}

/** The newest `limit` entries. */
export function trimHistory(list: readonly string[], limit: number): string[] {
  const n = Math.max(0, Math.floor(limit))
  return list.length > n ? list.slice(list.length - n) : [...list]
}

/** Removes consecutive repeats (used when dedupe is switched on for an existing list). */
export function dedupeHistory(list: readonly string[]): string[] {
  return list.filter((c, i) => i === 0 || list[i - 1] !== c)
}

export const SHELL_HISTORY_PREFIX = 'shardwise.shell.history'

/** localStorage key of the shell history: one per saved connection, or one shared list. */
export function historyStorageKey(scope: 'connection' | 'global', configId: string): string {
  return scope === 'global' ? SHELL_HISTORY_PREFIX : `${SHELL_HISTORY_PREFIX}:${configId}`
}

// ---------------------------------------------------------------------------
// Output clipping
// ---------------------------------------------------------------------------

export interface ClippedOutput {
  /** Texts to show; the last one may be cut. */
  shown: string[]
  hiddenLines: number
  hiddenChars: number
}

/**
 * Keeps output within `maxLines` lines and `maxChars` characters (0 = unlimited), in order. A text that crosses
 * a limit is cut at the limit; everything after it is hidden.
 */
export function clipOutput(texts: readonly string[], maxLines: number, maxChars: number): ClippedOutput {
  const lineCap = maxLines > 0 ? maxLines : Infinity
  const charCap = maxChars > 0 ? maxChars : Infinity
  const shown: string[] = []
  let lines = 0
  let chars = 0
  let hiddenLines = 0
  let hiddenChars = 0
  let full = false
  for (const t of texts) {
    const tLines = t.split('\n').length
    if (full) {
      hiddenLines += tLines
      hiddenChars += t.length
      continue
    }
    if (lines + tLines <= lineCap && chars + t.length <= charCap) {
      shown.push(t)
      lines += tLines
      chars += t.length
      continue
    }
    // Cut this text at whichever limit comes first.
    let cut = Math.min(t.length, charCap - chars)
    const allowedLines = lineCap - lines
    let nl = -1
    for (let i = 0; i < allowedLines; i++) {
      nl = t.indexOf('\n', nl + 1)
      if (nl < 0) break
    }
    if (nl >= 0) cut = Math.min(cut, nl)
    const part = t.slice(0, Math.max(0, cut))
    if (part) shown.push(part)
    const rest = t.slice(part.length).replace(/^\n/, '')
    hiddenLines += rest ? rest.split('\n').length : 0
    hiddenChars += rest.length
    full = true
  }
  return { shown, hiddenLines, hiddenChars }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** Applies the renderer's date display in the worker (dates printed in the "Dates & times" format). */
export function applyPrintDates(print: ShellPrintOptions | undefined): void {
  if (print?.dates === 'data' && print.dateDisplay) setDataDateDisplay(print.dateDisplay)
}

const numericValue = (v: unknown): string | null => {
  if (typeof v === 'number') return String(v)
  const t = (v as { _bsontype?: string } | null)?._bsontype
  if (t === 'Int32' || t === 'Double') return String((v as { valueOf(): number }).valueOf())
  if (t === 'Long' || t === 'Decimal128') return String(v)
  return null
}

/** Text of a scalar value (number, date, ObjectId…) under the print options. */
export function leafText(v: unknown, print: ShellPrintOptions = DEFAULT_PRINT): string {
  const t = bsonTypeOf(v)
  if (print.numbers === 'plain' && (t === 'int' || t === 'long' || t === 'double' || t === 'decimal')) {
    const n = numericValue(v)
    if (n !== null) return n
  }
  if (print.dates === 'data' && t === 'date') return dataDateText(v as Date)
  try {
    return shellText(v)
  } catch {
    return String(v)
  }
}

const KEY_RE = /^[A-Za-z_$][\w$]*$/
const keyText = (k: string): string => (KEY_RE.test(k) ? k : `'${k.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)

/**
 * Shell-syntax text of a (plain) value with the print options: nested documents deeper than `depth` become
 * `[Object]` / `[Array]`, numbers and dates follow the options. Short containers stay on one line.
 */
export function printValue(v: unknown, print: ShellPrintOptions = DEFAULT_PRINT, indent = 2): string {
  const pad = (n: number): string => ' '.repeat(n * indent)
  const fmt = (x: unknown, level: number): string => {
    const t = bsonTypeOf(x)
    if (t === 'string') return level === 0 ? (x as string) : `'${(x as string).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
    if (t !== 'object' && t !== 'array') return leafText(x, print)
    const arr = t === 'array'
    const entries: [string | null, unknown][] = arr ? (x as unknown[]).map((e) => [null, e]) : Object.entries(x as Record<string, unknown>).filter(([, e]) => e !== undefined)
    if (!entries.length) return arr ? '[]' : '{}'
    if (level >= print.depth) return arr ? '[Array]' : '[Object]'
    const parts = entries.map(([k, e]) => `${k === null ? '' : `${keyText(k)}: `}${fmt(e, level + 1)}`)
    const [o, c] = arr ? ['[', ']'] : ['{', '}']
    const oneLine = `${o} ${parts.join(', ')} ${c}`
    if (oneLine.length + level * indent <= 72 && !oneLine.includes('\n')) return oneLine
    // Nested multi-line parts are already indented for their own level.
    return `${o}\n${parts.map((p) => `${pad(level + 1)}${p}`).join(',\n')}\n${pad(level)}${c}`
  }
  return fmt(v, 0)
}
