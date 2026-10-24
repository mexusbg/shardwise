import { EJSON } from 'bson'
import type { MongoClient } from 'mongodb'
import { bsonTypeOf, isPlainDoc, shellText, TYPE_LABELS } from '@shared/bsonValue'
import { collectPaths, getPath } from '@shared/docPaths'
import { parseExplain } from '@shared/explain'
import type { PlanNode } from '@shared/explain'
import type { Doc } from '@shared/api'
import { RAW_TYPES } from '../mongo/ops'

export const MAX_RESULT_BYTES = 20_000

/** Field paths with observed types and presence from sample documents (no values). */
export function describeSchema(docs: Doc[], maxPaths = 300): string {
  const lines: string[] = []
  for (const path of collectPaths(docs).slice(0, maxPaths)) {
    const counts = new Map<string, number>()
    let present = 0
    for (const d of docs) {
      const v = getPath(d, path)
      if (v === undefined) continue
      present++
      const t = TYPE_LABELS[bsonTypeOf(v)]
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    const types = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
    const pct = docs.length ? Math.round((present / docs.length) * 100) : 0
    lines.push(`${path}: ${types.join(' | ')}${pct < 100 ? ` (${pct}%)` : ''}`)
  }
  return lines.join('\n')
}

export async function sampleDocs(client: MongoClient, db: string, coll: string, size: number): Promise<Doc[]> {
  return (await client
    .db(db)
    .collection(coll)
    .aggregate([{ $sample: { size } }], { ...RAW_TYPES, maxTimeMS: 15000 })
    .toArray()) as Doc[]
}

/** Shortens long strings and arrays so one huge field can't crowd out the rest of a result. */
export function clipValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 400 ? `${v.slice(0, 400)}… (${v.length} chars)` : v
  if (Array.isArray(v)) {
    const head = v.slice(0, 25).map((x) => clipValue(x, depth + 1))
    if (v.length > 25) head.push(`… ${v.length - 25} more elements`)
    return head
  }
  if (isPlainDoc(v)) {
    if (depth > 12) return '{…}'
    const out: Doc = {}
    for (const [k, x] of Object.entries(v)) out[k] = clipValue(x, depth + 1)
    return out
  }
  return v
}

const ejson = (v: unknown): string => EJSON.stringify(v, { relaxed: true })

/** Documents as relaxed EJSON lines, capped by count and total size. */
export function docsText(docs: Doc[], maxDocs: number, maxBytes = MAX_RESULT_BYTES): { text: string; shown: number; truncated: boolean } {
  const lines: string[] = []
  let size = 0
  for (const d of docs.slice(0, maxDocs)) {
    const line = ejson(clipValue(d))
    if (size + line.length > maxBytes && lines.length) break
    lines.push(line.length > maxBytes ? `${line.slice(0, maxBytes)}…` : line)
    size += line.length + 1
  }
  const truncated = lines.length < docs.length
  return { text: lines.join('\n'), shown: lines.length, truncated }
}

/** Any text capped at `maxBytes`. */
export function capText(text: string, maxBytes = MAX_RESULT_BYTES): string {
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… (truncated, ${text.length - maxBytes} more characters)` : text
}

/** Schema (and optionally a few sample documents) of a collection, for prompts. */
export async function collectionContext(client: MongoClient, db: string, coll: string, withSamples: boolean): Promise<string> {
  const sample = await sampleDocs(client, db, coll, 50)
  let text = `Fields observed in ${sample.length} sampled documents of ${db}.${coll} (path: types, presence when < 100%):\n${describeSchema(sample) || '(collection is empty)'}`
  if (withSamples && sample.length) {
    const examples = sample.slice(0, 3).map((d) => shellText(clipValue(d), 2).slice(0, 3000))
    text += `\n\nExample documents:\n${examples.join('\n\n')}`
  }
  return text
}

function planLines(n: PlanNode, depth: number, out: string[]): void {
  const d = n.details
  const st = n.stats
  const parts = [n.stage + (n.label ? ` [${n.label}]` : '')]
  if (typeof d.indexName === 'string') parts.push(`index=${d.indexName}`)
  if (isPlainDoc(d.keyPattern)) parts.push(`keyPattern=${shellText(d.keyPattern)}`)
  if (d.isMultiKey === true) parts.push('multikey')
  if (isPlainDoc(d.indexBounds)) parts.push(`bounds=${shellText(d.indexBounds).slice(0, 300)}`)
  if (isPlainDoc(d.filter)) parts.push(`filter=${shellText(d.filter).slice(0, 300)}`)
  if (isPlainDoc(d.sortPattern)) parts.push(`sort=${shellText(d.sortPattern)}`)
  if (st) {
    if (st.nReturned !== undefined) parts.push(`returned=${st.nReturned}`)
    if (st.docsExamined !== undefined) parts.push(`docsExamined=${st.docsExamined}`)
    if (st.keysExamined !== undefined) parts.push(`keysExamined=${st.keysExamined}`)
    if (st.timeMs !== undefined) parts.push(`ms=${st.timeMs}`)
    if (st.usedDisk) parts.push('usedDisk')
  }
  out.push(`${'  '.repeat(depth)}${parts.join(' ')}`)
  for (const c of n.children) planLines(c, depth + 1, out)
}

/** Compact, value-light text of an explain result: summary, winning plan tree, rejected plans. */
export function explainText(doc: Doc): string {
  try {
    const p = parseExplain(doc)
    const s = p.summary
    const lines = [
      `engine: ${s.engine}${s.sharded ? `, sharded on ${s.shardCount} shards` : ''}`,
      s.hasStats
        ? `returned ${s.nReturned ?? '?'}, docsExamined ${s.docsExamined ?? '?'}, keysExamined ${s.keysExamined ?? '?'}, time ${s.timeMs ?? '?'} ms`
        : 'queryPlanner only (no execution stats)',
      `indexes used: ${s.indexes.join(', ') || 'none'}${s.collscan ? ' (COLLSCAN)' : ''}; in-memory sort: ${s.inMemorySort ? 'yes' : 'no'}${s.covered ? '; covered' : ''}`,
      `rejected plans: ${s.rejectedPlans}${s.isCached !== undefined ? `; plan cache: ${s.isCached ? 'cached' : 'not cached'}` : ''}`,
      ...s.warnings.map((w) => `warning: ${w.text}`),
      '',
      'Winning plan (root first; data flows from the leaves up):'
    ]
    planLines(p.root, 1, lines)
    p.rejected.slice(0, 3).forEach((r, i) => {
      lines.push('', `Rejected plan ${i + 1}:`)
      planLines(r, 1, lines)
    })
    return capText(lines.join('\n'), 12_000)
  } catch {
    const copy = { ...doc }
    delete copy.serverInfo
    delete copy.serverParameters
    return capText(ejson(copy), 12_000)
  }
}
