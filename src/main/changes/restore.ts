import { MongoBulkWriteError } from 'mongodb'
import type { AnyBulkWriteOperation, Collection, Document, Filter } from 'mongodb'
import type { Doc } from '@shared/api'
import type { ChangePathDiff, ChangeRecordDetail, ChangeRecordInfo,RestoreAction, RestoreIssue, RestorePlan, RestoreResult, RestoreSelection } from '@shared/changeHistoryApi'
import { diffDocs } from '../compare/diff'
import { docIdText, parseDocId, readByIds, RAW } from './recorder'
import type { ChangeEntry } from './recorder'
import { ownerOf } from './store'
import type { ChangeHistory, ChangeRow, Owner } from './store'
import { ReadOnlyError } from '../mongo/readOnly'

const BATCH = 500
const fmt = (n: number): string => n.toLocaleString('en-US')

/** Equal ignoring field order (BSON types count). */
const same = (a: Doc, b: Doc): boolean => diffDocs(a, b, 0).total === 0

function pathDiffs(a: Doc | null | undefined, b: Doc | null | undefined): ChangePathDiff[] {
  if (!a || !b) return []
  return diffDocs(a, b, 500).diffs.map((d) => ({ path: d.segs.join('.'), kind: d.kind }))
}

/** Why restoring `newest` (the latest selected record of a document) over `current` would lose a later change. */
export function conflictOf(newest: ChangeRow, current: Doc | null): string | undefined {
  if (newest.op === 'delete') return current ? 'The document exists again' : undefined
  if (!newest.after) return undefined
  if (!current) return newest.op === 'insert' ? undefined : 'Deleted since this change'
  if (same(current, newest.after)) return undefined
  const n = diffDocs(newest.after, current).total
  return `Changed since this change (${fmt(n)} field${n === 1 ? '' : 's'} differ)`
}

interface Planned {
  newest: ChangeRow
  oldest: ChangeRow
  id: unknown
  target: Doc | null
  current: Doc | null
  action: RestoreAction
  conflict?: string
}

interface NsPlan {
  db: string
  coll: string
  items: Planned[]
}

const issue = (r: ChangeRow, reason: string): RestoreIssue => ({ id: r.id, coll: `${r.db}.${r.coll}`, docId: r.docId, reason })

/** Restore planning and execution over a ChangeHistory, for the connection `connId`. */
export class Restorer {
  constructor(private h: ChangeHistory) {}

  private owner(connId: string): Owner {
    return ownerOf(this.h.mgr.config(connId))
  }

  private coll(connId: string, db: string, coll: string): Collection<Document> {
    return this.h.mgr.get(connId).db(db).collection(coll)
  }

  async detail(connId: string, id: number): Promise<ChangeRecordDetail> {
    const row = this.h.get(id)
    if (!row || row.configId !== this.owner(connId).configId) throw new Error('Change record not found')
    const { before, after } = row
    const record: ChangeRecordInfo = {
      id: row.id,
      at: row.at,
      batchId: row.batchId,
      db: row.db,
      coll: row.coll,
      op: row.op,
      source: row.source,
      docId: row.docId,
      label: row.label,
      hasBefore: row.hasBefore,
      hasAfter: row.hasAfter,
      size: row.size
    }
    const detail: ChangeRecordDetail = { record, before, after, changed: pathDiffs(before, after), since: [], revert: [] }
    if (row.op === 'drop') return detail
    try {
      const current = (await this.coll(connId, row.db, row.coll).findOne({ _id: row.docId } as Filter<Document>, RAW)) as Doc | null
      detail.current = current
      detail.since = pathDiffs(after, current)
      detail.revert = row.op === 'insert' ? [] : pathDiffs(current, before)
      detail.conflict = conflictOf(row, current)
    } catch (e) {
      detail.currentError = (e as Error).message
    }
    return detail
  }

