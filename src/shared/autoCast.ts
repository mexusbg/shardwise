import { ObjectId } from 'bson'
import type { EditableType } from './bsonValue'
import { isPlainDoc } from './bsonValue'
import { parseDateInZone } from './dateFormat'

type Doc = Record<string, unknown>
type TypeOf = (path: string) => EditableType | undefined

const HEX24 = /^[0-9a-fA-F]{24}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/

const VALUE_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'])
const LIST_OPS = new Set(['$in', '$nin', '$all'])

/** Whether a filter contains strings that could be cast (used to decide if sampling types is worth it). */
export function hasCastCandidates(v: unknown): boolean {
  if (typeof v === 'string') return HEX24.test(v) || ISO_DATE.test(v)
  if (Array.isArray(v)) return v.some(hasCastCandidates)
  if (isPlainDoc(v)) return Object.values(v).some(hasCastCandidates)
  return false
}

/**
 * Cast plain strings to the stored type of the field they are compared with: 24-hex strings to ObjectId and
 * ISO date strings to Date, but only when sample documents show the field holds that type. So
 * `{ _id: '650…' }` and `{ customerId: { $in: ['650…'] } }` match like `ObjectId('650…')`.
 */
export function autoCastFilter(filter: Doc, typeOf: TypeOf): { filter: Doc; casts: number } {
  let casts = 0

  const castValue = (v: unknown, path: string): unknown => {
    if (typeof v !== 'string') return v
    const t = typeOf(path)
    if (t === 'objectId' && HEX24.test(v)) {
      casts++
      return new ObjectId(v)
    }
    if (t === 'date' && ISO_DATE.test(v)) {
      const d = parseDateInZone(v)
      if (!isNaN(d.getTime())) {
        casts++
        return d
      }
    }
    return v
  }

  const castOps = (ops: Doc, path: string): Doc => {
    const out: Doc = {}
    for (const [op, v] of Object.entries(ops)) {
      if (VALUE_OPS.has(op)) out[op] = castValue(v, path)
      else if (LIST_OPS.has(op) && Array.isArray(v)) out[op] = v.map((x) => castValue(x, path))
      else if (op === '$not' && isPlainDoc(v)) out[op] = castOps(v, path)
      else if (op === '$elemMatch' && isPlainDoc(v)) {
        const keys = Object.keys(v)
        out[op] = keys.length && keys.every((k) => k.startsWith('$') && !['$and', '$or', '$nor'].includes(k)) ? castOps(v, path) : castDoc(v, path)
      } else out[op] = v
    }
    return out
  }

  const castDoc = (doc: Doc, prefix: string): Doc => {
    const out: Doc = {}
    for (const [k, v] of Object.entries(doc)) {
      if (k === '$and' || k === '$or' || k === '$nor') {
        out[k] = Array.isArray(v) ? v.map((x) => (isPlainDoc(x) ? castDoc(x, prefix) : x)) : v
        continue
      }
      if (k.startsWith('$')) {
        out[k] = v
        continue
      }
      const path = prefix ? `${prefix}.${k}` : k
      if (isPlainDoc(v) && Object.keys(v).length && Object.keys(v).every((x) => x.startsWith('$'))) out[k] = castOps(v, path)
      else out[k] = castValue(v, path)
    }
    return out
  }

  const result = castDoc(filter, '')
  return { filter: result, casts }
}
