/** Ctrl+P "Go to collection": ranking of collections and views by the typed text. */

export interface QuickOpenItem {
  connId: string
  connName: string
  db: string
  coll: string
  view: boolean
}

/** Characters of `q` appear in `s` in order (gaps allowed). */
function subsequence(s: string, q: string): boolean {
  let i = 0
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true
  return q.length === 0
}

/** Starts of words: after `_`, `-`, `.`, a space, or a lower-to-upper case change ("orderItems" → "items"). */
function wordStarts(s: string): string[] {
  return s
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => w.toLocaleLowerCase())
}

/** 0 = best; null = no match. "db.coll" text matches against the full name, anything else against the collection. */
function score(item: QuickOpenItem, q: string): number | null {
  const coll = item.coll.toLocaleLowerCase()
  if (!q) return 0
  if (coll === q) return 0
  if (coll.startsWith(q)) return 1
  if (wordStarts(item.coll).some((w) => w.startsWith(q))) return 2
  if (coll.includes(q)) return 3
  const full = `${item.db}.${item.coll}`.toLocaleLowerCase()
  if (full.startsWith(q)) return 4
  if (full.includes(q)) return 5
  // Letters in order only within the collection name: across "db.coll" almost anything would match.
  if (subsequence(coll, q)) return 6
  return null
}

/** Matches for the typed text, best first; `system.*` collections only when asked for. */
export function rankCollections(items: readonly QuickOpenItem[], typed: string): QuickOpenItem[] {
  const q = typed.trim().toLocaleLowerCase()
  const scored: { item: QuickOpenItem; s: number }[] = []
  for (const item of items) {
    if (item.coll.startsWith('system.') && !q.includes('system')) continue
    const s = score(item, q)
    if (s !== null) scored.push({ item, s })
  }
  return scored
    .sort((a, b) => a.s - b.s || a.item.coll.length - b.item.coll.length || a.item.coll.localeCompare(b.item.coll) || a.item.db.localeCompare(b.item.db))
    .map((x) => x.item)
}
