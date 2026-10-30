import { parseUsage, recordUse } from '@shared/connectionUsage'
import type { ConnectionUsage } from '@shared/connectionUsage'

/** How often each saved connection is opened, kept in this window's localStorage (a UI convenience, not synced). */
const KEY = 'shardwise.connectionUsage'

export function connectionUsage(): ConnectionUsage {
  try {
    return parseUsage(localStorage.getItem(KEY))
  } catch {
    return {}
  }
}

export function noteConnectionUse(configId: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(recordUse(connectionUsage(), configId, Date.now())))
  } catch {
    // Storage full or unavailable: the sidebar falls back to A-Z.
  }
}

export type ConnectionSort = 'name' | 'usage'
const SORT_KEY = 'shardwise.connectionManagerSort'

/** How the Connection Manager orders connections (within each folder). */
export function connectionSort(): ConnectionSort {
  try {
    return localStorage.getItem(SORT_KEY) === 'usage' ? 'usage' : 'name'
  } catch {
    return 'name'
  }
}

export function setConnectionSort(s: ConnectionSort): void {
  try {
    localStorage.setItem(SORT_KEY, s)
  } catch {
    // Storage unavailable: the choice lasts until the dialog closes.
  }
}
