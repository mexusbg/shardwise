import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import { deserialize, serialize } from 'bson'
import type { MongoClient } from 'mongodb'
import type { Doc } from '@shared/api'
import type { ConnectionConfig } from '@shared/connection'
import { DEFAULT_CHANGE_SETTINGS } from '@shared/changeHistoryApi'
import type {
  ChangeBatchInfo,
  ChangeHistorySettings,
  ChangeHistoryStats,
  ChangeOp,
  ChangeQuery,
  ChangeRecordInfo,
  ChangeSource,
  PurgeRequest
} from '@shared/changeHistoryApi'
import { docIdText, parseDocId, RAW } from './recorder'
import type { ChangeBatch, ChangeEntry, ChangeRecorders, ConnRecorder } from './recorder'

/** What ChangeHistory needs from the connection manager (ConnectionManager satisfies it). */
export interface ChangeConnections {
  get(connId: string): MongoClient
  config(connId: string): ConnectionConfig
}

export interface Owner {
  configId: string
  connName: string
  /** The connection's Change History override; undefined follows the global setting. */
  history?: boolean
}

/** A stored record with its images (main-process only). */
export interface ChangeRow extends ChangeRecordInfo {
  configId: string
  docIdText: string
  before: Doc | null
  after: Doc | null
}

export const ownerOf = (cfg: Pick<ConnectionConfig, 'id' | 'name' | 'overrides'>): Owner => ({ configId: cfg.id, connName: cfg.name, history: cfg.overrides?.changeHistory })

const DAY = 86_400_000
const AGE_PRUNE_INTERVAL = 3_600_000
const ROW_OVERHEAD = 96
/** Size pruning goes down to this share of the limit. */
const PRUNE_TO = 0.9

const SCHEMA = `
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  configId TEXT NOT NULL,
  connName TEXT NOT NULL,
  db TEXT NOT NULL,
  coll TEXT NOT NULL,
  op TEXT NOT NULL,
  source TEXT NOT NULL,
  batchId TEXT NOT NULL,
  docId TEXT NOT NULL,
  label TEXT,
  before BLOB,
  after BLOB,
  size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_ns ON changes (configId, db, coll, at);
CREATE INDEX IF NOT EXISTS changes_batch ON changes (batchId);
CREATE INDEX IF NOT EXISTS changes_at ON changes (at);
`

const INFO_COLUMNS = 'id, at, batchId, db, coll, op, source, docId, label, before IS NOT NULL AS hasBefore, after IS NOT NULL AS hasAfter, size'

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
}

function normalize(s: Partial<ChangeHistorySettings>): ChangeHistorySettings {
  const d = DEFAULT_CHANGE_SETTINGS
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    retentionDays: clampInt(s.retentionDays ?? d.retentionDays, 0, 3650, d.retentionDays),
    maxSizeMB: clampInt(s.maxSizeMB ?? d.maxSizeMB, 1, 1_000_000, d.maxSizeMB),
    maxDocsPerOp: clampInt(s.maxDocsPerOp ?? d.maxDocsPerOp, 1, 10_000_000, d.maxDocsPerOp)
  }
}

const toBlob = (d: Doc | null | undefined): Uint8Array | null => (d ? serialize(d) : null)
export const fromBlob = (b: unknown): Doc | null => (b instanceof Uint8Array ? (deserialize(b, RAW) as Doc) : null)

type Row = Record<string, SQLInputValue>

function info(r: Row): ChangeRecordInfo {
  return {
    id: Number(r.id),
    at: new Date(Number(r.at)),
    batchId: String(r.batchId),
    db: String(r.db),
    coll: String(r.coll),
    op: r.op as ChangeOp,
    source: r.source as ChangeSource,
    docId: r.op === 'drop' ? null : parseDocId(String(r.docId)),
    label: r.label == null ? undefined : String(r.label),
    hasBefore: !!r.hasBefore,
    hasAfter: !!r.hasAfter,
    size: Number(r.size)
  }
}

/** Change History storage: before / after images in `<userData>/change-history.db`, settings next to it. */
export class ChangeHistory implements ChangeRecorders {
  static dbPath = (dir: string): string => join(dir, 'change-history.db')
  static settingsPath = (dir: string): string => join(dir, 'change-history.json')

