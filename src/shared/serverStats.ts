import { OP_TYPES } from './serverApi'
import type { OpType, ReplMember, ServerSample } from './serverApi'

/** Dashboard rolling window. */
export const WINDOW_MS = 5 * 60 * 1000

/** Per-second rate of a monotonic counter; null when the counter went backwards (server restart) or no time passed. */
export function counterRate(prev: number | undefined, cur: number | undefined, dtSec: number): number | null {
  if (prev == null || cur == null || !Number.isFinite(prev) || !Number.isFinite(cur)) return null
  if (!(dtSec > 0) || cur < prev) return null
  return (cur - prev) / dtSec
}

/** One chart point. Rates are per second; null = gap (first sample, restart, missing section). */
export interface StatPoint {
  t: number
  ops: Record<OpType, number | null>
  opsTotal: number | null
  netIn: number | null
  netOut: number | null
  requests: number | null
  docs: { inserted: number | null; updated: number | null; deleted: number | null; returned: number | null }
  scannedObjects: number | null
  connections: number
  /** Megabytes. */
  resident: number
  cacheUsedPct: number | null
  cacheDirtyPct: number | null
  activeClients: number | null
  queued: number | null
}

/** True when `cur` comes from a restarted server (uptime went backwards). */
export const restarted = (prev: ServerSample, cur: ServerSample): boolean => cur.uptime < prev.uptime

export function cacheUsage(s: ServerSample): { usedPct: number | null; dirtyPct: number | null } {
  const c = s.cache
  if (!c || !(c.max > 0)) return { usedPct: null, dirtyPct: null }
  return { usedPct: (c.bytes / c.max) * 100, dirtyPct: (c.dirty / c.max) * 100 }
}

/** Chart point for `cur`, with rates computed from the counters of `prev`. */
export function statPoint(prev: ServerSample | undefined, cur: ServerSample): StatPoint {
  const ok = !!prev && !restarted(prev, cur)
  const dt = ok ? (cur.at - prev!.at) / 1000 : 0
  const r = (a: number | undefined, b: number | undefined): number | null => (ok ? counterRate(a, b, dt) : null)
  const ops = {} as Record<OpType, number | null>
  for (const k of OP_TYPES) ops[k] = r(prev?.opcounters[k], cur.opcounters[k])
  const vals = OP_TYPES.map((k) => ops[k])
  const { usedPct, dirtyPct } = cacheUsage(cur)
  const gl = cur.globalLock
  return {
    t: cur.at,
    ops,
    opsTotal: vals.every((v) => v != null) ? vals.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
    netIn: r(prev?.network.bytesIn, cur.network.bytesIn),
    netOut: r(prev?.network.bytesOut, cur.network.bytesOut),
    requests: r(prev?.network.numRequests, cur.network.numRequests),
    docs: {
      inserted: r(prev?.document?.inserted, cur.document?.inserted),
      updated: r(prev?.document?.updated, cur.document?.updated),
      deleted: r(prev?.document?.deleted, cur.document?.deleted),
      returned: r(prev?.document?.returned, cur.document?.returned)
    },
    scannedObjects: r(prev?.queryExecutor?.scannedObjects, cur.queryExecutor?.scannedObjects),
    connections: cur.connections.current,
    resident: cur.mem.resident,
    cacheUsedPct: usedPct,
    cacheDirtyPct: dirtyPct,
    activeClients: gl ? gl.activeClients : null,
    queued: gl ? gl.currentQueue : null
  }
}

/** Append a point and drop those older than the window (relative to the newest point). */
export function appendPoint<T extends { t: number }>(points: readonly T[], p: T, windowMs = WINDOW_MS): T[] {
  const from = p.t - windowMs
  const out = points.filter((x) => x.t >= from && x.t < p.t)
  out.push(p)
  return out
}

/** Seconds each member is behind the primary (or the most advanced member when there is none). */
export function withLag<M extends Pick<ReplMember, 'stateStr' | 'optimeDate'>>(members: M[]): (M & { lagSec?: number })[] {
  const primary = members.find((m) => m.stateStr === 'PRIMARY' && m.optimeDate)
  const times = members.filter((m) => m.optimeDate && m.stateStr !== 'ARBITER').map((m) => m.optimeDate!.getTime())
  const ref = primary?.optimeDate?.getTime() ?? (times.length ? Math.max(...times) : undefined)
  return members.map((m) => {
    if (ref == null || !m.optimeDate || m.stateStr === 'ARBITER') return { ...m }
    return { ...m, lagSec: Math.max(0, (ref - m.optimeDate.getTime()) / 1000) }
  })
}

/** "~37 h", "~3 d", "~12 min" — rough size of a time span such as the oplog window. */
export function approxDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 90) return `~${Math.round(sec)} s`
  const min = sec / 60
  if (min < 90) return `~${Math.round(min)} min`
  const h = min / 60
  if (h < 72) return `~${Math.round(h)} h`
  return `~${Math.round(h / 24)} d`
}

/** Uptime as "3 d 4 h", "5 h 12 min", "42 s". */
export function uptimeText(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d} d ${h} h`
  if (h) return `${h} h ${m} min`
  if (m) return `${m} min`
  return `${Math.floor(sec)} s`
}

export function bytesText(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = Math.abs(n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const sign = n < 0 ? '-' : ''
  return `${sign}${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : digits).replace(/\.0+$/, '')} ${units[i]}`
}

/** Compact number: 950, 1.2k, 3.4M. */
export function compactNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a < 10 && n % 1 !== 0) return n.toFixed(1)
  if (a < 1000) return String(Math.round(n))
  if (a < 1e6) return `${(n / 1e3).toFixed(a < 1e4 ? 1 : 0)}k`
  if (a < 1e9) return `${(n / 1e6).toFixed(a < 1e7 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(1)}G`
}

/** Upper bound for a chart axis with four even divisions: 1, 2, 4, 6 or 8 × 10ⁿ above `max`. */
export function niceMax(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 1
  const exp = Math.floor(Math.log10(max))
  const base = 10 ** exp
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * base >= max) return m * base
  return 10 * base
}

/** Axis maximum for byte values, nice in binary units (e.g. 2 MB rather than 1.95 MB). */
export function niceBytesMax(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 1024
  let unit = 1
  while (max / unit >= 1024) unit *= 1024
  return niceMax(max / unit) * unit
}
