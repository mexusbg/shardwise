/**
 * Selecting several collections of one database in the tree: Ctrl/Cmd+click adds or removes one,
 * Shift+click takes the run from the selected row (the anchor) to the clicked one.
 *
 * `selection` is the selected tree row; `multi` the collection rows selected with it. The multi-selection counts only
 * while it contains `selection`, so selecting anything else (another click, the active tab) ends it.
 */
export interface TreeMulti {
  selection: string | null
  multi: string[]
}

/** The collections selected together (two or more), or an empty list. */
export const activeMulti = (s: TreeMulti): string[] => (s.selection !== null && s.multi.length > 1 && s.multi.includes(s.selection) ? s.multi : [])

/**
 * The selection after clicking `key` with Ctrl/Cmd (`toggle`) or Shift (`range`).
 * `siblings` are the collection rows of the clicked row's database, in tree order (as shown, after filtering).
 */
export function clickMulti(s: TreeMulti, key: string, siblings: string[], mode: 'toggle' | 'range'): TreeMulti {
  const anchor = s.selection !== null && siblings.includes(s.selection) ? s.selection : null
  if (anchor === null) return { selection: key, multi: [key] }
  if (mode === 'range') {
    const a = siblings.indexOf(anchor)
    const b = siblings.indexOf(key)
    return { selection: anchor, multi: siblings.slice(Math.min(a, b), Math.max(a, b) + 1) }
  }
  const current = activeMulti(s).length ? s.multi.filter((k) => siblings.includes(k)) : [anchor]
  if (!current.includes(key)) return { selection: anchor, multi: siblings.filter((k) => current.includes(k) || k === key) }
  const rest = current.filter((k) => k !== key)
  if (!rest.length) return { selection: key, multi: [key] }
  return { selection: key === anchor ? rest[0] : anchor, multi: rest }
}
