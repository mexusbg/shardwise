import type { BsonTypeName } from '@shared/bsonValue'
import { fieldQueryText } from '@shared/schema'
import type { FieldQuery, FieldReport } from '@shared/schema'
import { dbKey, openCollectionTab, patchTab, useStore } from '../../state/store'
import { runQuery, syncTextToVqb } from '../../state/queryActions'
import { dataDateText } from '@shared/dateFormat'

const mix = (a: string, pct: number, b: string): string => `color-mix(in srgb, var(${a}) ${pct}%, var(${b}))`

const COLORS: Record<BsonTypeName, string> = {
  string: 'var(--t-string)',
  int: 'var(--t-number)',
  long: mix('--t-number', 60, '--t-bool'),
  double: mix('--t-number', 55, '--bg'),
  decimal: mix('--t-number', 55, '--t-string'),
  bool: 'var(--t-bool)',
  date: 'var(--t-date)',
  timestamp: mix('--t-date', 60, '--bg'),
  objectId: 'var(--t-oid)',
  null: 'var(--t-null)',
  undefined: mix('--t-null', 60, '--bg'),
  object: 'var(--t-object)',
  array: mix('--t-object', 55, '--bg'),
  regex: 'var(--t-regex)',
  binary: 'var(--t-binary)',
  uuid: mix('--t-binary', 60, '--t-oid'),
  code: mix('--t-binary', 55, '--bg'),
  symbol: mix('--t-binary', 55, '--t-string'),
  dbref: mix('--t-object', 60, '--t-oid'),
  minKey: 'var(--t-null)',
  maxKey: 'var(--t-null)'
}

export const typeColor = (t: BsonTypeName): string => COLORS[t]

export function fmtPct(x: number): string {
  if (x >= 1) return '100%'
  if (x <= 0) return '0%'
  const v = x * 100
  if (v >= 99.95) return '>99.9%'
  if (v < 0.05) return '<0.1%'
  return `${v.toFixed(1).replace(/\.0$/, '')}%`
}

export const fmtNum = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 4 })

export const fmtInt = (n: number): string => n.toLocaleString()

export function fmtDate(d: Date): string {
  return dataDateText(d)
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

/** Short type summary for a tree row: the single type, or "Mixed". */
export function typeSummary(f: FieldReport): { label: string; type?: BsonTypeName } {
  const kinds = f.types.filter((t) => t.type !== 'null' && t.type !== 'undefined')
  if (f.mixed) return { label: 'Mixed' }
  if (f.numericMix) return { label: 'Number', type: kinds[0].type }
  const t = kinds[0] ?? f.types[0]
  return t ? { label: t.label, type: t.type } : { label: '' }
}

/** Open a query tab on the collection filtered by the field observation and run it. */
export async function openFieldQuery(connId: string, db: string, coll: string, f: FieldReport, q: FieldQuery): Promise<void> {
  const isView = useStore.getState().collections[dbKey(connId, db)]?.find((c) => c.name === coll)?.type === 'view'
  const id = openCollectionTab(connId, db, coll, isView)
  // `loading` keeps the new tab from applying its saved default query on mount.
  patchTab(id, { loading: true, queryText: fieldQueryText(f, q) })
  syncTextToVqb(id, 'query')
  await runQuery(id)
  patchTab(id, (t) => (t.loading && !t.docs ? { loading: false } : {}))
}
