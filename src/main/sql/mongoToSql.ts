import { bsonTypeOf, isPlainDoc } from '@shared/bsonValue'
import type { BsonTypeName } from '@shared/bsonValue'
import { isMapLike } from '@shared/mapKeys'
import type { PlannedColumn, PlannedTable, ToSqlCollection, ToSqlField } from '@shared/migrationApi'
import { createTableSql, kindOfSqlType, sanitizeName, toSqlValue, uniqueName } from './dialects/common'
import type { Dialect, SqlValue, ValueKind } from './dialects/types'

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

const MAX_DEPTH = 12

interface Stat {
  count: number
  nulls: number
  types: Map<BsonTypeName, number>
  maxLen: number
  children: Map<string, Stat>
  /** Keys of all object values together (to tell maps from wide records). */
  keys: number
  elem?: Stat
}

const newStat = (): Stat => ({ count: 0, nulls: 0, types: new Map(), maxLen: 0, children: new Map(), keys: 0 })

/**
 * Whether the object values' keys differ from document to document (`{ perms: { <user id>: … } }`): one
 * field per key would make thousands of columns, so the whole object becomes one JSON column.
 */
function isMap(s: Stat): boolean {
  return isMapLike(s.children.size, s.types.get('object') ?? 0, s.keys)
}

function observe(s: Stat, v: unknown, depth: number): void {
  s.count++
  const t = bsonTypeOf(v)
  if (t === 'null' || t === 'undefined') {
    s.nulls++
    return
  }
  s.types.set(t, (s.types.get(t) ?? 0) + 1)
  if (t === 'string') s.maxLen = Math.max(s.maxLen, (v as string).length)
  if (depth >= MAX_DEPTH) return
  if (t === 'object' && isPlainDoc(v)) {
    const entries = Object.entries(v)
    s.keys += entries.length
    for (const [k, x] of entries) {
      let c = s.children.get(k)
      if (!c) s.children.set(k, (c = newStat()))
      observe(c, x, depth + 1)
    }
  } else if (t === 'array') {
    const e = (s.elem ??= newStat())
    for (const x of v as unknown[]) observe(e, x, depth + 1)
  }
}

function dominant(s: Stat): { type: BsonTypeName | null; others: number } {
  let best: BsonTypeName | null = null
  let n = 0
  let total = 0
  for (const [t, c] of s.types) {
    total += c
    if (c > n) {
      best = t
      n = c
    }
  }
  return { type: best, others: total - n }
}

function toField(name: string, s: Stat, depth: number): ToSqlField {
  const { type, others } = dominant(s)
  const base = { name, count: s.count, nulls: s.nulls, include: true, column: sanitizeName(name), sqlType: '' }
  if (type === 'object' && isMap(s)) return { ...base, kind: 'object', bson: 'object', mixed: others, mode: 'json', table: '', fields: [], distinctKeys: s.children.size }
  if (type === 'object' && depth < MAX_DEPTH) {
    const fields = [...s.children].map(([k, c]) => toField(k, c, depth + 1))
    return { ...base, kind: 'object', bson: 'object', mixed: others, mode: fields.length ? 'flatten' : 'json', table: '', fields }
  }
  if (type === 'array' && depth < MAX_DEPTH) {
    const e = s.elem ?? newStat()
    const ed = dominant(e)
    const elemType = ed.type ?? 'string'
    const f: ToSqlField = { ...base, kind: 'array', bson: elemType, mixed: others + ed.others, mode: elemType === 'array' ? 'json' : 'table', table: '' }
    if (elemType === 'object' && isMap(e)) Object.assign(f, { mode: 'json', fields: [], distinctKeys: e.children.size })
    else if (elemType === 'object') f.fields = [...e.children].map(([k, c]) => toField(k, c, depth + 2))
    if (elemType === 'string') f.maxLen = e.maxLen
    return f
  }
  const f: ToSqlField = { ...base, kind: 'scalar', bson: type ?? 'null', mixed: others }
  if (type === 'string') f.maxLen = s.maxLen
  if (type === 'object' || type === 'array') f.mode = 'json'
  return f
}

