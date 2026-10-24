import { Binary, Decimal128, Double, EJSON, Int32, Long, ObjectId, UUID } from 'bson'
import { bsonTypeOf, isPlainDoc } from '@shared/bsonValue'
import type { PlannedTable, SqlConvert } from '@shared/migrationApi'
import type { Dialect, SqlValue, ValueKind } from './types'

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Letters, digits and `_` only (collection names may contain dots and spaces). */
export const sanitizeName = (s: string): string => s.replace(/[^\p{L}\p{N}_]+/gu, '_') || '_'

/** Truncates to the dialect limit and appends `_2`, `_3`… until the name is unused (case-insensitive). */
export function uniqueName(name: string, used: Set<string>, max: number): string {
  let base = name.slice(0, max)
  let n = base
  for (let i = 2; used.has(n.toLowerCase()); i++) {
    const suffix = `_${i}`
    base = name.slice(0, max - suffix.length)
    n = base + suffix
  }
  used.add(n.toLowerCase())
  return n
}

// ---------------------------------------------------------------------------
// SQL types
// ---------------------------------------------------------------------------

const OID_LIKE = /^(n?char|character|bpchar|n?varchar|character varying|varchar2)\s*\(\s*24\s*\)$/

/** What a declared SQL type holds. */
export function kindOfSqlType(type: string): ValueKind {
  const t = type.toLowerCase().trim()
  if (/^(bool|boolean|bit)$|^tinyint\s*\(\s*1\s*\)|^bit\s*\(\s*1\s*\)$/.test(t)) return 'bool'
  if (/^uuid$|uniqueidentifier/.test(t)) return 'uuid'
  if (/json/.test(t)) return 'json'
  if (/^(bigint|int8|bigserial|serial8)\b/.test(t)) return 'long'
  if (/^(numeric|decimal|money|smallmoney|number|dec)\b/.test(t)) return 'decimal'
  if (/int|serial/.test(t)) return 'int'
  if (/double|float|real/.test(t)) return 'double'
  if (/timestamp|datetime|smalldatetime|^date\b/.test(t)) return 'date'
  if (/bytea|blob|binary|image/.test(t)) return 'binary'
  if (OID_LIKE.test(t)) return 'objectId'
  return 'string'
}

export function rowsPerInsert(d: Dialect, columns: number): number {
  return Math.max(1, Math.min(d.maxRows, Math.floor(d.maxParams / Math.max(1, columns))))
}

export function insertSql(d: Dialect, qualified: string, columns: string[], rows: number): string {
  const cols = columns.map((c) => d.quote(c)).join(', ')
  const groups: string[] = []
  let p = 1
  for (let r = 0; r < rows; r++) {
    const ph: string[] = []
    for (let c = 0; c < columns.length; c++) ph.push(d.placeholder(p++))
    groups.push(`(${ph.join(', ')})`)
  }
  return `INSERT INTO ${qualified} (${cols}) VALUES ${groups.join(', ')}`
}

export function insertLiteralSql(d: Dialect, qualified: string, columns: string[], kinds: ValueKind[], rows: SqlValue[][]): string {
  const cols = columns.map((c) => d.quote(c)).join(', ')
  const values = rows.map((r) => `(${r.map((v, i) => d.literal(v, kinds[i])).join(', ')})`)
  return `INSERT INTO ${qualified} (${cols}) VALUES\n  ${values.join(',\n  ')}`
}

export function createTableSql(d: Dialect, schema: string, t: PlannedTable): string {
  const keys = new Set([...t.primaryKey, ...(t.foreignKey?.columns ?? [])])
  const collate = (name: string, type: string): string =>
    d.keyCollation && keys.has(name) && /char|text/i.test(type) && !/\bcollate\b/i.test(type) && kindOfSqlType(type) === 'string' ? ` COLLATE ${d.keyCollation}` : ''
  const lines = t.columns.map((c) => `  ${d.quote(c.name)} ${c.type}${collate(c.name, c.type)}${c.nullable ? '' : ' NOT NULL'}`)
  if (t.primaryKey.length) lines.push(`  PRIMARY KEY (${t.primaryKey.map((c) => d.quote(c)).join(', ')})`)
  if (t.foreignKey) {
    const fk = t.foreignKey
    lines.push(`  FOREIGN KEY (${fk.columns.map((c) => d.quote(c)).join(', ')}) REFERENCES ${d.qualified(schema, fk.table)} (${fk.refColumns.map((c) => d.quote(c)).join(', ')})`)
  }
  return `CREATE TABLE ${d.qualified(schema, t.name)} (\n${lines.join(',\n')}\n)${d.tableOptions ? ` ${d.tableOptions}` : ''}`
}

