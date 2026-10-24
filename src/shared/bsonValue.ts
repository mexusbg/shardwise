import { dataDateEditText, dataDateText, parseDateInZone } from './dateFormat'
import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID
} from 'bson'
import { parseFilter, toJSString } from 'mongodb-query-parser'

/** Value types the user can pick when entering or converting a value. */
export const EDITABLE_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
  'null',
  'regex',
  'array',
  'object'
] as const
export type EditableType = (typeof EDITABLE_TYPES)[number]

/** Every BSON type we can recognise in a document. */
export type BsonTypeName =
  | EditableType
  | 'binary'
  | 'uuid'
  | 'timestamp'
  | 'code'
  | 'symbol'
  | 'dbref'
  | 'minKey'
  | 'maxKey'
  | 'undefined'

export const TYPE_LABELS: Record<BsonTypeName, string> = {
  string: 'String',
  int: 'Int32',
  long: 'Int64',
  double: 'Double',
  decimal: 'Decimal128',
  bool: 'Boolean',
  date: 'Date',
  objectId: 'ObjectId',
  null: 'Null',
  regex: 'Regex',
  array: 'Array',
  object: 'Object',
  binary: 'Binary',
  uuid: 'UUID',
  timestamp: 'Timestamp',
  code: 'Code',
  symbol: 'Symbol',
  dbref: 'DBRef',
  minKey: 'MinKey',
  maxKey: 'MaxKey',
  undefined: 'Undefined'
}

/** `$type` aliases accepted by MongoDB, used by the has-type operator. */
export const MONGO_TYPE_ALIASES = [
  'double',
  'string',
  'object',
  'array',
  'binData',
  'objectId',
  'bool',
  'date',
  'null',
  'regex',
  'javascript',
  'int',
  'timestamp',
  'long',
  'decimal',
  'minKey',
  'maxKey',
  'number'
]

export class ValueParseError extends Error {}

/** ISO date-times without an offset are UTC, like ISODate() in mongosh (JS would use local time). */
export function parseUtcDate(s: string): Date {
  const t = s.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2')
  return new Date(/T\d{2}:\d{2}/.test(t) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(t) ? `${t}Z` : t)
}

export function bsonTypeOf(v: unknown): BsonTypeName {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= 0x7fffffff ? 'int' : 'double'
  if (typeof v === 'bigint') return 'long'
  if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') return 'date'
  if (v instanceof RegExp || Object.prototype.toString.call(v) === '[object RegExp]') return 'regex'
  if (Array.isArray(v)) return 'array'
  const t = (v as { _bsontype?: string })._bsontype
  switch (t) {
    case 'ObjectId':
      return 'objectId'
    case 'Int32':
      return 'int'
    case 'Long':
      return 'long'
    case 'Double':
      return 'double'
    case 'Decimal128':
      return 'decimal'
    case 'BSONRegExp':
      return 'regex'
    case 'Binary':
      return (v as Binary).sub_type === Binary.SUBTYPE_UUID ? 'uuid' : 'binary'
    case 'Timestamp':
      return 'timestamp'
    case 'Code':
      return 'code'
    case 'BSONSymbol':
      return 'symbol'
    case 'DBRef':
      return 'dbref'
    case 'MinKey':
      return 'minKey'
    case 'MaxKey':
      return 'maxKey'
  }
  return 'object'
}

/** True for a plain document (not an array, Date, RegExp or BSON wrapper). */
export function isPlainDoc(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && bsonTypeOf(v) === 'object'
}

const numberText = (v: unknown): string => {
  if (typeof v === 'number') return String(v)
  const t = (v as { _bsontype?: string } | null)?._bsontype
  if (t === 'Double' || t === 'Int32') return String((v as Double).valueOf())
  return String(v)
}

/** Shell-syntax text of any value, e.g. `ObjectId('…')`. */
export function shellText(v: unknown, indent: number | string = 0): string {
  if (v === undefined) return 'undefined'
  return toJSString(v as object, indent) ?? String(v)
}

/** Text the user sees in an editor for a value of an editable type (inverse of parseTyped). */
export function editText(v: unknown): string {
  const t = bsonTypeOf(v)
  switch (t) {
    case 'string':
      return v as string
    case 'int':
    case 'double':
      return numberText(v)
    case 'long':
    case 'decimal':
      return String(v)
    case 'bool':
      return v ? 'true' : 'false'
    case 'date':
      return dataDateEditText(v as Date)
    case 'objectId':
      return (v as ObjectId).toHexString()
    case 'null':
      return ''
    case 'regex': {
      if (v instanceof RegExp || Object.prototype.toString.call(v) === '[object RegExp]') {
        const r = v as RegExp
        return `/${r.source}/${r.flags}`
      }
      const r = v as BSONRegExp
      return `/${r.pattern}/${r.options}`
    }
    default:
      return shellText(v, 2)
  }
}

