import { randomUUID } from 'crypto'
import { ObjectId } from 'mongodb'
import type { Document, Filter, MongoClient } from 'mongodb'
import { shellText } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import type { SearchApi, SearchCollectionResult, SearchEvent, SearchHit, SearchMatch, SearchRequest } from '@shared/searchApi'
import { RAW_TYPES } from '../mongo/ops'

export interface SearchConnections {
  get(connId: string): MongoClient
}

const SAMPLE = 200
const CONCURRENCY = 3
const MAX_DEPTH = 12
const MAX_PATHS = 400
const MAX_MATCHES_PER_DOC = 20
const VALUE_TEXT = 160

type Kind = SearchMatch['type']

/** One way the search text can match a value. */
export type Probe = { kind: 'string'; test: (s: string) => boolean; query: unknown } | { kind: 'number'; value: number } | { kind: 'objectId'; value: ObjectId }

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const NUMERIC = new Set(['Int32', 'Double', 'Long', 'Decimal128'])
const bsonType = (v: unknown): string | undefined => (v && typeof v === 'object' ? (v as { _bsontype?: string })._bsontype : undefined)

function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  const t = bsonType(v)
  if (!t || !NUMERIC.has(t)) return null
  if (t === 'Long') return (v as { toNumber(): number }).toNumber()
  if (t === 'Decimal128') return parseFloat((v as { toString(): string }).toString())
  return (v as { valueOf(): number }).valueOf()
}

function kindOf(v: unknown): Kind | null {
  if (typeof v === 'string') return 'string'
  if (numberOf(v) !== null) return 'number'
  if (bsonType(v) === 'ObjectId') return 'objectId'
  return null
}

/** Parses the search text into the probes it stands for; throws on invalid input. */
export function buildProbes(req: Pick<SearchRequest, 'text' | 'type' | 'match' | 'caseSensitive'>): Probe[] {
  const text = req.text
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Enter a value to search for')
  const probes: Probe[] = []
  const flags = req.caseSensitive ? '' : 'i'

  const regex = (src: string, f: string): Probe => {
    let re: RegExp
    try {
      re = new RegExp(src, f.replace(/[^imsux]/g, ''))
    } catch (e) {
      throw new Error(`Invalid regular expression: ${(e as Error).message}`)
    }
    return { kind: 'string', test: (s) => re.test(s), query: { $regex: src, $options: f.replace(/[^imsx]/g, '') } }
  }
  const string = (): Probe => {
    if (req.match === 'exact') {
      if (req.caseSensitive) return { kind: 'string', test: (s) => s === text, query: text }
      return regex(`^${escapeRegex(text)}$`, 'i')
    }
    return regex(escapeRegex(text), flags)
  }
  const oidText = /^ObjectId\(\s*["']([0-9a-fA-F]{24})["']\s*\)$/.exec(trimmed)?.[1] ?? (/^[0-9a-fA-F]{24}$/.test(trimmed) ? trimmed : null)
  const isNum = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)
  const reLit = /^\/(.+)\/([a-z]*)$/s.exec(trimmed)

  switch (req.type) {
    case 'string':
      probes.push(string())
      break
    case 'number':
      if (!isNum) throw new Error(`"${trimmed}" is not a number`)
      probes.push({ kind: 'number', value: Number(trimmed) })
      break
    case 'objectId':
      if (!oidText) throw new Error('An ObjectId has 24 hexadecimal characters')
      probes.push({ kind: 'objectId', value: new ObjectId(oidText) })
      break
    case 'regex': {
      const src = reLit ? reLit[1] : text
      const f = reLit ? reLit[2] : ''
      probes.push(regex(src, req.caseSensitive ? f.replace('i', '') : f.includes('i') ? f : `${f}i`))
      break
    }
    default:
      if (reLit) {
        probes.push(regex(reLit[1], reLit[2]))
        break
      }
      if (!/^ObjectId\(/.test(trimmed)) probes.push(string())
      if (isNum) probes.push({ kind: 'number', value: Number(trimmed) })
      if (oidText) probes.push({ kind: 'objectId', value: new ObjectId(oidText) })
  }
  return probes
}

function testValue(v: unknown, probes: Probe[]): Kind | null {
  const k = kindOf(v)
  if (!k) return null
  for (const p of probes) {
    if (p.kind !== k) continue
    if (p.kind === 'string' && p.test(v as string)) return k
    if (p.kind === 'number' && numberOf(v) === p.value) return k
    if (p.kind === 'objectId' && (v as ObjectId).equals(p.value)) return k
  }
  return null
}

const shorten = (s: string): string => (s.length > VALUE_TEXT ? `${s.slice(0, VALUE_TEXT - 1)}…` : s)

/** Leaf values of a document that match, with their concrete paths (array positions included). */
export function matchDoc(doc: Doc, probes: Probe[], field?: string): SearchMatch[] {
  const out: SearchMatch[] = []
  const fieldParts = field ? field.split('.') : null
  const walk = (v: unknown, path: string[], logical: string[], depth: number): void => {
    if (out.length >= MAX_MATCHES_PER_DOC || depth > MAX_DEPTH) return
    if (fieldParts && logical.length > fieldParts.length) return
    if (fieldParts && logical.some((p, i) => p !== fieldParts[i])) return
    const k = testValue(v, probes)
    if (k) {
      if (!fieldParts || logical.length === fieldParts.length) out.push({ path: path.join('.'), value: shorten(k === 'string' ? (v as string) : shellText(v)), type: k })
      return
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)], logical, depth + 1))
    else if (v && typeof v === 'object' && !bsonType(v) && !(v instanceof Date)) {
      for (const [key, x] of Object.entries(v as Doc)) walk(x, [...path, key], [...logical, key], depth + 1)
    }
  }
  for (const [key, x] of Object.entries(doc)) walk(x, [key], [key], 1)
  return out
}

