import { IndexAdvicePanel } from './IndexAdvice'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { Doc, ProfilingStatus } from '@shared/api'
import { shellText } from '@shared/bsonValue'
import { buildProfileFilter, groupProfile, num, opLabel, PROFILE_OPS, profileQueryParts, profileWarnings, shapeKey } from '@shared/profile'
import type { ProfileOpFilter, ShapeGroup } from '@shared/profile'
import { api } from '../../lib/api'
import { toast } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { showMenu } from '../ContextMenu'
import { ProfilerDetails } from './ProfilerDetails'
import { copyText, ErrorNotice, fmtNum, fmtTime, friendlyError, openEntryInTab, shellCommand, sortRows, Th, useInterval } from './ProfilerCommon'
import type { SortState } from './ProfilerCommon'

const LEVELS = [
  { level: 0, label: 'Off' },
  { level: 1, label: 'Slow ops' },
  { level: 2, label: 'All' }
]

const RANGES = [
  { id: '5m', label: 'Last 5 min', ms: 5 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 3600_000 },
  { id: '24h', label: 'Last 24 h', ms: 24 * 3600_000 },
  { id: 'all', label: 'All time', ms: 0 }
]

const LIMITS = [100, 500, 1000, 5000]

interface Filters {
  minMs: string
  op: ProfileOpFilter
  ns: string
  text: string
  range: string
  limit: number
}

const searchCache = new WeakMap<Doc, string>()
function searchText(e: Doc): string {
  let s = searchCache.get(e)
  if (s === undefined) {
    s = [e.ns, e.op, e.appName, e.client, e.user, e.planSummary, shellText(e.command ?? null), e.originatingCommand ? shellText(e.originatingCommand) : '']
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    searchCache.set(e, s)
  }
  return s
}

const entryId = (e: Doc): string => `${e.ts instanceof Date ? e.ts.getTime() : ''}|${e.ns}|${e.op}|${num(e.millis)}|${num(e.docsExamined)}`

function opValue(e: Doc, col: string): unknown {
  switch (col) {
    case 'ts':
      return e.ts
    case 'op':
      return opLabel(e)
    case 'ns':
      return e.ns
    case 'plan':
      return e.planSummary
    case 'app':
      return e.appName || e.client
    default:
      return num(e[col])
  }
}

function PlanCell({ plan }: { plan: unknown }): ReactElement {
  if (typeof plan !== 'string' || !plan) return <span className="faint">—</span>
  return <span className={plan.includes('COLLSCAN') ? 'pf-bad' : ''}>{plan}</span>
}

