import { randomUUID } from 'crypto'
import { MongoBulkWriteError } from 'mongodb'
import type { AnyBulkWriteOperation, Collection, Document, Filter, MongoClient } from 'mongodb'
import { shellText } from '@shared/bsonValue'
import type { Doc, JobProgress } from '@shared/api'
import type { MaskingApi, MaskRequest, MaskRule, MaskSource, PreviewPair, ReschemaApplyOptions, ReschemaDryRun, ReschemaRequest } from '@shared/maskingApi'
import { compileOps, dryRunStages, failureExpr, HELPER, previewPipeline, stripHelpers } from '@shared/reschema'
import { RAW_TYPES } from '../mongo/ops'
import { fmt, Job, plural } from '../sql/job'
import { createJsonSink } from '../transfer/json'
import { cloneDoc, maskDoc, touchesId } from './engine'
import { recordUpdated } from '../changes/recorder'
import type { ChangeBatch, ChangeEntry, ChangeRecorders } from '../changes/recorder'

/** What Masking needs from the connection manager (ConnectionManager satisfies it). */
export interface MaskingConnections {
  get(connId: string): MongoClient
}

const BATCH = 500
const MAX_PREVIEW = 100
const FAILURE_SAMPLE = 20
const MAX_ERROR_LOGS = 100

const isAbort = (e: unknown, signal: AbortSignal): boolean => signal.aborted || (e as Error)?.name === 'AbortError'
const ns = (db: string, coll: string): string => `${db}.${coll}`
const idText = (v: unknown): string => {
  const s = shellText(v)
  return s.length > 80 ? `${s.slice(0, 77)}…` : s
}

function checkRules(rules: MaskRule[]): void {
  for (const r of rules) {
    const p = r.path.trim()
    if (!p || p.split('.').some((s) => !s)) throw new Error(`"${r.path}" is not a valid field path`)
  }
}

export class Masking {
  private jobs = new Map<string, Job>()

  constructor(
    private mgr: MaskingConnections,
    private emit: (p: JobProgress) => void,
    private recorders?: ChangeRecorders
  ) {}

  private coll(connId: string, db: string, coll: string): Collection<Document> {
    return this.mgr.get(connId).db(db).collection(coll)
  }

  private history(connId: string, db: string, coll: string, source: 'mask' | 'reschema', label: string): ChangeBatch | null {
    return this.recorders?.forConn(connId)?.begin(db, coll, source, label) ?? null
  }

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

