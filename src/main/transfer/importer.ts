import type { AnyBulkWriteOperation, Collection, Document, Filter } from 'mongodb'
import type { Doc } from '@shared/api'
import { docIdText, readByIds } from '../changes/recorder'
import type { ChangeBatch, ChangeEntry } from '../changes/recorder'

export const IMPORT_BATCH = 1000
/** Write errors logged per job before we only count them. */
const MAX_LOGGED_ERRORS = 100

export class ImportAbort extends Error {}

interface BulkErrorLike {
  name?: string
  message: string
  writeErrors?: { index?: number; errmsg?: string; code?: number }[] | { index?: number; errmsg?: string }
  result?: { insertedCount?: number; upsertedCount?: number; matchedCount?: number; modifiedCount?: number }
}

/** Batches documents into insertMany / bulkWrite(replaceOne upsert) calls and keeps counts. */
export class DocWriter {
  inserted = 0
  updated = 0
  failed = 0
  private batch: Doc[] = []
  /** Documents handed to the database so far (for error positions). */
  private submitted = 0
  private loggedErrors = 0

  constructor(
    private coll: Collection<Document>,
    private mode: 'insert' | 'upsert',
    private stopOnError: boolean,
    private log: (line: string) => void,
    /** Upsert mode: records replaced documents (before images) and new ones in Change History. */
    private history: ChangeBatch | null = null
  ) {}

  /** Existing documents an upsert batch is about to replace. */
  private async beforeImages(docs: Doc[]): Promise<Map<string, Doc> | null> {
    if (!this.history || this.history.remaining <= 0) return null
    const ids = docs.filter((d) => d._id !== undefined).map((d) => d._id)
    return readByIds(this.coll, ids).catch(() => null)
  }

  private recordHistory(docs: Doc[], existing: Map<string, Doc> | null, failed: Set<number>): void {
    if (!this.history || !existing) return
    const entries: ChangeEntry[] = []
    docs.forEach((d, i) => {
      if (failed.has(i) || d._id === undefined) return
      const old = existing.get(docIdText(d._id))
      entries.push(old ? { op: 'replace', before: old, after: d } : { op: 'insert', docId: d._id })
    })
    const wasTruncated = this.history.truncated
    this.history.add(entries)
    if (this.history.truncated && !wasTruncated) this.log(`Change History keeps at most ${this.history.cap.toLocaleString('en-US')} documents per operation: later documents are not recorded`)
  }

  get processed(): number {
    return this.inserted + this.updated + this.failed
  }

  async add(doc: Doc): Promise<void> {
    this.batch.push(doc)
    if (this.batch.length >= IMPORT_BATCH) await this.flush()
  }

  /** Count a record that could not be read (parse / conversion error). */
  async recordError(msg: string): Promise<void> {
    // With stop-on-error, documents before the bad record are still written (and may fail first).
    if (this.stopOnError) await this.flush()
    this.failed++
    this.logError(msg)
    if (this.stopOnError) throw new ImportAbort(msg)
  }

  private logError(msg: string): void {
    if (this.loggedErrors < MAX_LOGGED_ERRORS) this.log(msg)
    else if (this.loggedErrors === MAX_LOGGED_ERRORS) this.log('Too many errors; further errors are counted but not listed.')
    this.loggedErrors++
  }

  async flush(): Promise<void> {
    const docs = this.batch
    this.batch = []
    if (!docs.length) return
    const ordered = this.stopOnError
    const base = this.submitted
    this.submitted += docs.length
    const existing = this.mode === 'upsert' ? await this.beforeImages(docs) : null
    try {
      if (this.mode === 'insert') {
        const r = await this.coll.insertMany(docs as Document[], { ordered })
        this.inserted += r.insertedCount
      } else {
        const ops: AnyBulkWriteOperation<Document>[] = docs.map((d) =>
          d._id === undefined
            ? { insertOne: { document: d as Document } }
            : { replaceOne: { filter: { _id: d._id } as Filter<Document>, replacement: d as Document, upsert: true } }
        )
        const r = await this.coll.bulkWrite(ops, { ordered })
        this.inserted += r.insertedCount + r.upsertedCount
        this.updated += r.matchedCount
        this.recordHistory(docs, existing, new Set())
      }
    } catch (e) {
      const err = e as BulkErrorLike
      if (err.name !== 'MongoBulkWriteError' || !err.writeErrors) throw e
      const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors]
      if (this.mode === 'upsert') {
        // Ordered writes stop at the first error: nothing after it was written either.
        const first = Math.min(...errors.map((w) => w.index ?? 0))
        const failed = new Set(errors.map((w) => w.index ?? 0))
        if (ordered) docs.forEach((_, i) => i >= first && failed.add(i))
        this.recordHistory(docs, existing, failed)
      }
      const r = err.result ?? {}
      this.inserted += (r.insertedCount ?? 0) + (r.upsertedCount ?? 0)
      this.updated += r.matchedCount ?? 0
      this.failed += errors.length
      for (const w of errors) this.logError(`Document #${base + (w.index ?? 0) + 1}: ${w.errmsg ?? err.message}`)
      if (this.stopOnError) {
        // Ordered writes stop at the first error; documents after it in the batch were not written.
        throw new ImportAbort(errors[0]?.errmsg ?? err.message)
      }
    }
  }
}
