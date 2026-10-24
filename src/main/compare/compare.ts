import { randomUUID } from 'crypto'
import { MongoBulkWriteError } from 'mongodb'
import type { AnyBulkWriteOperation, Collection, Document, Filter, FindCursor, MongoClient } from 'mongodb'
import { shellText } from '@shared/bsonValue'
import type { Doc, JobProgress } from '@shared/api'
import type {
  CompareApi,
  CompareCategory,
  CompareCounts,
  CompareEntry,
  CompareRequest,
  CompareResultPage,
  CompareSide,
  CompareSummary,
  SyncOperation,
  SyncPlan,
  SyncRequest
} from '@shared/compareApi'
import { RAW_TYPES } from '../mongo/ops'
import { compareBson, diffDocs, keyId, keyOf, projectDoc, setUpdate, toFieldDiff } from './diff'
import { recordUpdated } from '../changes/recorder'
import type { ChangeEntry, ChangeRecorders } from '../changes/recorder'

/** What Comparisons needs from the connection manager (ConnectionManager satisfies it). */
export interface CompareConnections {
  get(connId: string): MongoClient
  /** Refuses read-only connections (ConnectionManager); the guarded client refuses the writes anyway. */
  assertWritable?(connId: string, action?: string): void
}

/** Entries kept in memory per category; counts stay exact beyond it. */
export const ENTRY_CAP = 10_000
const MAX_DIFFS_PER_DOC = 100
const MAX_RESULTS = 20
const BATCH = 500
const EMIT_INTERVAL_MS = 100
const MAX_LOG_LINES = 500
const PLAN_SAMPLE = 50

