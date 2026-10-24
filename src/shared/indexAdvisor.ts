import { groupProfile, isPlainObject, num, profileQueryParts, shapeKey } from './profile'

type Doc = Record<string, unknown>

export type IndexKey = [field: string, dir: 1 | -1]

const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne', '$nin', '$regex', '$exists', '$not', '$type', '$mod', '$size', '$all'])
const UNINDEXABLE = new Set(['$where', '$expr', '$text', '$jsonSchema', '$comment'])

interface Preds {
  eq: string[]
  range: string[]
  unindexable: boolean
}

const addUnique = (list: string[], f: string): void => {
  if (!list.includes(f)) list.push(f)
}

function collect(filter: Doc, prefix: string, preds: Preds, hasSort: boolean): void {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' && Array.isArray(v)) {
      for (const c of v) if (isPlainObject(c)) collect(c, prefix, preds, hasSort)
      continue
    }
    if (UNINDEXABLE.has(k)) {
      preds.unindexable = true
      continue
    }
    if (k.startsWith('$')) continue
    const path = prefix ? `${prefix}.${k}` : k
    const ops = isPlainObject(v) && Object.keys(v).length && Object.keys(v).every((x) => x.startsWith('$')) ? v : null
    if (!ops) {
      addUnique(preds.eq, path)
      continue
    }
    if (isPlainObject(ops.$elemMatch)) {
      const inner = ops.$elemMatch as Doc
      const innerKeys = Object.keys(inner)
      if (innerKeys.every((x) => x.startsWith('$'))) addUnique(preds.range, path)
      else collect(inner, path, preds, hasSort)
      continue
    }
    if ('$geoWithin' in ops || '$near' in ops || '$nearSphere' in ops || '$geoIntersects' in ops) {
      preds.unindexable = true
      continue
    }
    const opNames = Object.keys(ops)
    if (opNames.every((o) => o === '$eq')) addUnique(preds.eq, path)
    // $in behaves like equality for index order unless a sort follows it (then it acts like a range).
    else if (opNames.every((o) => o === '$in' || o === '$eq') && !hasSort) addUnique(preds.eq, path)
    else if (opNames.some((o) => RANGE_OPS.has(o) || o === '$in')) addUnique(preds.range, path)
  }
}

export interface IndexSuggestion {
  keys: IndexKey[]
  /** Leading equality fields (their order within the index does not matter). */
  eqCount: number
}

function keysFor(filter: Doc, sort: Doc | null): IndexSuggestion | null {
  const sortKeys: IndexKey[] = Object.entries(sort ?? {})
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, v]) => [k, (num(v) ?? 1) < 0 ? -1 : 1])
  const preds: Preds = { eq: [], range: [], unindexable: false }
  collect(filter, '', preds, sortKeys.length > 0)
  if (preds.unindexable && !preds.eq.length && !preds.range.length) return null
  const keys: IndexKey[] = preds.eq.map((f) => [f, 1])
  for (const [f, d] of sortKeys) if (!keys.some(([k]) => k === f)) keys.push([f, d])
  for (const f of preds.range) if (!keys.some(([k]) => k === f)) keys.push([f, 1])
  if (!keys.length) return null
  if (keys.length === 1 && keys[0][0] === '_id') return null
  return { keys: keys.slice(0, 8), eqCount: Math.min(preds.eq.length, 8) }
}

/**
 * Suggest index key patterns for a query following the Equality → Sort → Range rule. `$or` queries need
 * one index per branch, so one pattern is returned for each.
 */
export function suggestIndexes(filter: Doc, sort: Doc | null): IndexSuggestion[] {
  const or = Array.isArray(filter.$or) ? (filter.$or as unknown[]).filter(isPlainObject) : null
  if (or && or.length) {
    const rest = { ...filter }
    delete rest.$or
    const out: IndexSuggestion[] = []
    for (const branch of or) {
      const k = keysFor({ ...rest, $and: [branch] }, sort)
      if (k && !out.some((o) => sameKeys(o.keys, k.keys))) out.push(k)
    }
    return out
  }
  const k = keysFor(filter, sort)
  return k ? [k] : []
}

const sameKeys = (a: IndexKey[], b: IndexKey[]): boolean => a.length === b.length && a.every(([f, d], i) => b[i][0] === f && b[i][1] === d)

export interface ExistingIndex {
  name: string
  key: Doc
}

/**
 * Name of an existing index that already serves the suggestion: its leading fields match the suggestion
 * (equality fields in any order, then the rest in order, directions equal or all reversed).
 */
