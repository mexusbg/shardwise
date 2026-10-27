import { isPlainDoc, parseShellValue } from '../bsonValue'
import { newProjectionItem, newSortItem } from './types'
import type { ProjectionItem, SortItem } from './types'

type Doc = Record<string, unknown>

const num = (v: unknown): number | null => {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  if (v !== null && typeof v === 'object' && 'valueOf' in v) {
    const n = Number((v as { valueOf(): unknown }).valueOf())
    return Number.isNaN(n) ? null : n
  }
  return null
}

export function projectionToItems(p: unknown): ProjectionItem[] | null {
  if (p == null) return []
  if (!isPlainDoc(p)) return null
  const items: ProjectionItem[] = []
  for (const [field, v] of Object.entries(p)) {
    if (isPlainDoc(v)) {
      const keys = Object.keys(v)
      if (keys.length !== 1 || keys[0] !== '$slice') return null
      const s = v.$slice
      const text = Array.isArray(s) ? `[${s.map((x) => num(x)).join(', ')}]` : String(num(s))
      items.push({ ...newProjectionItem(field, 'slice'), slice: text })
      continue
    }
    const n = num(v)
    if (n === null) return null
    items.push(newProjectionItem(field, n ? 'include' : 'exclude'))
  }
  return items
}

const active = (items: ProjectionItem[]): ProjectionItem[] => items.filter((it) => it.enabled && it.field)

/**
 * Hide rows that are left out of the projection because other fields are shown: MongoDB refuses to mix 1 and 0
 * (except `_id: 0`), and a field that is not shown is not returned anyway.
 */
export function hiddenByShow(items: ProjectionItem[]): string[] {
  const on = active(items)
  if (!on.some((it) => it.mode === 'include')) return []
  return on.filter((it) => it.mode === 'exclude' && it.field !== '_id').map((it) => it.field)
}

export function itemsToProjection(items: ProjectionItem[]): Doc | null {
  const out: Doc = {}
  const skip = new Set(hiddenByShow(items))
  for (const it of active(items)) {
    if (skip.has(it.field)) continue
    if (it.mode === 'slice') {
      const v = parseShellValue(it.slice || '0')
      out[it.field] = { $slice: v }
    } else out[it.field] = it.mode === 'include' ? 1 : 0
  }
  return Object.keys(out).length ? out : null
}

export function sortToItems(s: unknown): SortItem[] | null {
  if (s == null) return []
  if (!isPlainDoc(s)) return null
  const items: SortItem[] = []
  for (const [field, v] of Object.entries(s)) {
    const n = num(v)
    if (n !== 1 && n !== -1) return null
    items.push(newSortItem(field, n))
  }
  return items
}

export function itemsToSort(items: SortItem[]): Doc | null {
  const out: Doc = {}
  for (const it of items) if (it.enabled && it.field) out[it.field] = it.dir
  return Object.keys(out).length ? out : null
}
