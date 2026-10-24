import { promises as fs } from 'fs'
import pg from 'pg'
import type { FieldDef } from 'pg'
import type { SqlConnectionConfig, SqlTableDetail } from '@shared/migrationApi'
import { parseSqlDate } from '../dialects/common'
import { postgres } from '../dialects/postgres'
import type { QueryResult, Row, SqlSession } from '../session'
import { groupForeignKeys, splitForeignKeys, stripSemicolon } from '../session'

const OIDS: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  26: 'oid',
  114: 'json',
  700: 'real',
  701: 'double precision',
  1042: 'character',
  1043: 'character varying',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamp with time zone',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb'
}

const typeName = (f: FieldDef): string => {
  const n = OIDS[f.dataTypeID] ?? 'unknown'
  return (f.dataTypeID === 1042 || f.dataTypeID === 1043) && f.dataTypeModifier > 4 ? `${n}(${f.dataTypeModifier - 4})` : n
}

/** Timestamps without time zone are read as UTC (pg would use local time); dates stay `YYYY-MM-DD` text. */
const types = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === 1114) return (s: string) => parseSqlDate(s) ?? s
    if (oid === 1082) return (s: string) => s
    return (pg.types.getTypeParser as (o: number, f?: string) => unknown)(oid, format)
  }) as never
}

let seq = 0

export async function openPostgres(cfg: SqlConnectionConfig, host: string, port: number): Promise<SqlSession> {
  const ssl = cfg.tls?.enabled
    ? { rejectUnauthorized: cfg.tls.rejectUnauthorized, ca: cfg.tls.caFile ? await fs.readFile(cfg.tls.caFile, 'utf8') : undefined, servername: cfg.host || undefined }
    : false
  const client = new pg.Client({
    host,
    port,
    database: cfg.database || undefined,
    user: cfg.user || undefined,
    password: cfg.password || undefined,
    ssl,
    types,
    connectionTimeoutMillis: 15000,
    application_name: 'Shardwise'
  })
  await client.connect()
  client.on('error', () => {})
  let inTx = false

  const q = async (sql: string, values?: unknown[]): Promise<QueryResult> => {
    const r = await client.query({ text: sql, values })
    return { rows: (r.rows ?? []) as Row[], columns: (r.fields ?? []).map((f) => ({ name: f.name, type: typeName(f), nullable: true })) }
  }
  const defaultSchema = String((await q('SELECT current_schema() AS s')).rows[0]?.s ?? 'public')

  return {
    dialect: postgres,
    defaultSchema,
    query: (sql, params, kinds) => q(sql, params?.map((v, i) => postgres.bind(v, kinds?.[i] ?? 'string'))),
    async exec(sql) {
      await client.query(sql)
    },
    async *stream(sql, batch) {
      const cursor = `mg_cursor_${++seq}`
      const own = !inTx
      if (own) await client.query('BEGIN')
      let finished = false
      try {
        await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${stripSemicolon(sql)}`)
        for (;;) {
          const r = await q(`FETCH ${batch} FROM ${cursor}`)
          if (r.rows.length) yield r
          if (r.rows.length < batch) break
        }
        await client.query(`CLOSE ${cursor}`)
        if (own) await client.query('COMMIT')
        finished = true
      } finally {
        if (!finished && own) await client.query('ROLLBACK').catch(() => {})
      }
    },
    async begin() {
      await client.query('BEGIN')
      inTx = true
    },
    async commit() {
      await client.query('COMMIT')
      inTx = false
    },
    async rollback() {
      inTx = false
      await client.query('ROLLBACK')
    },
    async version() {
      return `PostgreSQL ${String((await q('SHOW server_version')).rows[0]?.server_version ?? '')}`
    },
    async listSchemas() {
      const r = await q(
        `SELECT nspname AS name FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%' ORDER BY nspname`
      )
      return r.rows.map((x) => String(x.name))
    },
    async listTables(schema) {
      const r = await q(
        `SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname`,
        [schema]
      )
      return r.rows.map((x) => ({ schema, name: String(x.name), kind: x.kind === 'v' || x.kind === 'm' ? 'view' : 'table' }))
    },
    async describe(schema, table): Promise<SqlTableDetail> {
      const cols = await q(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [schema, table]
      )
      if (!cols.rows.length) throw new Error(`Table ${schema}.${table} not found`)
      const cons = await q(
        `SELECT con.conname AS name, con.contype AS kind, n1.nspname AS sch, c1.relname AS tbl, n2.nspname AS rsch, c2.relname AS rtbl,
           (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num) AS cols,
           (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num) AS rcols
         FROM pg_constraint con
         JOIN pg_class c1 ON c1.oid = con.conrelid JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
         LEFT JOIN pg_class c2 ON c2.oid = con.confrelid LEFT JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
         WHERE (con.contype = 'p' AND n1.nspname = $1 AND c1.relname = $2)
            OR (con.contype = 'f' AND ((n1.nspname = $1 AND c1.relname = $2) OR (n2.nspname = $1 AND c2.relname = $2)))
         ORDER BY con.conname`,
        [schema, table]
      )
      const pk = cons.rows.find((r) => r.kind === 'p')
      const fks = groupForeignKeys(
        cons.rows
          .filter((r) => r.kind === 'f')
          .flatMap((r) =>
            (r.cols as string[]).map((col, i) => ({
              name: String(r.name),
              sch: String(r.sch),
              tbl: String(r.tbl),
              col,
              rsch: String(r.rsch),
              rtbl: String(r.rtbl),
              rcol: (r.rcols as string[])[i]
            }))
          )
      )
      return {
        schema,
        name: table,
        columns: cols.rows.map((c) => ({ name: String(c.name), type: String(c.type), nullable: !!c.nullable })),
        primaryKey: pk ? (pk.cols as string[]) : [],
        ...splitForeignKeys(fks, schema, table)
      }
    },
    async close() {
      await client.end()
    }
  }
}
