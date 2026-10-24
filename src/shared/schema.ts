import { EJSON } from 'bson'
import { bsonTypeOf, shellText, TYPE_LABELS } from './bsonValue'
import type { BsonTypeName } from './bsonValue'
import { isMapLike } from './mapKeys'

export interface SchemaOptions {
  /** Distinct values tracked per field before cardinality is reported as a lower bound. */
  distinctCap?: number
  /** Top values are listed only when the field has at most this many distinct values. */
  topValuesMaxDistinct?: number
  topValues?: number
  samples?: number
}

export interface NumberStats {
  min: number
  max: number
  avg: number
}
export interface LengthStats {
  min: number
  max: number
  avg: number
}
export interface DateRange {
  min: Date
  max: Date
}

export interface TypeStats {
  type: BsonTypeName
  label: string
  count: number
  /** Share of this field's values (0..1). */
  pct: number
  number?: NumberStats
  date?: DateRange
  string?: LengthStats
  array?: LengthStats & { elementTypes: { type: BsonTypeName; label: string; count: number; pct: number }[] }
  /** Creation time range from ObjectId timestamps. */
  objectId?: DateRange
}

export interface ValueCount {
  value: unknown
  type: BsonTypeName
  count: number
  /** Share of this field's values (0..1). */
  pct: number
}

export interface FieldReport {
  /** Last path segment; `[]` for array elements. */
  name: string
  /** Display path, e.g. `items.[].sku`. */
  path: string
  /** Dotted path usable in queries (array segments dropped), e.g. `items.sku`. */
  queryPath: string
  depth: number
  isElement: boolean
  /** Number of values seen (array elements counted individually). */
  count: number
  /** Documents containing the field at least once. */
  docCount: number
  /** docCount / sampled documents (0..1). */
  presence: number
  /** Containers (documents or parent objects) the field could appear in. */
  parentCount: number
  /** Present in every parent container (false for array element nodes). */
  always: boolean
  types: TypeStats[]
  nullable: boolean
  /** More than one kind of non-null value (e.g. String and Int32). */
  mixed: boolean
  /** Only different numeric types (Int32 + Double…), usually harmless. */
  numericMix: boolean
  distinct: number
  distinctCapped: boolean
  topValues: ValueCount[]
  samples: unknown[]
  children: FieldReport[]
  /** Set on an object whose keys are data (ids, dates…): how many keys were merged into its `*` child. */
  mapKeys?: number
  /** The `*` child of a map and everything below it: merged from many keys, so it has no query path. */
  dynamic?: boolean
}

export interface SchemaReport {
  docCount: number
  fields: FieldReport[]
  /** Total number of field nodes in the tree. */
  fieldCount: number
  mixedCount: number
  ms: number
}

interface TypeAcc {
  count: number
  /** Values that contributed to min / max / sum. */
  n: number
  min: number
  max: number
  sum: number
}

interface Acc {
  name: string
  path: string
  queryPath: string
  depth: number
  isElement: boolean
  count: number
  docCount: number
  lastDoc: number
  objectCount: number
  /** Keys of all object values together (tells maps from wide records). */
  keyTotal: number
  dynamic: boolean
  mapKeys: number
  types: Map<BsonTypeName, TypeAcc>
  values: Map<string, { v: unknown; t: BsonTypeName; n: number }>
  capped: boolean
  samples: unknown[]
  sampleKeys: Set<string>
  children: Map<string, Acc>
  element: Acc | null
}

const NUMERIC = new Set<BsonTypeName>(['int', 'long', 'double', 'decimal'])
/** Elements read per array: element statistics come from the first ones, array lengths stay exact. */
const MAX_ELEMENTS = 500
/** Key of the merged child of a map-like object (a real key never starts with NUL). */
const MAP_CHILD = '\u0000*'

function newAcc(name: string, path: string, queryPath: string, depth: number, isElement: boolean): Acc {
  return {
    name,
    path,
    queryPath,
    depth,
    isElement,
    count: 0,
    docCount: 0,
    lastDoc: -1,
    objectCount: 0,
    keyTotal: 0,
    dynamic: false,
    mapKeys: 0,
    types: new Map(),
    values: new Map(),
    capped: false,
    samples: [],
    sampleKeys: new Set(),
    children: new Map(),
    element: null
  }
}

/** Numeric value of any BSON number. */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  const t = (v as { _bsontype?: string })?._bsontype
  if (t === 'Long') return (v as { toNumber: () => number }).toNumber()
  if (t === 'Decimal128') return Number(String(v))
  return Number((v as { valueOf: () => unknown }).valueOf())
}

