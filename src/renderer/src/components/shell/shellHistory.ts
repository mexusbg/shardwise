import { SHELL_HISTORY_PREFIX } from '@shared/shellOptions'

/** Window event sent after the shell history was cleared, so open shells forget theirs too. */
export const SHELL_HISTORY_CLEARED = 'shardwise:shell-history-cleared'

/** Keys of every stored shell history (shared and per connection). */
function historyKeys(): string[] {
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k === SHELL_HISTORY_PREFIX || k.startsWith(`${SHELL_HISTORY_PREFIX}:`))) keys.push(k)
    }
  } catch {
    // storage unavailable
  }
  return keys
}

/** Number of commands stored in all shell histories. */
export function shellHistoryCount(): number {
  let n = 0
  for (const k of historyKeys()) {
    try {
      const v = JSON.parse(localStorage.getItem(k) ?? '[]') as unknown
      if (Array.isArray(v)) n += v.length
    } catch {
      // ignore unreadable entries
    }
  }
  return n
}

/** Deletes every shell history and tells open shells. */
export function clearShellHistory(): void {
  for (const k of historyKeys()) {
    try {
      localStorage.removeItem(k)
    } catch {
      // storage unavailable
    }
  }
  window.dispatchEvent(new Event(SHELL_HISTORY_CLEARED))
}