  readonly db: DatabaseSync
  private cfg: ChangeHistorySettings
  private total = 0
  private lastAgePrune = 0
  private lastError?: { at: Date; message: string }
  private insertStmt: StatementSync

  constructor(
    private dir: string,
    readonly mgr: ChangeConnections,
    private now: () => number = Date.now
  ) {
    mkdirSync(dir, { recursive: true })
    this.cfg = this.loadSettings()
    this.db = this.open()
    this.insertStmt = this.db.prepare(
      'INSERT INTO changes (at, configId, connName, db, coll, op, source, batchId, docId, label, before, after, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.recount()
    this.prune()
  }

  /**
   * Opens (creating) the database. It is opened at startup, so a damaged file must not stop the app: it is moved
   * aside and recreated; anything else falls back to an in-memory database (history is then not kept).
   */
  private open(): DatabaseSync {
    const file = ChangeHistory.dbPath(this.dir)
    const init = (path: string): DatabaseSync => {
      const db = new DatabaseSync(path)
      try {
        db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
        db.exec(SCHEMA)
        return db
      } catch (e) {
        db.close()
        throw e
      }
    }
    try {
      return init(file)
    } catch (e) {
      const code = (e as { errcode?: number }).errcode
      // SQLITE_CORRUPT / SQLITE_NOTADB: keep the bad file for inspection and start over.
      if (code === 11 || code === 26) {
        try {
          const bad = `${file}.bad-${this.now()}`
          renameSync(file, bad)
          for (const s of ['-wal', '-shm']) rmSync(file + s, { force: true })
          this.fail(`the database was damaged and was moved to ${bad}`, e)
          return init(file)
        } catch (e2) {
          e = e2
        }
      }
      this.fail('could not open the database; changes are kept in memory until restart', e)
      return init(':memory:')
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  // -------------------------------------------------------------------------
  // Settings & stats
  // -------------------------------------------------------------------------

  private loadSettings(): ChangeHistorySettings {
    try {
      return normalize(JSON.parse(readFileSync(ChangeHistory.settingsPath(this.dir), 'utf8')) as Partial<ChangeHistorySettings>)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Change history settings unreadable, using defaults:', (e as Error).message)
      return { ...DEFAULT_CHANGE_SETTINGS }
    }
  }

  settings(): ChangeHistorySettings {
    return { ...this.cfg }
  }

  saveSettings(p: Partial<ChangeHistorySettings>): ChangeHistorySettings {
    this.cfg = normalize({ ...this.cfg, ...p })
    writeFileSync(ChangeHistory.settingsPath(this.dir), JSON.stringify(this.cfg, null, 2), 'utf8')
    this.prune()
    return this.settings()
  }

  stats(): ChangeHistoryStats {
    const r = this.db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM changes').get() as Row
    let fileBytes = 0
    for (const suffix of ['', '-wal']) {
      try {
        fileBytes += statSync(ChangeHistory.dbPath(this.dir) + suffix).size
      } catch {
        // missing WAL file
      }
    }
    return {
      count: Number(r.n),
      bytes: this.total,
      fileBytes,
      oldest: r.oldest == null ? undefined : new Date(Number(r.oldest)),
      lastError: this.lastError
    }
  }

  private fail(what: string, e: unknown): void {
    const message = `${what}: ${(e as Error)?.message ?? String(e)}`
    console.warn(`Change history: ${message}`)
    this.lastError = { at: new Date(this.now()), message }
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  forConn(connId: string): ConnRecorder | undefined {
    let cfg: ConnectionConfig
    try {
      cfg = this.mgr.config(connId)
    } catch {
      return undefined
    }
    return this.forOwner(ownerOf(cfg))
  }

  forConfig(cfg: Pick<ConnectionConfig, 'id' | 'name' | 'overrides'>): ConnRecorder {
    return this.forOwner(ownerOf(cfg))
  }

  forOwner(owner: Owner, cap?: number): ConnRecorder {
    return { begin: (db, coll, source, label) => this.begin(owner, db, coll, source, label, cap) }
  }

  begin(owner: Owner, db: string, coll: string, source: ChangeSource, label?: string, cap?: number): ChangeBatch | null {
    if (!(owner.history ?? this.cfg.enabled)) return null
    const id = randomUUID()
    const max = cap ?? this.cfg.maxDocsPerOp
    let used = 0
    let truncated = false
    const write = (rows: { op: ChangeOp; docId: string; before: Uint8Array | null; after: Uint8Array | null; label?: string }[]): void => {
      if (!rows.length) return
      const at = this.now()
      let added = 0
      this.db.exec('BEGIN')
      try {
        for (const r of rows) {
          const size = (r.before?.length ?? 0) + (r.after?.length ?? 0) + r.docId.length + ROW_OVERHEAD
          this.insertStmt.run(at, owner.configId, owner.connName, db, coll, r.op, source, id, r.docId, r.label ?? label ?? null, r.before, r.after, size)
          added += size
        }
        this.db.exec('COMMIT')
        this.total += added
      } catch (e) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // no transaction left
        }
        throw e
      }
      this.prune(at)
    }
    return {
      id,
      cap: max,
      get remaining() {
        return Math.max(0, max - used)
      },
      get truncated() {
        return truncated
      },
      add: (entries: ChangeEntry[]) => {
        if (!entries.length) return
        const room = Math.max(0, max - used)
        if (entries.length > room) {
          truncated = true
          entries = entries.slice(0, room)
        }
        used += entries.length
        try {
          write(
            entries.map((e) => ({
              op: e.op,
              docId: docIdText(e.docId !== undefined ? e.docId : (e.before?._id ?? e.after?._id)),
              before: e.op === 'insert' ? null : toBlob(e.before),
              after: toBlob(e.after)
            }))
          )
        } catch (e) {
          this.fail(`could not record changes of ${db}.${coll}`, e)
        }
      },
      marker: (text: string) => {
        try {
          write([{ op: 'drop', docId: '', before: null, after: null, label: text }])
        } catch (e) {
          this.fail(`could not record a marker for ${db}.${coll}`, e)
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  private recount(): void {
    this.total = Number((this.db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM changes').get() as Row).s)
  }

  /** Drops records past the retention period (at most hourly unless forced) and the oldest ones over the size limit. */
  prune(at = this.now(), forceAge = false): void {
    try {
      if (this.cfg.retentionDays > 0 && (forceAge || at - this.lastAgePrune >= AGE_PRUNE_INTERVAL || this.lastAgePrune === 0)) {
        this.lastAgePrune = at
        const r = this.db.prepare('DELETE FROM changes WHERE at < ?').run(at - this.cfg.retentionDays * DAY)
        if (Number(r.changes)) this.recount()
      }
      const max = this.cfg.maxSizeMB * 1024 * 1024
      if (this.total <= max) return
      // Free a little more than needed so a full store is not pruned (and rescanned) on every write.
      let excess = this.total - Math.floor(max * PRUNE_TO)
      let freed = 0
      let upTo = -1
      let lastId = 0
      const page = this.db.prepare('SELECT id, size FROM changes WHERE id > ? ORDER BY id LIMIT 1000')
      while (excess > 0) {
        const rows = page.all(lastId) as Row[]
        if (!rows.length) break
        for (const r of rows) {
          lastId = Number(r.id)
          excess -= Number(r.size)
          freed += Number(r.size)
          upTo = lastId
          if (excess <= 0) break
        }
      }
      if (upTo >= 0) this.db.prepare('DELETE FROM changes WHERE id <= ?').run(upTo)
      // Every row up to `upTo` was summed above: no need to rescan the whole table.
      this.total = Math.max(0, this.total - freed)
    } catch (e) {
      this.fail('pruning failed', e)
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private where(configId: string, q: Partial<ChangeQuery>): { sql: string; params: SQLInputValue[] } {
    const conds = ['configId = ?']
    const params: SQLInputValue[] = [configId]
    const eq = (col: string, v: string | undefined): void => {
      if (v === undefined || v === '') return
      conds.push(`${col} = ?`)
      params.push(v)
    }
    eq('db', q.db)
    eq('coll', q.coll)
    eq('op', q.op)
    eq('source', q.source)
    if (q.from) {
      conds.push('at >= ?')
      params.push(new Date(q.from).getTime())
    }
    if (q.to) {
      conds.push('at <= ?')
      params.push(new Date(q.to).getTime())
    }
    const text = q.text?.trim()
    if (text) {
      conds.push("docId LIKE ? ESCAPE '\\'")
      params.push(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    return { sql: conds.join(' AND '), params }
  }

  batches(configId: string, q: ChangeQuery): ChangeBatchInfo[] {
    const w = this.where(configId, q)
    const rows = this.db
      .prepare(
        `SELECT batchId, db, coll, MIN(at) AS at, MAX(at) AS last, MIN(source) AS source, MAX(label) AS label, MAX(connName) AS connName,
          COUNT(*) AS count, SUM(size) AS bytes, SUM(op = 'update') AS o_update, SUM(op = 'replace') AS o_replace, SUM(op = 'delete') AS o_delete,
          SUM(op = 'insert') AS o_insert, SUM(op = 'drop') AS o_drop, MAX(id) AS maxId
         FROM changes WHERE ${w.sql} GROUP BY batchId, db, coll ORDER BY maxId DESC LIMIT ? OFFSET ?`
      )
      .all(...w.params, clampInt(q.limit, 1, 5000, 200), clampInt(q.offset, 0, Number.MAX_SAFE_INTEGER, 0)) as Row[]
    return rows.map((r) => {
      const ops: ChangeBatchInfo['ops'] = {}
      for (const op of ['update', 'replace', 'delete', 'insert', 'drop'] as ChangeOp[]) {
        const n = Number(r[`o_${op}`])
        if (n) ops[op] = n
      }
      return {
        batchId: String(r.batchId),
        at: new Date(Number(r.at)),
        last: new Date(Number(r.last)),
        db: String(r.db),
        coll: String(r.coll),
        source: r.source as ChangeSource,
        label: r.label == null ? undefined : String(r.label),
        connName: String(r.connName),
        ops,
        count: Number(r.count),
        bytes: Number(r.bytes)
      }
    })
  }

  records(configId: string, batchId: string, q: ChangeQuery): ChangeRecordInfo[] {
    const w = this.where(configId, q)
    const rows = this.db
      .prepare(`SELECT ${INFO_COLUMNS} FROM changes WHERE ${w.sql} AND batchId = ? ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, batchId, clampInt(q.limit, 1, 100_000, 1000), clampInt(q.offset, 0, Number.MAX_SAFE_INTEGER, 0)) as Row[]
    return rows.map(info)
  }

  private full(r: Row): ChangeRow {
    return { ...info(r), configId: String(r.configId), docIdText: String(r.docId), before: fromBlob(r.before), after: fromBlob(r.after) }
  }

  get(id: number): ChangeRow | null {
    const r = this.db.prepare(`SELECT ${INFO_COLUMNS}, configId, before, after FROM changes WHERE id = ?`).get(id) as Row | undefined
    return r ? this.full(r) : null
  }

  /** Full rows (newest first) of the given ids and batches. */
  select(ids: number[] = [], batchIds: string[] = []): ChangeRow[] {
    const out = new Map<number, ChangeRow>()
    const cols = `${INFO_COLUMNS}, configId, before, after`
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      for (const r of this.db.prepare(`SELECT ${cols} FROM changes WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Row[]) out.set(Number(r.id), this.full(r))
    }
    for (const b of batchIds) for (const r of this.db.prepare(`SELECT ${cols} FROM changes WHERE batchId = ?`).all(b) as Row[]) out.set(Number(r.id), this.full(r))
    return [...out.values()].sort((a, b) => b.id - a.id)
  }

  purge(configId: string, req: PurgeRequest): number {
    let n = 0
    const run = (sql: string, ...params: SQLInputValue[]): void => {
      n += Number(this.db.prepare(sql).run(...params).changes)
    }
    this.db.exec('BEGIN')
    try {
      switch (req.kind) {
        case 'ids':
          for (let i = 0; i < req.ids.length; i += 500) {
            const chunk = req.ids.slice(i, i + 500)
            run(`DELETE FROM changes WHERE configId = ? AND id IN (${chunk.map(() => '?').join(',')})`, configId, ...chunk)
          }
          break
        case 'batches':
          for (const b of req.batchIds) run('DELETE FROM changes WHERE configId = ? AND batchId = ?', configId, b)
          break
        case 'olderThan': {
          const w = this.where(configId, { db: req.db, coll: req.coll })
          run(`DELETE FROM changes WHERE ${w.sql} AND at < ?`, ...w.params, new Date(req.before).getTime())
          break
        }
        case 'scope': {
          const w = this.where(configId, { db: req.db, coll: req.coll })
          run(`DELETE FROM changes WHERE ${w.sql}`, ...w.params)
          break
        }
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.recount()
    return n
  }
}
