import { createHash } from 'crypto'
import { Decimal128, Double, EJSON, Int32, Long, UUID } from 'bson'
import { bsonTypeOf, isPlainDoc } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import type { MaskRule } from '@shared/maskingApi'
import { toNumber } from '@shared/schema'
import { fakeValue, seededRng } from './fake'
import type { Rng } from './fake'

const REMOVE = Symbol('remove')
type Out = unknown | typeof REMOVE

const DAY_MS = 86_400_000
const NUMERIC = new Set(['int', 'long', 'double', 'decimal'])

/** Deep copy of documents and arrays; BSON values are shared (they are not mutated). */
export function cloneDoc<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cloneDoc) as T
  if (isPlainDoc(v)) {
    const out: Doc = {}
    for (const [k, x] of Object.entries(v)) out[k] = cloneDoc(x)
    return out as T
  }
  return v
}

/** Stable text of a value for hashing: strings as they are, anything else as canonical EJSON. */
function valueKey(v: unknown): string {
  if (typeof v === 'string') return v
  return EJSON.stringify(v as never, { relaxed: false })
}

export function sha256(salt: string, text: string): Buffer {
  return createHash('sha256').update(salt).update(text).digest()
}

export const hashHex = (salt: string, v: unknown): string => sha256(salt, valueKey(v)).toString('hex')

function rngFor(r: MaskRule, salt: string, v: unknown): Rng {
  if (!r.consistent) return Math.random
  return seededRng(sha256(`${salt}|${r.kind}|${r.fake ?? ''}|`, valueKey(v)))
}

const isSeparator = (c: string): boolean => !/[\p{L}\p{N}]/u.test(c)

/** Keep the first / last N characters (separators are not counted and stay visible when `keepSeparators`). */
export function partialMask(s: string, r: Pick<MaskRule, 'partial' | 'keepStart' | 'keepEnd' | 'maskChar' | 'keepSeparators'>): string {
  const ch = r.maskChar || '*'
  if (r.partial === 'email') {
    const at = s.lastIndexOf('@')
    if (at > 0) return `${[...s.slice(0, at)].slice(0, Math.max(0, r.keepStart ?? 1)).join('')}${ch.repeat(3)}${s.slice(at)}`
  }
  const chars = [...s]
  const keepSeps = r.keepSeparators !== false
  const maskable = chars.map((c, i) => (keepSeps && isSeparator(c) ? -1 : i)).filter((i) => i >= 0)
  const start = Math.max(0, r.keepStart ?? 0)
  const end = Math.max(0, r.keepEnd ?? 0)
  // Too short to reveal anything safely: mask it all.
  const reveal = maskable.length > start + end
  const keep = new Set(reveal ? [...maskable.slice(0, start), ...maskable.slice(maskable.length - end)] : [])
  for (const i of maskable) if (!keep.has(i)) chars[i] = ch
  return chars.join('')
}

/** A number written back with the original's BSON type. */
function numberLike(orig: unknown, x: number, decimals?: number): unknown {
  const t = bsonTypeOf(orig)
  const wrapped = typeof orig === 'object'
  const whole = Math.round(x)
  if (t === 'int' && (decimals ?? 0) === 0 && Math.abs(whole) <= 0x7fffffff) return wrapped ? new Int32(whole) : whole
  if (t === 'long' && (decimals ?? 0) === 0) return typeof orig === 'bigint' ? BigInt(whole) : Long.fromNumber(whole)
  if (t === 'decimal') return Decimal128.fromString(decimals !== undefined ? x.toFixed(decimals) : String(x))
  const v = decimals !== undefined ? Number(x.toFixed(decimals)) : x
  return wrapped || t === 'int' || t === 'long' ? new Double(v) : v
}

function shiftDate(v: unknown, r: MaskRule, rng: Rng): unknown {
  const days = Math.max(0, Math.floor(r.days ?? 0))
  const offset = Math.round((rng() * 2 - 1) * days) * DAY_MS
  if (bsonTypeOf(v) === 'date') {
    const t = (v as Date).getTime()
    return isNaN(t) ? v : new Date(t + offset)
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v)
    if (isNaN(d.getTime())) return v
    const shifted = new Date(d.getTime() + offset).toISOString()
    return v.length === 10 ? shifted.slice(0, 10) : shifted
  }
  return v
}

