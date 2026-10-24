import { createWriteStream } from 'fs'
import type { WriteStream } from 'fs'
import { randomUUID } from 'crypto'
import { MongoBulkWriteError } from 'mongodb'
import type { AnyBulkWriteOperation, Collection, Document, MongoClient } from 'mongodb'
import type { Doc, JobProgress } from '@shared/api'
import { dialectLabel } from '@shared/migrationApi'
import type {
  FromSqlPreview,
  FromSqlRequest,
  FromSqlSource,
  MigrationApi,
  SqlConnectionConfig,
  SqlDialect,
  SqlTableDetail,
  SqlTestResult,
  ToSqlCollection,
  ToSqlPreview,
  ToSqlRequest,
  ToSqlRunMode
} from '@shared/migrationApi'
import type { SecretCodec } from '../store'
import { RAW_TYPES } from '../mongo/ops'
import { createTableSql, insertLiteralSql, insertSql, rowsPerInsert } from './dialects/common'
import { getDialect } from './dialects'
import type { Dialect, SqlValue, ValueKind } from './dialects/types'
import { SqlConnectionStore } from './connections'
import { AbortError, fmt, Job, plural } from './job'
import { extractDoc, inferCollection, newExtractStats, plannedTable, planCollections, sqlValueText, statsLines } from './mongoToSql'
import type { CollectionPlan, ExtractStats, TableRecipe } from './mongoToSql'
import { openSqlSession, stripSemicolon } from './session'
import type { Row, SqlSession } from './session'
import { attachEmbed, distinctKeys, embedFor, inferMissingTypes, keyQueries, queryColumns, rowToDoc, selectFor, tableColumns } from './sqlToMongo'
import type { CellError } from './sqlToMongo'

/** What Migrations needs from the connection manager (ConnectionManager satisfies it). */
export interface MigrationConnections {
  get(connId: string): MongoClient
}

const MAX_ERRORS = 100
const MAX_ERROR_LOG = 50
const PREVIEW_ROWS = 10
const FILE_ROWS_PER_INSERT = 100

const isAbort = (e: unknown, signal: AbortSignal): boolean => signal.aborted || (e as Error)?.name === 'AbortError'
const looksDisconnected = (e: unknown): boolean => /connect|closed|terminat|ECONN|socket|not open|ETIMEOUT|EPIPE/i.test((e as Error)?.message ?? '')

type RowsByTable = Map<TableRecipe, SqlValue[][]>

interface Sink {
  ddl(statements: string[]): Promise<void>
  /** Writes the rows of one batch atomically, parents first. */
  write(rows: RowsByTable, order: TableRecipe[]): Promise<void>
  close(): Promise<void>
}

function ddlStatements(plans: CollectionPlan[], d: Dialect, schema: string, mode: ToSqlRunMode): string[] {
  const tables = plans.flatMap((p) => p.tables)
  const q = (t: TableRecipe): string => d.qualified(schema, t.name)
  const out: string[] = []
  if (mode === 'dropCreate') out.push(...[...tables].reverse().map((t) => d.dropTable(q(t))))
  for (const t of tables) {
    const create = createTableSql(d, schema, t)
    out.push(mode === 'create' || mode === 'dropCreate' ? create : d.createIfMissing(q(t), schema, t.name, create))
  }
  if (mode === 'truncate') out.push(...d.emptyTables([...tables].reverse().map(q)))
  return out
}

function liveSink(s: SqlSession, schema: string): Sink {
  const d = s.dialect
  const cache = new Map<string, string>()
  return {
    async ddl(statements) {
      for (const st of statements) await s.query(st)
    },
    async write(rows, order) {
      await s.begin()
      try {
        for (const t of order) {
          const list = rows.get(t)
          if (!list?.length) continue
          const names = t.cols.map((c) => c.name)
          const kinds = t.cols.map((c) => c.kind)
          const per = rowsPerInsert(d, names.length)
          for (let i = 0; i < list.length; i += per) {
            const chunk = list.slice(i, i + per)
            const key = `${t.id}|${chunk.length}`
            let text = cache.get(key)
            if (!text) cache.set(key, (text = insertSql(d, d.qualified(schema, t.name), names, chunk.length)))
            const allKinds: ValueKind[] = []
            for (let r = 0; r < chunk.length; r++) allKinds.push(...kinds)
            await s.query(text, chunk.flat(), allKinds)
          }
        }
        await s.commit()
      } catch (e) {
        await s.rollback().catch(() => {})
        throw e
      }
    },
    close: () => s.close()
  }
}