// ---------------------------------------------------------------------------
// Shared literal helpers
// ---------------------------------------------------------------------------

export const isoMs = (d: Date): string => d.toISOString()
/** `YYYY-MM-DD HH:MM:SS.mmm` in UTC. */
export const sqlDateTime = (d: Date): string => d.toISOString().replace('T', ' ').replace('Z', '')
export const quoteString = (s: string, backslash = false): string => `'${(backslash ? s.replace(/\\/g, '\\\\') : s).replace(/'/g, "''")}'`
export const finite = (n: number): string => (Number.isFinite(n) ? String(n) : 'NULL')

// ---------------------------------------------------------------------------
// BSON → SQL
// ---------------------------------------------------------------------------

export interface ToSqlResult {
  value: SqlValue
  /** The value had another type and was converted. */
  converted: boolean
  /** The value could not be converted and became NULL. */
  lost: boolean
}

const ok = (value: SqlValue): ToSqlResult => ({ value, converted: false, lost: false })
const conv = (value: SqlValue): ToSqlResult => (value === null ? lost() : { value, converted: true, lost: false })
const lost = (): ToSqlResult => ({ value: null, converted: false, lost: true })

const INT_RE = /^\s*[+-]?\d+\s*$/
const NUM_RE = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i

export function uuidText(b: Uint8Array): string {
  const h = Buffer.from(b).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const numOf = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  const t = (v as { _bsontype?: string } | null)?._bsontype
  if (t === 'Int32' || t === 'Double') return (v as Int32 | Double).value
  if (t === 'Long') return (v as Long).toNumber()
  if (t === 'Decimal128') return Number((v as Decimal128).toString())
  return undefined
}

/** Exact text of a numeric BSON value. */
const numText = (v: unknown): string | undefined => {
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  const t = (v as { _bsontype?: string } | null)?._bsontype
  if (t === 'Int32' || t === 'Double') return String((v as Int32 | Double).value)
  if (t === 'Long' || t === 'Decimal128') return (v as Long).toString()
  return undefined
}

/** Relaxed Extended JSON text (`{"$oid": …}` survives a round trip back to MongoDB). */
export const jsonText = (v: unknown): string => EJSON.stringify(v as never, { relaxed: true })

/** Text form of any BSON value. */
export function textOf(v: unknown): string {
  switch (bsonTypeOf(v)) {
    case 'string':
      return v as string
    case 'objectId':
      return (v as ObjectId).toHexString()
    case 'date':
      return (v as Date).toISOString()
    case 'int':
    case 'long':
    case 'double':
    case 'decimal':
      return numText(v)!
    case 'bool':
      return String(v)
    case 'uuid':
      return uuidText((v as Binary).buffer)
    case 'binary':
      return Buffer.from((v as Binary).buffer).toString('base64')
    case 'regex': {
      const r = v as { source?: string; pattern?: string; flags?: string; options?: string }
      return `/${r.source ?? r.pattern}/${r.flags ?? r.options ?? ''}`
    }
    case 'code':
      return (v as { code: string }).code
    case 'symbol':
      return String((v as { value: string }).value)
    default:
      return jsonText(v)
  }
}

function dateOf(v: unknown): Date | undefined {
  const t = bsonTypeOf(v)
  if (t === 'date') return v as Date
  if (t === 'timestamp') return new Date((v as { high: number }).high * 1000)
  if (t === 'objectId') return (v as ObjectId).getTimestamp()
  if (t === 'string') {
    const d = parseSqlDate(v as string)
    return d && !isNaN(d.getTime()) ? d : undefined
  }
  const n = numOf(v)
  return n !== undefined && Number.isFinite(n) ? new Date(n) : undefined
}