export function coveringIndex(keys: IndexKey[], existing: ExistingIndex[], eqCount = 0): string | undefined {
  for (const ix of existing) {
    const ixKeys = Object.entries(ix.key).map(([f, v]) => [f, typeof v === 'number' ? v : num(v) ?? v] as [string, unknown])
    if (ixKeys.length < keys.length) continue
    const head = ixKeys.slice(0, keys.length)
    const eqSet = new Set(keys.slice(0, eqCount).map(([f]) => f))
    const eqOk = head.slice(0, eqCount).every(([f]) => eqSet.has(f))
    const restSame = keys.slice(eqCount).every(([f, d], i) => head[eqCount + i][0] === f && head[eqCount + i][1] === d)
    const restRev = keys.slice(eqCount).every(([f, d], i) => head[eqCount + i][0] === f && head[eqCount + i][1] === -d)
    if (eqOk && (restSame || restRev)) return ix.name
  }
  return undefined
}

export const indexKeyDoc = (keys: IndexKey[]): Record<string, 1 | -1> => Object.fromEntries(keys)

export function createIndexCommand(coll: string, keys: IndexKey[]): string {
  const body = keys.map(([f, d]) => `${/^[A-Za-z_$][\w$]*$/.test(f) ? f : `'${f}'`}: ${d}`).join(', ')
  const target = /^[A-Za-z_$][\w$]*$/.test(coll) ? `db.${coll}` : `db.getCollection('${coll}')`
  return `${target}.createIndex({ ${body} })`
}

export interface IndexAdvice {
  /** Profile shape key the advice is based on. */
  shape: string
  coll: string
  keys: IndexKey[]
  command: string
  reasons: string[]
  example: string
  count: number
  totalMs: number
  avgMs: number
  avgDocsExamined: number
  avgReturned: number
  /** Set when an existing index already matches; the slow query has another cause. */
  coveredBy?: string
}

const fmt = (n: number): string => (n >= 100 ? Math.round(n).toLocaleString() : String(Math.round(n * 10) / 10))

/**
 * Index advice from system.profile entries: shapes that scan the collection, sort in memory or examine many
 * more documents than they return. Ranked by total time, merged per collection + key pattern.
 */
export function adviseFromProfile(entries: Doc[], indexesByColl: Record<string, ExistingIndex[]>): IndexAdvice[] {
  const byShape = new Map<string, Doc>()
  for (const e of entries) if (!byShape.has(shapeKey(e))) byShape.set(shapeKey(e), e)
  const sortStage = new Set<string>()
  for (const e of entries) if (e.hasSortStage === true) sortStage.add(shapeKey(e))

  const out = new Map<string, IndexAdvice>()
  for (const g of groupProfile(entries)) {
    const sample = byShape.get(g.key)
    const parts = sample && profileQueryParts(sample)
    if (!parts || !parts.coll) continue
    const ratio = g.avgDocsExamined / Math.max(g.avgReturned, 1)
    const reasons: string[] = []
    if (g.hasCollscan) reasons.push('Collection scan')
    if (sortStage.has(g.key)) reasons.push('Sorted in memory')
    if (ratio > 10 && g.avgDocsExamined > 50) reasons.push(`Examines ${fmt(ratio)}× more documents than it returns`)
    if (!reasons.length) continue
    const existing = indexesByColl[parts.coll] ?? []
    for (const { keys, eqCount } of suggestIndexes(parts.filter, parts.sort)) {
      const id = `${parts.coll}|${JSON.stringify(keys)}`
      const prev = out.get(id)
      if (prev) {
        prev.count += g.count
        prev.totalMs += g.totalMs
        prev.avgMs = prev.totalMs / prev.count
        for (const r of reasons) if (!prev.reasons.includes(r)) prev.reasons.push(r)
        continue
      }
      out.set(id, {
        shape: g.key,
        coll: parts.coll,
        keys,
        command: createIndexCommand(parts.coll, keys),
        reasons: [...reasons],
        example: g.example,
        count: g.count,
        totalMs: g.totalMs,
        avgMs: g.avgMs,
        avgDocsExamined: g.avgDocsExamined,
        avgReturned: g.avgReturned,
        coveredBy: coveringIndex(keys, existing, eqCount)
      })
    }
  }
  return [...out.values()].sort((a, b) => Number(!!a.coveredBy) - Number(!!b.coveredBy) || b.totalMs - a.totalMs)
}
