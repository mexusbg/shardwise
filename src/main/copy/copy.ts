import { MongoBulkWriteError } from 'mongodb'
import type { AnyBulkWriteOperation, CollectionInfo as DriverCollectionInfo, Db, Document, Filter, MongoClient } from 'mongodb'
import type { Doc, JobProgress } from '@shared/api'
import type { CopyApi, CopyItem, CopyOptions, CopyPlan, CopyPlanEntry, CopyRequest } from '@shared/copyApi'
import { RAW_TYPES } from '../mongo/ops'
import { fmt, plural } from '../sql/job'
import type { Job } from '../sql/job'
import { JobRunner } from './jobRunner'

/** What Copies needs from the connection manager (ConnectionManager satisfies it). */
export interface CopyConnections {
  get(connId: string): MongoClient
  /** Refuses read-only targets up front (ConnectionManager); their guarded client refuses the writes anyway. */
  assertWritable?(connId: string, action?: string): void
}

interface SourceInfo {
  name: string
  type: CopyPlanEntry['type']
  options: Doc
}

const MAX_ERRORS_LOGGED = 20
const CREATE_OPTION_KEYS = [
  'validator',
  'validationLevel',
  'validationAction',
  'collation',
  'capped',
  'size',
  'max',
  'timeseries',
  'expireAfterSeconds',
  'clusteredIndex',
  'changeStreamPreAndPostImages'
]

const ns = (db: string, coll: string): string => `${db}.${coll}`

async function collectionInfos(db: Db): Promise<Map<string, SourceInfo>> {
  const list = (await db.listCollections({}).toArray()) as DriverCollectionInfo[]
  const map = new Map<string, SourceInfo>()
  for (const c of list) map.set(c.name, { name: c.name, type: (c.type ?? 'collection') as SourceInfo['type'], options: (c.options ?? {}) as Doc })
  return map
}

/** createCollection options of a source collection that are safe to pass back to `create`. */
export function creationOptions(o: Doc): Doc {
  const out: Doc = {}
  for (const k of CREATE_OPTION_KEYS) if (o[k] !== undefined) out[k] = o[k]
  if (out.timeseries && typeof out.timeseries === 'object') {
    const ts = { ...(out.timeseries as Doc) }
    // listCollections reports the bucketing derived from the granularity; passing both is rejected.
    if (ts.granularity) {
      delete ts.bucketMaxSpanSeconds
      delete ts.bucketRoundingSeconds
    }
    out.timeseries = ts
  }
  if (out.clusteredIndex && typeof out.clusteredIndex === 'object') {
    const ci = { ...(out.clusteredIndex as Doc) }
    delete ci.v
    out.clusteredIndex = ci
  }
  if (!out.capped) {
    delete out.size
    delete out.max
  }
  return out
}

/** Views ordered so that a view comes after the views it is defined on. */
function orderViews(views: CopyPlanEntry[]): CopyPlanEntry[] {
  const bySource = new Map(views.map((v) => [v.source, v]))
  const out: CopyPlanEntry[] = []
  const seen = new Set<string>()
  const visit = (v: CopyPlanEntry, depth = 0): void => {
    if (seen.has(v.source) || depth > 50) return
    seen.add(v.source)
    const dep = v.viewOn ? bySource.get(v.viewOn) : undefined
    if (dep) visit(dep, depth + 1)
    out.push(v)
  }
  views.forEach((v) => visit(v))
  return out
}

function validName(name: string): string | null {
  if (!name.trim()) return 'A collection name is empty'
  if (name.includes('$')) return `Collection names cannot contain "$": ${name}`
  if (name.startsWith('system.')) return `Collection names cannot start with "system.": ${name}`
  if (name.includes('\0')) return 'Collection names cannot contain null characters'
  return null
}