const fmt = (n: number): string => n.toLocaleString('en-US')
const plural = (n: number, w: string): string => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`
const keyText = (k: unknown): string => {
  const s = shellText(k)
  return s.length > 80 ? `${s.slice(0, 77)}…` : s
}
const isAbort = (e: unknown, signal: AbortSignal): boolean => signal.aborted || (e as Error)?.name === 'AbortError'

/** Progress of one job, emitted at most every 100 ms (plus the final update). Mirrors transfer/jobs.ts. */
class Job {
  readonly ctrl = new AbortController()
  done = 0
  total?: number
  message?: string
  private log: string[] = []
  private dropped = 0
  private lastEmit = 0
  private timer: NodeJS.Timeout | null = null
  private finished = false

  constructor(
    readonly id: string,
    readonly title: string,
    private emit: (p: JobProgress) => void
  ) {}

  get signal(): AbortSignal {
    return this.ctrl.signal
  }

  addLog(line: string): void {
    this.log.push(line)
    if (this.log.length > MAX_LOG_LINES) {
      this.log.shift()
      this.dropped++
    }
    this.touch()
  }

  update(p: { done?: number; total?: number; message?: string }): void {
    if (p.done !== undefined) this.done = p.done
    if (p.total !== undefined) this.total = p.total
    if (p.message !== undefined) this.message = p.message
    this.touch()
  }

  private snapshot(state: JobProgress['state'], error?: string): JobProgress {
    const log = this.dropped ? [`… ${fmt(this.dropped)} earlier lines omitted`, ...this.log] : [...this.log]
    const p: JobProgress = { jobId: this.id, title: this.title, done: this.done, state, log }
    if (this.total !== undefined) p.total = this.total
    if (this.message !== undefined) p.message = this.message
    if (error !== undefined) p.error = error
    return p
  }

  private touch(): void {
    if (this.finished) return
    const wait = this.lastEmit + EMIT_INTERVAL_MS - Date.now()
    if (wait <= 0) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), wait)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.finished) return
    this.lastEmit = Date.now()
    this.emit(this.snapshot('running'))
  }

  finish(state: 'done' | 'error' | 'cancelled', error?: string): void {
    if (this.finished) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.finished = true
    this.emit(this.snapshot(state, error))
  }
}

interface CompareState {
  summary: CompareSummary
  entries: Record<CompareCategory, CompareEntry[]>
  started: number
  syncing: boolean
}

interface Sides {
  from: CompareSide
  into: CompareSide
  missing: CompareEntry[]
  extra: CompareEntry[]
}

/** One side of the merge-join: a key-sorted cursor that checks order and uniqueness as it goes. */
class SortedSide {
  private it: AsyncIterator<Doc>
  private prev: { key: unknown } | null = null
  read = 0
  /** The sample limit was reached: more documents exist. */
  limited = false

  constructor(
    private cursor: FindCursor<Doc>,
    private name: string,
    private key: string,
    private limit = 0
  ) {
    this.it = cursor[Symbol.asyncIterator]()
  }

  async next(): Promise<{ doc: Doc; key: unknown } | null> {
    const r = await this.it.next()
    if (r.done) return null
    if (this.limit && this.read >= this.limit) {
      this.limited = true
      return null
    }
    const doc = r.value
    const key = keyOf(doc, this.key)
    if (Array.isArray(key)) throw new Error(`The key field "${this.key}" holds an array in the ${this.name} (${keyText(doc._id)}); choose a field with single values`)
    if (this.prev) {
      const c = compareBson(this.prev.key, key)
      if (c === 0) throw new Error(`The key field "${this.key}" is not unique in the ${this.name}: ${keyText(key)} appears more than once`)
      if (c > 0) throw new Error(`Keys of the ${this.name} are not in a comparable order near ${keyText(key)}; use a key field with values of one type`)
    }
    this.prev = { key }
    this.read++
    return { doc, key }
  }

  close(): Promise<void> {
    return this.cursor.close().catch(() => {})
  }
}

export class Comparisons {
  private results = new Map<string, CompareState>()
  private jobs = new Map<string, Job>()

  constructor(
    private mgr: CompareConnections,
    private emit: (p: JobProgress) => void,
    private recorders?: ChangeRecorders
  ) {}

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  private run(
    title: string,
    body: (job: Job) => Promise<string>,
    after?: (state: 'done' | 'error' | 'cancelled', error?: string) => void,
    id: string = randomUUID()
  ): string {
    const job = new Job(id, title, this.emit)
    this.jobs.set(job.id, job)
    job.update({ message: 'Starting…' })
    void (async () => {
      let state: 'done' | 'error' | 'cancelled' = 'done'
      let error: string | undefined
      try {
        const message = await body(job)
        job.update({ message })
        if (job.signal.aborted) state = 'cancelled'
      } catch (e) {
        if (isAbort(e, job.signal)) {
          state = 'cancelled'
          job.update({ message: 'Cancelled' })
        } else {
          state = 'error'
          error = (e as Error)?.message || String(e)
          job.update({ message: error })
        }
      } finally {
        this.jobs.delete(job.id)
        after?.(state, error)
        job.finish(state, error)
      }
    })()
    return job.id
  }

  /** Cancels a compare or sync job; ids of other jobs are ignored. */
  cancel(jobId: string): void {
    this.jobs.get(jobId)?.ctrl.abort()
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) j.ctrl.abort()
  }

  dispose(jobId: string): void {
    this.cancel(jobId)
    this.results.delete(jobId)
  }

  private state(jobId: string): CompareState {
    const s = this.results.get(jobId)
    if (!s) throw new Error('This comparison is no longer available; run it again')
    return s
  }

  // -------------------------------------------------------------------------
  // Compare
  // -------------------------------------------------------------------------

  start(req: CompareRequest): string {
    const key = req.key.trim() || '_id'
    const r: CompareRequest = { ...req, key, sample: Math.max(0, Math.floor(req.sample || 0)) }
    this.mgr.get(r.source.connId)
    this.mgr.get(r.target.connId)
    if (!r.source.coll || !r.target.coll) throw new Error('Choose a source and a target collection')
    const same = r.source.connId === r.target.connId && r.source.db === r.target.db && r.source.coll === r.target.coll
    if (same && JSON.stringify(r.source.filter) === JSON.stringify(r.target.filter)) throw new Error('Source and target are the same collection')
    const title = `Compare ${r.source.db}.${r.source.coll} ⇄ ${r.target.db}.${r.target.coll}`
    const id = randomUUID()
    const st: CompareState = {
      summary: {
        jobId: id,
        state: 'running',
        request: r,
        startedAt: new Date(),
        ms: 0,
        sourceCount: 0,
        targetCount: 0,
        onlySource: 0,
        onlyTarget: 0,
        different: 0,
        identical: 0,
        truncated: [],
        cap: ENTRY_CAP,
        sampled: false,
        stale: false
      },
      entries: { onlySource: [], onlyTarget: [], different: [], identical: [] },
      started: Date.now(),
      syncing: false
    }
    this.results.set(id, st)
    this.evict()
    return this.run(
      title,
      (job) => this.runCompare(job, st),
      (state, error) => {
        st.summary.state = state
        st.summary.ms = Date.now() - st.started
        if (error) st.summary.error = error
      },
      id
    )
  }

  private evict(): void {
    if (this.results.size <= MAX_RESULTS) return
    for (const [id, s] of this.results) {
      if (this.results.size <= MAX_RESULTS) break
      if (s.summary.state !== 'running' && !s.syncing) this.results.delete(id)
    }
  }

  private cursor(side: CompareSide, key: string, limit: number): FindCursor<Doc> {
    return this.mgr
      .get(side.connId)
      .db(side.db)
      .collection(side.coll)
      .find(side.filter as Filter<Document>, {
        ...RAW_TYPES,
        sort: { [key]: 1 },
        collation: { locale: 'simple' },
        allowDiskUse: key === '_id' ? undefined : true,
        limit: limit || undefined
      }) as FindCursor<Doc>
  }

  private async count(side: CompareSide): Promise<number> {
    const c = this.mgr.get(side.connId).db(side.db).collection(side.coll)
    if (!Object.keys(side.filter).length) return c.estimatedDocumentCount()
    return c.countDocuments(side.filter as Filter<Document>)
  }

  private async runCompare(job: Job, st: CompareState): Promise<string> {
    const req = st.summary.request
    const sum = st.summary
    const { key, sample } = req
    const [sc, tc] = await Promise.all([this.count(req.source).catch(() => 0), this.count(req.target).catch(() => 0)])
    job.signal.throwIfAborted()
    sum.total = sample ? Math.min(sample, sc) * 2 : sc + tc
    job.update({ total: sum.total, done: 0, message: 'Comparing…' })

    const add = (cat: CompareCategory, e: CompareEntry): void => {
      sum[cat]++
      const list = st.entries[cat]
      if (list.length < ENTRY_CAP) list.push(e)
      else if (!sum.truncated.includes(cat)) {
        sum.truncated.push(cat)
        job.addLog(`More than ${fmt(ENTRY_CAP)} "${cat}" documents: only the first ${fmt(ENTRY_CAP)} are listed (counts stay exact)`)
      }
    }

    const src = new SortedSide(this.cursor(req.source, key, sample ? sample + 1 : 0), 'source', key, sample)
    const tgt = new SortedSide(this.cursor(req.target, key, 0), 'target', key)
    let s: Awaited<ReturnType<SortedSide['next']>> = null
    let t: Awaited<ReturnType<SortedSide['next']>> = null
    try {
      s = await src.next()
      t = await tgt.next()
      let n = 0
      while (s || t) {
        job.signal.throwIfAborted()
        if (!s && src.limited) {
          sum.sampled = true
          break
        }
        const c = s && t ? compareBson(s.key, t.key) : s ? -1 : 1
        if (c < 0) {
          add('onlySource', { key: s!.key })
          s = await src.next()
        } else if (c > 0) {
          add('onlyTarget', { key: t!.key })
          t = await tgt.next()
        } else {
          const a = projectDoc(s!.doc, req.fields, req.ignore)
          const b = projectDoc(t!.doc, req.fields, req.ignore)
          const d = diffDocs(a, b, MAX_DIFFS_PER_DOC)
          if (d.total === 0) add('identical', { key: s!.key })
          else {
            const e: CompareEntry = { key: s!.key, diffs: d.diffs.map(toFieldDiff) }
            if (d.total > d.diffs.length) e.more = d.total - d.diffs.length
            add('different', e)
          }
          s = await src.next()
          t = await tgt.next()
        }
        sum.sourceCount = src.read
        sum.targetCount = tgt.read
        if (++n % 200 === 0) job.update({ done: src.read + tgt.read, message: progressText(sum) })
      }
      if (!s && src.limited) sum.sampled = true
    } finally {
      await Promise.all([src.close(), tgt.close()])
    }
    sum.sourceCount = src.read
    // In sample mode the target's look-ahead document lies beyond the sampled key range.
    sum.targetCount = tgt.read - (t ? 1 : 0)
    const scanned = sum.sourceCount + sum.targetCount
    sum.total = scanned
    job.update({ done: scanned, total: scanned })
    const text = `${progressText(sum)}${sum.sampled ? ` (sample of the first ${plural(sample, 'source document')})` : ''}`
    job.addLog(text)
    return text
  }

  summary(jobId: string): CompareSummary {
    const st = this.state(jobId)
    const s = { ...st.summary, truncated: [...st.summary.truncated] }
    if (s.state === 'running') s.ms = Date.now() - st.started
    return s
  }

  result(jobId: string, category: CompareCategory, offset: number, limit: number): CompareResultPage {
    const list = this.state(jobId).entries[category]
    const o = Math.max(0, Math.floor(offset))
    return { category, entries: list.slice(o, o + Math.max(1, Math.min(1000, Math.floor(limit)))), stored: list.length, offset: o }
  }

  async docs(jobId: string, key: unknown): Promise<{ source: Doc | null; target: Doc | null }> {
    const req = this.state(jobId).summary.request
    const read = (side: CompareSide): Promise<Doc | null> =>
      this.mgr
        .get(side.connId)
        .db(side.db)
        .collection(side.coll)
        .findOne({ [req.key]: key } as Filter<Document>, RAW_TYPES) as Promise<Doc | null>
    const [source, target] = await Promise.all([read(req.source), read(req.target)])
    return { source, target }
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  private sides(st: CompareState, direction: SyncRequest['direction']): Sides {
    const r = st.summary.request
    return direction === 'sourceToTarget'
      ? { from: r.source, into: r.target, missing: st.entries.onlySource, extra: st.entries.onlyTarget }
      : { from: r.target, into: r.source, missing: st.entries.onlyTarget, extra: st.entries.onlySource }
  }

  private collection(side: CompareSide): Collection<Document> {
    return this.mgr.get(side.connId).db(side.db).collection(side.coll)
  }

  private ready(req: SyncRequest): { st: CompareState; sides: Sides } {
    const st = this.state(req.compareJobId)
    if (st.summary.state !== 'done') throw new Error('The comparison has not finished successfully')
    if (st.syncing) throw new Error('A sync of this comparison is already running')
    return { st, sides: this.sides(st, req.direction) }
  }

  private async fetch(coll: Collection<Document>, key: string, entries: CompareEntry[]): Promise<Map<string, Doc>> {
    const docs = (await coll.find({ [key]: { $in: entries.map((e) => e.key) } } as Filter<Document>, RAW_TYPES).toArray()) as Doc[]
    return new Map(docs.map((d) => [keyId(keyOf(d, key)), d]))
  }

  /** Dry run: counts plus the first operations, computed from the stored results and the current documents. */
  async plan(req: SyncRequest): Promise<SyncPlan> {
    const { st, sides } = this.ready(req)
    const r = st.summary.request
    const ns = (s: CompareSide): SyncPlan['into'] => ({ connId: s.connId, db: s.db, coll: s.coll })
    const plan: SyncPlan = {
      from: ns(sides.from),
      into: ns(sides.into),
      inserts: req.insertMissing ? sides.missing.length : 0,
      deletes: req.deleteExtra ? sides.extra.length : 0,
      updates: req.overwrite !== 'none' ? st.entries.different.length : 0,
      sample: [],
      truncated: false,
      cap: ENTRY_CAP
    }
    const t = st.summary.truncated
    const missingCat: CompareCategory = req.direction === 'sourceToTarget' ? 'onlySource' : 'onlyTarget'
    const extraCat: CompareCategory = req.direction === 'sourceToTarget' ? 'onlyTarget' : 'onlySource'
    plan.truncated = (plan.inserts > 0 && t.includes(missingCat)) || (plan.deletes > 0 && t.includes(extraCat)) || (plan.updates > 0 && t.includes('different'))
    const push = (o: SyncOperation): boolean => plan.sample.length < PLAN_SAMPLE && !!plan.sample.push(o)
    if (req.insertMissing) for (const e of sides.missing) if (!push({ op: 'insert', key: e.key })) break
    if (req.deleteExtra) for (const e of sides.extra) if (!push({ op: 'delete', key: e.key })) break
    const room = PLAN_SAMPLE - plan.sample.length
    if (req.overwrite !== 'none' && room > 0) {
      const batch = st.entries.different.slice(0, room)
      const [from, into] = await Promise.all([this.fetch(this.collection(sides.from), r.key, batch), this.fetch(this.collection(sides.into), r.key, batch)])
      for (const e of batch) {
        const f = from.get(keyId(e.key))
        const i = into.get(keyId(e.key))
        if (!f || !i) continue
        const d = diffDocs(projectDoc(f, r.fields, r.ignore), projectDoc(i, r.fields, r.ignore))
        if (!d.total) continue
        const u = req.overwrite === 'set' ? setUpdate(f, i, d.diffs) : null
        push(u ? { op: 'update', key: e.key, update: u } : { op: 'replace', key: e.key })
      }
    }
    return plan
  }

  startSync(req: SyncRequest): string {
    const { st, sides } = this.ready(req)
    if (!req.insertMissing && !req.deleteExtra && req.overwrite === 'none') throw new Error('Choose at least one sync action')
    this.mgr.get(sides.from.connId)
    this.mgr.get(sides.into.connId)
    this.mgr.assertWritable?.(sides.into.connId, `syncing into ${sides.into.db}.${sides.into.coll}`)
    st.syncing = true
    st.summary.stale = true
    const title = `Sync ${sides.from.db}.${sides.from.coll} → ${sides.into.db}.${sides.into.coll}`
    return this.run(
      title,
      (job) => this.runSync(job, st, sides, req),
      () => (st.syncing = false)
    )
  }

  private async runSync(job: Job, st: CompareState, sides: Sides, req: SyncRequest): Promise<string> {
    const r = st.summary.request
    const key = r.key
    const from = this.collection(sides.from)
    const into = this.collection(sides.into)
    const total = (req.insertMissing ? sides.missing.length : 0) + (req.deleteExtra ? sides.extra.length : 0) + (req.overwrite !== 'none' ? st.entries.different.length : 0)
    const n = { inserted: 0, deleted: 0, replaced: 0, updated: 0, skipped: 0, failed: 0 }
    let done = 0
    job.update({ total, done: 0 })
    const into1 = `${sides.into.db}.${sides.into.coll}`
    const errors = { logged: 0 }
    const history = this.recorders?.forConn(sides.into.connId)?.begin(sides.into.db, sides.into.coll, 'sync', `Sync from ${sides.from.db}.${sides.from.coll}`) ?? null
    /** Change History entries parallel to a batch's operations (null = nothing to record). */
    const record = (entries: (ChangeEntry | null)[], failed: Set<number>): void => {
      history?.add(entries.filter((e, i): e is ChangeEntry => !!e && !failed.has(i)))
    }

    const write = async (ops: AnyBulkWriteOperation<Document>[], keys: unknown[]): Promise<{ inserted: number; deleted: number; matched: number; failed: Set<number> }> => {
      const failed = new Set<number>()
      if (!ops.length) return { inserted: 0, deleted: 0, matched: 0, failed }
      try {
        const res = await into.bulkWrite(ops, { ordered: false })
        return { inserted: res.insertedCount, deleted: res.deletedCount, matched: res.matchedCount, failed }
      } catch (e) {
        if (!(e instanceof MongoBulkWriteError)) throw e
        const list = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]
        n.failed += list.length
        for (const w of list) {
          failed.add(w.index)
          if (errors.logged++ < 200) job.addLog(`Failed for key ${keyText(keys[w.index])}: ${w.errmsg ?? 'write error'}`)
        }
        return { inserted: e.insertedCount, deleted: e.deletedCount, matched: e.matchedCount, failed }
      }
    }
    const step = (k: number, what: string): void => {
      done += k
      job.update({ done, message: `${what}… ${fmt(done)} / ${fmt(total)}` })
    }

    if (req.insertMissing && sides.missing.length) {
      for (let i = 0; i < sides.missing.length; i += BATCH) {
        job.signal.throwIfAborted()
        const batch = sides.missing.slice(i, i + BATCH)
        const [docs, existing] = await Promise.all([this.fetch(from, key, batch), this.fetch(into, key, batch)])
        const ops: AnyBulkWriteOperation<Document>[] = []
        const keys: unknown[] = []
        for (const e of batch) {
          const id = keyId(e.key)
          const d = docs.get(id)
          if (!d) {
            n.skipped++
            job.addLog(`Skipped insert of ${keyText(e.key)}: no longer in the source`)
          } else if (existing.has(id)) {
            n.skipped++
            job.addLog(`Skipped insert of ${keyText(e.key)}: already exists in ${into1}`)
          } else {
            ops.push({ insertOne: { document: d } })
            keys.push(e.key)
          }
        }
        const res = await write(ops, keys)
        n.inserted += res.inserted
        record(ops.map((o) => ('insertOne' in o ? { op: 'insert', after: o.insertOne.document as Doc } : null)), res.failed)
        step(batch.length, 'Inserting')
      }
      job.addLog(`Inserted ${plural(n.inserted, 'document')} into ${into1}`)
    }

    if (req.deleteExtra && sides.extra.length) {
      for (let i = 0; i < sides.extra.length; i += BATCH) {
        job.signal.throwIfAborted()
        const batch = sides.extra.slice(i, i + BATCH)
        const [present, doomed] = await Promise.all([this.fetch(from, key, batch), history ? this.fetch(into, key, batch) : new Map<string, Doc>()])
        const ops: AnyBulkWriteOperation<Document>[] = []
        const keys: unknown[] = []
        const before: (ChangeEntry | null)[] = []
        for (const e of batch) {
          if (present.has(keyId(e.key))) {
            n.skipped++
            job.addLog(`Skipped delete of ${keyText(e.key)}: it now exists on the other side`)
          } else {
            ops.push({ deleteOne: { filter: { [key]: e.key } } })
            keys.push(e.key)
            const d = doomed.get(keyId(e.key))
            before.push(d ? { op: 'delete', before: d } : null)
          }
        }
        const res = await write(ops, keys)
        n.deleted += res.deleted
        record(before, res.failed)
        step(batch.length, 'Deleting')
      }
      job.addLog(`Deleted ${plural(n.deleted, 'document')} from ${into1}`)
    }

    if (req.overwrite !== 'none' && st.entries.different.length) {
      const list = st.entries.different
      for (let i = 0; i < list.length; i += BATCH) {
        job.signal.throwIfAborted()
        const batch = list.slice(i, i + BATCH)
        const [fromDocs, intoDocs] = await Promise.all([this.fetch(from, key, batch), this.fetch(into, key, batch)])
        const ops: AnyBulkWriteOperation<Document>[] = []
        const keys: unknown[] = []
        const before: Doc[] = []
        let replaces = 0
        for (const e of batch) {
          const f = fromDocs.get(keyId(e.key))
          const t = intoDocs.get(keyId(e.key))
          if (!f || !t) {
            n.skipped++
            job.addLog(`Skipped ${keyText(e.key)}: no longer on ${!f ? 'the side copied from' : into1}`)
            continue
          }
          const d = diffDocs(projectDoc(f, r.fields, r.ignore), projectDoc(t, r.fields, r.ignore))
          if (!d.total) {
            n.skipped++
            continue
          }
          const u = req.overwrite === 'set' ? setUpdate(f, t, d.diffs) : null
          if (u && !Object.keys(u).length) {
            n.skipped++
            continue
          }
          if (u) ops.push({ updateOne: { filter: { _id: t._id } as Filter<Document>, update: u } })
          else {
            if (req.overwrite === 'set') job.addLog(`Replaced ${keyText(e.key)} entirely: a field name cannot be used in $set`)
            const replacement: Doc = { ...f }
            if (key !== '_id') delete replacement._id
            ops.push({ replaceOne: { filter: { _id: t._id } as Filter<Document>, replacement } })
            replaces++
          }
          keys.push(e.key)
          before.push(t)
        }
        const res = await write(ops, keys)
        if (history) await recordUpdated(into, history, before.filter((_, k) => !res.failed.has(k)), req.overwrite === 'set' ? 'update' : 'replace').catch(() => {})
        // matched counts both kinds; attribute replacements first.
        const rep = Math.min(replaces, res.matched)
        n.replaced += rep
        n.updated += res.matched - rep
        step(batch.length, 'Overwriting')
      }
      job.addLog(`Overwrote ${plural(n.replaced + n.updated, 'document')} in ${into1}${n.updated && n.replaced ? ` (${fmt(n.updated)} with $set, ${fmt(n.replaced)} replaced)` : ''}`)
    }

    if (history?.truncated) job.addLog(`Change History kept the first ${fmt(history.cap)} changed documents only`)
    job.update({ done: total })
    const parts: string[] = []
    if (req.insertMissing) parts.push(`${fmt(n.inserted)} inserted`)
    if (req.deleteExtra) parts.push(`${fmt(n.deleted)} deleted`)
    if (req.overwrite !== 'none') parts.push(`${fmt(n.replaced + n.updated)} overwritten`)
    if (n.skipped) parts.push(`${fmt(n.skipped)} skipped`)
    if (n.failed) parts.push(`${fmt(n.failed)} failed`)
    const text = `Synced ${into1}: ${parts.join(', ')}`
    job.addLog(text)
    return text
  }
}

function progressText(s: CompareCounts): string {
  return `${plural(s.sourceCount + s.targetCount, 'document')} compared — ${fmt(s.different)} different, ${fmt(s.onlySource)} only in source, ${fmt(s.onlyTarget)} only in target, ${fmt(s.identical)} identical`
}

type Handlers = { [K in keyof CompareApi]: (...args: Parameters<CompareApi[K]>) => Promise<ReturnType<CompareApi[K]>> | ReturnType<CompareApi[K]> }

/** IPC handlers for the Diff & Sync methods; spread into createApi()'s result. */
export function compareHandlers(c: Comparisons): Handlers {
  return {
    compareStart: (req) => c.start(req),
    compareSummary: (jobId) => c.summary(jobId),
    compareResult: (jobId, category, offset, limit) => c.result(jobId, category, offset, limit),
    compareDocs: (jobId, key) => c.docs(jobId, key),
    compareSyncPlan: (req) => c.plan(req),
    compareSyncStart: (req) => c.startSync(req),
    compareCancel: (jobId) => c.cancel(jobId),
    compareDispose: (jobId) => c.dispose(jobId)
  }
}
