import { isPlainDoc, parseShellValue } from './bsonValue'
import type { Doc } from './api'

/**
 * Queries proposed by the assistant arrive as fenced blocks:
 *   ```mongo-find orders          { filter: {…}, projection: {…}, sort: {…}, limit: 20 }
 *   ```mongo-aggregate orders     [ { $match: … }, … ]
 * The word after the language tag is the collection (optional: defaults to the current one).
 */

export const FIND_FENCE = 'mongo-find'
export const AGGREGATE_FENCE = 'mongo-aggregate'

export type ProposedQuery =
  | { kind: 'find'; coll?: string; filter: Doc; projection: Doc | null; sort: Doc | null; skip: number; limit: number }
  | { kind: 'aggregate'; coll?: string; pipeline: Doc[]; text: string }

export interface QueryFence {
  lang: string
  coll?: string
  body: string
}

const FIND_KEYS = new Set(['filter', 'query', 'projection', 'sort', 'skip', 'limit', 'collection'])

const toInt = (v: unknown, what: string): number => {
  if (v === undefined || v === null) return 0
  const n = Number(typeof v === 'object' ? String(v) : v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a non-negative number`)
  return Math.floor(n)
}

const optDoc = (v: unknown, what: string): Doc | null => {
  if (v === undefined || v === null) return null
  if (!isPlainDoc(v)) throw new Error(`${what} must be an object`)
  return Object.keys(v).length ? v : null
}

export function parseProposedQuery(lang: string, body: string, coll?: string): ProposedQuery {
  const text = body.trim()
  if (!text) throw new Error('The query is empty')
  const value = parseShellValue(text)
  if (lang === AGGREGATE_FENCE) {
    if (!Array.isArray(value)) throw new Error('The pipeline must be an array of stages')
    value.forEach((st, i) => {
      if (!isPlainDoc(st) || Object.keys(st).length !== 1 || !Object.keys(st)[0].startsWith('$')) {
        throw new Error(`Stage ${i + 1} must be an object with one $operator key`)
      }
    })
    return { kind: 'aggregate', coll, pipeline: value as Doc[], text }
  }
  if (lang !== FIND_FENCE) throw new Error(`Unknown query block ${lang}`)
  if (!isPlainDoc(value)) throw new Error('The find query must be an object')
  const keys = Object.keys(value)
  // A bare filter (`{ status: 'A' }`) is accepted too.
  const wrapped = keys.length > 0 && keys.every((k) => FIND_KEYS.has(k))
  if (!wrapped) return { kind: 'find', coll, filter: value, projection: null, sort: null, skip: 0, limit: 0 }
  const filter = value.filter ?? value.query ?? {}
  if (!isPlainDoc(filter)) throw new Error('filter must be an object')
  const c = typeof value.collection === 'string' && value.collection ? value.collection : coll
  return {
    kind: 'find',
    coll: c,
    filter,
    projection: optDoc(value.projection, 'projection'),
    sort: optDoc(value.sort, 'sort'),
    skip: toInt(value.skip, 'skip'),
    limit: toInt(value.limit, 'limit')
  }
}

/** All complete mongo-find / mongo-aggregate blocks in a markdown text. */
export function extractQueryFences(markdown: string): QueryFence[] {
  const out: QueryFence[] = []
  const re = /^[ \t]*```[ \t]*(mongo-find|mongo-aggregate)[ \t]*([^\n`]*)\n([\s\S]*?)^[ \t]*```[ \t]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown))) out.push({ lang: m[1], coll: m[2].trim() || undefined, body: m[3] })
  return out
}

/** Fence info string → language tag and optional collection. */
export function fenceInfo(info: string): { lang: string; coll?: string } {
  const [lang = '', ...rest] = info.trim().split(/\s+/)
  return { lang, coll: rest.join(' ') || undefined }
}
