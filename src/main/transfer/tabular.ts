import { Double, EJSON, Int32, ObjectId } from 'bson'
import type { Decimal128, Long } from 'bson'
import type { CsvColumnType, Doc } from '@shared/api'

/*
 * Value mapping between documents and flat rows (CSV / Excel). Pure functions, unit-testable.
 */

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
/** Excel's maximum cell text length. */
export const XLSX_MAX_TEXT = 32767

const bsonType = (v: unknown): string | undefined =>
  v !== null && typeof v === 'object' ? (v as { _bsontype?: string })._bsontype : undefined
const isDate = (v: unknown): v is Date => v instanceof Date || Object.prototype.toString.call(v) === '[object Date]'

/** Compact relaxed EJSON text, used for objects, arrays and exotic types in a single cell. */
export function compactJson(v: unknown): string {
  return EJSON.stringify(v as never, { relaxed: true })
}

/** Text of a value in a CSV cell. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  switch (typeof v) {
    case 'string':
      return v
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number':
      return String(v)
    case 'bigint':
      return v.toString()
  }
  if (isDate(v)) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  switch (bsonType(v)) {
    case 'ObjectId':
      return (v as ObjectId).toHexString()
    case 'Int32':
    case 'Double':
      return String((v as Double).valueOf())
    case 'Long':
    case 'Decimal128':
      return (v as Long | Decimal128).toString()
  }
  return compactJson(v)
}

/** Value written to an Excel cell: real numbers, booleans and dates where possible. */
export function xlsxCell(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'string':
      return v.length > XLSX_MAX_TEXT ? v.slice(0, XLSX_MAX_TEXT) : v
    case 'boolean':
      return v
    case 'number':
      return Number.isFinite(v) ? v : String(v)
    case 'bigint':
      return safeNumber(v.toString())
  }
  if (isDate(v)) return Number.isNaN(v.getTime()) ? null : v
  switch (bsonType(v)) {
    case 'ObjectId':
      return (v as ObjectId).toHexString()
    case 'Int32':
    case 'Double': {
      const n = (v as Double).valueOf()
      return Number.isFinite(n) ? n : String(n)
    }
    case 'Long':
    case 'Decimal128':
      return safeNumber((v as Long | Decimal128).toString())
  }
  const s = compactJson(v)
  return s.length > XLSX_MAX_TEXT ? s.slice(0, XLSX_MAX_TEXT) : s
}

/** Number when it converts without precision loss, else the original text. */
function safeNumber(s: string): number | string {
  const n = Number(s)
  if (!Number.isFinite(n) || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return s
  if (Number.isInteger(n) && Math.abs(n) > Number.MAX_SAFE_INTEGER) return s
  const digits = s.replace(/[eE].*$/, '').replace(/[-+.]/g, '').replace(/^0+/, '')
  return digits.length <= 15 ? n : s
}

export class CellError extends Error {}

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const INTEGER = /^[-+]?\d+$/
const LEADING_ZERO = /^[-+]?0\d/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** Int32 for an int32-range integer, else Double. */
export function toNumber(n: number): Int32 | Double {
  return Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX && !Object.is(n, -0) ? new Int32(n) : new Double(n)
}

function parseNumber(s: string): Int32 | Double {
  const t = s.trim()
  if (!NUMERIC.test(t)) throw new CellError(`'${s}' is not a number`)
  return toNumber(Number(t))
}

function parseBool(s: string): boolean {
  const t = s.trim().toLowerCase()
  if (t === 'true' || t === '1' || t === 'yes') return true
  if (t === 'false' || t === '0' || t === 'no') return false
  throw new CellError(`'${s}' is not a boolean`)
}

function parseDate(s: string): Date {
  const t = s.trim()
  const d = /^-?\d+$/.test(t) ? new Date(Number(t)) : new Date(t)
  if (Number.isNaN(d.getTime())) throw new CellError(`'${s}' is not a date`)
  return d
}

function parseObjectId(s: string): ObjectId {
  const t = s.trim()
  if (!/^[0-9a-fA-F]{24}$/.test(t)) throw new CellError(`'${s}' is not an ObjectId`)
  return new ObjectId(t)
}

/** JSON object / array text (as written by our exporters) back to a value; undefined when it isn't one. */
function maybeJson(s: string): unknown {
  const t = s.trim()
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return undefined
  try {
    return EJSON.parse(t, { relaxed: false })
  } catch {
    return undefined
  }
}

/** Auto-detected value of a text cell: number, boolean, ISO date, JSON object/array, else the string. */
export function autoValue(s: string): unknown {
  const t = s.trim()
  if (NUMERIC.test(t) && !(INTEGER.test(t) && LEADING_ZERO.test(t))) return toNumber(Number(t))
  if (t === 'true') return true
  if (t === 'false') return false
  if (ISO_DATE.test(t)) {
    const d = new Date(t)
    if (!Number.isNaN(d.getTime())) return d
  }
  const j = maybeJson(t)
  return j === undefined ? s : j
}

/** Sentinel: leave the field out of the document. */
export const OMIT = Symbol('omit')

/** Convert CSV text to a typed value. Empty text omits the field (except for `string`). */
export function convertText(s: string, type: CsvColumnType): unknown {
  if (type === 'skip') return OMIT
  if (s === '') return type === 'string' ? '' : OMIT
  switch (type) {
    case 'string':
      return s
    case 'number':
      return parseNumber(s)
    case 'bool':
      return parseBool(s)
    case 'date':
      return parseDate(s)
    case 'objectId':
      return parseObjectId(s)
    case 'auto':
      return autoValue(s)
  }
}

/** A raw Excel cell value as returned by exceljs (rich text, formulas, hyperlinks unwrapped). */
export function plainCell(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || isDate(v)) return v as string | number | boolean | Date
  const o = v as { richText?: { text: string }[]; result?: unknown; text?: unknown; error?: unknown; formula?: unknown; sharedFormula?: unknown }
  if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('')
  if ('formula' in o || 'sharedFormula' in o) return plainCell(o.result)
  if ('error' in o) return null
  if ('text' in o) return plainCell(o.text)
  return String(v)
}

