import { promises as fs } from 'fs'
import mysql2 from 'mysql2/promise'
import type { FieldPacket } from 'mysql2/promise'
import type { Connection as CallbackConnection } from 'mysql2'
import type { SqlConnectionConfig, SqlTableDetail } from '@shared/migrationApi'
import { mysql } from '../dialects/mysql'
import type { QueryResult, Row, SqlSession } from '../session'
import { groupForeignKeys, splitForeignKeys, stripSemicolon } from '../session'

const TYPES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  249: 'blob',
  250: 'blob',
  251: 'blob',
  252: 'blob',
  253: 'varchar',
  254: 'char'
}

const BINARY_CHARSET = 63

function typeName(f: FieldPacket): string {
  const code = (f as { columnType?: number }).columnType ?? (f as { type?: number }).type ?? -1
  const len = (f as { columnLength?: number }).columnLength ?? 0
  const binary = (f as { characterSet?: number }).characterSet === BINARY_CHARSET
  const n = TYPES[code] ?? 'unknown'
  if (code === 1 && len === 1) return 'tinyint(1)'
  if (n === 'blob') return binary ? 'blob' : 'text'
  if (n === 'varchar' || n === 'char') return binary ? 'varbinary' : `${n}(${Math.round(len / 4) || len})`
  return n
}

const columnsOf = (fields: FieldPacket[] | undefined): QueryResult['columns'] => (fields ?? []).map((f) => ({ name: f.name, type: typeName(f), nullable: true }))

export async function openMysql(cfg: SqlConnectionConfig, host: string, port: number): Promise<SqlSession> {
  const ssl = cfg.tls?.enabled ? { rejectUnauthorized: cfg.tls.rejectUnauthorized, ca: cfg.tls.caFile ? await fs.readFile(cfg.tls.caFile, 'utf8') : undefined } : undefined
  const conn = await mysql2.createConnection({
    host,
    port,
    user: cfg.user || undefined,
    password: cfg.password || undefined,
    database: cfg.database || undefined,
    ssl,
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
    connectTimeout: 15000
  })
  conn.on('error', () => {})
  let dead = false

  const q = async (sql: string, values?: unknown[]): Promise<QueryResult> => {
    const [rows, fields] = await conn.query({ sql, values })
    return { rows: Array.isArray(rows) ? (rows as Row[]) : [], columns: columnsOf(fields as FieldPacket[] | undefined) }
  }
  const defaultSchema = String((await q('SELECT DATABASE() AS db')).rows[0]?.db ?? '')

  return {
    dialect: mysql,
    defaultSchema,
    query: (sql, params, kinds) => q(sql, params?.map((v, i) => mysql.bind(v, kinds?.[i] ?? 'string'))),
    async exec(sql) {
      for (const s of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await conn.query(s)
    },
    async *stream(sql, batch) {
      const raw = (conn as unknown as { connection: CallbackConnection }).connection
      const query = raw.query(stripSemicolon(sql))
      let columns: QueryResult['columns'] = []
      query.on('fields', (f: FieldPacket[]) => (columns = columnsOf(f)))
      const stream = query.stream({ highWaterMark: batch })
      let finished = false
      try {
        let rows: Row[] = []
        for await (const r of stream) {
          rows.push(r as Row)
          if (rows.length >= batch) {
            yield { rows, columns }
            rows = []
          }
        }
        if (rows.length) yield { rows, columns }
        finished = true
      } finally {
        if (!finished) {
          // The protocol cannot abandon a result set: drop the connection.
          dead = true
          stream.destroy()
          conn.destroy()
        }
      }
    },
    async begin() {
      await conn.query('START TRANSACTION')
    },
    async commit() {
      await conn.query('COMMIT')
    },
    async rollback() {
      if (!dead) await conn.query('ROLLBACK')
    },
    async version() {
      const v = String((await q('SELECT VERSION() AS v')).rows[0]?.v ?? '')
      return /mariadb/i.test(v) ? `MariaDB ${v}` : `MySQL ${v}`
    },
    async listSchemas() {
      const r = await q(
        `SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY schema_name`
      )
      return r.rows.map((x) => String(x.name))
    },
    async listTables(schema) {
      const r = await q('SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [schema])
      return r.rows.map((x) => ({ schema, name: String(x.name), kind: /view/i.test(String(x.type)) ? 'view' : 'table' }))
    },
    async describe(schema, table): Promise<SqlTableDetail> {
      const cols = await q(
        'SELECT column_name AS name, column_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
        [schema, table]
      )
      if (!cols.rows.length) throw new Error(`Table ${schema}.${table} not found`)
      const pk = await q(
        `SELECT column_name AS name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`,
        [schema, table]
      )
      const fk = await q(
        `SELECT constraint_name AS name, table_schema AS sch, table_name AS tbl, column_name AS col,
           referenced_table_schema AS rsch, referenced_table_name AS rtbl, referenced_column_name AS rcol
         FROM information_schema.key_column_usage
         WHERE referenced_table_name IS NOT NULL AND ((table_schema = ? AND table_name = ?) OR (referenced_table_schema = ? AND referenced_table_name = ?))
         ORDER BY table_name, constraint_name, ordinal_position`,
        [schema, table, schema, table]
      )
      return {
        schema,
        name: table,
        columns: cols.rows.map((c) => ({ name: String(c.name), type: String(c.type), nullable: c.nullable === 'YES' })),
        primaryKey: pk.rows.map((r) => String(r.name)),
        ...splitForeignKeys(groupForeignKeys(fk.rows as never), schema, table)
      }
    },
    async close() {
      if (!dead) await conn.end().catch(() => conn.destroy())
    }
  }
}