  private async build(connId: string, sel: RestoreSelection): Promise<{ records: number; skipped: RestoreIssue[]; plans: NsPlan[] }> {
    const { configId } = this.owner(connId)
    const rows = this.h.select(sel.ids, sel.batchIds)
    const skipped: RestoreIssue[] = []
    const groups = new Map<string, ChangeRow[]>()
    for (const r of rows) {
      if (r.configId !== configId) skipped.push(issue(r, 'Recorded on another connection'))
      else if (r.op === 'drop') skipped.push(issue(r, 'A dropped collection cannot be restored from history'))
      else if (r.op !== 'insert' && !r.before) skipped.push(issue(r, 'No before image was recorded'))
      else {
        const k = `${r.db}\u0000${r.coll}\u0000${r.docIdText}`
        groups.set(k, [...(groups.get(k) ?? []), r])
      }
    }
    const byNs = new Map<string, NsPlan>()
    for (const list of groups.values()) {
      const newest = list[0]
      const oldest = list[list.length - 1]
      const k = `${newest.db}\u0000${newest.coll}`
      if (!byNs.has(k)) byNs.set(k, { db: newest.db, coll: newest.coll, items: [] })
      byNs.get(k)!.items.push({
        newest,
        oldest,
        id: parseDocId(newest.docIdText),
        target: oldest.op === 'insert' ? null : oldest.before,
        current: null,
        action: 'replace'
      })
    }
    const plans = [...byNs.values()]
    for (const p of plans) {
      const current = await readByIds(this.coll(connId, p.db, p.coll), p.items.map((i) => i.id))
      p.items = p.items.filter((i) => {
        i.current = current.get(docIdText(i.id)) ?? null
        if (!i.target) {
          if (!i.current) return !skipped.push(issue(i.newest, 'Already removed'))
          i.action = 'remove'
        } else {
          if (i.current && same(i.current, i.target)) return !skipped.push(issue(i.newest, 'Already in the recorded state'))
          i.action = i.current ? 'replace' : 'reinsert'
        }
        i.conflict = conflictOf(i.newest, i.current)
        return true
      })
    }
    return { records: rows.length, skipped, plans: plans.filter((p) => p.items.length) }
  }

  async plan(connId: string, sel: RestoreSelection): Promise<RestorePlan> {
    const b = await this.build(connId, sel)
    const plan: RestorePlan = { records: b.records, documents: 0, actions: { replace: 0, reinsert: 0, remove: 0 }, conflicts: [], skipped: b.skipped }
    for (const p of b.plans) {
      for (const i of p.items) {
        plan.documents++
        plan.actions[i.action]++
        if (i.conflict) plan.conflicts.push(issue(i.newest, i.conflict))
      }
    }
    return plan
  }

  async restore(connId: string, sel: RestoreSelection, force: boolean): Promise<RestoreResult> {
    const cfg = this.h.mgr.config(connId)
    if (cfg.readOnly) throw new ReadOnlyError(cfg.name, 'restoring from Change History')
    const b = await this.build(connId, sel)
    const result: RestoreResult = { restored: 0, skipped: b.skipped, conflicts: [], failed: [], batchIds: [] }
    const rec = this.h.forOwner(this.owner(connId), Number.MAX_SAFE_INTEGER)
    for (const p of b.plans) {
      const items = p.items.filter((i) => {
        if (i.conflict && !force) return !result.conflicts.push(issue(i.newest, i.conflict))
        return true
      })
      if (!items.length) continue
      const coll = this.coll(connId, p.db, p.coll)
      const batch = rec.begin(p.db, p.coll, 'restore', `Restore of ${fmt(items.length)} document${items.length === 1 ? '' : 's'}`)
      if (batch) result.batchIds.push(batch.id)
      for (let i = 0; i < items.length; i += BATCH) {
        const chunk = items.slice(i, i + BATCH)
        const ops: AnyBulkWriteOperation<Document>[] = chunk.map((it) =>
          it.target
            ? { replaceOne: { filter: { _id: it.id } as Filter<Document>, replacement: it.target, upsert: true } }
            : { deleteOne: { filter: { _id: it.id } as Filter<Document> } }
        )
        const failed = new Set<number>()
        try {
          await coll.bulkWrite(ops, { ordered: false })
        } catch (e) {
          if (!(e instanceof MongoBulkWriteError)) throw e
          for (const w of Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]) {
            failed.add(w.index)
            result.failed.push(issue(chunk[w.index].newest, w.errmsg ?? 'write error'))
          }
        }
        const entries: ChangeEntry[] = []
        chunk.forEach((it, k) => {
          if (failed.has(k)) return
          result.restored++
          if (!it.target) entries.push({ op: 'delete', docId: it.id, before: it.current })
          else if (!it.current) entries.push({ op: 'insert', docId: it.id, after: it.target })
          else entries.push({ op: 'replace', docId: it.id, before: it.current, after: it.target })
        })
        batch?.add(entries)
      }
    }
    return result
  }
}