async function fileSink(path: string, d: Dialect, schema: string, header: string): Promise<Sink> {
  const out: WriteStream = createWriteStream(path, { encoding: 'utf8' })
  await new Promise<void>((resolve, reject) => {
    out.once('open', () => resolve())
    out.once('error', reject)
  })
  let failed: Error | null = null
  out.on('error', (e) => (failed = e))
  const put = async (text: string): Promise<void> => {
    if (failed) throw failed
    if (!out.write(text)) await new Promise<void>((r) => out.once('drain', () => r()))
  }
  // UTF-8 throughout; the BOM and prologue make SSMS / sqlcmd, mysql and psql on Windows read it as UTF-8 too.
  await put(`${d.scriptBom ? '\uFEFF' : ''}${header}`)
  for (const st of d.scriptPrologue ?? []) await put(`${st};\n\n`)
  return {
    async ddl(statements) {
      for (const st of statements) await put(`${st};\n\n`)
    },
    async write(rows, order) {
      let text = `${d.begin};\n`
      for (const t of order) {
        const list = rows.get(t)
        if (!list?.length) continue
        const names = t.cols.map((c) => c.name)
        const kinds = t.cols.map((c) => c.kind)
        const per = Math.min(FILE_ROWS_PER_INSERT, d.maxRows)
        for (let i = 0; i < list.length; i += per) text += `${insertLiteralSql(d, d.qualified(schema, t.name), names, kinds, list.slice(i, i + per))};\n`
      }
      await put(`${text}${d.commit};\n\n`)
    },
    async close() {
      await new Promise<void>((resolve) => out.end(() => resolve()))
      if (failed) throw failed
    }
  }
}

function writeErrors(e: unknown): { index: number; message: string }[] {
  if (!(e instanceof MongoBulkWriteError)) return []
  const list = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]
  return list.map((w) => ({ index: w.index, message: w.errmsg ?? String(w) }))
}

export class Migrations {
  readonly conns: SqlConnectionStore
  private sessions = new Map<string, Promise<SqlSession>>()
  private jobs = new Map<string, Job>()

  constructor(
    private mgr: MigrationConnections,
    codec: SecretCodec,
    userData: string,
    private emit: (p: JobProgress) => void,
    private open: (c: SqlConnectionConfig) => Promise<SqlSession> = openSqlSession
  ) {
    this.conns = new SqlConnectionStore(SqlConnectionStore.path(userData), codec)
  }

  // -------------------------------------------------------------------------
  // Connections & schema browser
  // -------------------------------------------------------------------------

  async saveConnection(c: SqlConnectionConfig): Promise<SqlConnectionConfig> {
    const saved = await this.conns.save(c)
    await this.drop(saved.id)
    return saved
  }

  async deleteConnection(id: string): Promise<void> {
    await this.conns.delete(id)
    await this.drop(id)
  }

  async test(c: SqlConnectionConfig): Promise<SqlTestResult> {
    const t0 = Date.now()
    let s: SqlSession | null = null
    try {
      s = await this.open(c)
      const serverVersion = await s.version()
      return { ok: true, serverVersion, ms: Date.now() - t0 }
    } catch (e) {
      return { ok: false, error: (e as Error).message || String(e), ms: Date.now() - t0 }
    } finally {
      await s?.close().catch(() => {})
    }
  }

  private async drop(id: string): Promise<void> {
    const s = this.sessions.get(id)
    this.sessions.delete(id)
    if (s) await s.then((x) => x.close()).catch(() => {})
  }

