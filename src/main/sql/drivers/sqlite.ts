import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import type { SqlForeignKey, SqlTableDetail, SqlTableInfo } from '@shared/migrationApi'
import { sqlite } from '../dialects/sqlite'
import type { SqlValue, ValueKind } from '../dialects/types'
import type { QueryResult, Row, SqlSession } from '../session'
import { stripSemicolon } from '../session'

type Bindable = null | number | bigint | string | Uint8Array

const columnsOf = (st: StatementSync): QueryResult['columns'] => st.columns().map((c) => ({ name: c.name, type: c.type ?? '', nullable: true }))

/** Converts Uint8Array blobs to Buffers so they behave like the other drivers' binary values. */
const fixRow = (r: Record<string, unknown>): Row => {
  for (const k in r) if (r[k] instanceof Uint8Array && !Buffer.isBuffer(r[k])) r[k] = Buffer.from(r[k] as Uint8Array)
  return r
}

export function openSqlite(file: string): SqlSession {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  const bind = (params: SqlValue[] = [], kinds: ValueKind[] = []): Bindable[] => params.map((v, i) => sqlite.bind(v, kinds[i] ?? 'string') as Bindable)

  const all = (sql: string, params: Bindable[] = []): Row[] => {
    const st = db.prepare(sql)
    return st.all(...params) as Row[]
  }

  const tables = (schema: string): SqlTableInfo[] =>
    all(`SELECT name, type FROM ${sqlite.quote(schema || 'main')}.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => ({
      schema: schema || 'main',
      name: String(r.name),
      kind: r.type === 'view' ? 'view' : 'table'
    }))

  const pkOf = (schema: string, table: string): string[] =>
    all('SELECT name, pk FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', [table, schema])
      .map((r) => String(r.name))

  const fksOf = (schema: string, table: string): SqlForeignKey[] => {
    const rows = all('SELECT id, seq, "table" AS ref, "from" AS col, "to" AS rcol FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', [table, schema])
    const byId = new Map<number, SqlForeignKey>()
    for (const r of rows) {
      const id = Number(r.id)
      let fk = byId.get(id)
      if (!fk) byId.set(id, (fk = { name: `fk_${table}_${id}`, schema, table, columns: [], refSchema: schema, refTable: String(r.ref), refColumns: [] }))
      fk.columns.push(String(r.col))
      if (r.rcol !== null) fk.refColumns.push(String(r.rcol))
    }
    for (const fk of byId.values()) if (!fk.refColumns.length) fk.refColumns = pkOf(schema, fk.refTable)
    return [...byId.values()]
  }

  return {
    dialect: sqlite,
    defaultSchema: '',
    async query(sql, params, kinds) {
      const st = db.prepare(sql)
      st.setReadBigInts(true)
      const columns = columnsOf(st)
      if (!columns.length) {
        st.run(...bind(params, kinds))
        return { rows: [], columns }
      }
      return { rows: (st.all(...bind(params, kinds)) as Row[]).map(fixRow), columns }
    },
    async exec(sql) {
      db.exec(sql)
    },
    async *stream(sql, batch) {
      const st = db.prepare(stripSemicolon(sql))
      st.setReadBigInts(true)
      const columns = columnsOf(st)
      let rows: Row[] = []
      for (const r of st.iterate()) {
        rows.push(fixRow(r as Row))
        if (rows.length >= batch) {
          yield { rows, columns }
          rows = []
        }
      }
      if (rows.length) yield { rows, columns }
    },
    async begin() {
      db.exec('BEGIN')
    },
    async commit() {
      db.exec('COMMIT')
    },
    async rollback() {
      if (db.isTransaction) db.exec('ROLLBACK')
    },
    async version() {
      return `SQLite ${String(all('SELECT sqlite_version() AS v')[0].v)}`
    },
    async listSchemas() {
      return all('PRAGMA database_list').map((r) => String(r.name)).filter((n) => n !== 'temp')
    },
    async listTables(schema) {
      return tables(schema)
    },
    async describe(schema, table): Promise<SqlTableDetail> {
      const s = schema || 'main'
      const cols = all('SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info(?, ?) ORDER BY cid', [table, s])
      if (!cols.length) throw new Error(`Table ${table} not found`)
      const referencedBy = tables(s)
        .filter((t) => t.kind === 'table')
        .flatMap((t) => fksOf(s, t.name))
        .filter((f) => f.refTable.toLowerCase() === table.toLowerCase())
      return {
        schema: s,
        name: table,
        columns: cols.map((c) => ({ name: String(c.name), type: String(c.type ?? ''), nullable: Number(c.nn) === 0 && Number(c.pk) === 0 })),
        primaryKey: cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name)),
        foreignKeys: fksOf(s, table),
        referencedBy
      }
    },
    async close() {
      if (db.isOpen) db.close()
    }
  }
}
