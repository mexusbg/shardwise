import type { Doc } from './api'

/** Helpers for system.profile entries and $currentOp documents (no BSON dependency: values are inspected structurally). */

export const SHAPE_VALUE = '?'

export function isPlainObject(v: unknown): v is Doc {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || '_bsontype' in (v as object)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Number from a JS number, Int32/Double/Long wrapper or bigint; undefined when absent. */
export function num(v: unknown): number | undefined {
  if (v == null) return undefined
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'object') {
    const o = v as { toNumber?: () => number; valueOf: () => unknown }
    if (typeof o.toNumber === 'function') return o.toNumber()
    const n = Number(o.valueOf())
    return Number.isFinite(n) ? n : undefined
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const LOGICAL = new Set(['$and', '$or', '$nor'])

/** Replace every value of a filter with `?`, keeping field names and operators (order is preserved). */
export function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length && value.every(isPlainObject) ? value.map(shapeOf) : SHAPE_VALUE
  if (!isPlainObject(value)) return SHAPE_VALUE
  const out: Doc = {}
  for (const [k, v] of Object.entries(value)) {
    if (LOGICAL.has(k) && Array.isArray(v)) out[k] = v.map(shapeOf)
    else if (k === '$elemMatch' || k === '$not' || isPlainObject(v)) out[k] = shapeOf(v)
    else out[k] = SHAPE_VALUE
  }
  return out
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/** Compact shell-like text of a shape: `{ a: ?, b: { $gt: ? } }`. Non-shape leaves are printed as JSON. */
export function shapeText(shape: unknown): string {
  if (shape === SHAPE_VALUE) return SHAPE_VALUE
  if (Array.isArray(shape)) return shape.length ? `[ ${shape.map(shapeText).join(', ')} ]` : '[]'
  if (isPlainObject(shape)) {
    const keys = Object.keys(shape)
    if (!keys.length) return '{}'
    return `{ ${keys.map((k) => `${IDENT.test(k) ? k : `'${k}'`}: ${shapeText(shape[k])}`).join(', ')} }`
  }
  if (typeof shape === 'string') return `'${shape}'`
  const n = num(shape)
  return n !== undefined ? String(n) : String(shape)
}

export interface ProfileQueryParts {
  /** Command that produced the query (find, count, distinct, aggregate, update, delete, findAndModify). */
  kind: string
  coll: string
  filter: Doc
  sort: Doc | null
  projection: Doc | null
  skip: number
  limit: number
}

const asDoc = (v: unknown): Doc | null => (isPlainObject(v) ? v : null)
const collOf = (cmdValue: unknown, ns: unknown): string => {
  if (typeof cmdValue === 'string' && cmdValue) return cmdValue
  if (typeof ns === 'string' && ns.includes('.')) return ns.slice(ns.indexOf('.') + 1)
  return ''
}

/** The command document of a profile / currentOp entry (legacy 3.x entries keep `find` commands under `query`). */
export function commandOf(entry: Doc): Doc | null {
  return asDoc(entry.command) ?? (entry.op === 'query' ? asDoc(entry.query) : null)
}

function partsFromCommand(cmd: Doc, ns: unknown): ProfileQueryParts | null {
  if ('explain' in cmd && isPlainObject(cmd.explain)) return partsFromCommand(cmd.explain, ns)
  const base = { sort: null as Doc | null, projection: null as Doc | null, skip: num(cmd.skip) ?? 0, limit: Math.abs(num(cmd.limit) ?? 0) }
  if ('find' in cmd) {
    return {
      ...base,
      kind: 'find',
      coll: collOf(cmd.find, ns),
      filter: asDoc(cmd.filter) ?? {},
      sort: asDoc(cmd.sort),
      projection: asDoc(cmd.projection)
    }
  }
  if ('count' in cmd) return { ...base, kind: 'count', coll: collOf(cmd.count, ns), filter: asDoc(cmd.query) ?? {} }
  if ('distinct' in cmd) return { ...base, kind: 'distinct', coll: collOf(cmd.distinct, ns), filter: asDoc(cmd.query) ?? {} }
  if ('aggregate' in cmd) {
    const coll = collOf(cmd.aggregate, ns)
    const first = Array.isArray(cmd.pipeline) ? asDoc(cmd.pipeline[0]) : null
    const match = first && asDoc(first.$match)
    if (!coll || typeof cmd.aggregate !== 'string' || !match) return null
    return { ...base, skip: 0, limit: 0, kind: 'aggregate', coll, filter: match }
  }
  const fam = 'findAndModify' in cmd ? cmd.findAndModify : cmd.findandmodify
  if (fam !== undefined) {
    return { ...base, kind: 'findAndModify', coll: collOf(fam, ns), filter: asDoc(cmd.query) ?? {}, sort: asDoc(cmd.sort), projection: asDoc(cmd.fields) }
  }
  if ('update' in cmd && Array.isArray(cmd.updates)) {
    const u = asDoc(cmd.updates[0])
    return u ? { ...base, skip: 0, limit: 0, kind: 'update', coll: collOf(cmd.update, ns), filter: asDoc(u.q) ?? {}, sort: asDoc(u.sort) } : null
  }
  if ('delete' in cmd && Array.isArray(cmd.deletes)) {
    const d = asDoc(cmd.deletes[0])
    return d ? { ...base, skip: 0, limit: 0, kind: 'delete', coll: collOf(cmd.delete, ns), filter: asDoc(d.q) ?? {} } : null
  }
  return null
}

/**
 * Collection, filter, sort, projection, skip and limit of the query behind a profile entry, or null when the entry
 * is not a query (insert, createIndexes, aggregate without a leading $match, …).
 */
export function profileQueryParts(entry: Doc): ProfileQueryParts | null {
  const ns = entry.ns
  const cmd = commandOf(entry)
  const orig = asDoc(entry.originatingCommand)
  if (orig && (entry.op === 'getmore' || (cmd && 'getMore' in cmd))) return partsFromCommand(orig, ns)
  if (!cmd) return null
  // Per-statement update / remove entries: { q, u, multi, upsert } or { q, limit }
  if ('q' in cmd && isPlainObject(cmd.q) && !('find' in cmd)) {
    const kind = entry.op === 'update' || 'u' in cmd ? 'update' : 'delete'
    return { kind, coll: collOf(undefined, ns), filter: cmd.q, sort: asDoc(cmd.sort), projection: null, skip: 0, limit: 0 }
  }
  return partsFromCommand(cmd, ns)
}

const COMMAND_OPS = ['aggregate', 'count', 'distinct', 'findAndModify', 'findandmodify', 'mapReduce', 'createIndexes', 'dropIndexes', 'drop', 'create', 'listIndexes', 'collStats', 'dbStats']

/** A more specific operation label: `aggregate`, `count`, `distinct`, … instead of `command`. */
export function opLabel(entry: Doc): string {
  const op = typeof entry.op === 'string' ? entry.op : '?'
  if (op !== 'command') return op
  const cmd = commandOf(entry)
  if (!cmd) return op
  const name = COMMAND_OPS.find((k) => k in cmd) ?? Object.keys(cmd)[0]
  if (!name) return op
  return name === 'findandmodify' ? 'findAndModify' : name
}

/** Human readable shape of the query of an entry, used as example and fallback grouping key. */
export function queryShapeText(entry: Doc): string {
  const cmd = commandOf(entry)
  const orig = asDoc(entry.originatingCommand)
  const source = orig && (entry.op === 'getmore' || (cmd && 'getMore' in cmd)) ? orig : cmd
  if (source && 'aggregate' in source && Array.isArray(source.pipeline)) {
    const stages = source.pipeline.map((s) => {
      const d = asDoc(s)
      const name = d ? Object.keys(d)[0] : '?'
      return name === '$match' && d ? `$match ${shapeText(shapeOf(d.$match))}` : name
    })
    return `[ ${stages.join(', ')} ]`
  }
  const parts = profileQueryParts(entry)
  if (!parts) {
    if (!cmd) return opLabel(entry)
    const first = Object.keys(cmd)[0]
    return first ?? opLabel(entry)
  }
  let s = shapeText(shapeOf(parts.filter))
  if (parts.sort && Object.keys(parts.sort).length) s += ` sort ${shapeText(parts.sort)}`
  if (parts.projection && Object.keys(parts.projection).length) s += ` proj { ${Object.keys(parts.projection).join(', ')} }`
  return s
}

/** Server-reported shape hash: queryShapeHash (8.0+), planCacheShapeHash (8.0+) or queryHash (4.2–7.x). */
export function shapeHash(entry: Doc): string | undefined {
  for (const k of ['queryShapeHash', 'planCacheShapeHash', 'queryHash']) {
    const v = entry[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

export function shapeKey(entry: Doc): string {
  const ns = typeof entry.ns === 'string' ? entry.ns : ''
  return `${ns}|${opLabel(entry)}|${shapeHash(entry) ?? queryShapeText(entry)}`
}

export interface ShapeGroup {
  key: string
  hash?: string
  ns: string
  op: string
  /** Shape of the first (newest) entry. */
  example: string
  count: number
  totalMs: number
  avgMs: number
  maxMs: number
  avgDocsExamined: number
  avgKeysExamined: number
  avgReturned: number
  /** Distinct plan summaries, most frequent first. */
  plans: string[]
  hasCollscan: boolean
  lastTs?: Date
}

/** Group profile entries by query shape; sorted by total time, descending. */
export function groupProfile(entries: Doc[]): ShapeGroup[] {
  const map = new Map<string, ShapeGroup & { plansCount: Map<string, number> }>()
  for (const e of entries) {
    const key = shapeKey(e)
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        hash: shapeHash(e),
        ns: typeof e.ns === 'string' ? e.ns : '',
        op: opLabel(e),
        example: queryShapeText(e),
        count: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
        avgDocsExamined: 0,
        avgKeysExamined: 0,
        avgReturned: 0,
        plans: [],
        hasCollscan: false,
        plansCount: new Map()
      }
      map.set(key, g)
    }
    const ms = num(e.millis) ?? 0
    g.count++
    g.totalMs += ms
    g.maxMs = Math.max(g.maxMs, ms)
    g.avgDocsExamined += num(e.docsExamined) ?? 0
    g.avgKeysExamined += num(e.keysExamined) ?? 0
    g.avgReturned += num(e.nreturned) ?? 0
    if (typeof e.planSummary === 'string' && e.planSummary) {
      g.plansCount.set(e.planSummary, (g.plansCount.get(e.planSummary) ?? 0) + 1)
      if (e.planSummary.includes('COLLSCAN')) g.hasCollscan = true
    }
    if (e.ts instanceof Date && (!g.lastTs || e.ts > g.lastTs)) g.lastTs = e.ts
  }
  const out: ShapeGroup[] = []
  for (const { plansCount, ...g } of map.values()) {
    out.push({
      ...g,
      avgMs: g.totalMs / g.count,
      avgDocsExamined: g.avgDocsExamined / g.count,
      avgKeysExamined: g.avgKeysExamined / g.count,
      avgReturned: g.avgReturned / g.count,
      plans: [...plansCount.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
    })
  }
  return out.sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
}

export interface ProfileWarning {
  level: 'warn' | 'danger'
  text: string
}

/** Performance red flags of one profile entry. */
export function profileWarnings(entry: Doc): ProfileWarning[] {
  const out: ProfileWarning[] = []
  const plan = typeof entry.planSummary === 'string' ? entry.planSummary : ''
  if (plan.includes('COLLSCAN')) out.push({ level: 'danger', text: 'Collection scan (COLLSCAN): no index was used' })
  if (entry.hasSortStage === true) out.push({ level: 'warn', text: 'In-memory sort (no index provides the sort order)' })
  if (entry.usedDisk === true) out.push({ level: 'danger', text: 'Spilled to disk (usedDisk)' })
  const examined = Math.max(num(entry.docsExamined) ?? 0, num(entry.keysExamined) ?? 0)
  const returned = num(entry.nreturned) ?? 0
  if (examined > 0 && examined / Math.max(returned, 1) > 10) {
    out.push({ level: 'warn', text: `Examined ${examined.toLocaleString('en-US')} for ${returned.toLocaleString('en-US')} returned (ratio ${Math.round(examined / Math.max(returned, 1)).toLocaleString('en-US')}:1)` })
  }
  return out
}

export const PROFILE_OPS = ['all', 'query', 'getmore', 'insert', 'update', 'remove', 'command', 'aggregate'] as const
export type ProfileOpFilter = (typeof PROFILE_OPS)[number]

export interface ProfileFilterOptions {
  db: string
  minMs?: number
  op?: ProfileOpFilter
  /** Collection name (exact) or part of a namespace. */
  ns?: string
  nsExact?: boolean
  /** Only entries newer than this many milliseconds before `now`. */
  sinceMs?: number
  now?: Date
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Server-side filter on system.profile; the profiler's own reads of system.profile are excluded. */
export function buildProfileFilter(o: ProfileFilterOptions): Doc {
  const f: Doc = {}
  if (o.minMs && o.minMs > 0) f.millis = { $gte: o.minMs }
  if (o.op === 'aggregate') {
    f.op = 'command'
    f['command.aggregate'] = { $exists: true }
  } else if (o.op && o.op !== 'all') f.op = o.op
  const ns = o.ns?.trim()
  if (ns) f.ns = o.nsExact ? `${o.db}.${ns}` : { $regex: escapeRegex(ns), $options: 'i' }
  else f.ns = { $ne: `${o.db}.system.profile` }
  if (o.sinceMs && o.sinceMs > 0) f.ts = { $gte: new Date((o.now ?? new Date()).getTime() - o.sinceMs) }
  return f
}