export function ProfilerPanel({ connId, db, topology, active }: { connId: string; db: string; topology?: string; active: boolean }): ReactElement {
  const [status, setStatus] = useState<ProfilingStatus | null>(null)
  const [statusErr, setStatusErr] = useState<{ title: string; detail?: string } | null>(null)
  const [draft, setDraft] = useState({ level: 0, slowms: '100', sampleRate: '1' })
  const [applying, setApplying] = useState(false)
  const [filters, setFilters] = useState<Filters>({ minMs: '', op: 'all', ns: '', text: '', range: 'all', limit: 500 })
  const [entries, setEntries] = useState<Doc[]>([])
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState<{ title: string; detail?: string } | null>(null)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [auto, setAuto] = useState(false)
  const [mode, setMode] = useState<'ops' | 'shapes' | 'advice'>('ops')
  const [shape, setShape] = useState<ShapeGroup | null>(null)
  const [sort, setSort] = useState<SortState>({ col: 'ts', dir: -1 })
  const [shapeSort, setShapeSort] = useState<SortState>({ col: 'totalMs', dir: -1 })
  const [selected, setSelected] = useState<Doc | null>(null)
  const [collections, setCollections] = useState<string[]>([])
  const seq = useRef(0)

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.profilingStatus(connId, db)
      setStatus(s)
      setStatusErr(null)
      setDraft({ level: s.level, slowms: String(s.slowms), sampleRate: String(s.sampleRate) })
    } catch (e) {
      setStatusErr(friendlyError(e, topology, db))
    }
  }, [connId, db, topology])

  const load = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    try {
      const range = RANGES.find((r) => r.id === filters.range)
      const ns = filters.ns.trim()
      const filter = buildProfileFilter({
        db,
        minMs: parseFloat(filters.minMs) || 0,
        op: filters.op,
        ns,
        nsExact: collections.includes(ns),
        sinceMs: range?.ms
      })
      const docs = await api.readProfile(connId, db, { filter, limit: filters.limit })
      if (my !== seq.current) return
      setEntries(docs)
      setLoadErr(null)
      setLoadedAt(new Date())
      // keep the selection when the same entry is still there
      setSelected((sel) => (sel ? (docs.find((d) => entryId(d) === entryId(sel)) ?? sel) : null))
    } catch (e) {
      if (my === seq.current) setLoadErr(friendlyError(e, topology, db))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [connId, db, topology, filters.minMs, filters.op, filters.ns, filters.range, filters.limit, collections])

  useEffect(() => {
    void loadStatus()
    api
      .listCollections(connId, db)
      .then((l) => setCollections(l.map((c) => c.name).filter((n) => !n.startsWith('system.')).sort()))
      .catch(() => {})
  }, [connId, db, loadStatus])

  // Server-side filters: reload (debounced for typed values)
  useEffect(() => {
    const t = setTimeout(() => void load(), 300)
    return () => clearTimeout(t)
  }, [load])

  useInterval(() => void load(), auto && active ? 5000 : null)

  const apply = async (level = draft.level, slowms = Number(draft.slowms), sampleRate = Number(draft.sampleRate)): Promise<void> => {
    setApplying(true)
    try {
      const s = await api.setProfiling(connId, db, level, slowms, sampleRate)
      setStatus(s)
      setStatusErr(null)
      setDraft({ level: s.level, slowms: String(s.slowms), sampleRate: String(s.sampleRate) })
      toast(s.level === 0 ? `Profiling turned off for ${db}` : `Profiling ${s.level === 2 ? 'all operations' : `operations slower than ${s.slowms} ms`} on ${db}`, 'success')
      void load()
    } catch (e) {
      setStatusErr(friendlyError(e, topology, db))
    } finally {
      setApplying(false)
    }
  }

  const clear = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Clear profile data',
      message: (
        <>
          Drop <b>{db}.system.profile</b>? All recorded operations of this database are deleted. Profiling is briefly turned off while the collection is
          dropped.
        </>
      ),
      confirmLabel: 'Clear',
      danger: true
    })
    if (!ok) return
    try {
      await api.clearProfile(connId, db)
      setSelected(null)
      setShape(null)
      toast('Profile data cleared', 'success')
      void load()
    } catch (e) {
      toast(friendlyError(e, topology, db).title, 'error')
    }
  }

  const patchFilters = (p: Partial<Filters>): void => setFilters((f) => ({ ...f, ...p }))

  const textMatched = useMemo(() => {
    const t = filters.text.trim().toLowerCase()
    return t ? entries.filter((e) => searchText(e).includes(t)) : entries
  }, [entries, filters.text])
  const groups = useMemo(() => groupProfile(textMatched), [textMatched])
  const sortedGroups = useMemo(
    () => sortRows(groups, shapeSort, (g, col) => (col === 'plan' ? g.plans[0] : (g as unknown as Record<string, unknown>)[col])),
    [groups, shapeSort]
  )
  const visible = useMemo(() => {
    const rows = shape ? textMatched.filter((e) => shapeKey(e) === shape.key) : textMatched
    return sortRows(rows, sort, opValue)
  }, [textMatched, shape, sort])
  const maxMs = useMemo(() => Math.max(1, ...visible.map((e) => num(e.millis) ?? 0)), [visible])
  const maxTotal = useMemo(() => Math.max(1, ...groups.map((g) => g.totalMs)), [groups])
  const selId = selected ? entryId(selected) : null

  const draftValid = Number.isFinite(Number(draft.slowms)) && Number(draft.slowms) >= 0 && draft.slowms.trim() !== '' && Number(draft.sampleRate) >= 0 && Number(draft.sampleRate) <= 1 && draft.sampleRate.trim() !== ''
  const dirty = !!status && (draft.level !== status.level || Number(draft.slowms) !== status.slowms || Number(draft.sampleRate) !== status.sampleRate)
  const filtered = !!(filters.minMs || filters.op !== 'all' || filters.ns || filters.text || filters.range !== 'all')
  const showEmpty = !loading && !loadErr && entries.length === 0 && status?.level === 0 && !filtered

  const rowMenu = (e: ReactMouseEvent, entry: Doc): void => {
    setSelected(entry)
    const parts = profileQueryParts(entry)
    showMenu(e, [
      { label: 'Open query in new tab', icon: 'play', disabled: !parts?.coll, onClick: () => openEntryInTab(connId, entry) },
      { label: 'Copy command', icon: 'copy', onClick: () => void copyText(shellCommand(entry)) },
      { label: 'Copy profile document', icon: 'json', onClick: () => void copyText(shellText(entry, 2), 'Document') },
      { separator: true },
      {
        label: 'Show all of this query shape',
        icon: 'filter',
        onClick: () => {
          const key = shapeKey(entry)
          setShape(groupProfile(textMatched).find((g) => g.key === key) ?? null)
        }
      }
    ])
  }

  return (
    <div className="pf-body">
      {statusErr ? (
        <div className="pf-strip">
          <ErrorNotice error={statusErr} />
          <button className="btn small" onClick={() => void loadStatus()}>
            <Icon name="refresh" size={13} /> Retry
          </button>
        </div>
      ) : (
        <div className="pf-strip">
          <span className="pf-lbl">Profiling</span>
          <div className="segmented small">
            {LEVELS.map((l) => (
              <button key={l.level} className={draft.level === l.level ? 'on' : ''} onClick={() => setDraft((d) => ({ ...d, level: l.level }))}>
                {l.label}
              </button>
            ))}
          </div>
          <label className="pf-field" title="Operations slower than this are recorded at level 1 (also used for the server log)">
            <span className="pf-lbl">Slower than</span>
            <input
              className={`input small pf-w60 ${Number(draft.slowms) >= 0 && draft.slowms.trim() ? '' : 'invalid'}`}
              value={draft.slowms}
              onChange={(e) => setDraft((d) => ({ ...d, slowms: e.target.value }))}
            />
            <span className="faint">ms</span>
          </label>
          <label className="pf-field" title="Fraction of slow operations to record (0 – 1)">
            <span className="pf-lbl">Sample rate</span>
            <input
              className={`input small pf-w50 ${Number(draft.sampleRate) >= 0 && Number(draft.sampleRate) <= 1 && draft.sampleRate.trim() ? '' : 'invalid'}`}
              value={draft.sampleRate}
              onChange={(e) => setDraft((d) => ({ ...d, sampleRate: e.target.value }))}
            />
          </label>
          <button className={`btn small ${dirty ? 'primary' : ''}`} disabled={!status || !draftValid || applying || !dirty} onClick={() => void apply()}>
            Apply
          </button>
          {status && (
            <span className="pf-state">
              <span className={`pf-dot l${status.level}`} />
              {status.level === 0 ? 'Off' : status.level === 1 ? `Recording ops > ${status.slowms} ms` : 'Recording all operations'}
              {status.level > 0 && status.sampleRate < 1 && ` · ${Math.round(status.sampleRate * 100)}% sampled`}
              {status.filter && (
                <span className="badge" title={shellText(status.filter, 2)}>
                  server filter
                </span>
              )}
            </span>
          )}
        </div>
      )}
      {(draft.level === 2 || status?.level === 2) && !statusErr && (
        <div className="notice pf-banner">
          <Icon name="warn" size={13} /> Profiling all operations adds load to the server and fills system.profile quickly — don&apos;t leave it on in production.
        </div>
      )}

      <div className="pf-strip">
        <div className="segmented small">
          <button className={mode === 'ops' ? 'on' : ''} onClick={() => setMode('ops')}>
            <Icon name="table" size={12} /> Operations
          </button>
          <button className={mode === 'shapes' ? 'on' : ''} onClick={() => setMode('shapes')}>
            <Icon name="filter" size={12} /> Query shapes
          </button>
          <button className={mode === 'advice' ? 'on' : ''} onClick={() => setMode('advice')}>
            <Icon name="key" size={12} /> Index suggestions
          </button>
        </div>
        <label className="pf-field" title="Minimum duration">
          <span className="pf-lbl">≥</span>
          <input className="input small pf-w60" placeholder="0" value={filters.minMs} onChange={(e) => patchFilters({ minMs: e.target.value.replace(/[^\d.]/g, '') })} />
          <span className="faint">ms</span>
        </label>
        <select className="select small" value={filters.op} onChange={(e) => patchFilters({ op: e.target.value as ProfileOpFilter })} title="Operation type">
          {PROFILE_OPS.map((o) => (
            <option key={o} value={o}>
              {o === 'all' ? 'All operations' : o}
            </option>
          ))}
        </select>
        <input
          className="input small pf-w140"
          list={`pf-colls-${connId}-${db}`}
          placeholder="Collection / namespace"
          value={filters.ns}
          onChange={(e) => patchFilters({ ns: e.target.value })}
          title="Pick a collection for an exact match, or type part of a namespace"
        />
        <datalist id={`pf-colls-${connId}-${db}`}>
          {collections.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <select className="select small" value={filters.range} onChange={(e) => patchFilters({ range: e.target.value })} title="Time range">
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <select className="select small" value={filters.limit} onChange={(e) => patchFilters({ limit: Number(e.target.value) })} title="Maximum entries to read">
          {LIMITS.map((l) => (
            <option key={l} value={l}>
              {l} entries
            </option>
          ))}
        </select>
        <div className="pf-search">
          <Icon name="search" size={12} />
          <input className="input small" placeholder="Search commands…" value={filters.text} onChange={(e) => patchFilters({ text: e.target.value })} />
        </div>
        <span className="spacer" />
        <label className="check pf-lbl" title="Refresh every 5 seconds">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto refresh
        </label>
        <button className="btn small" onClick={() => void load()} title="Refresh">
          <Icon name="refresh" size={13} className={loading ? 'pf-spin' : ''} /> Refresh
        </button>
        <button className="btn small danger" onClick={() => void clear()} title="Drop system.profile">
          <Icon name="trash" size={13} /> Clear
        </button>
      </div>

      {loadErr && (
        <div className="pf-strip">
          <ErrorNotice error={loadErr} />
        </div>
      )}

      {shape && mode === 'ops' && (
        <div className="pf-chipbar">
          <span className="pf-chip">
            <Icon name="filter" size={12} />
            <span className="faint">Shape</span>
            <span className="mono ellipsis">{shape.example}</span>
            <button className="btn ghost icon small" title="Show all operations" onClick={() => setShape(null)}>
              <Icon name="close" size={12} />
            </button>
          </span>
        </div>
      )}

      <div className="pf-split">
        <div className="pf-main">
          {loading && <div className="loading-bar" />}
          {showEmpty ? (
            <div className="pf-empty">
              <Icon name="gauge" size={36} />
              <h3>Profiling is off for {db}</h3>
              <p className="muted">
                The database profiler records operations into <span className="mono">{db}.system.profile</span>. Turn it on to see slow queries, collection scans,
                in-memory sorts and how much each query shape costs. Level 1 only records operations slower than the threshold and is usually safe to leave on.
              </p>
              <button className="btn primary" disabled={applying || !!statusErr} onClick={() => void apply(1, 100, 1)}>
                <Icon name="play" size={12} /> Enable for slow operations (100 ms)
              </button>
            </div>
          ) : mode === 'advice' ? (
            <IndexAdvicePanel connId={connId} db={db} entries={textMatched} />
          ) : mode === 'ops' ? (
            <div className="grid pf-grid">
              <table>
                <thead>
                  <tr>
                    <Th col="ts" sort={sort} onSort={setSort} width={150} descFirst>
                      Time
                    </Th>
                    <Th col="op" sort={sort} onSort={setSort} width={92}>
                      Op
                    </Th>
                    <Th col="ns" sort={sort} onSort={setSort} width={170}>
                      Namespace
                    </Th>
                    <Th col="millis" sort={sort} onSort={setSort} width={130} descFirst>
                      Duration
                    </Th>
                    <Th col="docsExamined" sort={sort} onSort={setSort} width={92} num descFirst title="Documents examined">
                      Docs ex.
                    </Th>
                    <Th col="keysExamined" sort={sort} onSort={setSort} width={92} num descFirst title="Index keys examined">
                      Keys ex.
                    </Th>
                    <Th col="nreturned" sort={sort} onSort={setSort} width={84} num descFirst>
                      Returned
                    </Th>
                    <Th col="plan" sort={sort} onSort={setSort} width={200}>
                      Plan
                    </Th>
                    <Th col="app" sort={sort} onSort={setSort}>
                      App / client
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((e, i) => {
                    const id = entryId(e)
                    const ms = num(e.millis) ?? 0
                    const warns = profileWarnings(e)
                    const ns = typeof e.ns === 'string' ? e.ns : ''
                    return (
                      <tr key={`${id}#${i}`} className={id === selId ? 'sel' : ''} onClick={() => setSelected(e)} onContextMenu={(ev) => rowMenu(ev, e)}>
                        <td title={e.ts instanceof Date ? e.ts.toISOString() : undefined}>{fmtTime(e.ts)}</td>
                        <td>
                          <span className="pf-op">{opLabel(e)}</span>
                        </td>
                        <td title={ns}>{ns.startsWith(`${db}.`) ? ns.slice(db.length + 1) : ns}</td>
                        <td>
                          <div className="pf-dur">
                            <div className={`pf-durbar ${ms >= 1000 ? 'danger' : ms >= 100 ? 'warn' : ''}`} style={{ width: `${(ms / maxMs) * 100}%` }} />
                            <span>{fmtNum(ms)}</span>
                          </div>
                        </td>
                        <td className="pf-num">{fmtNum(e.docsExamined)}</td>
                        <td className="pf-num">{fmtNum(e.keysExamined)}</td>
                        <td className="pf-num">{fmtNum(e.nreturned)}</td>
                        <td title={warns.map((w) => w.text).join('\n') || undefined}>
                          {warns.length > 0 && <Icon name="warn" size={12} className={`pf-wicon ${warns.some((w) => w.level === 'danger') ? 'danger' : ''}`} />}
                          <PlanCell plan={e.planSummary} />
                        </td>
                        <td className="faint">{[e.appName, e.client].filter(Boolean).join(' · ') || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!loading && visible.length === 0 && !loadErr && (
                <div className="pf-none muted">
                  {entries.length ? 'No operations match the search.' : status && status.level > 0 ? 'No operations recorded yet for these filters.' : 'No profile data for these filters.'}
                </div>
              )}
            </div>
          ) : (
            <div className="grid pf-grid">
              <table>
                <thead>
                  <tr>
                    <Th col="ns" sort={shapeSort} onSort={setShapeSort} width={160}>
                      Namespace
                    </Th>
                    <Th col="op" sort={shapeSort} onSort={setShapeSort} width={92}>
                      Op
                    </Th>
                    <Th col="example" sort={shapeSort} onSort={setShapeSort}>
                      Query shape
                    </Th>
                    <Th col="count" sort={shapeSort} onSort={setShapeSort} width={70} num descFirst>
                      Count
                    </Th>
                    <Th col="totalMs" sort={shapeSort} onSort={setShapeSort} width={130} descFirst>
                      Total ms
                    </Th>
                    <Th col="avgMs" sort={shapeSort} onSort={setShapeSort} width={80} num descFirst>
                      Avg ms
                    </Th>
                    <Th col="maxMs" sort={shapeSort} onSort={setShapeSort} width={80} num descFirst>
                      Max ms
                    </Th>
                    <Th col="avgDocsExamined" sort={shapeSort} onSort={setShapeSort} width={96} num descFirst title="Average documents examined">
                      Avg docs ex.
                    </Th>
                    <Th col="avgReturned" sort={shapeSort} onSort={setShapeSort} width={90} num descFirst>
                      Avg returned
                    </Th>
                    <Th col="plan" sort={shapeSort} onSort={setShapeSort} width={190}>
                      Plan
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {sortedGroups.map((g) => (
                    <tr
                      key={g.key}
                      onClick={() => {
                        setShape(g)
                        setMode('ops')
                        setSelected(null)
                      }}
                      title={`Show the ${g.count} operation${g.count === 1 ? '' : 's'} of this shape${g.hash ? `\nShape hash: ${g.hash}` : ''}`}
                    >
                      <td title={g.ns}>{g.ns.startsWith(`${db}.`) ? g.ns.slice(db.length + 1) : g.ns}</td>
                      <td>
                        <span className="pf-op">{g.op}</span>
                      </td>
                      <td className="pf-shape" title={g.example}>
                        {g.example}
                      </td>
                      <td className="pf-num">{fmtNum(g.count)}</td>
                      <td>
                        <div className="pf-dur">
                          <div className="pf-durbar" style={{ width: `${(g.totalMs / maxTotal) * 100}%` }} />
                          <span>{fmtNum(g.totalMs)}</span>
                        </div>
                      </td>
                      <td className="pf-num">{fmtNum(g.avgMs)}</td>
                      <td className="pf-num">{fmtNum(g.maxMs)}</td>
                      <td className="pf-num">{fmtNum(g.avgDocsExamined)}</td>
                      <td className="pf-num">{fmtNum(g.avgReturned)}</td>
                      <td title={g.plans.join('\n')}>
                        <PlanCell plan={g.plans[0]} />
                        {g.plans.length > 1 && <span className="faint"> +{g.plans.length - 1}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!loading && groups.length === 0 && !loadErr && <div className="pf-none muted">No operations to group.</div>}
            </div>
          )}
        </div>
        {selected && mode === 'ops' && <ProfilerDetails connId={connId} entry={selected} onClose={() => setSelected(null)} />}
      </div>

      <div className="pf-foot faint">
        {shape ? `${visible.length} of ${entries.length}` : textMatched.length !== entries.length ? `${textMatched.length} of ${entries.length}` : entries.length} operation
        {entries.length === 1 ? '' : 's'}
        {mode === 'shapes' && ` · ${groups.length} shape${groups.length === 1 ? '' : 's'}`}
        {entries.length >= filters.limit && ` · limit of ${filters.limit} reached`}
        <span className="spacer" />
        {loadedAt && `Updated ${fmtTime(loadedAt).replace(/\.\d+$/, '')}`}
        {auto && active && ' · auto refresh 5 s'}
      </div>
    </div>
  )
}