/** Dot paths (without array positions) holding strings, numbers or ObjectIds in the sampled documents. */
export function typedPaths(docs: Doc[]): Record<Kind, Set<string>> {
  const out: Record<Kind, Set<string>> = { string: new Set(), number: new Set(), objectId: new Set() }
  let n = 0
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || n > MAX_PATHS * 4) return
    const k = kindOf(v)
    if (k) {
      if (!out[k].has(path)) n++
      out[k].add(path)
      return
    }
    if (Array.isArray(v)) v.forEach((x) => walk(x, path, depth + 1))
    else if (v && typeof v === 'object' && !bsonType(v) && !(v instanceof Date)) {
      for (const [key, x] of Object.entries(v as Doc)) if (!key.startsWith('$')) walk(x, path ? `${path}.${key}` : key, depth + 1)
    }
  }
  for (const d of docs) walk(d, '', 0)
  return out
}

/** `$or` filter over the given paths, or null when no path can hold a match. */
export function buildFilter(paths: Record<Kind, Set<string>>, probes: Probe[]): Doc | null {
  const or: Doc[] = []
  for (const p of probes) {
    const list = [...paths[p.kind]].slice(0, MAX_PATHS)
    for (const path of list) or.push({ [path]: p.kind === 'string' ? p.query : p.value })
  }
  if (!or.length) return null
  return or.length === 1 ? or[0] : { $or: or }
}

export class Searches {
  private ctrls = new Map<string, AbortController>()

  constructor(
    private mgr: SearchConnections,
    private emit: (e: SearchEvent) => void
  ) {}

  cancel(searchId: string): void {
    this.ctrls.get(searchId)?.abort()
  }

  cancelAll(): void {
    for (const c of this.ctrls.values()) c.abort()
  }

