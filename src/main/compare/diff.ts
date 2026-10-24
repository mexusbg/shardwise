import { EJSON, serialize } from 'bson'
import type { Binary, BSONRegExp, BSONSymbol, Code, Decimal128, Double, Int32, Long, ObjectId, Timestamp } from 'bson'
import { isPlainDoc } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import type { CompareRequest, FieldDiff } from '@shared/compareApi'

/*
 * Pure helpers of Diff & Sync.
 *
 * Key ordering: both sides are read with `sort({ key: 1 })` and `collation: { locale: 'simple' }`, so the
 * server orders keys by MongoDB's BSON comparison order. `compareBson` reproduces that order: values are
 * ranked by canonical type (MinKey < undefined < null < numbers < strings/symbols < objects < arrays <
 * binary < ObjectId < bool < date < timestamp < regex < code < MaxKey); numbers of any type compare by
 * numeric value (Int32 1 == Double 1.0 == Long 1, Long beyond 2^53 exactly via BigInt, Decimal128 via its
 * double value); strings by UTF-8 bytes (simple collation); binaries by length, subtype, then bytes;
 * objects element by element (type, field name, value). The merge-join also checks every key against the
 * previous one on the same side, so an order that disagrees with the server's (or a duplicate key) stops
 * the comparison with an error instead of producing wrong results. Array keys are rejected.
 */

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const bsonType = (v: unknown): string | undefined => (v as { _bsontype?: string } | null)?._bsontype

export function typeRank(v: unknown): number {
  if (v === undefined) return 0
  if (v === null) return 5
  switch (typeof v) {
    case 'number':
    case 'bigint':
      return 10
    case 'string':
      return 15
    case 'boolean':
      return 40
  }
  if (v instanceof Date) return 45
  if (v instanceof RegExp) return 50
  if (Array.isArray(v)) return 25
  switch (bsonType(v)) {
    case 'MinKey':
      return -1
    case 'MaxKey':
      return 127
    case 'Int32':
    case 'Double':
    case 'Long':
    case 'Decimal128':
      return 10
    case 'BSONSymbol':
      return 15
    case 'Binary':
      return 30
    case 'ObjectId':
      return 35
    case 'Timestamp':
      return 47
    case 'BSONRegExp':
      return 50
    case 'Code':
      return (v as Code).scope ? 65 : 60
  }
  return 20
}

/** Numeric value: bigint when exact (integers, Long), number otherwise. */
function numeric(v: unknown): number | bigint {
  if (typeof v === 'number' || typeof v === 'bigint') return v
  switch (bsonType(v)) {
    case 'Int32':
    case 'Double':
      return (v as Int32 | Double).valueOf() as number
    case 'Long':
      return BigInt((v as Long).toString())
    case 'Decimal128':
      return Number((v as Decimal128).toString())
  }
  return NaN
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0)

function cmpNumbers(a: unknown, b: unknown): number {
  const x = numeric(a)
  const y = numeric(b)
  if (typeof x === 'bigint' && typeof y === 'bigint') return x < y ? -1 : x > y ? 1 : 0
  if (typeof x === 'number' && typeof y === 'number') {
    // NaN sorts before every other number and equals itself.
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : -1) : 1
    return x < y ? -1 : x > y ? 1 : 0
  }
  const flip = typeof x === 'number'
  const big = (flip ? y : x) as bigint
  const n = (flip ? x : y) as number
  let r: number
  if (Number.isNaN(n)) r = 1
  else if (!Number.isFinite(n)) r = n > 0 ? -1 : 1
  else if (Number.isInteger(n)) {
    const bn = BigInt(n)
    r = big < bn ? -1 : big > bn ? 1 : 0
  } else r = big <= BigInt(Math.floor(n)) ? -1 : 1
  return flip ? -r : r
}

const cmpBytes = (a: Uint8Array, b: Uint8Array): number => sign(Buffer.compare(a, b))
const cmpStrings = (a: string, b: string): number => (a === b ? 0 : cmpBytes(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))

function entries(v: unknown): [string, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x])
  if (bsonType(v) === 'DBRef') return Object.entries((v as { toJSON(): Doc }).toJSON())
  return Object.entries(v as Doc)
}

function cmpObjects(a: unknown, b: unknown): number {
  const ea = entries(a)
  const eb = entries(b)
  const n = Math.min(ea.length, eb.length)
  for (let i = 0; i < n; i++) {
    const r = sign(typeRank(ea[i][1]) - typeRank(eb[i][1])) || cmpStrings(ea[i][0], eb[i][0]) || compareBson(ea[i][1], eb[i][1])
    if (r) return r
  }
  return sign(ea.length - eb.length)
}

const regexParts = (v: unknown): [string, string] =>
  v instanceof RegExp ? [v.source, v.flags] : [(v as BSONRegExp).pattern, (v as BSONRegExp).options]

