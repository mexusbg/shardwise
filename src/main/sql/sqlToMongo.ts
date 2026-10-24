import type { Doc } from '@shared/api'
import type { FromSqlColumn, FromSqlEmbed, FromSqlSource, SqlColumnInfo, SqlTableDetail } from '@shared/migrationApi'
import { setPath, toBson } from './dialects/common'
import type { Dialect, SqlValue, ValueKind } from './dialects/types'
import type { Row } from './session'
import { stripSemicolon } from './session'

export type CellError = (column: string, message: string) => void

/** One document from a row: each included column at its (dotted) field, converted. */
export function rowToDoc(row: Row, columns: FromSqlColumn[], onError: CellError): Doc {
  const doc: Doc = {}
  for (const c of columns) {
    const field = c.field.trim()
    if (!c.include || !field) continue
    let v: unknown
    try {
      v = toBson(row[c.column], c.type, c.convert)
    } catch (e) {
      onError(c.column, (e as Error).message)
      v = null
    }
    setPath(doc, field, v)
  }
  return doc
}

const norm = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex')
  return String(v)
}

/** Comparable key of a row's columns; null when any part is NULL (never matches). */
export function rowKey(row: Row, columns: string[]): string | null {
  const parts = columns.map((c) => norm(row[c]))
  return parts.includes(null) ? null : JSON.stringify(parts)
}

const kindOfJs = (v: unknown): ValueKind => {
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= 2147483647 ? 'int' : 'double'
  if (typeof v === 'bigint') return 'long'
  if (typeof v === 'boolean') return 'bool'
  if (v instanceof Date) return 'date'
  if (v instanceof Uint8Array) return 'binary'
  return 'string'
}

export const toSqlParam = (v: unknown): SqlValue => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : (v as SqlValue))

export interface KeyQuery {
  sql: string
  params: SqlValue[]
  kinds: ValueKind[]
}

/** SELECTs for the rows of `schema.table` whose `columns` match any of `keys`, split to respect parameter limits. */
export function keyQueries(d: Dialect, schema: string, table: string, columns: string[], keys: unknown[][]): KeyQuery[] {
  const per = Math.max(1, Math.min(1000, Math.floor(d.maxParams / columns.length)))
  const out: KeyQuery[] = []
  const from = `SELECT * FROM ${d.qualified(schema, table)} WHERE `
  for (let i = 0; i < keys.length; i += per) {
    const chunk = keys.slice(i, i + per)
    const params: SqlValue[] = []
    const kinds: ValueKind[] = []
    let p = 1
    let where: string
    if (columns.length === 1) {
      const ph = chunk.map((k) => {
        params.push(toSqlParam(k[0]))
        kinds.push(kindOfJs(k[0]))
        return d.placeholder(p++)
      })
      where = `${d.quote(columns[0])} IN (${ph.join(', ')})`
    } else {
      where = chunk
        .map((k) => {
          const parts = columns.map((c, j) => {
            params.push(toSqlParam(k[j]))
            kinds.push(kindOfJs(k[j]))
            return `${d.quote(c)} = ${d.placeholder(p++)}`
          })
          return `(${parts.join(' AND ')})`
        })
        .join(' OR ')
    }
    out.push({ sql: from + where, params, kinds })
  }
  return out
}

/** Distinct non-null key tuples of `rows`. */
export function distinctKeys(rows: Row[], columns: string[]): unknown[][] {
  const seen = new Set<string>()
  const out: unknown[][] = []
  for (const r of rows) {
    const k = rowKey(r, columns)
    if (k === null || seen.has(k)) continue
    seen.add(k)
    out.push(columns.map((c) => r[c]))
  }
  return out
}

/** Attaches matched rows to the documents built from `rows` (same order). */
export function attachEmbed(e: FromSqlEmbed, rows: Row[], docs: Doc[], matches: Row[], onError: CellError): void {
  const groups = new Map<string, Row[]>()
  for (const m of matches) {
    const k = rowKey(m, e.foreignColumns)
    if (k === null) continue
    let g = groups.get(k)
    if (!g) groups.set(k, (g = []))
    g.push(m)
  }
  const field = e.field.trim()
  if (!field) return
  rows.forEach((r, i) => {
    const k = rowKey(r, e.localColumns)
    const found = k === null ? [] : (groups.get(k) ?? [])
    const sub = found.map((m) => rowToDoc(m, e.columns, (c, msg) => onError(`${e.table}.${c}`, msg)))
    if (e.as === 'array') setPath(docs[i], field, sub)
    else if (sub.length) setPath(docs[i], field, sub[0])
  })
}

export function selectFor(d: Dialect, s: FromSqlSource): string {
  if (s.kind === 'query') {
    const q = stripSemicolon(s.query ?? '')
    if (!q) throw new Error('The query is empty')
    return q
  }
  if (!s.table) throw new Error('Choose a table')
  return `SELECT * FROM ${d.qualified(s.schema ?? '', s.table)}`
}

const column = (c: SqlColumnInfo, field = c.name, include = true): FromSqlColumn => ({ column: c.name, type: c.type || undefined, field, include, convert: 'auto' })

/** Column mapping for a table: a single-column primary key becomes `_id`, a composite one `_id.<column>`. */
export function tableColumns(t: SqlTableDetail): FromSqlColumn[] {
  const pk = t.primaryKey
  return t.columns.map((c) => column(c, pk.length === 1 && pk[0] === c.name ? '_id' : pk.length > 1 && pk.includes(c.name) ? `_id.${c.name}` : c.name))
}

export const queryColumns = (cols: SqlColumnInfo[]): FromSqlColumn[] => cols.map((c) => column(c))

export function embedFor(id: string, fk: { schema: string; table: string; local: string[]; foreign: string[] }, detail: SqlTableDetail | null, as: 'array' | 'object'): FromSqlEmbed {
  const cols = (detail?.columns ?? []).map((c) => column(c, c.name, !(as === 'array' && fk.foreign.includes(c.name))))
  return { id, include: false, schema: fk.schema, table: fk.table, localColumns: fk.local, foreignColumns: fk.foreign, field: fk.table, as, columns: cols }
}

/** Columns without a declared type (expressions in custom queries) become Double when a value in the first rows has a fraction. */
export function inferMissingTypes(columns: FromSqlColumn[], rows: Row[]): FromSqlColumn[] {
  return columns.map((c) => {
    if (c.type || c.convert !== 'auto') return c
    const fraction = rows.some((r) => typeof r[c.column] === 'number' && !Number.isInteger(r[c.column]))
    return fraction ? { ...c, type: 'double precision' } : c
  })
}