function valueKey(v: unknown, t: BsonTypeName): string | null {
  switch (t) {
    case 'string':
      return 's' + (v as string)
    case 'int':
    case 'long':
    case 'double':
    case 'decimal':
      return t + String(t === 'long' || t === 'decimal' ? String(v) : toNumber(v))
    case 'bool':
      return v ? 'btrue' : 'bfalse'
    case 'null':
      return 'null'
    case 'undefined':
      return 'undef'
    case 'date':
      return 'd' + (v as Date).getTime()
    case 'objectId':
      return 'o' + (v as { toHexString: () => string }).toHexString()
    case 'timestamp':
    case 'minKey':
    case 'maxKey':
      return t + String(v)
    default:
      return null
  }
}

function range(ta: TypeAcc, x: number): void {
  if (ta.n++ === 0) {
    ta.min = x
    ta.max = x
  } else {
    if (x < ta.min) ta.min = x
    if (x > ta.max) ta.max = x
  }
  ta.sum += x
}

/** Analyse a sample of documents: field paths, types, presence and value statistics. */
export function analyzeSchema(docs: readonly unknown[], opts: SchemaOptions = {}): SchemaReport {
  const t0 = performance.now()
  const cap = opts.distinctCap ?? 1000
  const sampleMax = opts.samples ?? 5
  const root = newAcc('', '', '', -1, false)

  const visit = (acc: Acc, v: unknown, doc: number): void => {
    acc.count++
    if (acc.lastDoc !== doc) {
      acc.lastDoc = doc
      acc.docCount++
    }
    const t = bsonTypeOf(v)
    let ta = acc.types.get(t)
    if (!ta) acc.types.set(t, (ta = { count: 0, n: 0, min: 0, max: 0, sum: 0 }))
    ta.count++
    switch (t) {
      case 'int':
      case 'long':
      case 'double':
      case 'decimal': {
        const n = toNumber(v)
        if (Number.isFinite(n)) range(ta, n)
        break
      }
      case 'date': {
        const ms = (v as Date).getTime()
        if (!isNaN(ms)) range(ta, ms)
        break
      }
      case 'string':
        range(ta, (v as string).length)
        break
      case 'array':
        range(ta, (v as unknown[]).length)
        break
      case 'objectId':
        range(ta, (v as { getTimestamp: () => Date }).getTimestamp().getTime())
        break
    }
    const key = valueKey(v, t)
    if (key !== null) {
      const e = acc.values.get(key)
      if (e) e.n++
      else if (acc.values.size < cap) acc.values.set(key, { v, t, n: 1 })
      else acc.capped = true
    }
    if (acc.samples.length < sampleMax && t !== 'object' && t !== 'array') {
      const sk = key ?? String(acc.samples.length)
      if (!acc.sampleKeys.has(sk)) {
        acc.sampleKeys.add(sk)
        acc.samples.push(v)
      }
    }
    if (t === 'object') {
      acc.objectCount++
      const o = v as Record<string, unknown>
      const keys = Object.keys(o)
      acc.keyTotal += keys.length
      for (const k of keys) {
        let c = acc.children.get(k)
        if (!c) {
          const p = acc.path ? `${acc.path}.${k}` : k
          const q = acc.queryPath ? `${acc.queryPath}.${k}` : k
          acc.children.set(k, (c = newAcc(k, p, q, acc.depth + 1, false)))
        }
        visit(c, o[k], doc)
      }
    } else if (t === 'array') {
      const arr = v as unknown[]
      if (arr.length) {
        if (!acc.element) acc.element = newAcc('[]', acc.path ? `${acc.path}.[]` : '[]', acc.queryPath, acc.depth + 1, true)
        for (let i = 0; i < Math.min(arr.length, MAX_ELEMENTS); i++) visit(acc.element, arr[i], doc)
      }
    }
  }

  docs.forEach((d, i) => {
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      root.objectCount++
      const o = d as Record<string, unknown>
      const keys = Object.keys(o)
      root.keyTotal += keys.length
      for (const k of keys) {
        let c = root.children.get(k)
        if (!c) root.children.set(k, (c = newAcc(k, k, k, 0, false)))
        visit(c, o[k], i)
      }
    }
  })

  const total = docs.length

  // Fold `s` (another key's statistics) into `t`. Document counts can only be estimated: capped at `docCap`.
  const merge = (t: Acc, s: Acc, docCap: number): void => {
    t.count += s.count
    t.docCount = Math.min(docCap, t.docCount + s.docCount)
    t.objectCount += s.objectCount
    t.keyTotal += s.keyTotal
    for (const [type, x] of s.types) {
      const y = t.types.get(type)
      if (!y) t.types.set(type, { ...x })
      else {
        y.count += x.count
        if (x.n) {
          y.min = y.n ? Math.min(y.min, x.min) : x.min
          y.max = y.n ? Math.max(y.max, x.max) : x.max
          y.n += x.n
          y.sum += x.sum
        }
      }
    }
    for (const [k, e] of s.values) {
      const x = t.values.get(k)
      if (x) x.n += e.n
      else if (t.values.size < cap) t.values.set(k, { ...e })
      else t.capped = true
    }
    if (s.capped) t.capped = true
    for (const v of s.samples) if (t.samples.length < sampleMax) t.samples.push(v)
    for (const [k, c] of s.children) {
      let d = t.children.get(k)
      if (!d) t.children.set(k, (d = newAcc(k, `${t.path}.${k}`, `${t.queryPath}.${k}`, t.depth + 1, false)))
      d.dynamic = true
      merge(d, c, docCap)
    }
    if (s.element) {
      if (!t.element) t.element = newAcc('[]', `${t.path}.[]`, t.queryPath, t.depth + 1, true)
      t.element.dynamic = true
      merge(t.element, s.element, docCap)
    }
  }

  // An object whose keys are data: keys present in fewer than half of its values are merged into one `*` child.
  const collapseMap = (acc: Acc, docCap: number): void => {
    if (!isMapLike(acc.children.size, acc.objectCount, acc.keyTotal)) return
    const star = newAcc('*', acc.path ? `${acc.path}.*` : '*', acc.queryPath ? `${acc.queryPath}.*` : '*', acc.depth + 1, false)
    star.dynamic = true
    const kept = new Map<string, Acc>()
    for (const [k, c] of acc.children) {
      if (c.count * 2 >= acc.objectCount) kept.set(k, c)
      else {
        merge(star, c, docCap)
        acc.mapKeys++
      }
    }
    if (!acc.mapKeys) return
    kept.set(MAP_CHILD, star)
    acc.children = kept
  }

  const topMax = opts.topValues ?? 10
  const topDistinct = opts.topValuesMaxDistinct ?? 50
  let fieldCount = 0
  let mixedCount = 0

  const finish = (acc: Acc, parentCount: number): FieldReport => {
    collapseMap(acc, acc.docCount)
    fieldCount++
    const types: TypeStats[] = [...acc.types.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([type, ta]) => {
        const s: TypeStats = { type, label: TYPE_LABELS[type], count: ta.count, pct: ta.count / acc.count }
        const span = { min: ta.min, max: ta.max, avg: ta.n ? ta.sum / ta.n : 0 }
        if (!ta.n && type !== 'array') return s
        if (NUMERIC.has(type)) s.number = span
        else if (type === 'string') s.string = span
        else if (type === 'date') s.date = { min: new Date(ta.min), max: new Date(ta.max) }
        else if (type === 'objectId') s.objectId = { min: new Date(ta.min), max: new Date(ta.max) }
        else if (type === 'array') {
          const el = acc.element
          const elementTypes = el
            ? [...el.types.entries()]
                .sort((a, b) => b[1].count - a[1].count)
                .map(([t, x]) => ({ type: t, label: TYPE_LABELS[t], count: x.count, pct: x.count / el.count }))
            : []
          s.array = { ...span, elementTypes }
        }
        return s
      })
    const kinds = types.filter((t) => t.type !== 'null' && t.type !== 'undefined')
    const families = new Set(kinds.map((t) => (NUMERIC.has(t.type) ? 'number' : t.type)))
    const mixed = families.size > 1
    if (mixed) mixedCount++
    const numericMix = !mixed && kinds.length > 1
    const tracked = acc.values.size > 0
    const topValues: ValueCount[] =
      tracked && !acc.capped && acc.values.size <= topDistinct
        ? [...acc.values.values()]
            .sort((a, b) => b.n - a.n)
            .slice(0, topMax)
            .map((e) => ({ value: e.v, type: e.t, count: e.n, pct: e.n / acc.count }))
        : []
    const children = [...acc.children.values()].map((c) => finish(c, acc.objectCount))
    if (acc.element) children.unshift(finish(acc.element, acc.count))
    return {
      name: acc.name,
      path: acc.path,
      queryPath: acc.queryPath,
      depth: acc.depth,
      isElement: acc.isElement,
      count: acc.count,
      docCount: acc.docCount,
      presence: total ? acc.docCount / total : 0,
      parentCount,
      always: !acc.isElement && parentCount > 0 && acc.count >= parentCount,
      types,
      nullable: acc.types.has('null'),
      mixed,
      numericMix,
      distinct: acc.values.size,
      distinctCapped: acc.capped,
      topValues,
      samples: acc.samples,
      children,
      ...(acc.mapKeys ? { mapKeys: acc.mapKeys } : {}),
      ...(acc.dynamic ? { dynamic: true } : {})
    }
  }

  collapseMap(root, total)
  const fields = [...root.children.values()].map((c) => finish(c, root.objectCount))
  const id = fields.findIndex((f) => f.name === '_id')
  if (id > 0) fields.unshift(...fields.splice(id, 1))
  return { docCount: total, fields, fieldCount, mixedCount, ms: performance.now() - t0 }
}