/** Convert an Excel cell (already unwrapped by `plainCell`) to a typed value; cell types are honoured. */
export function convertCell(v: string | number | boolean | Date | null, type: CsvColumnType): unknown {
  if (type === 'skip') return OMIT
  if (v === null || v === '') return type === 'string' && v === '' ? '' : OMIT
  if (typeof v === 'string') {
    if (type === 'auto') {
      const j = maybeJson(v)
      return j === undefined ? v : j
    }
    return convertText(v, type)
  }
  const text = isDate(v) ? v.toISOString() : String(v)
  switch (type) {
    case 'auto':
      return typeof v === 'number' ? toNumber(v) : v
    case 'string':
      return text
    case 'number':
      if (typeof v === 'number') return toNumber(v)
      if (typeof v === 'boolean') return new Int32(v ? 1 : 0)
      return new Double((v as Date).getTime())
    case 'bool':
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      throw new CellError(`'${text}' is not a boolean`)
    case 'date':
      if (isDate(v)) return v
      if (typeof v === 'number') return new Date(v)
      throw new CellError(`'${text}' is not a date`)
    case 'objectId':
      return parseObjectId(text)
  }
}

/** Mutable dot-path set that creates intermediate objects. */
export function setDeep(doc: Doc, path: string, value: unknown): void {
  const segs = path.split('.')
  let cur: Doc = doc
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur[segs[i]]
    if (next === null || typeof next !== 'object' || Array.isArray(next) || bsonType(next) || isDate(next)) {
      const o: Doc = {}
      cur[segs[i]] = o
      cur = o
    } else cur = next as Doc
  }
  cur[segs[segs.length - 1]] = value
}

/** Build a document from a row given header names and per-column conversion. */
export function rowToDoc<T>(
  headers: string[],
  cells: T[],
  convert: (cell: T, header: string) => unknown
): Doc {
  const doc: Doc = {}
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (!h) continue
    let v: unknown
    try {
      v = convert(cells[i], h)
    } catch (e) {
      throw new CellError(`column '${h}': ${(e as Error).message}`)
    }
    if (v !== OMIT) setDeep(doc, h, v)
  }
  return doc
}

/** Make an Excel-legal sheet name (max 31 chars, no []:*?/\). */
export function sheetName(name: string): string {
  const s = name.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').slice(0, 31)
  return s || 'Sheet1'
}

/** Normalise a delimiter option (`\t`, `tab`). */
export function normDelimiter(d: string | undefined): string {
  if (!d) return ','
  if (d === '\\t' || d.toLowerCase() === 'tab') return '\t'
  return d
}