  /** Cancels a masking or reschema job; ids of other jobs are ignored. */
  cancel(jobId: string): void {
    this.jobs.get(jobId)?.ctrl.abort()
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) j.ctrl.abort()
  }

  private async count(c: Collection<Document>, filter: Doc): Promise<number> {
    return Object.keys(filter).length ? c.countDocuments(filter as Filter<Document>) : c.estimatedDocumentCount()
  }

  // -------------------------------------------------------------------------
  // Masking
  // -------------------------------------------------------------------------

  async preview(source: MaskSource, rules: MaskRule[], salt: string, limit: number): Promise<PreviewPair[]> {
    checkRules(rules)
    const n = Math.max(1, Math.min(MAX_PREVIEW, Math.floor(limit) || 20))
    const docs = (await this.coll(source.connId, source.db, source.coll).find(source.filter as Filter<Document>, { ...RAW_TYPES, limit: n }).toArray()) as Doc[]
    return docs.map((d) => ({ before: d, after: maskDoc(cloneDoc(d), rules, salt) }))
  }

  start(req: MaskRequest): string {
    const { source, target } = req
    this.mgr.get(source.connId)
    checkRules(req.rules)
    if (!req.rules.some((r) => r.kind !== 'keep') && target.kind === 'inPlace') throw new Error('Every field is kept: there is nothing to mask')
    let title: string
    if (target.kind === 'collection') {
      this.mgr.get(target.connId)
      if (!target.db.trim() || !target.coll.trim()) throw new Error('Choose a target database and collection')
      if (target.connId === source.connId && target.db === source.db && target.coll === source.coll) throw new Error('The target is the source collection; use "Mask in place" instead')
      title = `Mask ${ns(source.db, source.coll)} → ${ns(target.db, target.coll)}`
    } else if (target.kind === 'inPlace') {
      if (target.confirm !== source.coll) throw new Error('Type the collection name to confirm masking in place')
      if (touchesId(req.rules)) throw new Error('_id cannot be changed in place; copy into another collection instead')
      title = `Mask ${ns(source.db, source.coll)} in place`
    } else {
      if (!target.path.trim()) throw new Error('Choose a file to export to')
      title = `Mask ${ns(source.db, source.coll)} → ${target.path.split(/[\\/]/).pop()}`
    }
    return this.run(title, (job) => this.runMask(job, req))
  }

  private async runMask(job: Job, req: MaskRequest): Promise<string> {
    const { source, target, rules, salt } = req
    const src = this.coll(source.connId, source.db, source.coll)
    const total = await this.count(src, source.filter).catch(() => 0)
    job.check()
    job.update({ total, done: 0, message: 'Masking…' })
    let done = 0
    let written = 0
    let failed = 0
    let logged = 0
    const fail = (msg: string): void => {
      failed++
      if (logged++ < MAX_ERROR_LOGS) job.addLog(msg)
    }
    const step = (n: number): void => {
      done += n
      job.update({ done, message: `Masking… ${fmt(done)} / ${fmt(Math.max(total, done))}` })
    }

    const cursor = src.find(source.filter as Filter<Document>, { ...RAW_TYPES, batchSize: BATCH, ...(target.kind === 'inPlace' ? { sort: { _id: 1 } } : {}) })
    try {
      if (target.kind === 'file') {
        const sink = createJsonSink(target.path, { flavor: 'relaxed', layout: 'lines', pretty: false })
        try {
          for await (const d of cursor) {
            job.check()
            await sink.write(maskDoc(d as Doc, rules, salt))
            written++
            if (written % 100 === 0) step(100)
          }
          await sink.close()
        } catch (e) {
          await sink.destroy()
          throw e
        }
        done = written
        job.update({ done })
        const text = `Exported ${plural(written, 'masked document')} to ${target.path}`
        job.addLog(text)
        return text
      }

      if (target.kind === 'collection') {
        const dst = this.coll(target.connId, target.db, target.coll)
        const into = ns(target.db, target.coll)
        if (target.dropFirst) {
          await dst.drop().catch((e: { codeName?: string; code?: number }) => {
            if (e?.codeName !== 'NamespaceNotFound' && e?.code !== 26) throw e
          })
          job.addLog(`Dropped ${into}`)
        }
        const flush = async (docs: Doc[]): Promise<void> => {
          if (!docs.length) return
          try {
            written += (await dst.insertMany(docs as Document[], { ordered: false })).insertedCount
          } catch (e) {
            if (!(e instanceof MongoBulkWriteError)) throw e
            written += e.insertedCount
            const list = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]
            for (const w of list) fail(`Insert failed for _id ${idText(docs[w.index]?._id)}: ${w.errmsg ?? 'write error'}`)
          }
          step(docs.length)
        }
        let batch: Doc[] = []
        for await (const d of cursor) {
          job.check()
          batch.push(maskDoc(d as Doc, rules, salt))
          if (batch.length >= BATCH) {
            await flush(batch)
            batch = []
          }
        }
        job.check()
        await flush(batch)
        const text = `Copied ${plural(written, 'masked document')} into ${into}${failed ? `, ${fmt(failed)} failed` : ''}`
        job.addLog(text)
        return text
      }

      let matched = 0
      const history = this.history(source.connId, source.db, source.coll, 'mask', 'Mask in place')
      const flush = async (ops: AnyBulkWriteOperation<Document>[], ids: unknown[], entries: ChangeEntry[]): Promise<void> => {
        if (!ops.length) return
        const failed = new Set<number>()
        try {
          matched += (await src.bulkWrite(ops, { ordered: false })).matchedCount
        } catch (e) {
          if (!(e instanceof MongoBulkWriteError)) throw e
          matched += e.matchedCount
          const list = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]
          for (const w of list) {
            failed.add(w.index)
            fail(`Update failed for _id ${idText(ids[w.index])}: ${w.errmsg ?? 'write error'}`)
          }
        }
        history?.add(entries.filter((_, i) => !failed.has(i)))
        step(ops.length)
      }
      let ops: AnyBulkWriteOperation<Document>[] = []
      let ids: unknown[] = []
      let entries: ChangeEntry[] = []
      for await (const d of cursor) {
        job.check()
        const doc = d as Doc
        const replacement = maskDoc(cloneDoc(doc), rules, salt)
        ops.push({ replaceOne: { filter: { _id: doc._id } as Filter<Document>, replacement } })
        ids.push(doc._id)
        if (history) entries.push({ op: 'replace', before: doc, after: replacement })
        if (ops.length >= BATCH) {
          await flush(ops, ids, entries)
          ops = []
          ids = []
          entries = []
        }
      }
      job.check()
      await flush(ops, ids, entries)
      if (history?.truncated) job.addLog(`Change History kept the first ${fmt(history.cap)} documents only`)
      const text = `Masked ${plural(matched, 'document')} of ${ns(source.db, source.coll)} in place${failed ? `, ${fmt(failed)} failed` : ''}`
      job.addLog(text)
      return text
    } finally {
      await cursor.close().catch(() => {})
    }
  }

  // -------------------------------------------------------------------------
  // Restructure Fields
  // -------------------------------------------------------------------------

  async reschemaPreview(req: ReschemaRequest, limit: number): Promise<PreviewPair[]> {
    const n = Math.max(1, Math.min(MAX_PREVIEW, Math.floor(limit) || 20))
    const pipeline = previewPipeline(req.filter, req.ops, n)
    const docs = (await this.coll(req.connId, req.db, req.coll).aggregate(pipeline, { ...RAW_TYPES, allowDiskUse: true }).toArray()) as Doc[]
    return docs.map((d) => ({ before: d[`${HELPER}orig`] as Doc, after: stripHelpers(d) }))
  }

  async reschemaDryRun(req: ReschemaRequest): Promise<ReschemaDryRun> {
    const t0 = Date.now()
    const c = this.coll(req.connId, req.db, req.coll)
    const stages = dryRunStages(req.filter, req.ops)
    const convertOps = req.ops.map((op, i) => ({ op, i })).filter(({ op }) => failureExpr(op) !== null)
    const group: Doc = {
      _id: null,
      matched: { $sum: 1 },
      changed: { $sum: { $cond: [`$${HELPER}changed`, 1, 0] } }
    }
    for (const { i } of convertOps) group[`f${i}`] = { $sum: { $cond: [{ $eq: [`$${HELPER}f${i}`, true] }, 1, 0] } }
    const [g] = (await c.aggregate([...stages, { $group: group }], { allowDiskUse: true }).toArray()) as Doc[]
    const num = (v: unknown): number => Number(v ?? 0)
    const failures: ReschemaDryRun['failures'] = []
    for (const { op, i } of convertOps) {
      if (op.kind !== 'convert') continue
      const count = num(g?.[`f${i}`])
      const sampleIds = count
        ? ((await c.aggregate([...stages, { $match: { [`${HELPER}f${i}`]: true } }, { $limit: FAILURE_SAMPLE }, { $project: { _id: 1 } }], { ...RAW_TYPES, allowDiskUse: true }).toArray()) as Doc[]).map((d) => d._id)
        : []
      failures.push({ op: i, path: op.path.trim(), to: op.to, count, sampleIds })
    }
    return { matched: num(g?.matched), changed: num(g?.changed), failures, ms: Date.now() - t0 }
  }

  reschemaStart(req: ReschemaRequest, opts: ReschemaApplyOptions): string {
    this.mgr.get(req.connId)
    const pipeline = compileOps(req.ops)
    const batch = Math.max(0, Math.floor(opts.batchSize || 0))
    return this.run(`Restructure fields ${ns(req.db, req.coll)}`, (job) => this.runReschema(job, req, pipeline, batch))
  }

  private async runReschema(job: Job, req: ReschemaRequest, pipeline: Doc[], batch: number): Promise<string> {
    const c = this.coll(req.connId, req.db, req.coll)
    const filter = req.filter as Filter<Document>
    const name = ns(req.db, req.coll)
    const history = this.history(req.connId, req.db, req.coll, 'reschema', `Restructure fields: ${plural(req.ops.length, 'change')}`)
    let cappedLogged = false
    const capped = (): void => {
      if (!cappedLogged) job.addLog(`Change History keeps at most ${fmt(history!.cap)} documents per operation: the rest is not recorded`)
      cappedLogged = true
    }
    if (!batch) {
      job.update({ message: 'Running updateMany…' })
      let before: Doc[] | null = null
      if (history) {
        before = (await c.find(filter, { ...RAW_TYPES, limit: history.remaining + 1 }).toArray()) as Doc[]
        if (before.length > history.remaining) {
          capped()
          before = null
        }
      }
      const r = await c.updateMany(filter, pipeline)
      await recordUpdated(c, history, before).catch(() => {})
      job.update({ done: r.matchedCount, total: r.matchedCount })
      const text = `Updated ${name}: ${plural(r.matchedCount, 'document')} matched, ${fmt(r.modifiedCount)} modified`
      job.addLog(text)
      return text
    }
    const total = await this.count(c, req.filter).catch(() => 0)
    job.check()
    job.update({ total, done: 0, message: 'Updating…' })
    const hasFilter = Object.keys(req.filter).length > 0
    let done = 0
    let matched = 0
    let modified = 0
    const cursor = c.find(filter, { projection: { _id: 1 }, sort: { _id: 1 }, batchSize: batch, ...RAW_TYPES })
    const flush = async (ids: unknown[]): Promise<void> => {
      if (!ids.length) return
      const inIds = { _id: { $in: ids } }
      let before: Doc[] | null = null
      if (history && history.remaining > 0) {
        const some = { _id: { $in: ids.slice(0, history.remaining) } }
        before = (await c.find((hasFilter ? { $and: [req.filter, some] } : some) as Filter<Document>, RAW_TYPES).toArray()) as Doc[]
        if (ids.length > history.remaining) capped()
      }
      const r = await c.updateMany((hasFilter ? { $and: [req.filter, inIds] } : inIds) as Filter<Document>, pipeline)
      await recordUpdated(c, history, before).catch(() => {})
      matched += r.matchedCount
      modified += r.modifiedCount
      done += ids.length
      job.update({ done, message: `Updating… ${fmt(done)} / ${fmt(Math.max(total, done))}` })
    }
    try {
      let ids: unknown[] = []
      for await (const d of cursor) {
        job.check()
        ids.push((d as Doc)._id)
        if (ids.length >= batch) {
          await flush(ids)
          ids = []
        }
      }
      job.check()
      await flush(ids)
    } catch (e) {
      if (isAbort(e, job.signal)) job.addLog(`Cancelled after ${plural(done, 'document')} (${fmt(modified)} modified); the rest is unchanged`)
      throw e
    } finally {
      await cursor.close().catch(() => {})
    }
    const text = `Updated ${name}: ${plural(matched, 'document')} matched, ${fmt(modified)} modified`
    job.addLog(text)
    return text
  }
}

type Handlers = { [K in keyof MaskingApi]: (...args: Parameters<MaskingApi[K]>) => Promise<ReturnType<MaskingApi[K]>> | ReturnType<MaskingApi[K]> }

/** IPC handlers for the masking and reschema methods; spread into createApi()'s result. */
export function maskingHandlers(m: Masking): Handlers {
  return {
    maskingPreview: (source, rules, salt, limit) => m.preview(source, rules, salt, limit),
    maskingStart: (req) => m.start(req),
    maskingCancel: (jobId) => m.cancel(jobId),
    reschemaPreview: (req, limit) => m.reschemaPreview(req, limit),
    reschemaDryRun: (req) => m.reschemaDryRun(req),
    reschemaStart: (req, opts) => m.reschemaStart(req, opts)
  }
}