/** Converts a BSON value for a column of the given kind. */
export function toSqlValue(v: unknown, kind: ValueKind): ToSqlResult {
  if (v === null || v === undefined) return ok(null)
  const t = bsonTypeOf(v)
  if (t === 'null' || t === 'undefined' || t === 'minKey' || t === 'maxKey') return ok(null)
  switch (kind) {
    case 'json':
      return ok(jsonText(v))
    case 'string':
      return t === 'string' ? ok(v as string) : conv(textOf(v))
    case 'objectId':
      if (t === 'objectId') return ok((v as ObjectId).toHexString())
      return conv(textOf(v))
    case 'uuid':
      if (t === 'uuid' || (t === 'binary' && (v as Binary).buffer.length === 16)) return ok(uuidText((v as Binary).buffer))
      if (t === 'string' && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v as string)) return conv(uuidText(Buffer.from((v as string).replace(/-/g, ''), 'hex')))
      return lost()
    case 'int':
    case 'long': {
      let big: bigint | undefined
      if (t === 'int' || t === 'long') big = t === 'long' ? (v as Long).toBigInt?.() ?? BigInt(v as bigint) : BigInt(numOf(v)!)
      else if (t === 'double' || t === 'decimal') {
        const n = numOf(v)!
        if (Number.isFinite(n)) big = BigInt(Math.trunc(n))
      } else if (t === 'bool') big = v ? 1n : 0n
      else if (t === 'string' && INT_RE.test(v as string)) big = BigInt((v as string).trim())
      else if (t === 'string' && NUM_RE.test(v as string)) big = BigInt(Math.trunc(Number(v)))
      else if (t === 'date') big = BigInt((v as Date).getTime())
      if (big === undefined) return lost()
      const same = t === 'int' || t === 'long' || ((t === 'double' || t === 'decimal') && Number(big) === numOf(v))
      if (kind === 'int') {
        if (big > 2147483647n || big < -2147483648n) return lost()
        return same ? ok(Number(big)) : conv(Number(big))
      }
      return same ? ok(big) : conv(big)
    }
    case 'double': {
      if (t === 'int' || t === 'long' || t === 'double' || t === 'decimal') return t === 'decimal' ? conv(numOf(v)!) : ok(numOf(v)!)
      if (t === 'bool') return conv(v ? 1 : 0)
      if (t === 'string' && NUM_RE.test(v as string)) return conv(Number(v))
      return lost()
    }
    case 'decimal': {
      const s = numText(v)
      if (s !== undefined) return s === 'NaN' || /Infinity/.test(s) ? lost() : t === 'double' || t === 'decimal' || t === 'int' || t === 'long' ? ok(s) : conv(s)
      if (t === 'bool') return conv(v ? '1' : '0')
      if (t === 'string' && NUM_RE.test(v as string)) return conv((v as string).trim())
      return lost()
    }
    case 'bool': {
      if (t === 'bool') return ok(v as boolean)
      const n = numOf(v)
      if (n !== undefined) return conv(n !== 0)
      if (t === 'string') {
        const s = (v as string).trim().toLowerCase()
        if (['true', 't', 'yes', 'y', '1'].includes(s)) return conv(true)
        if (['false', 'f', 'no', 'n', '0'].includes(s)) return conv(false)
      }
      return lost()
    }
    case 'date': {
      if (t === 'date') return ok(v as Date)
      const d = dateOf(v)
      return d ? conv(d) : lost()
    }
    case 'binary': {
      if (t === 'binary' || t === 'uuid') return ok(Buffer.from((v as Binary).buffer))
      if (t === 'string') return conv(Buffer.from(v as string, 'utf8'))
      if (t === 'objectId') return conv(Buffer.from((v as ObjectId).id))
      return lost()
    }
  }
}

// ---------------------------------------------------------------------------
// SQL → BSON
// ---------------------------------------------------------------------------

export class ConversionError extends Error {}

/** Dates from SQL: `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS[.fff]`, ISO; no offset = UTC. */
export function parseSqlDate(s: string): Date | undefined {
  const t = s.trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return undefined
  let iso = t.replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += 'T00:00:00Z'
  // Postgres: `+02` offsets and up to 6 fractional digits.
  iso = iso.replace(/([+-]\d{2})$/, '$1:00').replace(/(\.\d{3})\d+/, '$1')
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? undefined : d
}

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array
const fail = (v: unknown, to: string): never => {
  throw new ConversionError(`cannot convert ${typeof v === 'string' ? JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v) : String(v)} to ${to}`)
}

