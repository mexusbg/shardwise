import type { CollationOptions, Collection, Document, Filter } from 'mongodb'
import { EJSON, serialize } from 'bson'
import type { Doc } from '@shared/api'
import { HISTORY_CAP_CODE } from '@shared/changeHistoryApi'
import type { ChangeOp, ChangeSource, WriteOptions } from '@shared/changeHistoryApi'

/** One captured document change. */
export interface ChangeEntry {
  op: Exclude<ChangeOp, 'drop'>
  /** Defaults to `before._id ?? after._id`. */
  docId?: unknown
  before?: Doc | null
  after?: Doc | null
}

/** Records of one operation. Methods never throw: capture failures are logged and kept as the last error. */
export interface ChangeBatch {
  readonly id: string
  readonly cap: number
  /** Documents this batch may still capture. */
  readonly remaining: number
  /** Entries beyond the cap were dropped. */
  readonly truncated: boolean
  add(entries: ChangeEntry[]): void
  /** A non-restorable event, e.g. a collection dropped before an import. */
  marker(label: string): void
}

/** Recorder bound to one saved connection. */
export interface ConnRecorder {
  /** Null when Change History is disabled. */
  begin(db: string, coll: string, source: ChangeSource, label?: string): ChangeBatch | null
}

/** Recorders by live connection id; ChangeHistory implements it. */
export interface ChangeRecorders {
  forConn(connId: string): ConnRecorder | undefined
}

/** Same as RAW_TYPES in mongo/ops (not imported to avoid a cycle). */
export const RAW = { promoteValues: false, promoteLongs: false } as const
/** After images of multi-document updates are read back only up to this many documents. */
export const AFTER_IMAGE_LIMIT = 1000

export const docIdText = (id: unknown): string => EJSON.stringify({ v: id } as Doc, { relaxed: false }).slice(5, -1)
export const parseDocId = (text: string): unknown => (EJSON.parse(`{"v":${text}}`, { relaxed: false }) as Doc).v

const fmt = (n: number): string => n.toLocaleString('en-US')

export function capError(cap: number): Error {
  return new Error(
    `${HISTORY_CAP_CODE}: This write affects more than ${fmt(cap)} documents, the most Change History captures per operation. ` +
      'Run it without history, or raise the limit in Settings → Safety & undo.'
  )
}

/**
 * Reads the documents a write is about to change. Returns null when nothing is captured (no batch, read failed,
 * or too many documents with `allowWithoutHistory`); throws the HISTORY_CAP error when the write affects more
 * documents than the batch may capture.
 */
/** `collation`: the one the write uses, so the same documents are captured. */
export async function captureBefore(coll: Collection<Document>, filter: Doc, batch: ChangeBatch | null, opts?: WriteOptions, collation?: CollationOptions): Promise<Doc[] | null> {
  if (!batch) return null
  let docs: Doc[]
  try {
    docs = (await coll.find(filter as Filter<Document>, { ...RAW, limit: batch.remaining + 1, collation }).toArray()) as Doc[]
  } catch (e) {
    console.warn('Change history: could not read before images:', (e as Error).message)
    return null
  }
  if (docs.length > batch.remaining) {
    if (opts?.allowWithoutHistory) return null
    throw capError(batch.cap)
  }
  return docs
}

/** Current documents by canonical _id text. */
export async function readByIds(coll: Collection<Document>, ids: unknown[]): Promise<Map<string, Doc>> {
  const out = new Map<string, Doc>()
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000)
    const docs = (await coll.find({ _id: { $in: chunk } } as Filter<Document>, RAW).toArray()) as Doc[]
    for (const d of docs) out.set(docIdText(d._id), d)
  }
  return out
}

/** Records before images (plus after images read back when few) of an update that already ran. */
export async function recordUpdated(coll: Collection<Document>, batch: ChangeBatch | null, before: Doc[] | null, op: 'update' | 'replace' = 'update'): Promise<void> {
  if (!batch || !before?.length) return
  let after = new Map<string, Doc>()
  if (before.length <= AFTER_IMAGE_LIMIT) after = await readByIds(coll, before.map((d) => d._id)).catch(() => after)
  const entries: ChangeEntry[] = []
  for (const d of before) {
    const a = after.get(docIdText(d._id)) ?? null
    if (a && sameDoc(a, d)) continue
    entries.push({ op, before: d, after: a })
  }
  batch.add(entries)
}

export function sameDoc(a: Doc, b: Doc): boolean {
  try {
    return Buffer.from(serialize(a)).equals(Buffer.from(serialize(b)))
  } catch {
    return false
  }
}
