import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { shellText } from '@shared/bsonValue'
import type { CollectionInfo, DatabaseInfo, Doc } from '@shared/api'
import type { CompareCategory, CompareEntry, CompareRequest, CompareSummary, FieldMode } from '@shared/compareApi'
import { api } from '../../lib/api'
import { tryParse } from '../../lib/queryText'
import { connName, errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { compareApi } from './compareClient'
import { DiffPanel } from './DiffPanel'
import { openSyncDialog } from './SyncDialog'
import './compare.css'

const PAGE = 100
const fmt = (n: number): string => n.toLocaleString()

const CATEGORIES: { id: CompareCategory; label: string; short: string }[] = [
  { id: 'different', label: 'Different', short: 'Different' },
  { id: 'onlySource', label: 'Only in source', short: 'Only source' },
  { id: 'onlyTarget', label: 'Only in target', short: 'Only target' },
  { id: 'identical', label: 'Identical', short: 'Identical' }
]

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`
}

const splitPaths = (s: string): string[] => s.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean)

interface Setup {
  srcFilter: string
  tgtConn: string
  tgtDb: string
  tgtColl: string
  tgtFilter: string
  sameFilter: boolean
  key: string
  fieldMode: FieldMode
  fieldPaths: string
  ignore: string
  sampleOn: boolean
  sample: number
}

function useList<T>(load: (() => Promise<T[]>) | null, deps: unknown[]): { list: T[] | null; error: string | null } {
  const [state, setState] = useState<{ list: T[] | null; error: string | null }>({ list: null, error: null })
  useEffect(() => {
    if (!load) {
      setState({ list: null, error: null })
      return
    }
    let alive = true
    setState({ list: null, error: null })
    load()
      .then((list) => alive && setState({ list, error: null }))
      .catch((e) => alive && setState({ list: [], error: errorText(e) }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

function FilterInput({ value, onChange, fields, disabled, onSubmit }: { value: string; onChange: (v: string) => void; fields: string[]; disabled?: boolean; onSubmit: () => void }): ReactElement {
  const invalid = tryParse('query', value) === undefined
  return (
    <div className={`cmp-filter ${disabled ? 'disabled' : ''}`}>
      <CodeEditor value={value} onChange={disabled ? undefined : onChange} readOnly={disabled} fields={fields} invalid={invalid} placeholder="{ } — all documents" onSubmit={onSubmit} maxHeight={90} />
    </div>
  )
}

function Card({ label, value, kind, active, onClick, hint }: { label: string; value: string; kind: string; active?: boolean; onClick?: () => void; hint?: string }): ReactElement {
  const body = (
    <>
      <span className="cmp-card-value">{value}</span>
      <span className="cmp-card-label">{label}</span>
    </>
  )
  if (!onClick)
    return (
      <div className={`cmp-card k-${kind}`} title={hint}>
        {body}
      </div>
    )
  return (
    <button className={`cmp-card k-${kind} clickable ${active ? 'active' : ''}`} onClick={onClick} title={hint}>
      {body}
    </button>
  )
}

/** Compare a collection with another one (any live connection) and sync the differences. */
export function CompareView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const coll = tab.coll ?? ''
  const live = useStore((s) => s.live)
  const connected = !!live[connId]
  const [setup, setSetup] = useState<Setup>({
    srcFilter: '',
    tgtConn: connId,
    tgtDb: db,
    tgtColl: '',
    tgtFilter: '',
    sameFilter: true,
    key: '_id',
    fieldMode: 'all',
    fieldPaths: '',
    ignore: '',
    sampleOn: false,
    sample: 1000
  })
  const patch = (p: Partial<Setup>): void => setSetup((s) => ({ ...s, ...p }))
  const [showSetup, setShowSetup] = useState(true)

  const [jobId, setJobId] = useState<string | null>(null)
  const [summary, setSummary] = useState<CompareSummary | null>(null)
  const [starting, setStarting] = useState(false)
  const [category, setCategory] = useState<CompareCategory>('different')
  const [page, setPage] = useState(0)
  const [entries, setEntries] = useState<{ list: CompareEntry[]; stored: number } | null>(null)
  const [selected, setSelected] = useState(0)
  const [syncJob, setSyncJob] = useState<string | null>(null)
  const job = useStore((s) => (jobId ? s.jobs[jobId] : undefined))
  const sync = useStore((s) => (syncJob ? s.jobs[syncJob] : undefined))
  const listRef = useRef<HTMLDivElement>(null)

  // Target connection may go away: fall back to the source connection.
  useEffect(() => {
    if (!live[setup.tgtConn] && live[connId]) patch({ tgtConn: connId, tgtDb: db, tgtColl: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, setup.tgtConn])

  const dbs = useList<DatabaseInfo>(live[setup.tgtConn] ? () => api.listDatabases(setup.tgtConn) : null, [setup.tgtConn, !!live[setup.tgtConn]])
  const colls = useList<CollectionInfo>(live[setup.tgtConn] && setup.tgtDb ? () => api.listCollections(setup.tgtConn, setup.tgtDb) : null, [setup.tgtConn, setup.tgtDb, !!live[setup.tgtConn]])
  const fields = useList<string>(connected ? () => api.sampleFields(connId, db, coll, 200) : null, [connId, db, coll, connected])
  const fieldList = fields.list ?? []

  const tgtCollOptions = useMemo(() => (colls.list ?? []).filter((c) => !c.name.startsWith('system.')), [colls.list])

  // Default target collection: same name in the chosen database when it exists, else the first one.
  useEffect(() => {
    if (!colls.list || setup.tgtColl) return
    const names = colls.list.map((c) => c.name)
    const sameNs = setup.tgtConn === connId && setup.tgtDb === db
    if (!sameNs && names.includes(coll)) patch({ tgtColl: coll })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colls.list])

  // Dispose results when the tab closes.
  const current = useRef<string | null>(null)
  current.current = jobId
  useEffect(() => () => void (current.current && compareApi.compareDispose(current.current).catch(() => {})), [])

  const running = summary?.state === 'running' || (!!job && job.state === 'running' && !summary)

  const refreshSummary = useCallback(async (id: string): Promise<CompareSummary | null> => {
    try {
      const s = await compareApi.compareSummary(id)
      if (current.current === id) setSummary(s)
      return s
    } catch {
      return null
    }
  }, [])

  // Live counts while comparing.
  useEffect(() => {
    if (!jobId || summary?.state !== 'running') return
    const t = setInterval(() => void refreshSummary(jobId), 400)
    return () => clearInterval(t)
  }, [jobId, summary?.state, refreshSummary])

  useEffect(() => {
    if (jobId && job && job.state !== 'running') void refreshSummary(jobId)
  }, [jobId, job?.state, refreshSummary])

  useEffect(() => {
    if (jobId && sync && sync.state !== 'running') void refreshSummary(jobId)
  }, [jobId, sync?.state, refreshSummary])

  const finished = summary && summary.state !== 'running'

  useEffect(() => {
    if (!jobId || !finished) return
    let alive = true
    compareApi
      .compareResult(jobId, category, page * PAGE, PAGE)
      .then((r) => {
        if (!alive) return
        setEntries({ list: r.entries, stored: r.stored })
        setSelected(0)
      })
      .catch((e) => alive && toast(errorText(e), 'error'))
    return () => {
      alive = false
    }
  }, [jobId, finished, category, page])

  const parsed = useMemo(() => {
    const src = tryParse('query', setup.srcFilter)
    const tgt = setup.sameFilter ? src : tryParse('query', setup.tgtFilter)
    return { src, tgt }
  }, [setup.srcFilter, setup.tgtFilter, setup.sameFilter])

  const problem = !connected
    ? 'The source connection is closed'
    : !live[setup.tgtConn]
      ? 'Choose a connected target'
      : !setup.tgtDb || !setup.tgtColl
        ? 'Choose a target database and collection'
        : parsed.src === undefined
          ? 'The source filter is not valid'
          : parsed.tgt === undefined
            ? 'The target filter is not valid'
            : setup.fieldMode !== 'all' && !splitPaths(setup.fieldPaths).length
              ? 'List the fields to compare or exclude'
              : null

  const start = async (): Promise<void> => {
    if (problem || running || starting) return
    const req: CompareRequest = {
      source: { connId, db, coll, filter: (parsed.src ?? {}) as Doc },
      target: { connId: setup.tgtConn, db: setup.tgtDb, coll: setup.tgtColl, filter: (parsed.tgt ?? {}) as Doc },
      key: setup.key.trim() || '_id',
      fields: { mode: setup.fieldMode, paths: splitPaths(setup.fieldPaths) },
      ignore: splitPaths(setup.ignore),
      sample: setup.sampleOn ? Math.max(1, Math.floor(setup.sample || 0)) : 0
    }
    setStarting(true)
    try {
      const prev = jobId
      const id = await compareApi.compareStart(req)
      if (prev) void compareApi.compareDispose(prev).catch(() => {})
      current.current = id
      setJobId(id)
      setSummary(null)
      setEntries(null)
      setPage(0)
      setSelected(0)
      setSyncJob(null)
      setShowSetup(false)
      await refreshSummary(id)
    } catch (e) {
      toast(`Could not start the comparison: ${errorText(e)}`, 'error')
    } finally {
      setStarting(false)
    }
  }

  const cancel = (): void => {
    if (jobId) void compareApi.compareCancel(jobId).catch((e) => toast(errorText(e), 'error'))
  }

  // Pick the most interesting category once results arrive.
  const picked = useRef<string | null>(null)
  useEffect(() => {
    if (!summary || summary.state === 'running' || picked.current === summary.jobId) return
    picked.current = summary.jobId
    const first = CATEGORIES.find((c) => summary[c.id] > 0)?.id ?? 'different'
    setCategory(first)
    setPage(0)
  }, [summary])

  const openSync = async (): Promise<void> => {
    if (!summary) return
    const id = await openSyncDialog(summary)
    if (id) {
      setSyncJob(id)
      void refreshSummary(summary.jobId)
    }
  }

  const choose = (c: CompareCategory): void => {
    setCategory(c)
    setPage(0)
    setSelected(0)
  }

  const onListKey = (e: ReactKeyboardEvent): void => {
    if (!entries?.list.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(entries.list.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(0, i - 1))
    }
  }

  useEffect(() => {
    listRef.current?.querySelector('.cmp-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const req = summary?.request
  const srcTitle = req ? `${connName(req.source.connId)} · ${req.source.db}.${req.source.coll}` : ''
  const tgtTitle = req ? `${connName(req.target.connId)} · ${req.target.db}.${req.target.coll}` : ''
  const count = summary ? summary[category] : 0
  const stored = entries?.stored ?? 0
  const pages = Math.max(1, Math.ceil(stored / PAGE))
  const entry = entries?.list[selected]
  const pct = job?.total ? Math.min(100, (job.done / job.total) * 100) : 0
  const syncable = !!summary && summary.state === 'done' && summary.onlySource + summary.onlyTarget + summary.different > 0
  const liveConns = Object.values(live)

  if (!connected && !summary)
    return (
      <div className="cmp">
        <div className="cmp-empty">
          <Icon name="unplug" size={36} />
          <h3>Disconnected</h3>
          <p className="muted">Reconnect to compare {coll}.</p>
        </div>
      </div>
    )

  return (
    <div className="cmp">
      <div className="cmp-head">
        <Icon name="compare" size={16} className="cmp-head-icon" />
        <span className="cmp-title ellipsis" title={`${db}.${coll}`}>
          Compare <span className="faint">{db}.</span>
          {coll}
        </span>
        {summary && !showSetup && (
          <span className="cmp-head-vs ellipsis faint" title={tgtTitle}>
            with {tgtTitle}
          </span>
        )}
        <span className="spacer" />
        {summary && (
          <button className="btn small ghost" onClick={() => setShowSetup((v) => !v)}>
            <Icon name={showSetup ? 'chevronDown' : 'chevronRight'} size={13} /> {showSetup ? 'Hide setup' : 'Edit setup'}
          </button>
        )}
        {running ? (
          <button className="btn small" onClick={cancel}>
            <Icon name="close" size={13} /> Cancel
          </button>
        ) : (
          <button className="btn small primary" onClick={() => void start()} disabled={!!problem || starting} title={problem ?? 'Ctrl+Enter in a filter'}>
            <Icon name="play" size={13} /> {summary ? 'Compare again' : 'Compare'}
          </button>
        )}
        <button className="btn small" onClick={() => void openSync()} disabled={!syncable || sync?.state === 'running'} title={syncable ? 'Copy, overwrite or delete documents' : 'Run a comparison with differences first'}>
          <Icon name="refresh" size={13} /> Sync…
        </button>
      </div>

      {showSetup && (
        <div className="cmp-setup">
          <div className="cmp-sides">
            <section className="cmp-side source">
              <div className="cmp-side-title">
                <span className="cmp-side-dot source" /> Source
              </div>
              <div className="cmp-side-ns">
                <span className="cmp-conn-chip" style={live[connId]?.color ? { borderColor: live[connId]!.color } : undefined}>
                  {connName(connId)}
                </span>
                <span className="mono ellipsis" title={`${db}.${coll}`}>
                  {db}.{coll}
                </span>
              </div>
              <label className="cmp-label">Filter</label>
              <FilterInput value={setup.srcFilter} onChange={(v) => patch({ srcFilter: v })} fields={fieldList} onSubmit={() => void start()} />
            </section>

            <div className="cmp-sides-arrow">
              <Icon name="compare" size={18} />
            </div>

            <section className="cmp-side target">
              <div className="cmp-side-title">
                <span className="cmp-side-dot target" /> Target
              </div>
              <div className="cmp-target-pick">
                <select className="select small" value={setup.tgtConn} onChange={(e) => patch({ tgtConn: e.target.value, tgtDb: '', tgtColl: '' })} title="Connection">
                  {liveConns.map((l) => (
                    <option key={l.connId} value={l.connId}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <select className="select small" value={setup.tgtDb} onChange={(e) => patch({ tgtDb: e.target.value, tgtColl: '' })} title="Database">
                  <option value="" disabled>
                    {dbs.list ? 'Database…' : 'Loading…'}
                  </option>
                  {setup.tgtDb && !(dbs.list ?? []).some((d) => d.name === setup.tgtDb) && <option value={setup.tgtDb}>{setup.tgtDb}</option>}
                  {(dbs.list ?? []).map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <select className="select small" value={setup.tgtColl} onChange={(e) => patch({ tgtColl: e.target.value })} title="Collection" disabled={!setup.tgtDb}>
                  <option value="" disabled>
                    {colls.list ? 'Collection…' : setup.tgtDb ? 'Loading…' : '—'}
                  </option>
                  {tgtCollOptions.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                      {c.type !== 'collection' ? ` (${c.type})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              {(dbs.error || colls.error) && <div className="error-text cmp-small">{dbs.error ?? colls.error}</div>}
              <label className="cmp-label row">
                Filter
                <span className="spacer" />
                <label className="check cmp-small">
                  <input type="checkbox" checked={setup.sameFilter} onChange={(e) => patch({ sameFilter: e.target.checked })} /> Same as source
                </label>
              </label>
              <FilterInput
                value={setup.sameFilter ? setup.srcFilter : setup.tgtFilter}
                onChange={(v) => patch({ tgtFilter: v })}
                fields={fieldList}
                disabled={setup.sameFilter}
                onSubmit={() => void start()}
              />
            </section>
          </div>

          <div className="cmp-options">
            <div className="cmp-opt">
              <label className="cmp-label" title="Unique field used to pair documents">
                Key field
              </label>
              <input className="input small mono" list={`cmp-keys-${tab.id}`} value={setup.key} onChange={(e) => patch({ key: e.target.value })} placeholder="_id" style={{ width: 150 }} />
              <datalist id={`cmp-keys-${tab.id}`}>
                {fieldList.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
            <div className="cmp-opt grow">
              <label className="cmp-label">Fields</label>
              <div className="row">
                <div className="segmented small">
                  {(['all', 'include', 'exclude'] as FieldMode[]).map((m) => (
                    <button key={m} className={setup.fieldMode === m ? 'on' : ''} onClick={() => patch({ fieldMode: m })}>
                      {m === 'all' ? 'All' : m === 'include' ? 'Only' : 'All except'}
                    </button>
                  ))}
                </div>
                {setup.fieldMode !== 'all' && (
                  <input className="input small mono grow" value={setup.fieldPaths} onChange={(e) => patch({ fieldPaths: e.target.value })} placeholder="name, address.city, items" />
                )}
              </div>
            </div>
            <div className="cmp-opt grow">
              <label className="cmp-label" title="Never compared (e.g. timestamps that always differ)">
                Ignore fields
              </label>
              <input className="input small mono" value={setup.ignore} onChange={(e) => patch({ ignore: e.target.value })} placeholder="updatedAt, __v" />
            </div>
            <div className="cmp-opt">
              <label className="cmp-label">
                <label className="check">
                  <input type="checkbox" checked={setup.sampleOn} onChange={(e) => patch({ sampleOn: e.target.checked })} /> Sample
                </label>
              </label>
              <div className="row">
                <input
                  className="input small"
                  type="number"
                  min={1}
                  value={setup.sample}
                  disabled={!setup.sampleOn}
                  onChange={(e) => patch({ sample: Number(e.target.value) })}
                  style={{ width: 90 }}
                />
                <span className="faint cmp-small">first by key</span>
              </div>
            </div>
          </div>
          {problem && connected && <div className="faint cmp-small cmp-problem">{problem}</div>}
        </div>
      )}

      {!summary && !showSetup && (
        <div className="cmp-placeholder">
          <span className="cmp-spinner" /> Starting…
        </div>
      )}

      {!summary && showSetup && (
        <div className="cmp-intro">
          <Icon name="compare" size={34} />
          <h3>Diff & Sync</h3>
          <p className="muted">
            Documents are paired by the key field and classified as only in source, only in target, different (field by field) or identical. Nothing is written until you
            run a sync and confirm it.
          </p>
        </div>
      )}

      {summary && (
        <>
          {running && (
            <div className="cmp-progress">
              <div className={`progress ${job?.total ? '' : 'indeterminate'}`}>
                <div style={{ width: `${pct}%` }} />
              </div>
              <span className="faint cmp-small ellipsis">{job?.message ?? 'Comparing…'}</span>
            </div>
          )}

          <div className="cmp-cards">
            <Card label="Source docs" value={fmt(summary.sourceCount)} kind="count" hint={srcTitle} />
            <Card label="Target docs" value={fmt(summary.targetCount)} kind="count" hint={tgtTitle} />
            {CATEGORIES.map((c) => (
              <Card key={c.id} label={c.label} value={fmt(summary[c.id])} kind={c.id} active={finished ? category === c.id : false} onClick={finished ? () => choose(c.id) : undefined} />
            ))}
            <Card label={summary.state === 'running' ? 'Elapsed' : 'Duration'} value={duration(summary.ms)} kind="time" />
          </div>

          <div className="cmp-notices">
            {summary.state === 'error' && <div className="notice error">Comparison failed: {summary.error}</div>}
            {summary.state === 'cancelled' && <div className="notice">Cancelled — the results below are partial.</div>}
            {summary.sampled && <div className="notice">Sample: the first {fmt(summary.request.sample)} source documents by key and the target documents in the same key range.</div>}
            {summary.truncated.length > 0 && (
              <div className="notice">
                More than {fmt(summary.cap)} documents in {summary.truncated.map((t) => CATEGORIES.find((c) => c.id === t)!.label.toLowerCase()).join(', ')}: lists keep the first {fmt(summary.cap)}{' '}
                (counts are exact) and a sync acts on listed documents only.
              </div>
            )}
            {sync && (
              <div className={`notice cmp-sync-status ${sync.state === 'error' ? 'error' : sync.state === 'done' ? 'ok' : ''}`}>
                {sync.state === 'running' && <span className="cmp-spinner" />}
                <span className="grow">
                  {sync.state === 'running' ? `Syncing… ${sync.message ?? ''}` : sync.state === 'done' ? sync.message : sync.state === 'cancelled' ? 'Sync cancelled' : `Sync failed: ${sync.error}`}
                </span>
                {sync.state === 'running' ? (
                  <button className="btn small" onClick={() => void compareApi.compareCancel(sync.jobId)}>
                    Cancel
                  </button>
                ) : (
                  <button className="btn small primary" onClick={() => void start()} disabled={!!problem}>
                    <Icon name="refresh" size={12} /> Compare again
                  </button>
                )}
              </div>
            )}
            {!sync && summary.stale && <div className="notice">A sync ran after this comparison: results may be outdated. Compare again for fresh results.</div>}
          </div>

          {finished && (
            <div className="cmp-results">
              <div className="cmp-list-col">
                <div className="cmp-tabs">
                  {CATEGORIES.map((c) => (
                    <button key={c.id} className={`cmp-tab k-${c.id} ${category === c.id ? 'on' : ''}`} onClick={() => choose(c.id)}>
                      {c.short}
                      <span className="cmp-tab-count">{fmt(summary[c.id])}</span>
                    </button>
                  ))}
                </div>
                <div className="cmp-list" ref={listRef} tabIndex={0} onKeyDown={onListKey}>
                  {entries?.list.map((e, i) => (
                    <div key={`${page}-${i}`} className={`cmp-row k-${category} ${i === selected ? 'sel' : ''}`} onMouseDown={() => setSelected(i)}>
                      <span className="cmp-row-mark" />
                      <span className="mono ellipsis grow cmp-row-key">{shellText(e.key)}</span>
                      {e.diffs && (
                        <span className="cmp-row-diffs ellipsis" title={e.diffs.map((d) => d.path).join(', ')}>
                          {e.diffs
                            .slice(0, 3)
                            .map((d) => d.path)
                            .join(', ')}
                          {e.diffs.length > 3 || e.more ? '…' : ''}
                        </span>
                      )}
                      {e.diffs && <span className="badge">{e.diffs.length + (e.more ?? 0)}</span>}
                    </div>
                  ))}
                  {entries && !entries.list.length && <div className="cmp-list-empty faint">{count ? 'No documents listed' : 'No documents in this category'}</div>}
                </div>
                {stored > 0 && (
                  <div className="cmp-pager">
                    <button className="btn ghost icon small" disabled={page === 0} onClick={() => setPage((p) => p - 1)} title="Previous page">
                      <Icon name="chevronLeft" size={13} />
                    </button>
                    <span className="faint cmp-small grow">
                      {fmt(page * PAGE + 1)}–{fmt(Math.min(stored, (page + 1) * PAGE))} of {fmt(count)}
                      {stored < count ? ` (first ${fmt(stored)} listed)` : ''}
                    </span>
                    <button className="btn ghost icon small" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} title="Next page">
                      <Icon name="chevronRight" size={13} />
                    </button>
                  </div>
                )}
              </div>
              <div className="cmp-detail-col">
                {entry && jobId ? (
                  <DiffPanel key={`${jobId}-${category}-${page}-${selected}`} jobId={jobId} entry={entry} category={category} sourceTitle={srcTitle} targetTitle={tgtTitle} />
                ) : (
                  <div className="cmp-placeholder faint">{entries ? 'Select a document' : 'Loading…'}</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
