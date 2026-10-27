/** How often, and when last, each saved connection was opened (keyed by connection id). */
export type ConnectionUsage = Record<string, { count: number; last: number }>

export function recordUse(usage: ConnectionUsage, id: string, now: number): ConnectionUsage {
  const prev = usage[id]
  return { ...usage, [id]: { count: (prev?.count ?? 0) + 1, last: now } }
}

/** Most opened first, then most recently opened; connections never opened keep their given (A-Z) order after them. */
export function byUsage<T extends { id: string }>(items: T[], usage: ConnectionUsage): T[] {
  return items
    .map((it, i) => ({ it, i, u: usage[it.id] }))
    .sort((a, b) => (b.u?.count ?? 0) - (a.u?.count ?? 0) || (b.u?.last ?? 0) - (a.u?.last ?? 0) || a.i - b.i)
    .map((x) => x.it)
}

export function parseUsage(text: string | null): ConnectionUsage {
  if (!text) return {}
  const raw = JSON.parse(text) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ConnectionUsage = {}
  for (const [id, v] of Object.entries(raw)) {
    const { count, last } = (v ?? {}) as { count?: unknown; last?: unknown }
    if (typeof count === 'number' && typeof last === 'number') out[id] = { count, last }
  }
  return out
}
