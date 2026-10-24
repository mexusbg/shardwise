import { useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { Doc } from '@shared/api'
import { commandOf, isPlainObject, num, profileQueryParts } from '@shared/profile'
import { formatQuery } from '../../lib/queryText'
import { api } from '../../lib/api'
import { dbKey, errorText, openCollectionTab, patchTab, toast, useStore } from '../../state/store'
import { runQuery, syncTextToVqb } from '../../state/queryActions'
import { fmtDate, fmtTime as fmtClock } from '../../lib/datetime'

export const fmtNum = (v: unknown): string => {
  const n = num(v)
  return n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

export function fmtTime(v: unknown): string {
  if (!(v instanceof Date) || isNaN(v.getTime())) return '—'
  // Milliseconds matter when comparing profiled operations.
  const t = `${fmtClock(v)}.${pad(v.getMilliseconds(), 3)}`
  return v.toDateString() === new Date().toDateString() ? t : `${fmtDate(v)} ${t}`
}

/** Readable explanation of profiler errors (privileges, mongos). */
export function friendlyError(e: unknown, topology: string | undefined, db: string): { title: string; detail?: string } {
  const msg = errorText(e)
  if (topology?.startsWith('Sharded') || /mongos|not supported on a router/i.test(msg)) {
    return {
      title: 'This connection is a mongos router: profiling is configured per shard. Connect directly to a shard member (mongod) to use the profiler. Current Operations work on mongos.',
      detail: msg
    }
  }
  if (/not authorized|unauthorized|requires authentication|Unauthorized/i.test(msg)) {
    return { title: `Your user is not allowed to do this on "${db}". The profiler needs the enableProfiler privilege (e.g. the dbAdmin role); reading system.profile needs find on it.`, detail: msg }
  }
  return { title: msg }
}

export function ErrorNotice({ error }: { error: { title: string; detail?: string } }): ReactElement {
  return (
    <div className="notice error pf-notice">
      <div>{error.title}</div>
      {error.detail && error.detail !== error.title && <div className="mono faint pf-notice-detail">{error.detail}</div>}
    </div>
  )
}

export function useInterval(cb: () => void, ms: number | null): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (ms == null) return
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

// ---------------------------------------------------------------------------
// Sortable tables
// ---------------------------------------------------------------------------

export interface SortState {
  col: string
  dir: 1 | -1
}

function cmp(a: unknown, b: unknown): number {
  if (a == null || a === '') return b == null || b === '' ? 0 : 1
  if (b == null || b === '') return -1
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

export function sortRows<T>(rows: T[], s: SortState, get: (r: T, col: string) => unknown): T[] {
  return [...rows].sort((x, y) => {
    const a = get(x, s.col)
    const b = get(y, s.col)
    // empty values always last
    if (a == null || a === '' || b == null || b === '') return cmp(a, b)
    return cmp(a, b) * s.dir
  })
}

export function Th(p: {
  col: string
  sort: SortState
  onSort: (s: SortState) => void
  children: ReactNode
  width?: number
  num?: boolean
  title?: string
  /** First click sorts descending (numbers, times). */
  descFirst?: boolean
}): ReactElement {
  const on = p.sort.col === p.col
  return (
    <th
      style={p.width ? { width: p.width } : undefined}
      className={`${on ? 'sorted' : ''} ${p.num ? 'pf-num' : ''}`}
      title={p.title}
      onClick={() => p.onSort({ col: p.col, dir: on ? (p.sort.dir === 1 ? -1 : 1) : p.descFirst ? -1 : 1 })}
    >
      {p.children}
      {on && <span className="sort-ind">{p.sort.dir === 1 ? '▲' : '▼'}</span>}
    </th>
  )
}

// ---------------------------------------------------------------------------
// Shell text and "open in tab"
// ---------------------------------------------------------------------------

const NOISE = new Set(['lsid', 'txnNumber', 'autocommit', 'startTransaction', 'apiVersion', 'apiStrict', 'apiDeprecationErrors', 'mayBypassWriteBlocking'])

/** Command without driver / session noise ($db, lsid, $clusterTime, …). */
export function cleanCommand(cmd: Doc): Doc {
  const out: Doc = {}
  for (const [k, v] of Object.entries(cmd)) if (!k.startsWith('$') && !NOISE.has(k)) out[k] = v
  return out
}

const q = (v: unknown): string => formatQuery(v)
const collRef = (c: string): string => `db.getCollection('${c.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`

/** The operation behind a profile / currentOp entry in mongo shell syntax. */
export function shellCommand(entry: Doc): string {
  const raw = commandOf(entry)
  const orig = isPlainObject(entry.originatingCommand) ? entry.originatingCommand : null
  const isGetMore = !!orig && (entry.op === 'getmore' || (!!raw && 'getMore' in raw))
  const cmd = isGetMore ? orig : raw
  if (!cmd) return '// no command recorded'
  const prefix = isGetMore ? '// getMore of:\n' : ''
  const parts = profileQueryParts(entry)
  const c = parts?.coll ?? ''
  if (parts && c) {
    const f = q(parts.filter)
    switch (parts.kind) {
      case 'find': {
        let s = `${collRef(c)}.find(${f}${parts.projection ? `, ${q(parts.projection)}` : ''})`
        if (parts.sort) s += `.sort(${q(parts.sort)})`
        if (parts.skip) s += `.skip(${parts.skip})`
        if (parts.limit) s += `.limit(${parts.limit})`
        return prefix + s
      }
      case 'count':
        return prefix + `${collRef(c)}.countDocuments(${f})`
      case 'distinct':
        return prefix + `${collRef(c)}.distinct(${JSON.stringify(cmd.key ?? '')}, ${f})`
      case 'aggregate':
        return prefix + `${collRef(c)}.aggregate(${q(cmd.pipeline)})`
      case 'update': {
        const u = 'u' in cmd ? cmd.u : Array.isArray(cmd.updates) && isPlainObject(cmd.updates[0]) ? cmd.updates[0].u : undefined
        const multi = 'multi' in cmd ? cmd.multi : Array.isArray(cmd.updates) && isPlainObject(cmd.updates[0]) ? cmd.updates[0].multi : false
        if (u !== undefined) return prefix + `${collRef(c)}.${multi ? 'updateMany' : 'updateOne'}(${f}, ${q(u)})`
        break
      }
      case 'delete': {
        const lim = 'limit' in cmd ? num(cmd.limit) : Array.isArray(cmd.deletes) && isPlainObject(cmd.deletes[0]) ? num(cmd.deletes[0].limit) : 0
        return prefix + `${collRef(c)}.${lim === 1 ? 'deleteOne' : 'deleteMany'}(${f})`
      }
    }
  }
  if (Array.isArray(cmd.pipeline) && typeof cmd.aggregate === 'string') return prefix + `${collRef(cmd.aggregate)}.aggregate(${q(cmd.pipeline)})`
  return prefix + `db.runCommand(${q(cleanCommand(cmd))})`
}

/** Open the entry's query (find, count, aggregate $match, update/delete filter…) in a new collection tab and run it. */
export function openEntryInTab(connId: string, entry: Doc): boolean {
  const parts = profileQueryParts(entry)
  const ns = typeof entry.ns === 'string' ? entry.ns : ''
  if (!parts?.coll || !ns.includes('.')) return false
  const db = ns.slice(0, ns.indexOf('.'))
  const isView = useStore.getState().collections[dbKey(connId, db)]?.find((c) => c.name === parts.coll)?.type === 'view'
  const id = openCollectionTab(connId, db, parts.coll, isView)
  patchTab(id, {
    queryText: Object.keys(parts.filter).length ? formatQuery(parts.filter) : '',
    sortText: parts.sort && Object.keys(parts.sort).length ? formatQuery(parts.sort) : '',
    projectionText: parts.projection && Object.keys(parts.projection).length ? formatQuery(parts.projection) : '',
    skipText: parts.skip ? String(parts.skip) : '',
    limitText: parts.limit ? String(parts.limit) : ''
  })
  syncTextToVqb(id, 'query')
  syncTextToVqb(id, 'projection')
  syncTextToVqb(id, 'sort')
  // Running right away (before the tab mounts) keeps a saved default query from replacing the profiled one.
  void runQuery(id)
  return true
}

export async function copyText(text: string, what = 'Command'): Promise<void> {
  try {
    await api.copyText(text)
    toast(`${what} copied`, 'success')
  } catch (e) {
    toast(errorText(e), 'error')
  }
}