  /** Runs `fn` on the cached browsing session of a saved connection, reopening it once if it was lost. */
  async withSession<T>(id: string, fn: (s: SqlSession) => Promise<T>, retry = true): Promise<T> {
    let p = this.sessions.get(id)
    if (!p) {
      p = this.conns.get(id).then((c) => this.open(c))
      this.sessions.set(id, p)
      p.catch(() => this.sessions.get(id) === p && this.sessions.delete(id))
    }
    const s = await p
    try {
      return await fn(s)
    } catch (e) {
      if (!looksDisconnected(e)) throw e
      await this.drop(id)
      if (retry) return this.withSession(id, fn, false)
      throw e
    }
  }

  private async dialectOf(id: string): Promise<Dialect> {
    return getDialect((await this.conns.get(id)).dialect)
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  private run(title: string, body: (job: Job) => Promise<string>): string {
    const job = new Job(randomUUID(), title, this.emit)
    this.jobs.set(job.id, job)
    job.update({ message: 'Starting…' })
    void (async () => {
      let state: 'done' | 'error' | 'cancelled' = 'done'
      let error: string | undefined
      try {
        job.update({ message: await body(job) })
        if (job.signal.aborted) state = 'cancelled'
      } catch (e) {
        if (isAbort(e, job.signal)) {
          state = 'cancelled'
          job.update({ message: 'Cancelled' })
        } else {
          state = 'error'
          error = (e as Error)?.message || String(e)
          job.addLog(`Error: ${error}`)
          job.update({ message: error })
        }
      } finally {
        this.jobs.delete(job.id)
        job.finish(state, error)
      }
    })()
    return job.id
  }

  cancel(jobId: string): void {
    this.jobs.get(jobId)?.ctrl.abort()
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) j.ctrl.abort()
  }

  /** Cancels jobs and closes browsing sessions (app quit). */
  async closeAll(): Promise<void> {
    this.cancelAll()
    await Promise.all([...this.sessions.keys()].map((id) => this.drop(id)))
  }

  // -------------------------------------------------------------------------
  // MongoDB → SQL
  // -------------------------------------------------------------------------

  async inferToSql(connId: string, db: string, colls: string[], sample: number): Promise<ToSqlCollection[]> {
    const client = this.mgr.get(connId)
    const size = Math.max(1, Math.floor(sample || 1000))
    return Promise.all(
      colls.map(async (c) => {
        // $sample returns documents in random order and columns follow first appearance: sort for a stable order.
        const docs = await client.db(db).collection(c).aggregate([{ $sample: { size } }, { $sort: { _id: 1 } }], { ...RAW_TYPES, allowDiskUse: true }).toArray()
        return inferCollection(c, docs)
      })
    )
  }

  private async targetDialect(req: ToSqlRequest): Promise<{ d: Dialect; schema: string }> {
    const t = req.target
    const d = t.kind === 'file' ? getDialect(t.dialect) : await this.dialectOf(t.sqlConnId)
    return { d, schema: t.schema?.trim() || d.defaultSchema }
  }

  async previewToSql(req: ToSqlRequest): Promise<ToSqlPreview> {
    const { d, schema } = await this.targetDialect(req)
    const plans = planCollections(req.collections, d)
    const client = this.mgr.get(req.connId)
    const stats = newExtractStats()
    const rows = new Map<TableRecipe, SqlValue[][]>()
    const warnings: string[] = []
    for (const p of plans) {
      const docs = await client
        .db(req.db)
        .collection(p.coll.coll)
        .find((p.coll.filter ?? {}) as Document, RAW_TYPES)
        .limit(PREVIEW_ROWS)
        .toArray()
      for (const doc of docs) {
        try {
          extractDoc(doc, p.root, (t, row) => {
            let list = rows.get(t)
            if (!list) rows.set(t, (list = []))
            if (list.length < PREVIEW_ROWS) list.push(row)
          }, stats)
        } catch (e) {
          warnings.push(`${p.coll.coll}: ${(e as Error).message}`)
        }
      }
    }
    const tables = plans.flatMap((p) => p.tables)
    const header = `-- ${dialectLabel(d.id)}${schema ? `, schema ${schema}` : ''}: ${plural(tables.length, 'table')}\n\n`
    return {
      dialect: d.id,
      tables: tables.map(plannedTable),
      ddl: header + ddlStatements(plans, d, schema, req.mode).map((s) => `${s};`).join('\n\n'),
      rows: tables.map((t) => ({ table: t.name, columns: t.cols.map((c) => c.name), rows: (rows.get(t) ?? []).map((r) => r.map(sqlValueText)) })),
      autoTypes: Object.fromEntries(plans.map((p) => [p.coll.coll, p.autoTypes])),
      warnings: [...mixedWarnings(req.collections), ...warnings, ...statsLines(stats)]
    }
  }

