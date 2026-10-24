/**
 * Type-to-jump in the connection tree: typing selects the next row at the same level (same parent) whose name
 * starts with the typed text, wrapping around. Letters typed in quick succession build a longer prefix
 * ("per" → "permissions"); repeating one letter ("ppp") cycles through the rows starting with it.
 */

/** Pause after which the next key starts a new prefix. */
export const TYPE_AHEAD_RESET_MS = 700

export interface TypeAheadItem {
  key: string
  /** Key of the parent row ('' for top-level rows). */
  parent: string
  name: string
}

/** Key of the row to select for `typed`, or null when no row at that level matches. */
export function typeAheadTarget(items: readonly TypeAheadItem[], current: string | null, typed: string): string | null {
  if (!typed) return null
  const lower = typed.toLocaleLowerCase()
  // "ppp" cycles through the "p" rows instead of looking for a "ppp" prefix.
  const repeated = [...lower].every((c) => c === lower[0])
  const prefix = repeated ? lower[0] : lower
  const at = current == null ? -1 : items.findIndex((i) => i.key === current)
  const parent = at >= 0 ? items[at].parent : (items[0]?.parent ?? '')
  const siblings = items.filter((i) => i.parent === parent)
  const from = at >= 0 ? siblings.findIndex((i) => i.key === current) : -1
  // A single key (or a repeated one) moves past the current row; a longer prefix may stay on it.
  const start = repeated || from < 0 ? from + 1 : from
  for (let n = 0; n < siblings.length; n++) {
    const item = siblings[(start + n) % siblings.length]
    if (item.name.toLocaleLowerCase().startsWith(prefix)) return item.key
  }
  return null
}
