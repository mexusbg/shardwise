import type { ResultViewKind } from './api'

/** Last result view per collection (most recent last), as remembered by the renderer. */
export type ViewMap = Record<string, ResultViewKind>

export const VIEW_MEMORY_MAX = 500

const VIEWS: ResultViewKind[] = ['table', 'list', 'json']
export const isResultView = (v: unknown): v is ResultViewKind => VIEWS.includes(v as ResultViewKind)

/** `v` as a result view, with the removed Tree view read as List; null for anything else. */
export const toResultView = (v: unknown): ResultViewKind | null => (v === 'tree' ? 'list' : isResultView(v) ? v : null)

export const viewKey = (configId: string, db: string, coll: string): string => JSON.stringify([configId, db, coll])

/** Map with `key` set to `view` as the most recent entry; the oldest entries beyond `max` are dropped. */
export function withView(map: ViewMap, key: string, view: ResultViewKind, max = VIEW_MEMORY_MAX): ViewMap {
  const rest = Object.entries(map).filter(([k]) => k !== key)
  // Insertion order is the recency order: newest last.
  const kept = rest.slice(Math.max(0, rest.length - (max - 1)))
  return Object.fromEntries([...kept, [key, view]])
}

/** Parse stored JSON, ignoring anything malformed. */
export function parseViewMap(text: string | null): ViewMap {
  if (!text) return {}
  try {
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => {
      const view = toResultView(v)
      return view ? [[k, view]] : []
    })) as ViewMap
  } catch {
    return {}
  }
}