  startToSql(req: ToSqlRequest): string {
    const into = req.target.kind === 'file' ? req.target.path.split(/[\\/]/).pop() : 'SQL'
    const n = req.collections.filter((c) => c.include).length
    return this.run(`Migrate ${n === 1 ? req.collections.find((c) => c.include)!.coll : plural(n, 'collection')} → ${into}`, (job) => this.runToSql(job, req))
  }

  private async runToSql(job: Job, req: ToSqlRequest): Promise<string> {
    const target = await this.targetDialect(req)
    const d = target.d
    let schema = target.schema
    const plans = planCollections(req.collections, d)
    if (!plans.length) throw new Error('Choose at least one collection')
    const client = this.mgr.get(req.connId)
    const batchSize = Math.max(1, Math.floor(req.batchSize || 500))
    const t = req.target
    let sink: Sink
    if (t.kind === 'file') {
      const header = `-- Shardwise: ${req.db} → ${dialectLabel(d.id)}, ${new Date().toISOString()}\n-- Collections: ${plans.map((p) => p.coll.coll).join(', ')}\n\n`
      sink = await fileSink(t.path, d, schema, header)
    } else {
      const s = await this.open(await this.conns.get(t.sqlConnId))
      schema = t.schema?.trim() || s.defaultSchema
      sink = liveSink(s, schema)
    }
    const stats = newExtractStats()
    let errors = 0
    let docsDone = 0
    let rowsDone = 0
    let failedDocs = 0
    const tableCount = plans.reduce((n, p) => n + p.tables.length, 0)
    try {
      job.update({ message: 'Creating tables…' })
      await sink.ddl(ddlStatements(plans, d, schema, req.mode))
      if (req.mode === 'create' || req.mode === 'dropCreate') job.addLog(`Created ${plural(tableCount, 'table')}`)
      else if (req.mode === 'truncate') job.addLog(`Emptied ${plural(tableCount, 'table')}`)

      let total = 0
      const counts: number[] = []
      for (const p of plans) {
        const c = client.db(req.db).collection(p.coll.coll)
        const n = p.coll.filter && Object.keys(p.coll.filter).length ? await c.countDocuments(p.coll.filter as Document) : await c.estimatedDocumentCount()
        counts.push(n)
        total += n
      }
      job.update({ total, done: 0 })

      for (const [pi, p] of plans.entries()) {
        job.check()
        const order = p.tables
        const cursor = client
          .db(req.db)
          .collection(p.coll.coll)
          .find((p.coll.filter ?? {}) as Document, { ...RAW_TYPES, batchSize })
        let collDocs = 0
        try {
          let batch: { id: unknown; rows: RowsByTable }[] = []
          const flush = async (): Promise<void> => {
            if (!batch.length) return
            job.check()
            const merged: RowsByTable = new Map()
            for (const b of batch) for (const [tb, list] of b.rows) {
              let m = merged.get(tb)
              if (!m) merged.set(tb, (m = []))
              m.push(...list)
            }
            try {
              await sink.write(merged, order)
              for (const list of merged.values()) rowsDone += list.length
            } catch (e) {
              if (t.kind === 'file') throw e
              job.check()
              // Find the failing documents: retry one by one.
              for (const b of batch) {
                job.check()
                try {
                  await sink.write(b.rows, order)
                  for (const list of b.rows.values()) rowsDone += list.length
                } catch (err) {
                  failedDocs++
                  if (++errors <= MAX_ERROR_LOG) job.addLog(`${p.coll.coll} _id ${String(b.id)}: ${(err as Error).message}`)
                  if (errors >= MAX_ERRORS) throw new Error(`Stopped after ${fmt(errors)} errors`)
                }
              }
            }
            docsDone += batch.length
            collDocs += batch.length
            batch = []
            job.update({ done: docsDone, message: `${p.coll.coll}: ${fmt(collDocs)} of ${fmt(counts[pi])} documents` })
          }
          for await (const doc of cursor) {
            const rows: RowsByTable = new Map()
            try {
              extractDoc(doc, p.root, (tb, row) => {
                let list = rows.get(tb)
                if (!list) rows.set(tb, (list = []))
                list.push(row)
              }, stats)
            } catch (e) {
              failedDocs++
              if (++errors <= MAX_ERROR_LOG) job.addLog(`${p.coll.coll}: ${(e as Error).message}`)
              if (errors >= MAX_ERRORS) throw new Error(`Stopped after ${fmt(errors)} errors`)
              continue
            }
            batch.push({ id: (doc as Doc)._id, rows })
            if (batch.length >= batchSize) await flush()
          }
          await flush()
        } finally {
          await cursor.close().catch(() => {})
        }
        job.addLog(`${p.coll.coll}: ${plural(collDocs, 'document')} → ${p.tables.map((x) => x.name).join(', ')}`)
      }
      for (const line of statsLines(stats)) job.addLog(line)
      const where = t.kind === 'file' ? t.path : dialectLabel(d.id)
      return `${plural(docsDone - failedDocs, 'document')} (${plural(rowsDone, 'row')}) written to ${where}${failedDocs ? `, ${plural(failedDocs, 'document')} failed` : ''}`
    } finally {
      await sink.close().catch(() => {})
    }
  }