  start(req: SearchRequest): string {
    const client = this.mgr.get(req.connId)
    const probes = buildProbes(req)
    const field = req.field?.trim() || undefined
    const max = Math.max(1, Math.min(10_000, Math.floor(req.maxPerCollection) || 50))
    const searchId = randomUUID()
    const ctrl = new AbortController()
    this.ctrls.set(searchId, ctrl)
    const t0 = Date.now()
    void (async () => {
      let state: 'done' | 'cancelled' | 'error' = 'done'
      let error: string | undefined
      try {
        const db = client.db(req.db)
        let colls = req.collections
        if (!colls) {
          const list = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()
          colls = list
            .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
            .map((c) => c.name)
            .sort((a, b) => a.localeCompare(b))
        }
        const queue = [...colls]
        const current = new Set<string>()
        let done = 0
        const total = colls.length
        const progress = (): void => this.emit({ searchId, kind: 'progress', done, total, current: [...current] })
        progress()
        const worker = async (): Promise<void> => {
          while (queue.length && !ctrl.signal.aborted) {
            const coll = queue.shift()!
            current.add(coll)
            progress()
            const result = await this.searchCollection(client, req.db, coll, probes, field, max, req.deep, ctrl.signal)
            current.delete(coll)
            done++
            if (ctrl.signal.aborted) break
            if (result.hits.length || result.error) this.emit({ searchId, kind: 'collection', result })
            progress()
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, total)) }, worker))
        if (ctrl.signal.aborted) state = 'cancelled'
      } catch (e) {
        if (ctrl.signal.aborted) state = 'cancelled'
        else {
          state = 'error'
          error = (e as Error).message || String(e)
        }
      } finally {
        this.ctrls.delete(searchId)
        this.emit({ searchId, kind: 'done', state, error, ms: Date.now() - t0 })
      }
    })()
    return searchId
  }

  async searchCollection(client: MongoClient, db: string, coll: string, probes: Probe[], field: string | undefined, max: number, deep: boolean, signal: AbortSignal): Promise<SearchCollectionResult> {
    const t0 = Date.now()
    const c = client.db(db).collection(coll)
    const hits: SearchHit[] = []
    let truncated = false
    let pathCount = 0
    try {
      if (deep) {
        const filter = field ? ({ [field]: { $exists: true } } as Filter<Document>) : {}
        // The signal also stops a query in flight (closing its connection), not just between documents.
        const cursor = c.find(filter, { ...RAW_TYPES, batchSize: 500, signal })
        try {
          for await (const d of cursor) {
            if (signal.aborted) break
            const matches = matchDoc(d as Doc, probes, field)
            if (!matches.length) continue
            if (hits.length >= max) {
              truncated = true
              break
            }
            hits.push({ _id: d._id, matches })
          }
        } finally {
          await cursor.close().catch(() => {})
        }
      } else {
        let paths: Record<Kind, Set<string>>
        if (field) paths = { string: new Set([field]), number: new Set([field]), objectId: new Set([field]) }
        else {
          const sample = (await c.aggregate([{ $sample: { size: SAMPLE } }], { ...RAW_TYPES, maxTimeMS: 30_000, signal }).toArray()) as Doc[]
          paths = typedPaths(sample)
        }
        pathCount = new Set([...paths.string, ...paths.number, ...paths.objectId]).size
        const filter = buildFilter(paths, probes)
        if (filter && !signal.aborted) {
          const docs = (await c.find(filter as Filter<Document>, { ...RAW_TYPES, limit: max + 1, signal }).toArray()) as Doc[]
          truncated = docs.length > max
          for (const d of docs.slice(0, max)) {
            const matches = matchDoc(d, probes, field)
            // Equality on an array field matches the array itself; keep the hit with the field path.
            hits.push({ _id: d._id, matches: matches.length ? matches : [{ path: field ?? '', value: '', type: probes[0].kind }] })
          }
        }
      }
      return { coll, hits, truncated, paths: pathCount, ms: Date.now() - t0 }
    } catch (e) {
      return { coll, hits, truncated, paths: pathCount, ms: Date.now() - t0, error: (e as Error).message || String(e) }
    }
  }
}

type Handlers = { [K in keyof SearchApi]: (...args: Parameters<SearchApi[K]>) => Promise<ReturnType<SearchApi[K]>> | ReturnType<SearchApi[K]> }

/** IPC handlers for Find in Database; spread into the api object. */
export function searchHandlers(s: Searches): Handlers {
  return {
    searchStart: (req) => s.start(req),
    searchCancel: (searchId) => s.cancel(searchId)
  }
}
