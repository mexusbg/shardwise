import { promises as fs } from 'fs'
import sql from 'mssql'
import type { IColumnMetadata, ISqlType } from 'mssql'
import type { SqlConnectionConfig, SqlTableDetail } from '@shared/migrationApi'
import { mssql } from '../dialects/mssql'
import type { SqlValue, ValueKind } from '../dialects/types'
import type { QueryResult, Row, SqlSession } from '../session'
import { groupForeignKeys, splitForeignKeys, stripSemicolon } from '../session'

function typeName(c: IColumnMetadata[string]): string {
  const decl = String((c.type as unknown as { declaration?: string })?.declaration ?? 'unknown')
  if (/char|binary/.test(decl)) {
    const len = c.length > 8000 || c.length < 0 ? 'max' : /^n/.test(decl) ? c.length / 2 : c.length
    return `${decl}(${len})`
  }
  if (/decimal|numeric/.test(decl)) return `${decl}(${c.precision},${c.scale})`
  return decl
}

const columnsOf = (cols: IColumnMetadata | undefined): QueryResult['columns'] =>
  Object.values(cols ?? {})
    .sort((a, b) => a.index - b.index)
    .map((c) => ({ name: c.name, type: typeName(c), nullable: c.nullable }))

/** Parameter type per value kind; long / decimal / uuid / JSON go as text and are converted by the server. */
function paramType(kind: ValueKind, v: SqlValue): ISqlType | (() => ISqlType) {
  switch (kind) {
    case 'int':
      return sql.Int
    case 'double':
      return sql.Float
    case 'bool':
      return sql.Bit
    case 'date':
      return sql.DateTime2(3)
    case 'binary':
      return sql.VarBinary(sql.MAX)
    case 'decimal':
      return typeof v === 'string' && /e/i.test(v) ? sql.Float : sql.NVarChar(sql.MAX)
    default:
      return sql.NVarChar(sql.MAX)
  }
}

