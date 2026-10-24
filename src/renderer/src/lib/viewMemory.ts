import type { ResultViewKind } from '@shared/api'
import { isResultView, parseViewMap, viewKey, withView } from '@shared/viewMap'
import type { ViewMap } from '@shared/viewMap'

/** Last result view per collection, kept in this window's localStorage (a UI convenience, not synced). */
const KEY = 'shardwise.resultViews'

function read(): ViewMap {
  try {
    return parseViewMap(localStorage.getItem(KEY))
  } catch {
    return {}
  }
}

export function rememberedView(configId: string, db: string, coll: string): ResultViewKind | null {
  return read()[viewKey(configId, db, coll)] ?? null
}

export function rememberView(configId: string, db: string, coll: string, view: string): void {
  if (!isResultView(view)) return
  const key = viewKey(configId, db, coll)
  const map = read()
  if (map[key] === view && Object.keys(map).pop() === key) return
  try {
    localStorage.setItem(KEY, JSON.stringify(withView(map, key, view)))
  } catch {
    // Storage full or unavailable: the default view is used next time.
  }
}