/** Depth-first list of every field node. */
export function flattenFields(fields: readonly FieldReport[]): FieldReport[] {
  const out: FieldReport[] = []
  const walk = (list: readonly FieldReport[]): void => {
    for (const f of list) {
      out.push(f)
      walk(f.children)
    }
  }
  walk(fields)
  return out
}

/** `$jsonSchema` / `$type` alias of a BSON type. */
export const JSON_SCHEMA_TYPES: Record<BsonTypeName, string> = {
  string: 'string',
  int: 'int',
  long: 'long',
  double: 'double',
  decimal: 'decimal',
  bool: 'bool',
  date: 'date',
  objectId: 'objectId',
  null: 'null',
  regex: 'regex',
  array: 'array',
  object: 'object',
  binary: 'binData',
  uuid: 'binData',
  timestamp: 'timestamp',
  code: 'javascript',
  symbol: 'symbol',
  dbref: 'object',
  minKey: 'minKey',
  maxKey: 'maxKey',
  undefined: 'undefined'
}

export interface JsonSchemaOptions {
  /** 'always-present': fields seen in every sampled parent are listed in `required`. */
  required?: 'always-present' | 'none'
}

type JsonSchema = Record<string, unknown>

/** MongoDB `$jsonSchema` describing the sampled documents. */
export function toJsonSchema(report: SchemaReport, opts: JsonSchemaOptions = {}): JsonSchema {
  const withRequired = (opts.required ?? 'always-present') === 'always-present'

  const objectSchema = (children: readonly FieldReport[]): JsonSchema => {
    const s: JsonSchema = { bsonType: 'object' }
    const anyKey = children.find((c) => c.dynamic && c.name === '*' && !c.isElement)
    const props = children.filter((c) => !c.isElement && c !== anyKey)
    const req = withRequired ? props.filter((c) => c.always).map((c) => c.name) : []
    if (req.length) s.required = req
    if (props.length) s.properties = Object.fromEntries(props.map((c) => [c.name, fieldSchema(c)]))
    if (anyKey) s.additionalProperties = fieldSchema(anyKey)
    return s
  }

  const fieldSchema = (f: FieldReport): JsonSchema => {
    const names = [...new Set(f.types.map((t) => JSON_SCHEMA_TYPES[t.type]))].filter((n) => n !== 'undefined')
    const s: JsonSchema = {}
    if (names.length) s.bsonType = names.length === 1 ? names[0] : names
    if (f.types.some((t) => t.type === 'object')) {
      const o = objectSchema(f.children)
      if (o.required) s.required = o.required
      if (o.properties) s.properties = o.properties
      if (o.additionalProperties) s.additionalProperties = o.additionalProperties
    }
    const el = f.children.find((c) => c.isElement)
    if (el && f.types.some((t) => t.type === 'array')) s.items = fieldSchema(el)
    return s
  }

  return objectSchema(report.fields)
}