/** Compact one-line text for table cells. */
export function cellText(v: unknown): string {
  const t = bsonTypeOf(v)
  switch (t) {
    case 'string':
      return v as string
    case 'object':
      return `{ ${Object.keys(v as object).length} fields }`
    case 'array':
      return `[ ${(v as unknown[]).length} elements ]`
    case 'date':
      return dataDateText(v as Date)
    case 'objectId':
      return (v as ObjectId).toHexString()
    case 'null':
      return 'null'
    case 'undefined':
      return 'undefined'
    case 'double': {
      const n = Number((v as Double).valueOf())
      return Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(1) : String(n)
    }
    case 'binary': {
      const b = v as Binary
      return `Binary(${b.sub_type}) ${b.length()} bytes`
    }
    case 'uuid':
      return (v as Binary).toUUID().toHexString()
    case 'dbref': {
      const r = v as DBRef
      return `DBRef(${r.collection}, ${shellText(r.oid)})`
    }
    default:
      return editText(v)
  }
}

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

function parseRegexText(text: string): BSONRegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(text.trim())
  if (m) return new BSONRegExp(m[1], m[2])
  return new BSONRegExp(text, '')
}

/** Parse editor text as a value of the given type. Throws ValueParseError on bad input. */
export function parseTyped(text: string, type: EditableType): unknown {
  const s = text.trim()
  switch (type) {
    case 'string':
      return text
    case 'int': {
      if (!/^[-+]?\d+$/.test(s)) throw new ValueParseError(`'${text}' is not a valid Int32`)
      const n = Number(s)
      if (n < INT32_MIN || n > INT32_MAX) throw new ValueParseError(`'${text}' is out of Int32 range`)
      return new Int32(n)
    }
    case 'long':
      if (!/^[-+]?\d+$/.test(s)) throw new ValueParseError(`'${text}' is not a valid Int64`)
      return Long.fromString(s.replace(/^\+/, ''))
    case 'double': {
      const n = Number(s)
      if (s === '' || Number.isNaN(n)) {
        if (/^nan$/i.test(s)) return new Double(NaN)
        throw new ValueParseError(`'${text}' is not a valid Double`)
      }
      return new Double(n)
    }
    case 'decimal':
      try {
        return Decimal128.fromString(s)
      } catch {
        throw new ValueParseError(`'${text}' is not a valid Decimal128`)
      }
    case 'bool':
      if (/^(true|1|yes)$/i.test(s)) return true
      if (/^(false|0|no)$/i.test(s)) return false
      throw new ValueParseError(`'${text}' is not a valid Boolean`)
    case 'date': {
      const d = parseDateInZone(s)
      if (s === '' || isNaN(d.getTime())) throw new ValueParseError(`'${text}' is not a valid Date`)
      return d
    }
    case 'objectId': {
      const m = /^(?:ObjectId\(\s*)?["']?([0-9a-fA-F]{24})["']?(?:\s*\))?$/.exec(s)
      if (!m) throw new ValueParseError(`'${text}' is not a valid ObjectId`)
      return new ObjectId(m[1])
    }
    case 'null':
      return null
    case 'regex':
      return parseRegexText(text)
    case 'array':
    case 'object': {
      let v: unknown
      try {
        v = parseShellValue(s)
      } catch (e) {
        throw new ValueParseError((e as Error).message)
      }
      if (type === 'array' && !Array.isArray(v)) throw new ValueParseError('Value is not an array')
      if (type === 'object' && !isPlainDoc(v)) throw new ValueParseError('Value is not an object')
      return v
    }
  }
}

/** Parse any shell-syntax expression (object, array or scalar). */
export function parseShellValue(text: string): unknown {
  const wrapped = parseFilter(`{"v": ${text}}`) as { v: unknown }
  return wrapped.v
}

/** Convert a value to another type, keeping as much meaning as possible. */
export function convertValue(v: unknown, to: EditableType): unknown {
  if (to === 'null') return null
  const from = bsonTypeOf(v)
  if (from === to) return v
  if (to === 'string') return from === 'object' || from === 'array' ? shellText(v) : editText(v)
  if (to === 'date' && from === 'objectId') return (v as ObjectId).getTimestamp()
  if (to === 'array') return [v]
  return parseTyped(editText(v), to)
}

/** Default value for a newly chosen type. */
export function defaultValue(type: EditableType): unknown {
  switch (type) {
    case 'string':
      return ''
    case 'int':
      return new Int32(0)
    case 'long':
      return Long.fromNumber(0)
    case 'double':
      return new Double(0)
    case 'decimal':
      return Decimal128.fromString('0')
    case 'bool':
      return false
    case 'date':
      return new Date()
    case 'objectId':
      return new ObjectId()
    case 'null':
      return null
    case 'regex':
      return new BSONRegExp('', '')
    case 'array':
      return []
    case 'object':
      return {}
  }
}

export function isEditableType(t: BsonTypeName): t is EditableType {
  return (EDITABLE_TYPES as readonly string[]).includes(t)
}

// Re-exported so renderer code imports BSON classes from one place.
export {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID
}