export async function openMssql(cfg: SqlConnectionConfig, host: string, port: number, forwarded = !!cfg.ssh?.enabled): Promise<SqlSession> {
  const ca = cfg.tls?.enabled && cfg.tls.caFile ? await fs.readFile(cfg.tls.caFile, 'utf8') : undefined
  const pool = new sql.ConnectionPool({
    server: host,
    port: cfg.instance && !forwarded ? undefined : port,
    database: cfg.database || undefined,
    user: cfg.user || undefined,
    password: cfg.password || undefined,
    connectionTimeout: 15000,
    requestTimeout: 0,
    pool: { min: 0, max: 4 },
    options: {
      encrypt: !!cfg.tls?.enabled,
      trustServerCertificate: !cfg.tls?.enabled || !cfg.tls.rejectUnauthorized,
      instanceName: cfg.instance && !forwarded ? cfg.instance : undefined,
      useUTC: true,
      appName: 'Shardwise',
      ...(ca ? { cryptoCredentialsDetails: { ca } } : {})
    }
  })
  pool.on('error', () => {})
  await pool.connect()
  let tx: sql.Transaction | null = null

  const request = (): sql.Request => (tx ? new sql.Request(tx) : pool.request())
  const q = async (text: string, params: SqlValue[] = [], kinds: ValueKind[] = []): Promise<QueryResult> => {
    const req = request()
    params.forEach((v, i) => req.input(`p${i + 1}`, paramType(kinds[i] ?? 'string', v), mssql.bind(v, kinds[i] ?? 'string')))
    const r = await req.query(text)
    const rs = r.recordset
    return { rows: (rs ?? []) as Row[], columns: columnsOf(rs?.columns) }
  }
  const defaultSchema = String((await q('SELECT SCHEMA_NAME() AS s')).rows[0]?.s ?? 'dbo')

  return {
    dialect: mssql,
    defaultSchema,
    query: (s, params, kinds) => q(s, params, kinds),
    async exec(s) {
      // Generated scripts start with a UTF-8 BOM (for SSMS); read as text it is U+FEFF, which the server rejects.
      await request().batch(s.replace(/^\uFEFF/, ''))
    },
    async *stream(s, batch) {
      const req = pool.request()
      req.stream = true
      const queue: Row[] = []
      let columns: QueryResult['columns'] = []
      let done = false
      let error: Error | null = null
      let wake: (() => void) | null = null
      const poke = (): void => {
        const w = wake
        wake = null
        w?.()
      }
      req.on('recordset', (cols: IColumnMetadata) => (columns = columnsOf(cols)))
      req.on('row', (row: Row) => {
        queue.push(row)
        if (queue.length >= batch) req.pause()
        poke()
      })
      req.on('error', (e: Error) => {
        error ??= e
        poke()
      })
      req.on('done', () => {
        done = true
        poke()
      })
      void req.query(stripSemicolon(s)).catch(() => {})
      try {
        for (;;) {
          if (error) throw error
          if (queue.length >= batch || (done && queue.length)) {
            yield { rows: queue.splice(0, batch), columns }
            if (queue.length < batch) req.resume()
            continue
          }
          if (done) return
          await new Promise<void>((r) => (wake = r))
        }
      } finally {
        if (!done) req.cancel()
      }
    },
    async begin() {
      tx = new sql.Transaction(pool)
      await tx.begin()
    },
    async commit() {
      const t = tx
      tx = null
      await t?.commit()
    },
    async rollback() {
      const t = tx
      tx = null
      await t?.rollback()
    },
    async version() {
      const r = await q(`SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS v, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS e`)
      return `SQL Server ${String(r.rows[0]?.v ?? '')} ${String(r.rows[0]?.e ?? '')}`.trim()
    },
    async listSchemas() {
      const r = await q(`SELECT name FROM sys.schemas WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND name NOT LIKE 'db[_]%' ORDER BY name`)
      return r.rows.map((x) => String(x.name))
    },
    async listTables(schema) {
      const r = await q('SELECT table_name AS name, table_type AS type FROM INFORMATION_SCHEMA.TABLES WHERE table_schema = @p1 ORDER BY table_name', [schema])
      return r.rows.map((x) => ({ schema, name: String(x.name), kind: /view/i.test(String(x.type)) ? 'view' : 'table' }))
    },
    async describe(schema, table): Promise<SqlTableDetail> {
      const cols = await q(
        `SELECT column_name AS name, data_type AS type, character_maximum_length AS len, numeric_precision AS prec, numeric_scale AS scale, is_nullable AS nullable
         FROM INFORMATION_SCHEMA.COLUMNS WHERE table_schema = @p1 AND table_name = @p2 ORDER BY ordinal_position`,
        [schema, table]
      )
      if (!cols.rows.length) throw new Error(`Table ${schema}.${table} not found`)
      const pk = await q(
        `SELECT kcu.column_name AS name FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = @p1 AND tc.table_name = @p2 ORDER BY kcu.ordinal_position`,
        [schema, table]
      )
      const fk = await q(
        `SELECT fk.name, SCHEMA_NAME(tp.schema_id) AS sch, tp.name AS tbl, cp.name AS col, SCHEMA_NAME(tr.schema_id) AS rsch, tr.name AS rtbl, cr.name AS rcol
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
         JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
         JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
         JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
         WHERE (SCHEMA_NAME(tp.schema_id) = @p1 AND tp.name = @p2) OR (SCHEMA_NAME(tr.schema_id) = @p1 AND tr.name = @p2)
         ORDER BY tp.name, fk.name, fkc.constraint_column_id`,
        [schema, table]
      )
      const typeText = (c: Row): string => {
        const t = String(c.type)
        if (c.len !== null && c.len !== undefined) return `${t}(${Number(c.len) < 0 ? 'max' : c.len})`
        if (/decimal|numeric/.test(t)) return `${t}(${c.prec},${c.scale})`
        return t
      }
      return {
        schema,
        name: table,
        columns: cols.rows.map((c) => ({ name: String(c.name), type: typeText(c), nullable: c.nullable === 'YES' })),
        primaryKey: pk.rows.map((r) => String(r.name)),
        ...splitForeignKeys(groupForeignKeys(fk.rows as never), schema, table)
      }
    },
    async close() {
      await pool.close()
    }
  }
}