/** Default conversion for a value read from a column of declared `type` (may be unknown for custom queries). */
export function autoConvert(v: unknown, type: string | undefined): Exclude<SqlConvert, 'auto'> {
  const k = type ? kindOfSqlType(type) : undefined
  if (isBytes(v)) return k === 'uuid' && v.length === 16 ? 'uuid' : k === 'bool' ? 'bool' : 'binary'
  if (v instanceof Date) return 'date'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'object') return 'json'
  switch (k) {
    case 'int': {
      const n = typeof v === 'bigint' ? v : typeof v === 'number' ? v : Number(v)
      return n <= 2147483647 && n >= -2147483648 ? 'int' : 'long'
    }
    case 'long':
    case 'double':
    case 'decimal':
    case 'bool':
    case 'date':
    case 'json':
      return k
    case 'objectId':
      return typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v) ? 'objectId' : 'string'
    case 'uuid':
    case 'binary':
    case 'string':
      return 'string'
  }
  if (typeof v === 'bigint') return v <= 2147483647n && v >= -2147483648n ? 'int' : 'long'
  if (typeof v === 'number') return Number.isInteger(v) ? (Math.abs(v) <= 2147483647 ? 'int' : 'long') : 'double'
  return 'string'
}

const BOOL_TRUE = ['true', 't', 'yes', 'y', '1', 'on']
const BOOL_FALSE = ['false', 'f', 'no', 'n', '0', 'off']

/** Converts a value read from SQL into a BSON value; throws ConversionError when impossible. */
export function toBson(v: unknown, type: string | undefined, convert: SqlConvert): unknown {
  if (v === null || v === undefined) return null
  const to = convert === 'auto' ? autoConvert(v, type) : convert
  switch (to) {
    case 'string':
      if (typeof v === 'string') return v
      if (v instanceof Date) return v.toISOString()
      if (isBytes(v)) return kindOfSqlType(type ?? '') === 'uuid' && v.length === 16 ? uuidText(v) : Buffer.from(v).toString('hex')
      if (typeof v === 'object') return JSON.stringify(v)
      return String(v)
    case 'int': {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v)
      if (!Number.isInteger(n) || n > 2147483647 || n < -2147483648) fail(v, 'Int32')
      return new Int32(n)
    }
    case 'long': {
      if (typeof v === 'bigint') return Long.fromBigInt(v)
      if (typeof v === 'number' && Number.isInteger(v)) return Long.fromNumber(v)
      if (typeof v === 'string' && INT_RE.test(v)) return Long.fromString(v.trim())
      if (typeof v === 'boolean') return Long.fromNumber(v ? 1 : 0)
      return fail(v, 'Int64')
    }
    case 'double': {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' && !NUM_RE.test(v) ? NaN : Number(v)
      if (isNaN(n)) fail(v, 'Double')
      return new Double(n)
    }
    case 'decimal': {
      const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v).trim()
      if (!NUM_RE.test(s)) fail(v, 'Decimal128')
      return Decimal128.fromString(s)
    }
    case 'bool': {
      if (typeof v === 'boolean') return v
      if (typeof v === 'number' || typeof v === 'bigint') return Number(v) !== 0
      if (isBytes(v)) return v.some((b) => b !== 0)
      const s = String(v).trim().toLowerCase()
      if (BOOL_TRUE.includes(s)) return true
      if (BOOL_FALSE.includes(s)) return false
      return fail(v, 'Boolean')
    }
    case 'date': {
      if (v instanceof Date) return isNaN(v.getTime()) ? fail(v, 'Date') : v
      if (typeof v === 'number' || typeof v === 'bigint') return new Date(Number(v))
      const d = parseSqlDate(String(v))
      return d ?? fail(v, 'Date')
    }
    case 'binary':
      if (isBytes(v)) return new Binary(Buffer.from(v))
      return new Binary(Buffer.from(String(v), 'utf8'))
    case 'uuid': {
      if (isBytes(v) && v.length === 16) return new Binary(Buffer.from(v), Binary.SUBTYPE_UUID)
      const s = String(v).trim()
      if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) fail(v, 'UUID')
      return new UUID(s.replace(/-/g, '')).toBinary()
    }
    case 'objectId': {
      if (isBytes(v) && v.length === 12) return new ObjectId(Buffer.from(v))
      const s = String(v).trim()
      if (!/^[0-9a-f]{24}$/i.test(s)) fail(v, 'ObjectId')
      return new ObjectId(s)
    }
    case 'json': {
      if (typeof v === 'object' && !isBytes(v) && !(v instanceof Date)) return EJSON.deserialize(v as never, { relaxed: true })
      try {
        return EJSON.parse(isBytes(v) ? Buffer.from(v).toString('utf8') : String(v), { relaxed: true })
      } catch {
        return fail(v, 'a JSON document')
      }
    }
  }
}

/** Sets `a.b.c` on a document, creating sub-documents. */
export function setPath(doc: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split('.')
  let cur = doc
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (!isPlainDoc(cur[k])) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = v
}