  // -------------------------------------------------------------------------
  // SQL → MongoDB
  // -------------------------------------------------------------------------

  async defaultSource(sqlConnId: string, from: { schema: string; table: string } | { query: string }): Promise<FromSqlSource> {
    return this.withSession(sqlConnId, async (s) => {
      if ('query' in from) {
        const r = await s.query(s.dialect.limit(stripSemicolon(from.query), 1))
        return { id: randomUUID(), kind: 'query', query: from.query, include: true, collection: 'query_result', idMode: 'new', idColumns: [], columns: queryColumns(r.columns), embeds: [] }
      }
      const det = await s.describe(from.schema, from.table)
      const describe = (schema: string, table: string): Promise<SqlTableDetail | null> => s.describe(schema, table).catch(() => null)
      const embeds = []
      for (const fk of det.referencedBy)
        embeds.push(embedFor(randomUUID(), { schema: fk.schema, table: fk.table, local: fk.refColumns, foreign: fk.columns }, await describe(fk.schema, fk.table), 'array'))
      for (const fk of det.foreignKeys)
        embeds.push(embedFor(randomUUID(), { schema: fk.refSchema, table: fk.refTable, local: fk.columns, foreign: fk.refColumns }, await describe(fk.refSchema, fk.refTable), 'object'))
      return {
        id: randomUUID(),
        kind: 'table',
        schema: det.schema,
        table: det.name,
        include: true,
        collection: det.name,
        idMode: det.primaryKey.length ? 'pk' : 'new',
        idColumns: det.primaryKey,
        columns: tableColumns(det),
        embeds
      }
    })
  }

  private async embedRows(s: SqlSession, src: FromSqlSource, rows: Row[], docs: Doc[], onError: CellError): Promise<void> {
    for (const e of src.embeds) {
      if (!e.include || !e.localColumns.length || e.localColumns.length !== e.foreignColumns.length) continue
      const keys = distinctKeys(rows, e.localColumns)
      const matches: Row[] = []
      for (const kq of keyQueries(s.dialect, e.schema, e.table, e.foreignColumns, keys)) matches.push(...(await s.query(kq.sql, kq.params, kq.kinds)).rows)
      attachEmbed(e, rows, docs, matches, onError)
    }
  }