/** mongosh command that installs the schema as the collection's validator. */
export function validatorCommand(coll: string, schema: JsonSchema): string {
  return `db.runCommand(${shellText({ collMod: coll, validator: { $jsonSchema: schema }, validationLevel: 'moderate' }, 2)})`
}

const IDENT = /^[A-Za-z_$][\w$]*$/

const keyText = (k: string): string => (IDENT.test(k) ? k : shellText(k))

/** Shell text of a value for a query filter (Int32 / Double written as plain numbers). */
export function filterValueText(v: unknown): string {
  const t = bsonTypeOf(v)
  if (t === 'int' || t === 'double') {
    const n = toNumber(v)
    if (Number.isFinite(n)) return String(n)
  }
  return shellText(v)
}

export type FieldQuery = { kind: 'exists' } | { kind: 'missing' } | { kind: 'type'; type: BsonTypeName } | { kind: 'equals'; value: unknown }

/** Query-bar filter text that finds documents matching a schema observation. */
export function fieldQueryText(f: Pick<FieldReport, 'queryPath'>, q: FieldQuery): string {
  const k = keyText(f.queryPath)
  switch (q.kind) {
    case 'exists':
      return `{ ${k}: { $exists: true } }`
    case 'missing':
      return `{ ${k}: { $exists: false } }`
    case 'type':
      return `{ ${k}: { $type: '${JSON_SCHEMA_TYPES[q.type]}' } }`
    case 'equals':
      return `{ ${k}: ${filterValueText(q.value)} }`
  }
}

/** The report as relaxed Extended JSON text. */
export function reportJson(report: SchemaReport): string {
  return EJSON.stringify(report as unknown as Record<string, unknown>, undefined, 2, { relaxed: true })
}