function scalar(v: unknown, r: MaskRule, salt: string): unknown {
  if (v === null || v === undefined) return v
  const t = bsonTypeOf(v)
  switch (r.kind) {
    case 'redact':
      return r.text ?? '***'
    case 'partial': {
      if (typeof v === 'string') return partialMask(v, r)
      if (NUMERIC.has(t)) return partialMask(String(t === 'long' || t === 'decimal' ? v.toString() : toNumber(v)), r)
      return v
    }
    case 'hash':
      return hashHex(r.salt ?? salt, v)
    case 'fake': {
      const kind = r.fake ?? 'fullName'
      const s = fakeValue(kind, rngFor(r, salt, v), v)
      if (kind === 'uuid' && t === 'uuid') return new UUID(s)
      return s
    }
    case 'number': {
      if (!NUMERIC.has(t)) return v
      let lo = Number(r.min ?? 0)
      let hi = Number(r.max ?? 0)
      if (lo > hi) [lo, hi] = [hi, lo]
      const decimals = Math.max(0, Math.min(10, Math.floor(r.decimals ?? 0)))
      const x = lo + rngFor(r, salt, v)() * (hi - lo)
      return numberLike(v, decimals === 0 ? Math.round(x) : x, decimals)
    }
    case 'noise': {
      if (!NUMERIC.has(t)) return v
      const n = toNumber(v)
      const pct = Math.abs(r.percent ?? 0) / 100
      const x = n * (1 + (rngFor(r, salt, v)() * 2 - 1) * pct)
      return numberLike(v, x, t === 'int' || t === 'long' ? 0 : undefined)
    }
    case 'dateShift':
      return shiftDate(v, r, rngFor(r, salt, v))
    default:
      return v
  }
}

function transform(v: unknown, r: MaskRule, salt: string): Out {
  switch (r.kind) {
    case 'keep':
      return v
    case 'remove':
      return REMOVE
    case 'nullify':
      return null
    case 'constant':
      return cloneDoc(r.value ?? null)
    case 'hash':
    case 'redact':
      // Whole sub-documents are replaced; arrays are masked element by element.
      if (Array.isArray(v)) return v.map((e) => transform(e, r, salt))
      return scalar(v, r, salt)
    default:
      if (Array.isArray(v)) return v.map((e) => transform(e, r, salt))
      if (isPlainDoc(v) || bsonTypeOf(v) === 'binary') return v
      return scalar(v, r, salt)
  }
}

/** Apply `fn` to the value at `segs` under `container`, traversing arrays (numeric segments index into them). */
function applyAt(container: unknown, segs: string[], fn: (v: unknown) => Out): void {
  const [k, ...rest] = segs
  if (Array.isArray(container)) {
    if (/^\d+$/.test(k)) {
      const i = Number(k)
      if (i >= container.length) return
      if (rest.length) applyAt(container[i], rest, fn)
      else {
        const nv = fn(container[i])
        container[i] = nv === REMOVE ? null : nv
      }
      return
    }
    for (const el of container) applyAt(el, segs, fn)
    return
  }
  if (!isPlainDoc(container) || !Object.prototype.hasOwnProperty.call(container, k)) return
  if (rest.length) return applyAt(container[k], rest, fn)
  const nv = fn(container[k])
  if (nv === REMOVE) delete container[k]
  else container[k] = nv
}

/** Mask a document in place (rules run in order) and return it. */
export function maskDoc(doc: Doc, rules: readonly MaskRule[], salt: string): Doc {
  for (const r of rules) {
    const path = r.path.trim()
    if (r.kind === 'keep' || !path) continue
    applyAt(doc, path.split('.'), (v) => transform(v, r, salt))
  }
  return doc
}

/** Rules that would change `_id` (not allowed when masking in place). */
export const touchesId = (rules: readonly MaskRule[]): boolean => rules.some((r) => r.kind !== 'keep' && (r.path.trim() === '_id' || r.path.trim().startsWith('_id.')))