  async previewFromSql(sqlConnId: string, src: FromSqlSource): Promise<FromSqlPreview> {
    return this.withSession(sqlConnId, async (s) => {
      const r = await s.query(s.dialect.limit(selectFor(s.dialect, src), PREVIEW_ROWS))
      const types = new Map(r.columns.map((c) => [c.name, c.type]))
      const columns = inferMissingTypes(src.columns.map((c) => ({ ...c, type: c.type || types.get(c.column) || undefined })), r.rows)
      const docs = r.rows.map((row) => rowToDoc(row, columns, () => {}))
      await this.embedRows(s, src, r.rows, docs, () => {})
      return { docs, columns: r.columns }
    })
  }

  startFromSql(req: FromSqlRequest): string {
    const list = req.sources.filter((s) => s.include)
    const title = list.length === 1 ? `Import ${list[0].table ?? 'query'} → ${req.db}.${list[0].collection}` : `Import ${plural(list.length, list.every((s) => s.kind === 'table') ? 'table' : 'source')} → ${req.db}`
    return this.run(title, (job) => this.runFromSql(job, req))
  }

  private async runFromSql(job: Job, req: FromSqlRequest): Promise<string> {
    const sources = req.sources.filter((s) => s.include)
    if (!sources.length) throw new Error('Choose at least one table or query')
    for (const s of sources) if (!s.collection.trim()) throw new Error(`Choose a collection name for ${s.table ?? 'the query'}`)
    const client = this.mgr.get(req.connId)
    const cfg = await this.conns.get(req.sqlConnId)
    const batchSize = Math.max(1, Math.floor(req.batchSize || 1000))
    const main = await this.open(cfg)
    let aux: SqlSession | null = null
    let errors = 0
    let written = 0
    let read = 0
    const onError: CellError = (column, message) => {
      errors++
      if (errors <= MAX_ERROR_LOG) job.addLog(`${column}: ${message} (stored as null)`)
    }
    try {
      if (sources.some((s) => s.embeds.some((e) => e.include))) aux = await this.open(cfg)
      const d = main.dialect
      let total = 0
      const totals: (number | undefined)[] = []
      for (const s of sources) {
        let n: number | undefined
        if (s.kind === 'table') n = Number((await main.query(`SELECT COUNT(*) AS n FROM ${d.qualified(s.schema ?? '', s.table!)}`)).rows[0]?.n ?? 0)
        totals.push(n)
        total += n ?? 0
      }
      job.update({ total: totals.every((n) => n !== undefined) ? total : undefined, done: 0 })

      for (const [si, src] of sources.entries()) {
        job.check()
        const coll = client.db(req.db).collection(src.collection.trim())
        if (req.dropTarget) {
          await coll.drop().catch((e) => {
            if (!/ns not found|NamespaceNotFound/i.test((e as Error).message) && (e as { code?: number }).code !== 26) throw e
          })
        }
        let srcRows = 0
        let types: Map<string, string> | null = null
        let columns = src.columns
        for await (const chunk of main.stream(selectFor(d, src), batchSize)) {
          job.check()
          if (!types) {
            types = new Map(chunk.columns.map((c) => [c.name, c.type]))
            columns = inferMissingTypes(src.columns.map((c) => ({ ...c, type: c.type || types!.get(c.column) || undefined })), chunk.rows)
          }
          const docs = chunk.rows.map((r) => rowToDoc(r, columns, onError))
          if (aux) await this.embedRows(aux, src, chunk.rows, docs, onError)
          job.check()
          written += await this.writeDocs(coll, docs, req.mode, job, () => ++errors)
          if (errors >= MAX_ERRORS * 10) throw new Error(`Stopped after ${fmt(errors)} errors`)
          read += chunk.rows.length
          srcRows += chunk.rows.length
          job.update({ done: read, message: `${src.table ?? 'query'}: ${fmt(srcRows)}${totals[si] !== undefined ? ` of ${fmt(totals[si]!)}` : ''} rows` })
        }
        job.addLog(`${src.table ?? 'query'} → ${src.collection}: ${plural(srcRows, 'row')}`)
      }
      return `${plural(read, 'row')} read, ${plural(written, 'document')} ${req.mode === 'upsert' ? 'written' : 'inserted'}${errors ? `, ${plural(errors, 'error')}` : ''}`
    } finally {
      await main.close().catch(() => {})
      await aux?.close().catch(() => {})
    }
  }

