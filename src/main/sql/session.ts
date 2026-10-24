import type { SqlColumnInfo, SqlConnectionConfig, SqlForeignKey, SqlTableDetail, SqlTableInfo } from '@shared/migrationApi'
import { SQL_DIALECTS } from '@shared/migrationApi'
import { openSshTunnel } from '../mongo/sshTunnel'
import type { Tunnel } from '../mongo/sshTunnel'
import { connectVia, DIRECT, forwardVia, proxyRouter } from '../net/proxy'
import type { Dialect, SqlValue, ValueKind } from './dialects/types'

export type Row = Record<string, unknown>

export interface QueryResult {
  rows: Row[]
  columns: SqlColumnInfo[]
}

/** One open SQL connection. Not safe for concurrent use: callers serialise their statements. */
export interface SqlSession {
  dialect: Dialect
  /** Schema new tables go to when none is given (`public`, `dbo`, the MySQL database, '' for SQLite). */
  defaultSchema: string
  query(sql: string, params?: SqlValue[], kinds?: ValueKind[]): Promise<QueryResult>
  /** Runs a script of one or more statements. */
  exec(sql: string): Promise<void>
  /** Reads a SELECT in batches without loading it whole. Breaking out of the loop stops the query. */
  stream(sql: string, batch: number): AsyncGenerator<QueryResult>
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  version(): Promise<string>
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<SqlTableInfo[]>
  describe(schema: string, table: string): Promise<SqlTableDetail>
  close(): Promise<void>
}

/** Groups key_column_usage-style rows (one per column) into foreign keys. */
export function groupForeignKeys(rows: { name: string; sch: string; tbl: string; col: string; rsch: string; rtbl: string; rcol: string }[]): SqlForeignKey[] {
  const byName = new Map<string, SqlForeignKey>()
  for (const r of rows) {
    const k = `${r.sch}.${r.tbl}.${r.name}`
    let fk = byName.get(k)
    if (!fk) byName.set(k, (fk = { name: r.name, schema: r.sch, table: r.tbl, columns: [], refSchema: r.rsch, refTable: r.rtbl, refColumns: [] }))
    fk.columns.push(r.col)
    fk.refColumns.push(r.rcol)
  }
  return [...byName.values()]
}

export function splitForeignKeys(all: SqlForeignKey[], schema: string, table: string): Pick<SqlTableDetail, 'foreignKeys' | 'referencedBy'> {
  return {
    foreignKeys: all.filter((f) => f.schema === schema && f.table === table),
    referencedBy: all.filter((f) => f.refSchema === schema && f.refTable === table)
  }
}

export const stripSemicolon = (sql: string): string => sql.trim().replace(/;+\s*$/, '')

/** `forwarded`: host / port are a local port forward (SSH or proxy), so named-instance lookups cannot work. */
type Opener = (cfg: SqlConnectionConfig, host: string, port: number, forwarded: boolean) => Promise<SqlSession>

const openers: Record<Exclude<SqlConnectionConfig['dialect'], 'sqlite'>, () => Promise<Opener>> = {
  postgres: async () => (await import('./drivers/postgres')).openPostgres,
  mysql: async () => (await import('./drivers/mysql')).openMysql,
  mssql: async () => (await import('./drivers/mssql')).openMssql
}

/**
 * Opens a session, through an SSH tunnel and / or the proxy of Settings → Network & tools when configured. SQL
 * drivers dial by host and port, so a proxied server is reached through a local port forward.
 */
export async function openSqlSession(cfg: SqlConnectionConfig): Promise<SqlSession> {
  if (cfg.dialect === 'sqlite') {
    if (!cfg.file) throw new Error('Choose a SQLite database file')
    return (await import('./drivers/sqlite')).openSqlite(cfg.file)
  }
  if (!cfg.host && !cfg.ssh?.enabled) throw new Error('Host is required')
  let host = cfg.host || 'localhost'
  let port = cfg.port || SQL_DIALECTS.find((d) => d.id === cfg.dialect)!.port
  let forwarded = false
  let cleanup = async (): Promise<void> => {}
  if (cfg.ssh?.enabled) {
    const sshHost = cfg.ssh.host ?? ''
    const sshPort = cfg.ssh.port || 22
    const route = sshHost ? await proxyRouter.route(sshHost, sshPort) : DIRECT
    const sock = route.kind === 'proxy' ? await connectVia(route, sshHost, sshPort) : undefined
    let tunnel: Tunnel
    try {
      tunnel = await openSshTunnel(cfg.ssh, sock)
    } catch (e) {
      sock?.destroy()
      throw e
    }
    try {
      const fwd = await tunnel.forwardPort(host, port)
      host = '127.0.0.1'
      port = fwd.port
      forwarded = true
      cleanup = async () => {
        fwd.close()
        await tunnel.close()
      }
    } catch (e) {
      await tunnel.close()
      throw e
    }
  } else {
    const route = await proxyRouter.route(host, port)
    if (route.kind === 'proxy') {
      // Fail with the proxy's own message (bad credentials, refused) instead of a driver socket error.
      ;(await connectVia(route, host, port)).destroy()
      const fwd = await forwardVia(route, host, port)
      host = '127.0.0.1'
      port = fwd.port
      forwarded = true
      cleanup = async () => fwd.close()
    }
  }
  try {
    const s = await (await openers[cfg.dialect]())(cfg, host, port, forwarded)
    const close = s.close.bind(s)
    s.close = async () => {
      await close().catch(() => {})
      await cleanup()
    }
    return s
  } catch (e) {
    await cleanup()
    throw e
  }
}