/** MongoDB BSON sort order (simple collation). */
export function compareBson(a: unknown, b: unknown): number {
  const ra = typeRank(a)
  const rb = typeRank(b)
  if (ra !== rb) return sign(ra - rb)
  switch (ra) {
    case -1:
    case 0:
    case 5:
    case 127:
      return 0
    case 10:
      return cmpNumbers(a, b)
    case 15: {
      const s = (v: unknown): string => (typeof v === 'string' ? v : (v as BSONSymbol).value)
      return cmpStrings(s(a), s(b))
    }
    case 20:
    case 25:
      return cmpObjects(a, b)
    case 30: {
      const x = a as Binary
      const y = b as Binary
      return sign(x.length() - y.length()) || sign(x.sub_type - y.sub_type) || cmpBytes(x.value(), y.value())
    }
    case 35:
      return cmpStrings((a as ObjectId).toHexString(), (b as ObjectId).toHexString())
    case 40:
      return sign(Number(a) - Number(b))
    case 45:
      return sign((a as Date).getTime() - (b as Date).getTime())
    case 47: {
      const x = a as Timestamp
      const y = b as Timestamp
      return sign(x.t - y.t) || sign(x.i - y.i)
    }
    case 50: {
      const [pa, fa] = regexParts(a)
      const [pb, fb] = regexParts(b)
      return cmpStrings(pa, pb) || cmpStrings(fa, fb)
    }
    case 60:
    case 65:
      return cmpStrings((a as Code).code, (b as Code).code)
  }
  return 0
}

/** Lookup id of a key value: equal keys (by `compareBson`) of the common types give the same id. */
export function keyId(v: unknown): string {
  if (typeRank(v) === 10) {
    const n = numeric(v)
    if (typeof n === 'bigint') return `n:${n}`
    if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return `n:${n}`
    return `n:${Object.is(n, -0) ? 0 : n}`
  }
  if (typeof v === 'string' || bsonType(v) === 'BSONSymbol') return `s:${typeof v === 'string' ? v : (v as BSONSymbol).value}`
  if (v === undefined || v === null) return 'null'
  return EJSON.stringify({ v } as Doc, { relaxed: false })
}

export const splitPath = (p: string): string[] => p.split('.')

/** Value at path segments; numeric segments index arrays. `undefined` when missing. */
export function getSegs(doc: unknown, segs: string[]): unknown {
  let cur = doc
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object') return undefined
    if (Array.isArray(cur)) cur = /^\d+$/.test(s) ? cur[Number(s)] : undefined
    else if (isPlainDoc(cur) && has(cur, s)) cur = cur[s]
    else return undefined
  }
  return cur
}

/** Key value of a document; a missing key reads as null (like the server's sort). */
export function keyOf(doc: Doc, key: string): unknown {
  const v = getSegs(doc, splitPath(key))
  return v === undefined ? null : v
}

// ---------------------------------------------------------------------------
// Field selection
// ---------------------------------------------------------------------------

type Tree = Map<string, Tree | true>
const MISSING = Symbol('missing')

function buildTree(paths: string[]): Tree {
  const root: Tree = new Map()
  for (const p of paths) {
    const segs = splitPath(p.trim()).filter(Boolean)
    if (!segs.length) continue
    let node = root
    segs.forEach((s, i) => {
      if (i === segs.length - 1) node.set(s, true)
      else {
        const cur = node.get(s)
        if (cur === true) return
        if (!cur) node.set(s, new Map())
        node = node.get(s) as Tree
      }
    })
  }
  return root
}

function pick(v: unknown, tree: Tree): unknown {
  if (Array.isArray(v)) return v.filter((e) => isPlainDoc(e)).map((e) => pick(e, tree))
  if (!isPlainDoc(v)) return MISSING
  const out: Doc = {}
  for (const [k, sub] of tree) {
    if (!has(v, k)) continue
    if (sub === true) out[k] = v[k]
    else {
      const r = pick(v[k], sub)
      if (r !== MISSING) out[k] = r
    }
  }
  return out
}

function omit(v: unknown, segs: string[]): unknown {
  if (Array.isArray(v)) return v.map((e) => (isPlainDoc(e) ? omit(e, segs) : e))
  if (!isPlainDoc(v) || !has(v, segs[0])) return v
  const copy: Doc = { ...v }
  if (segs.length === 1) delete copy[segs[0]]
  else copy[segs[0]] = omit(copy[segs[0]], segs.slice(1))
  return copy
}

/** The part of a document that is compared: field subset (include / exclude) minus ignored paths. */
export function projectDoc(doc: Doc, fields: CompareRequest['fields'], ignore: string[]): Doc {
  let out: unknown = doc
  const include = fields.mode === 'include' ? fields.paths.filter((p) => p.trim()) : []
  if (include.length) out = pick(out, buildTree(include))
  const exclude = [...ignore, ...(fields.mode === 'exclude' ? fields.paths : [])].map((p) => p.trim()).filter(Boolean)
  for (const p of exclude) out = omit(out, splitPath(p))
  return out as Doc
}