/** Relational mapping inferred from sample documents: one root table, `_id` first. */
export function inferCollection(coll: string, docs: readonly unknown[]): ToSqlCollection {
  const root = newStat()
  let objects = 0
  for (const d of docs) {
    if (!isPlainDoc(d)) continue
    objects++
    const entries = Object.entries(d)
    root.keys += entries.length
    for (const [k, v] of entries) {
      let c = root.children.get(k)
      if (!c) root.children.set(k, (c = newStat()))
      observe(c, v, 1)
    }
  }
  if (!root.children.has('_id')) root.children.set('_id', { ...newStat(), types: new Map([['objectId', 1]]) })
  // Top-level keys that are data (a different set in every document): the rare ones share one JSON column.
  let rest: ToSqlField | null = null
  if (isMapLike(root.children.size, objects, root.keys)) {
    let rare = 0
    for (const [k, s] of [...root.children]) {
      if (k === '_id' || s.count * 2 >= objects) continue
      root.children.delete(k)
      rare++
    }
    if (rare) {
      const base = { count: objects, nulls: 0, mixed: 0, include: true, sqlType: '', table: '' }
      rest = { ...base, name: '*', kind: 'object', bson: 'object', column: 'other_fields', mode: 'json', fields: [], distinctKeys: rare, rest: true }
    }
  }
  const fields = [...root.children].map(([k, s]) => toField(k, s, 1))
  const id = fields.findIndex((f) => f.name === '_id')
  const [idField] = fields.splice(id, 1)
  // `_id` is a single column: keep sub-documents / arrays as JSON text.
  if (idField.kind !== 'scalar') Object.assign(idField, { kind: 'scalar', mode: 'json', fields: undefined })
  return { coll, include: true, table: sanitizeName(coll), sampled: docs.length, fields: [idField, ...fields, ...(rest ? [rest] : [])] }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface ColumnRecipe extends PlannedColumn {
  kind: ValueKind
  get: 'field' | 'key' | 'idx' | 'value' | 'rest'
  path?: string[]
  /** `rest`: the top-level keys that have columns of their own. */
  except?: string[]
  keyIndex?: number
}

export interface TableRecipe extends PlannedTable {
  cols: ColumnRecipe[]
  /** Indexes of the primary key columns in `cols`. */
  pkIdx: number[]
  /** Index of this table's own key in the primary key (root `_id`, array index); -1 for 1:1 tables. */
  ownKey: number
  children: { path: string[]; table: TableRecipe }[]
}

export interface CollectionPlan {
  coll: ToSqlCollection
  root: TableRecipe
  /** Parents first. */
  tables: TableRecipe[]
  /** Field path → default SQL type. */
  autoTypes: Record<string, string>
}

const columnKind = (type: string, json: boolean): ValueKind => {
  const k = kindOfSqlType(type)
  return json && k === 'string' ? 'json' : k
}

/** Tables, columns and extraction recipes for the included collections; table names are unique across all of them. */
export function planCollections(colls: ToSqlCollection[], d: Dialect): CollectionPlan[] {
  const usedTables = new Set<string>()
  return colls.filter((c) => c.include).map((c) => planCollection(c, d, usedTables))
}

function planCollection(c: ToSqlCollection, d: Dialect, usedTables: Set<string>): CollectionPlan {
  const autoTypes: Record<string, string> = {}
  const tables: TableRecipe[] = []
  const usedCols = new Map<TableRecipe, Set<string>>()

  const newTable = (name: string, kind: TableRecipe['kind'], path: string, parent?: TableRecipe): TableRecipe => {
    const t: TableRecipe = { id: `${c.coll}:${path || '$root'}`, name: uniqueName(name, usedTables, d.maxIdent), coll: c.coll, path, kind, columns: [], cols: [], primaryKey: [], pkIdx: [], ownKey: -1, children: [] }
    if (parent) t.parent = parent.id
    usedCols.set(t, new Set())
    tables.push(t)
    return t
  }
  const addCol = (t: TableRecipe, col: Omit<ColumnRecipe, 'name'> & { name: string }): ColumnRecipe => {
    const r: ColumnRecipe = { ...col, name: uniqueName(col.name, usedCols.get(t)!, d.maxIdent) }
    t.cols.push(r)
    t.columns.push({ name: r.name, type: r.type, nullable: r.nullable, key: r.key, source: r.source })
    if (r.key) {
      t.pkIdx.push(t.cols.length - 1)
      t.primaryKey.push(r.name)
    }
    return r
  }

  const fieldType = (f: ToSqlField, full: string, key = false, json = false): string => {
    const auto = json ? d.typeFor('object') : d.typeFor(key && f.mixed ? 'string' : f.bson, { key, maxLen: f.maxLen })
    autoTypes[full] = auto
    return f.sqlType.trim() || auto
  }

  const child = (parent: TableRecipe, f: ToSqlField, prefix: string, rel: string[], full: string, kind: TableRecipe['kind']): TableRecipe => {
    const t = newTable(f.table?.trim() || `${parent.name}_${prefix}${f.column || f.name}`, kind, full, parent)
    const fk: string[] = []
    parent.pkIdx.forEach((ci, i) => {
      const pc = parent.cols[ci]
      const name = i === parent.ownKey ? `${parent.name}_${parent.kind === 'root' ? 'id' : 'idx'}` : pc.name
      fk.push(addCol(t, { name, type: pc.type, kind: pc.kind, nullable: false, key: true, source: '(parent)', get: 'key', keyIndex: i }).name)
    })
    t.foreignKey = { columns: fk, table: parent.name, refColumns: [...parent.primaryKey] }
    if (kind !== 'object') {
      addCol(t, { name: 'idx', type: d.typeFor('int'), kind: 'int', nullable: false, key: true, source: '(index)', get: 'idx' })
      t.ownKey = t.pkIdx.length - 1
    }
    parent.children.push({ path: rel, table: t })
    return t
  }

  const addFields = (t: TableRecipe, fields: ToSqlField[], rel: string[], prefix: string, fullBase: string): void => {
    for (const f of fields) {
      if (!f.include) continue
      if (f.rest) {
        const type = fieldType(f, '*', false, true)
        const except = c.fields.filter((x) => !x.rest).map((x) => x.name)
        addCol(t, { name: f.column || 'other_fields', type, kind: columnKind(type, true), nullable: true, key: false, source: '(other fields)', get: 'rest', except })
        continue
      }
      const path = [...rel, f.name]
      const full = fullBase ? `${fullBase}.${f.name}` : f.name
      if (f.kind === 'object' && f.mode !== 'json' && f.fields?.length) {
        if (f.mode === 'table') addFields(child(t, f, prefix, path, full, 'object'), f.fields, [], '', full)
        else addFields(t, f.fields, path, `${prefix}${f.column || f.name}_`, full)
      } else if (f.kind === 'array' && f.mode === 'table') {
        if (f.bson === 'object' && f.fields?.length) addFields(child(t, f, prefix, path, full, 'documents'), f.fields, [], '', full)
        else {
          const ct = child(t, f, prefix, path, full, 'scalars')
          const type = fieldType(f, full, false, f.bson === 'array' || f.bson === 'object')
          addCol(ct, { name: 'value', type, kind: columnKind(type, f.bson === 'array' || f.bson === 'object'), nullable: true, key: false, source: '(value)', get: 'value' })
        }
      } else {
        const json = f.kind !== 'scalar' || f.mode === 'json'
        const type = fieldType(f, full, false, json)
        addCol(t, { name: `${prefix}${f.column || f.name}`, type, kind: columnKind(type, json), nullable: true, key: false, source: full, get: 'field', path })
      }
    }
  }

  const root = newTable(c.table.trim() || sanitizeName(c.coll), 'root', '')
  const idField = c.fields.find((f) => f.name === '_id')
  const idJson = !!idField && (idField.kind !== 'scalar' || idField.mode === 'json')
  let idType: string
  if (!idField) idType = d.typeFor('objectId', { key: true })
  else if (idJson) {
    autoTypes._id = d.typeFor('string', { key: true })
    idType = idField.sqlType.trim() || autoTypes._id
  } else idType = fieldType(idField, '_id', true)
  addCol(root, { name: idField?.column || '_id', type: idType, kind: columnKind(idType, idJson), nullable: false, key: true, source: '_id', get: 'field', path: ['_id'] })
  root.ownKey = 0
  addFields(root, c.fields.filter((f) => f.name !== '_id'), [], '', '')
  return { coll: c, root, tables, autoTypes }
}

/** The plan without extraction details (sent to the renderer). */
export const plannedTable = (t: TableRecipe): PlannedTable => {
  const p: PlannedTable = { id: t.id, name: t.name, coll: t.coll, path: t.path, kind: t.kind, columns: t.columns, primaryKey: t.primaryKey }
  if (t.parent) p.parent = t.parent
  if (t.foreignKey) p.foreignKey = t.foreignKey
  return p
}

export function ddlFor(plans: CollectionPlan[], d: Dialect, schema: string): string[] {
  return plans.flatMap((p) => p.tables.map((t) => createTableSql(d, schema, t)))
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractStats {
  /** `table.column` → values converted from another type. */
  converted: Map<string, number>
  /** `table.column` → values that could not be converted (NULL). */
  lost: Map<string, number>
  /** `table` → array elements skipped (not documents). */
  skipped: Map<string, number>
}

export const newExtractStats = (): ExtractStats => ({ converted: new Map(), lost: new Map(), skipped: new Map() })

const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1)

/** The keys of `doc` not in `except` (undefined when there are none). */
function restOf(doc: unknown, except: string[]): Record<string, unknown> | undefined {
  if (!isPlainDoc(doc)) return undefined
  const skip = new Set(except)
  const out: Record<string, unknown> = {}
  let any = false
  for (const [k, v] of Object.entries(doc)) {
    if (skip.has(k)) continue
    out[k] = v
    any = true
  }
  return any ? out : undefined
}

function getPath(v: unknown, path: string[]): unknown {
  let cur = v
  for (const k of path) {
    if (!isPlainDoc(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/** Rows of every table for one document; `emit` is called parents first. */
export function extractDoc(doc: unknown, root: TableRecipe, emit: (t: TableRecipe, row: SqlValue[]) => void, stats: ExtractStats): void {
  const fill = (t: TableRecipe, elem: unknown, keys: SqlValue[], idx?: number): void => {
    const row = t.cols.map((c): SqlValue => {
      if (c.get === 'key') return keys[c.keyIndex!]
      if (c.get === 'idx') return idx ?? 0
      const v = c.get === 'value' ? elem : c.get === 'rest' ? restOf(elem, c.except!) : getPath(elem, c.path!)
      const r = toSqlValue(v, c.kind)
      if (r.converted) bump(stats.converted, `${t.name}.${c.name}`)
      if (r.lost) bump(stats.lost, `${t.name}.${c.name}`)
      return r.value
    })
    if (t.kind === 'root' && row[t.pkIdx[0]] === null) throw new Error(`_id ${JSON.stringify(String(getPath(elem, ['_id'])))} cannot be stored as ${t.cols[t.pkIdx[0]].type}`)
    emit(t, row)
    const mine = t.pkIdx.map((i) => row[i])
    for (const ch of t.children) {
      const v = getPath(elem, ch.path)
      if (ch.table.kind === 'object') {
        if (isPlainDoc(v)) fill(ch.table, v, mine)
      } else if (Array.isArray(v)) {
        v.forEach((e, i) => {
          if (ch.table.kind === 'documents' && !isPlainDoc(e)) bump(stats.skipped, ch.table.name)
          else fill(ch.table, e, mine, i)
        })
      }
    }
  }
  fill(root, doc, [])
}

/** Display text of a SQL value for previews. */
export function sqlValueText(v: SqlValue): string | null {
  if (v === null) return null
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `0x${v.subarray(0, 32).toString('hex')}${v.length > 32 ? '…' : ''}`
  const s = String(v)
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

export function statsLines(s: ExtractStats): string[] {
  const out: string[] = []
  for (const [k, n] of s.converted) out.push(`${k}: ${n.toLocaleString('en-US')} value(s) converted from another type`)
  for (const [k, n] of s.lost) out.push(`${k}: ${n.toLocaleString('en-US')} value(s) could not be converted and were stored as NULL`)
  for (const [k, n] of s.skipped) out.push(`${k}: ${n.toLocaleString('en-US')} array element(s) skipped (not documents)`)
  return out
}