function validDbName(name: string): string | null {
  if (!name.trim()) return 'Enter a target database name'
  if (/[/\\. "$*<>:|?\0]/.test(name)) return `Invalid database name: ${name}`
  return null
}

const isEmptyFilter = (f?: Doc): boolean => !f || Object.keys(f).length === 0

export class Copies {
  private runner: JobRunner

  constructor(
    private mgr: CopyConnections,
    emit: (p: JobProgress) => void
  ) {
    this.runner = new JobRunner(emit)
  }

  cancel(jobId: string): void {
    this.runner.cancel(jobId)
  }

  cancelAll(): void {
    this.runner.cancelAll()
  }

  async plan(req: CopyRequest): Promise<CopyPlan> {
    const src = this.mgr.get(req.source.connId)
    const tgt = this.mgr.get(req.target.connId)
    const dbErr = validDbName(req.target.db)
    if (dbErr) throw new Error(dbErr)
    const [srcInfos, tgtInfos] = await Promise.all([collectionInfos(src.db(req.source.db)), collectionInfos(tgt.db(req.target.db))])
    const items: CopyItem[] = req.items ?? [...srcInfos.keys()].filter((n) => !n.startsWith('system.')).sort((a, b) => a.localeCompare(b)).map((n) => ({ source: n, target: n }))
    const missing: string[] = []
    const entries: CopyPlanEntry[] = []
    for (const it of items) {
      const info = srcInfos.get(it.source)
      if (!info) {
        missing.push(it.source)
        continue
      }
      let count = 0
      if (info.type !== 'view') {
        count = await src
          .db(req.source.db)
          .collection(it.source)
          .estimatedDocumentCount({ maxTimeMS: 5000 })
          .catch(() => -1)
      }
      entries.push({
        source: it.source,
        target: it.target,
        type: info.type,
        exists: tgtInfos.has(it.target),
        count,
        viewOn: typeof info.options.viewOn === 'string' ? info.options.viewOn : undefined
      })
    }
    const colls = entries.filter((e) => e.type !== 'view')
    const views = orderViews(entries.filter((e) => e.type === 'view'))
    return { entries: [...colls, ...views], targetDbExists: tgtInfos.size > 0, missing }
  }

  async start(req: CopyRequest): Promise<string> {
    this.mgr.assertWritable?.(req.target.connId, `pasting into ${req.target.db}`)
    const o = normalizeOptions(req.options)
    const plan = await this.plan(req)
    if (plan.missing.length) throw new Error(`Not found in ${req.source.db}: ${plan.missing.join(', ')}`)
    const filters = new Map((req.items ?? []).map((i) => [i.source, i.filter]))
    const entries = plan.entries.filter((e) => e.type !== 'view' || o.views)
    if (!entries.length) throw new Error(plan.entries.length ? 'Nothing to copy: enable "Views" to copy views' : 'Nothing to copy')
    const seen = new Set<string>()
    const sameDb = req.source.connId === req.target.connId && req.source.db === req.target.db
    const sources = new Set(entries.map((e) => e.source))
    for (const e of entries) {
      const err = validName(e.target)
      if (err) throw new Error(err)
      if (seen.has(e.target)) throw new Error(`Two collections would be copied to "${e.target}"`)
      seen.add(e.target)
      if (sameDb && e.source === e.target) throw new Error(`"${e.source}" would be copied onto itself; choose another target name`)
      // Within one database, writing to a collection that is also copied from would copy already-overwritten data.
      if (sameDb && sources.has(e.target)) throw new Error(`"${e.target}" is both copied and overwritten by this copy; choose another target name`)
    }
    const existing = entries.filter((e) => e.exists)
    if (o.conflict === 'abort' && existing.length)
      throw new Error(`Already in ${req.target.db}: ${existing.map((e) => e.target).join(', ')}. Choose another conflict policy or target name`)

    const src = this.mgr.get(req.source.connId)
    const tgt = this.mgr.get(req.target.connId)
    const one = entries.length === 1 ? entries[0] : null
    const title = one
      ? `Copy ${ns(req.source.db, one.source)} → ${ns(req.target.db, one.target)}`
      : `Copy ${req.items ? plural(entries.length, 'collection') : `database ${req.source.db}`} → ${req.target.db}`
    const rename = new Map(entries.map((e) => [e.source, e.target]))

    return this.runner.run(title, async (job) => {
      const sdb = src.db(req.source.db)
      const tdb = tgt.db(req.target.db)
      const tgtInfos = await collectionInfos(tdb)
      const srcInfos = await collectionInfos(sdb)
      const colls = entries.filter((e) => e.type !== 'view')
      const views = entries.filter((e) => e.type === 'view')
      const totals = { docs: 0, skipped: 0, failed: 0, replaced: 0, indexes: 0, colls: 0, views: 0 }
      let total = 0
      if (o.documents) {
        for (const e of colls) {
          const f = filters.get(e.source)
          if (!isEmptyFilter(f)) e.count = await sdb.collection(e.source).countDocuments(f as Filter<Document>).catch(() => -1)
          total += Math.max(0, e.count)
        }
        job.update({ done: 0, total })
      }
      const progress = (): number => totals.docs + totals.skipped + totals.failed + totals.replaced

      let i = 0
      for (const e of colls) {
        job.check()
        i++
        const label = `${ns(req.target.db, e.target)}`
        job.update({ message: `Copying ${e.source}${entries.length > 1 ? ` (${i}/${entries.length})` : ''}…` })
        const info = srcInfos.get(e.source)!
        const target = tgtInfos.get(e.target)
        let fresh = !target
        if (target && o.conflict === 'drop') {
          await tdb.collection(e.target).drop()
          job.addLog(`Dropped ${label}`)
          fresh = true
        } else if (target?.type === 'view') {
          throw new Error(`${label} is a view; it cannot receive documents`)
        }
        if (fresh) {
          await tdb.createCollection(e.target, (o.collectionOptions ? creationOptions(info.options) : {}) as never)
        }
        const targetType = fresh ? (o.collectionOptions ? info.type : 'collection') : target!.type
        if (o.documents) {
          const base = progress()
          const mode = !fresh && o.conflict === 'replace' && targetType !== 'timeseries' ? 'upsert' : 'insert'
          const r = await this.copyDocs(job, sdb, tdb, e.source, e.target, filters.get(e.source), o.batchSize, mode, (n) => job.update({ done: base + n }))
          totals.docs += r.inserted
          totals.replaced += r.replaced
          totals.skipped += r.skipped
          totals.failed += r.failed
          job.update({ done: progress() })
          const parts = [`${fmt(r.inserted)} inserted`]
          if (r.replaced) parts.push(`${fmt(r.replaced)} replaced`)
          if (r.skipped) parts.push(`${fmt(r.skipped)} duplicates skipped`)
          if (r.failed) parts.push(`${fmt(r.failed)} failed`)
          job.addLog(`${e.source} → ${label}: ${parts.join(', ')}`)
        } else if (fresh) {
          job.addLog(`Created ${label}`)
        }
        if (o.indexes) totals.indexes += await this.copyIndexes(job, sdb, tdb, e.source, e.target, !!info.options.collation)
        totals.colls++
      }

      for (const e of views) {
        job.check()
        i++
        job.update({ message: `Creating view ${e.target}${entries.length > 1 ? ` (${i}/${entries.length})` : ''}…` })
        const info = srcInfos.get(e.source)!
        const label = ns(req.target.db, e.target)
        const existing = tgtInfos.get(e.target) ?? ((await tdb.listCollections({ name: e.target }).next()) as DriverCollectionInfo | null)
        if (existing) {
          if (o.conflict === 'merge') {
            job.addLog(`${label} exists; view skipped`)
            continue
          }
          // "Replace duplicates" may replace a view definition, but never drops a collection and its documents.
          if (o.conflict !== 'drop' && (existing.type ?? 'collection') !== 'view') {
            totals.failed++
            job.addLog(`${label} exists and is not a view; view skipped (use "Drop target first" to replace it)`)
            continue
          }
          await tdb.collection(e.target).drop()
        }
        const viewOn = String(info.options.viewOn ?? '')
        const opts: Doc = { viewOn: rename.get(viewOn) ?? viewOn, pipeline: info.options.pipeline ?? [] }
        if (info.options.collation) opts.collation = info.options.collation
        try {
          await tdb.createCollection(e.target, opts as never)
          totals.views++
          job.addLog(`View ${label} on ${opts.viewOn as string}`)
        } catch (err) {
          totals.failed++
          job.addLog(`View ${label} failed: ${(err as Error).message}`)
        }
      }

      const parts = [`${plural(totals.docs + totals.replaced, 'document')} copied`]
      if (totals.colls > 1 || !o.documents) parts.push(plural(totals.colls, 'collection'))
      if (totals.views) parts.push(plural(totals.views, 'view'))
      if (o.indexes && totals.indexes) parts.push(`${fmt(totals.indexes)} ${totals.indexes === 1 ? 'index' : 'indexes'}`)
      if (totals.skipped) parts.push(`${fmt(totals.skipped)} duplicates skipped`)
      if (totals.failed) parts.push(`${fmt(totals.failed)} failed`)
      const text = parts.join(', ')
      job.addLog(`Done: ${text}`)
      return text
    })
  }

  private async copyDocs(
    job: Job,
    sdb: Db,
    tdb: Db,
    from: string,
    to: string,
    filter: Doc | undefined,
    batchSize: number,
    mode: 'insert' | 'upsert',
    onProgress: (n: number) => void
  ): Promise<{ inserted: number; replaced: number; skipped: number; failed: number }> {
    const r = { inserted: 0, replaced: 0, skipped: 0, failed: 0 }
    let logged = 0
    const logErr = (msg: string): void => {
      if (logged++ < MAX_ERRORS_LOGGED) job.addLog(`${from}: ${msg}`)
      else if (logged === MAX_ERRORS_LOGGED + 1) job.addLog(`${from}: further errors not shown`)
    }
    const target = tdb.collection(to)
    const write = async (batch: Doc[]): Promise<void> => {
      if (mode === 'upsert') {
        const ops: AnyBulkWriteOperation<Document>[] = batch.map((d) =>
          d._id === undefined ? { insertOne: { document: d } } : { replaceOne: { filter: { _id: d._id } as Filter<Document>, replacement: d, upsert: true } }
        )
        try {
          const res = await target.bulkWrite(ops, { ordered: false, bypassDocumentValidation: true })
          r.inserted += res.upsertedCount + res.insertedCount
          r.replaced += res.matchedCount
        } catch (e) {
          if (!(e instanceof MongoBulkWriteError)) throw e
          const res = e.result
          r.inserted += res.upsertedCount + res.insertedCount
          r.replaced += res.matchedCount
          const errs = e.writeErrors ? (Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]) : []
          r.failed += errs.length || batch.length - res.upsertedCount - res.insertedCount - res.matchedCount
          for (const we of errs) logErr(we.errmsg ?? `write error ${we.code}`)
        }
        return
      }
      try {
        const res = await target.insertMany(batch, { ordered: false, bypassDocumentValidation: true })
        r.inserted += res.insertedCount
      } catch (e) {
        if (!(e instanceof MongoBulkWriteError)) throw e
        r.inserted += e.result.insertedCount
        const errs = e.writeErrors ? (Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]) : []
        let failed = 0
        for (const we of errs) {
          if (we.code === 11000) r.skipped++
          else {
            failed++
            logErr(we.errmsg ?? `write error ${we.code}`)
          }
        }
        if (!errs.length) failed = batch.length - e.result.insertedCount
        r.failed += failed
      }
    }

    const cursor = sdb.collection(from).find((filter ?? {}) as Filter<Document>, { ...RAW_TYPES, batchSize })
    let batch: Doc[] = []
    try {
      for await (const doc of cursor) {
        job.check()
        batch.push(doc as Doc)
        if (batch.length >= batchSize) {
          await write(batch)
          batch = []
          onProgress(r.inserted + r.replaced + r.skipped + r.failed)
        }
      }
      job.check()
      if (batch.length) await write(batch)
    } finally {
      await cursor.close().catch(() => {})
    }
    return r
  }

  /** With a collection default collation, indexes listed without one use the simple collation explicitly. */
  private async copyIndexes(job: Job, sdb: Db, tdb: Db, from: string, to: string, hasCollation: boolean): Promise<number> {
    const list = (await sdb.collection(from).listIndexes().toArray()) as Doc[]
    const specs = list
      .filter((i) => i.name !== '_id_' && !i.clustered)
      .map((i) => {
        const s: Doc = { ...i }
        delete s.v
        delete s.ns
        delete s.background
        if (hasCollation && !s.collation) s.collation = { locale: 'simple' }
        return s as { key: Document; name: string }
      })
    if (!specs.length) return 0
    try {
      await tdb.collection(to).createIndexes(specs)
      return specs.length
    } catch {
      let n = 0
      for (const s of specs) {
        job.check()
        try {
          await tdb.collection(to).createIndexes([s])
          n++
        } catch (e) {
          job.addLog(`${to}: index ${s.name} not created: ${(e as Error).message}`)
        }
      }
      return n
    }
  }
}

function normalizeOptions(o: CopyOptions): CopyOptions {
  const batchSize = Math.min(100_000, Math.max(1, Math.floor(Number(o.batchSize) || 1000)))
  return { ...o, batchSize }
}

type Handlers = { [K in keyof CopyApi]: (...args: Parameters<CopyApi[K]>) => Promise<ReturnType<CopyApi[K]>> | ReturnType<CopyApi[K]> }

/** IPC handlers for copy / paste; spread into the api object. */
export function copyHandlers(c: Copies): Handlers {
  return {
    copyPlan: (req) => c.plan(req),
    copyStart: (req) => c.start(req),
    copyCancel: (jobId) => c.cancel(jobId)
  }
}