// ---------------------------------------------------------------------------
// Document diff
// ---------------------------------------------------------------------------

export interface RawDiff {
  segs: string[]
  kind: FieldDiff['kind']
  source?: unknown
  target?: unknown
}

export const canonical = (v: unknown): string => EJSON.stringify({ v } as Doc, { relaxed: false })

type Shape = 'doc' | 'array' | 'leaf'
const shape = (v: unknown): Shape => (Array.isArray(v) ? 'array' : isPlainDoc(v) ? 'doc' : 'leaf')

function sameBytes(a: Doc, b: Doc): boolean {
  try {
    return Buffer.from(serialize(a)).equals(Buffer.from(serialize(b)))
  } catch {
    return false
  }
}

/**
 * Field-level diff from `a` (source) to `b` (target): objects by field name (field order is ignored),
 * arrays element by element, leaves by canonical EJSON (so the BSON type matters). At most `max` diffs are
 * returned; `total` counts all of them.
 */
export function diffDocs(a: Doc, b: Doc, max = Infinity): { diffs: RawDiff[]; total: number } {
  const diffs: RawDiff[] = []
  let total = 0
  if (sameBytes(a, b)) return { diffs, total }
  const push = (d: RawDiff): void => {
    total++
    if (diffs.length < max) diffs.push(d)
  }
  const walk = (x: unknown, y: unknown, segs: string[]): void => {
    const sx = shape(x)
    const sy = shape(y)
    if (sx === 'doc' && sy === 'doc') {
      const dx = x as Doc
      const dy = y as Doc
      for (const k of Object.keys(dx)) {
        if (has(dy, k)) walk(dx[k], dy[k], [...segs, k])
        else push({ segs: [...segs, k], kind: 'removed', source: dx[k] })
      }
      for (const k of Object.keys(dy)) if (!has(dx, k)) push({ segs: [...segs, k], kind: 'added', target: dy[k] })
    } else if (sx === 'array' && sy === 'array') {
      const ax = x as unknown[]
      const ay = y as unknown[]
      for (let i = 0; i < Math.max(ax.length, ay.length); i++) {
        const s = [...segs, String(i)]
        if (i >= ay.length) push({ segs: s, kind: 'removed', source: ax[i] })
        else if (i >= ax.length) push({ segs: s, kind: 'added', target: ay[i] })
        else walk(ax[i], ay[i], s)
      }
    } else if (canonical(x) !== canonical(y)) push({ segs, kind: 'changed', source: x, target: y })
  }
  walk(a, b, [])
  return { diffs, total }
}

export const toFieldDiff = (d: RawDiff): FieldDiff => {
  const f: FieldDiff = { path: d.segs.join('.'), kind: d.kind }
  if (d.kind !== 'added') f.source = d.source
  if (d.kind !== 'removed') f.target = d.target
  return f
}

// ---------------------------------------------------------------------------
// $set / $unset sync
// ---------------------------------------------------------------------------

const unsafeSeg = (s: string): boolean => !s || s.includes('.') || s.startsWith('$')

/**
 * Update that makes `to` match `from` on the differing paths (`diffs` = diffDocs(from, to)). Changes inside
 * arrays set the whole (outermost) array. `_id` is never touched. Returns null when a path cannot be
 * expressed in update syntax (field names with dots or `$`), so the caller replaces the document instead.
 */
export function setUpdate(from: Doc, to: Doc, diffs: RawDiff[]): Doc | null {
  const paths: string[][] = []
  for (const d of diffs) {
    let a: unknown = from
    let b: unknown = to
    let segs = d.segs
    for (let i = 0; i < d.segs.length; i++) {
      if (Array.isArray(a) || Array.isArray(b)) {
        segs = d.segs.slice(0, i)
        break
      }
      a = isPlainDoc(a) ? a[d.segs[i]] : undefined
      b = isPlainDoc(b) ? b[d.segs[i]] : undefined
    }
    if (!segs.length) return null
    if (segs.some(unsafeSeg)) return null
    if (segs[0] === '_id') continue
    paths.push(segs)
  }
  paths.sort((x, y) => x.length - y.length)
  const kept: string[][] = []
  for (const p of paths) {
    if (kept.some((k) => k.length <= p.length && k.every((s, i) => s === p[i]))) continue
    kept.push(p)
  }
  const $set: Doc = {}
  const $unset: Doc = {}
  for (const p of kept) {
    const v = getSegs(from, p)
    if (v === undefined) $unset[p.join('.')] = ''
    else $set[p.join('.')] = v
  }
  const u: Doc = {}
  if (Object.keys($set).length) u.$set = $set
  if (Object.keys($unset).length) u.$unset = $unset
  return u
}