  private async writeDocs(coll: Collection<Document>, docs: Doc[], mode: 'insert' | 'upsert', job: Job, error: () => void): Promise<number> {
    if (!docs.length) return 0
    const ops: AnyBulkWriteOperation<Document>[] = docs.map((doc) =>
      mode === 'upsert' && doc._id !== undefined && doc._id !== null
        ? { replaceOne: { filter: { _id: doc._id }, replacement: doc as Document, upsert: true } }
        : { insertOne: { document: doc as Document } }
    )
    try {
      const r = await coll.bulkWrite(ops, { ordered: false })
      return r.insertedCount + r.upsertedCount + r.matchedCount
    } catch (e) {
      const errs = writeErrors(e)
      if (!errs.length) throw e
      for (const w of errs) {
        error()
        job.addLog(`Document ${String(docs[w.index]?._id ?? `#${w.index + 1}`)}: ${w.message}`)
      }
      const r = (e as MongoBulkWriteError).result
      return r ? r.insertedCount + r.upsertedCount + r.matchedCount : docs.length - errs.length
    }
  }
}

function mixedWarnings(colls: ToSqlCollection[]): string[] {
  const out: string[] = []
  const walk = (coll: string, fields: ToSqlCollection['fields'], base: string): void => {
    for (const f of fields) {
      if (!f.include) continue
      const path = base ? `${base}.${f.name}` : f.name
      if (f.distinctKeys) out.push(`${coll}.${path}: ${plural(f.distinctKeys, 'different key')} in the sample (keys are data, e.g. ids): stored as one JSON column`)
      if (f.mixed > 0 && !(f.kind !== 'scalar' && f.mode === 'json')) out.push(`${coll}.${path}: ${plural(f.mixed, 'value')} of another type in the sample will be converted (or stored as NULL)`)
      if (f.fields && f.mode !== 'json') walk(coll, f.fields, path)
    }
  }
  for (const c of colls) if (c.include) walk(c.coll, c.fields, '')
  return out
}

type Handlers = { [K in keyof MigrationApi]: (...args: Parameters<MigrationApi[K]>) => Promise<ReturnType<MigrationApi[K]>> | ReturnType<MigrationApi[K]> }

/** IPC handlers for the migration methods; spread into createApi()'s result. */
export function migrationHandlers(m: Migrations): Handlers {
  return {
    sqlListConnections: () => m.conns.list(),
    sqlSaveConnection: (c) => m.saveConnection(c),
    sqlDeleteConnection: (id) => m.deleteConnection(id),
    sqlTestConnection: (c) => m.test(c),
    sqlListSchemas: (id) => m.withSession(id, (s) => s.listSchemas()),
    sqlListTables: (id, schema) => m.withSession(id, (s) => s.listTables(schema)),
    sqlDescribeTable: (id, schema, table) => m.withSession(id, (s) => s.describe(schema, table)),
    sqlDialectTypes: (d: SqlDialect) => getDialect(d).types,
    sqlDefaultSchema: (id) => m.withSession(id, async (s) => s.defaultSchema),
    migrationInferToSql: (connId, db, colls, sample) => m.inferToSql(connId, db, colls, sample),
    migrationPreviewToSql: (req) => m.previewToSql(req),
    migrationStartToSql: (req) => m.startToSql(req),
    migrationDefaultSource: (id, from) => m.defaultSource(id, from),
    migrationPreviewFromSql: (id, src) => m.previewFromSql(id, src),
    migrationStartFromSql: (req) => m.startFromSql(req),
    migrationCancel: (jobId) => m.cancel(jobId)
  }
}

export { AbortError }
