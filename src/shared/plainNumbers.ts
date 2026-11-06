import { Decimal128, Double, Int32, Long } from 'bson'
import { bsonTypeOf, isPlainDoc } from './bsonValue'

/**
 * Plain numbers in document text: `qty: 3, price: 221.21` instead of `NumberInt('3')`, `Double('221.21')`.
 * The text hides the type, so saving puts it back from the document that was edited (`restoreNumberTypes`).
 */

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

/** The JS number a numeric BSON value is shown as, or undefined when a bare number would not read back the same. */
function asPlain(v: unknown): number | undefined {
  switch (bsonTypeOf(v)) {
    case 'int':
      return typeof v === 'number' ? v : (v as Int32).valueOf()
    case 'double': {
      const n = typeof v === 'number' ? v : (v as Double).valueOf()
      // NaN, ±Infinity and -0 have no bare-number spelling.
      return Number.isFinite(n) && !Object.is(n, -0) ? n : undefined
    }
    case 'long': {
      if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : undefined
      const l = v as Long
      // Beyond 2^53 a JS number would round the value.
      return l.lessThanOrEqual(Number.MAX_SAFE_INTEGER) && l.greaterThanOrEqual(Number.MIN_SAFE_INTEGER) ? l.toNumber() : undefined
    }
    case 'decimal': {
      // Only when the decimal text survives as a number (1.50 keeps its trailing zero as NumberDecimal('1.50')).
      const s = (v as Decimal128).toString()
      const n = Number(s)
      return Number.isFinite(n) && String(n) === s ? n : undefined
    }
  }
  return undefined
}

/** Copy of a document (or array / value) with Int32, Double, Long and Decimal128 values as bare numbers where exact. */
export function plainNumbers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plainNumbers)
  if (isPlainDoc(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = plainNumbers(x)
    return out
  }
  const n = asPlain(v)
  return n === undefined ? v : n
}

const NUMERIC = new Set(['int', 'long', 'double', 'decimal'])

/** A typed number of the same BSON type as `like`, or of the nearest type that holds the value. */
function retype(n: number, like: unknown): unknown {
  switch (bsonTypeOf(like)) {
    case 'int':
      if (Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX) return new Int32(n)
      // A whole number that outgrew Int32 stays whole; a fraction becomes a Double.
      return Number.isSafeInteger(n) ? Long.fromNumber(n) : new Double(n)
    case 'long':
      return Number.isSafeInteger(n) ? Long.fromNumber(n) : new Double(n)
    case 'double':
      return new Double(n)
    case 'decimal':
      return Decimal128.fromString(String(n))
  }
  return n
}

/** The type numbers of an array share, for elements that have no counterpart at the same index (added ones). */
function arrayNumberType(a: unknown[]): unknown {
  const nums = a.filter((x) => NUMERIC.has(bsonTypeOf(x)))
  if (!nums.length) return undefined
  const t = bsonTypeOf(nums[0])
  return nums.every((x) => bsonTypeOf(x) === t) ? nums[0] : undefined
}

/**
 * Bare numbers in `next` (the edited document) take the type of the value at the same path in `original`:
 * an Int32 stays an Int32, a Double stays a Double even when it reads `5`, and so on. Numbers written with a
 * type (`NumberLong('5')`) and numbers in new fields are left as they are.
 */
export function restoreNumberTypes(next: unknown, original: unknown): unknown {
  if (typeof next === 'number') return NUMERIC.has(bsonTypeOf(original)) ? retype(next, original) : next
  if (Array.isArray(next)) {
    const orig = Array.isArray(original) ? original : []
    const common = arrayNumberType(orig)
    return next.map((x, i) => restoreNumberTypes(x, i < orig.length ? orig[i] : common))
  }
  if (isPlainDoc(next)) {
    const orig = isPlainDoc(original) ? original : {}
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(next)) out[k] = restoreNumberTypes(x, orig[k])
    return out
  }
  return next
}
