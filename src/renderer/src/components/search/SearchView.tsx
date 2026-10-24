import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { shellText } from '@shared/bsonValue'
import type { CollectionInfo } from '@shared/api'
import type { SearchCollectionResult, SearchEvent, SearchHit, SearchRequest, SearchType } from '@shared/searchApi'
import { api } from '../../lib/api'
import { formatQuery } from '../../lib/queryText'
import { runQuery } from '../../state/queryActions'
import { dbKey, errorText, openCollectionTab, patchTab, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { applyFind } from '../history/historyActions'
import { showMenu } from '../ContextMenu'
import { Icon } from '../Icon'
import { onSearchEvent, searchApi } from './searchClient'
import './search.css'

const fmt = (n: number): string => n.toLocaleString()
const plural = (n: number, w: string): string => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`

const TYPES: { id: SearchType; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Text; numbers and ObjectIds are matched as such too; /pattern/i is a regex' },
  { id: 'string', label: 'String', hint: 'String values only' },
  { id: 'number', label: 'Number', hint: 'Numeric values (any numeric type)' },
  { id: 'objectId', label: 'ObjectId', hint: '24 hex characters or ObjectId("…")' },
  { id: 'regex', label: 'Regex', hint: 'Regular expression on string values' }
]

interface Form {
  text: string
  type: SearchType
  match: 'contains' | 'exact'
  caseSensitive: boolean
  field: string
  max: number
  deep: boolean
  scope: 'all' | 'selected'
  selected: string[]
}

interface Run {
  id: string | null
  req: SearchRequest
  state: 'running' | 'done' | 'cancelled' | 'error'
  error?: string
  done: number
  total: number
  current: string[]
  results: SearchCollectionResult[]
  ms?: number
  started: number
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Regex marking the matched part of string values, mirroring the main-process probes. */
function highlightRegex(req: SearchRequest): RegExp | null {
  const t = req.text.trim()
  const lit = /^\/(.+)\/([a-z]*)$/s.exec(t)
  try {
    if (req.type === 'regex' || (req.type === 'auto' && lit)) {
      const src = lit ? lit[1] : req.text
      let flags = (lit ? lit[2] : '').replace(/[^imsu]/g, '')
      if (req.type === 'regex' && !req.caseSensitive && !flags.includes('i')) flags += 'i'
      return new RegExp(src, `${flags}g`)
    }
    if (req.type === 'number' || req.type === 'objectId') return null
    if (req.match === 'exact') return new RegExp(`^${escapeRegex(req.text)}$`, req.caseSensitive ? 'g' : 'gi')
    return new RegExp(escapeRegex(req.text), req.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}

function Marked({ text, re }: { text: string; re: RegExp | null }): ReactElement {
  if (!re) return <>{text}</>
  const parts: ReactNode[] = []
  let last = 0
  re.lastIndex = 0
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = re.exec(text)) && guard++ < 50) {
    if (!m[0]) {
      re.lastIndex++
      continue
    }
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<mark key={m.index}>{m[0]}</mark>)
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** Path without array positions: `items.2.sku` → `items.sku`. */
const logicalPath = (p: string): string =>
  p
    .split('.')
    .filter((s) => !/^\d+$/.test(s))
    .join('.')

function HitRow({ hit, re, onOpen }: { hit: SearchHit; re: RegExp | null; onOpen: () => void }): ReactElement {
  const shown = hit.matches.slice(0, 4)
  return (
    <div className="fs-hit" onClick={onOpen} onContextMenu={(e) => showMenu(e, [{ label: 'Open Document in Query Tab', icon: 'play', onClick: onOpen }, { label: 'Copy _id', icon: 'copy', onClick: () => void api.copyText(shellText(hit._id)) }])} title="Open in a query tab">
      <span className="fs-hit-id mono ellipsis">{shellText(hit._id)}</span>
      <div className="fs-hit-matches">
        {shown.map((m, i) => (
          <span key={i} className="fs-match">
            <span className="fs-match-path mono">{m.path}</span>
            {m.value && (
              <span className={`fs-match-value mono t-${m.type === 'objectId' ? 'objectId' : m.type === 'number' ? 'double' : 'string'}`}>
                {m.type === 'string' ? (
                  <>
                    “<Marked text={m.value} re={re} />”
                  </>
                ) : (
                  <mark>{m.value}</mark>
                )}
              </span>
            )}
          </span>
        ))}
        {hit.matches.length > shown.length && <span className="faint fs-more">+{hit.matches.length - shown.length} more</span>}
      </div>
      <Icon name="chevronRight" size={13} className="fs-hit-go" />
    </div>
  )
}

function Group({ r, re, max, onOpen, onOpenAll }: { r: SearchCollectionResult; re: RegExp | null; max: number; onOpen: (h: SearchHit) => void; onOpenAll: () => void }): ReactElement {
  const [open, setOpen] = useState(true)
  const paths = useMemo(() => {
    const counts = new Map<string, number>()
    for (const h of r.hits) for (const p of new Set(h.matches.map((m) => logicalPath(m.path)).filter(Boolean))) counts.set(p, (counts.get(p) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [r.hits])
  return (
    <div className={`fs-group ${open ? 'open' : ''}`}>
      <div className="fs-group-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} className="faint" />
        <Icon name="collection" size={14} className="fs-group-icon" />
        <b className="mono ellipsis fs-group-name">{r.coll}</b>
        {r.hits.length > 0 && (
          <span className="fs-count" title={r.truncated ? `Stopped after ${max} matches` : undefined}>
            {fmt(r.hits.length)}
            {r.truncated ? '+' : ''}
          </span>
        )}
        <div className="fs-paths">
          {paths.slice(0, 5).map(([p, n]) => (
            <span key={p} className="fs-path mono" title={`${n} match${n === 1 ? '' : 'es'} in ${p}`}>
              {p}
            </span>
          ))}
          {paths.length > 5 && <span className="faint fs-more">+{paths.length - 5}</span>}
        </div>
        <span className="spacer" />
        <span className="faint fs-small">{duration(r.ms)}</span>
        {r.hits.length > 1 && (
          <button
            className="btn ghost small"
            title="Open all matches of this collection in one query tab"
            onClick={(e) => {
              e.stopPropagation()
              onOpenAll()
            }}
          >
            <Icon name="play" size={11} /> Open all
          </button>
        )}
      </div>
      {open && (
        <div className="fs-group-body">
          {r.error && <div className="error-text fs-small fs-group-error">{r.error}</div>}
          {r.hits.map((h, i) => (
            <HitRow key={i} hit={h} re={re} onOpen={() => onOpen(h)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ScopePicker({ colls, selected, onChange }: { colls: CollectionInfo[]; selected: string[]; onChange: (v: string[]) => void }): ReactElement {
  const [filter, setFilter] = useState('')
  const set = new Set(selected)
  const shown = colls.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="fs-scope">
      <div className="fs-scope-bar">
        <input className="input small grow" placeholder="Filter collections" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn ghost small" onClick={() => onChange([...new Set([...selected, ...shown.map((c) => c.name)])])}>
          All
        </button>
        <button className="btn ghost small" onClick={() => onChange(selected.filter((s) => !shown.some((c) => c.name === s)))}>
          None
        </button>
      </div>
      <div className="fs-scope-list">
        {shown.map((c) => (
          <label key={c.name} className={`fs-scope-item ${set.has(c.name) ? 'on' : ''}`}>
            <input type="checkbox" checked={set.has(c.name)} onChange={(e) => onChange(e.target.checked ? [...selected, c.name] : selected.filter((s) => s !== c.name))} />
            <Icon name={c.type === 'view' ? 'view' : 'collection'} size={12} />
            <span className="mono ellipsis">{c.name}</span>
          </label>
        ))}
        {!shown.length && <span className="faint fs-small">No collections</span>}
      </div>
    </div>
  )
}

/** Find in Database: search a value across the collections of one database. */
export function SearchView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const connected = useStore((s) => !!s.live[connId])
  const [form, setForm] = useState<Form>({ text: '', type: 'auto', match: 'contains', caseSensitive: false, field: '', max: 50, deep: false, scope: 'all', selected: [] })
  const patch = (p: Partial<Form>): void => setForm((f) => ({ ...f, ...p }))
  const [colls, setColls] = useState<CollectionInfo[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const [now, setNow] = useState(Date.now())
  const idRef = useRef<string | null>(null)
  const buffer = useRef<SearchEvent[]>([])
  const starting = useRef(false)

  useEffect(() => {
    if (!connected) return
    api
      .listCollections(connId, db)
      .then((list) => setColls(list.filter((c) => !c.name.startsWith('system.'))))
      .catch(() => {})
  }, [connId, db, connected])

  const apply = (e: SearchEvent): void => {
    setRun((r) => {
      if (!r || r.id !== e.searchId) return r
      if (e.kind === 'progress') return { ...r, done: e.done, total: e.total, current: e.current }
      if (e.kind === 'collection') return { ...r, results: [...r.results, e.result] }
      return { ...r, state: e.state, error: e.error, ms: e.ms, current: [] }
    })
  }

  useEffect(
    () =>
      onSearchEvent((e) => {
        if (idRef.current === e.searchId) apply(e)
        else if (starting.current) buffer.current.push(e)
      }),
    []
  )

  // Stop a running search when the tab closes.
  useEffect(() => () => void (idRef.current && searchApi.searchCancel(idRef.current).catch(() => {})), [])

  const running = run?.state === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [running])

  const textOnly = form.type === 'number' || form.type === 'objectId' || form.type === 'regex'
  const scopeEmpty = form.scope === 'selected' && !form.selected.length

  const start = async (): Promise<void> => {
    if (!form.text.trim() || scopeEmpty) return
    if (running && run?.id) await searchApi.searchCancel(run.id).catch(() => {})
    const req: SearchRequest = {
      connId,
      db,
      text: form.text,
      type: form.type,
      match: form.match,
      caseSensitive: form.caseSensitive,
      collections: form.scope === 'all' ? null : form.selected,
      field: form.field.trim() || undefined,
      maxPerCollection: Math.max(1, form.max || 50),
      deep: form.deep
    }
    idRef.current = null
    buffer.current = []
    starting.current = true
    setRun({ id: null, req, state: 'running', done: 0, total: req.collections?.length ?? 0, current: [], results: [], started: Date.now() })
    try {
      const id = await searchApi.searchStart(req)
      idRef.current = id
      starting.current = false
      setRun((r) => (r ? { ...r, id } : r))
      const pending = buffer.current.filter((e) => e.searchId === id)
      buffer.current = []
      pending.forEach(apply)
    } catch (e) {
      starting.current = false
      setRun((r) => (r ? { ...r, state: 'error', error: errorText(e) } : r))
    }
  }

  const cancel = (): void => {
    if (run?.id) void searchApi.searchCancel(run.id).catch(() => {})
  }

  const openQuery = async (coll: string, query: string): Promise<void> => {
    if (!useStore.getState().live[connId]) {
      toast('The connection is closed', 'error')
      return
    }
    const isView = useStore.getState().collections[dbKey(connId, db)]?.find((c) => c.name === coll)?.type === 'view'
    const id = openCollectionTab(connId, db, coll, isView)
    // `loading` keeps the new tab from applying its default query on mount.
    patchTab(id, { loading: true })
    applyFind(id, { kind: 'find', query, projection: '', sort: '', skip: '', limit: '' }, false)
    await runQuery(id)
    patchTab(id, (t) => (t.loading && !t.docs ? { loading: false } : {}))
  }

  const re = useMemo(() => (run ? highlightRegex(run.req) : null), [run?.req])
  const results = run?.results ?? []
  const totalHits = results.reduce((n, r) => n + r.hits.length, 0)
  const withHits = results.filter((r) => r.hits.length).length
  const errors = results.filter((r) => r.error).length
  const pct = run && run.total ? (run.done / run.total) * 100 : 0
  const elapsed = run ? (run.ms ?? now - run.started) : 0

  return (
    <div className="fs">
      <div className="fs-head">
        <Icon name="search" className="fs-head-icon" />
        <span className="fs-title">Find in Database</span>
        <span className="fs-db mono faint ellipsis">{db}</span>
      </div>

      <div className="fs-form">
        <div className="fs-query">
          <div className="fs-input">
            <Icon name="search" size={15} />
            <input
              className="input"
              value={form.text}
              autoFocus
              placeholder={form.type === 'number' ? 'e.g. 42' : form.type === 'objectId' ? 'e.g. 650a1f…' : form.type === 'regex' ? 'e.g. ^ord-\\d+' : 'Value to find in any field'}
              onChange={(e) => patch({ text: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void start()}
              spellCheck={false}
            />
          </div>
          <div className="segmented fs-types">
            {TYPES.map((t) => (
              <button key={t.id} className={form.type === t.id ? 'on' : ''} title={t.hint} onClick={() => patch({ type: t.id })}>
                {t.label}
              </button>
            ))}
          </div>
          {running ? (
            <button className="btn fs-go" onClick={cancel}>
              <Icon name="close" size={13} /> Cancel
            </button>
          ) : (
            <button className="btn primary fs-go" disabled={!form.text.trim() || scopeEmpty || !connected} onClick={() => void start()}>
              <Icon name="search" size={13} /> Find
            </button>
          )}
        </div>

        <div className="fs-options">
          <div className={`segmented small ${textOnly ? 'fs-disabled' : ''}`} title={textOnly ? 'Applies to text searches' : undefined}>
            <button className={form.match === 'contains' ? 'on' : ''} disabled={textOnly} onClick={() => patch({ match: 'contains' })}>
              Contains
            </button>
            <button className={form.match === 'exact' ? 'on' : ''} disabled={textOnly} onClick={() => patch({ match: 'exact' })}>
              Exact
            </button>
          </div>
          <label className={`check fs-small ${form.type === 'number' || form.type === 'objectId' ? 'fs-disabled' : ''}`}>
            <input type="checkbox" checked={form.caseSensitive} disabled={form.type === 'number' || form.type === 'objectId'} onChange={(e) => patch({ caseSensitive: e.target.checked })} />
            Match case
          </label>
          <span className="fs-opt-sep" />
          <label className="fs-opt">
            <span className="faint fs-small">Field</span>
            <input className="input small mono fs-field" value={form.field} placeholder="any field" onChange={(e) => patch({ field: e.target.value })} title="Restrict to one dot path, e.g. address.city" />
          </label>
          <label className="fs-opt">
            <span className="faint fs-small">Max per collection</span>
            <input className="input small mono fs-max" type="number" min={1} max={10000} value={form.max} onChange={(e) => patch({ max: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
          <label className="check fs-small" title="Scan every document instead of querying the fields found in a 200-document sample. Slower, but finds values in rare fields.">
            <input type="checkbox" checked={form.deep} onChange={(e) => patch({ deep: e.target.checked })} />
            Deep scan
          </label>
          <span className="fs-opt-sep" />
          <div className="segmented small">
            <button className={form.scope === 'all' ? 'on' : ''} onClick={() => patch({ scope: 'all' })}>
              All collections
            </button>
            <button className={form.scope === 'selected' ? 'on' : ''} onClick={() => patch({ scope: 'selected' })}>
              Selected{form.selected.length ? ` (${form.selected.length})` : '…'}
            </button>
          </div>
        </div>
        {form.scope === 'selected' && <ScopePicker colls={colls} selected={form.selected} onChange={(selected) => patch({ selected })} />}
      </div>

      {run && (
        <div className={`fs-status fs-${run.state}`}>
          <div className="fs-status-line">
            {running ? <Icon name="refresh" size={13} className="fs-spin" /> : run.state === 'done' ? <Icon name="check" size={13} className="fs-ok" /> : <Icon name="warn" size={13} className="fs-warn" />}
            <span>
              {running ? (
                <>
                  Searching {run.total ? `${fmt(run.done)} of ${fmt(run.total)} collections` : 'collections'}
                  {run.current.length > 0 && <span className="faint"> · {run.current.join(', ')}</span>}
                </>
              ) : run.state === 'cancelled' ? (
                'Cancelled'
              ) : run.state === 'error' ? (
                <span className="error-text">{run.error}</span>
              ) : (
                <>Searched {plural(run.total, 'collection')}</>
              )}
            </span>
            <span className="spacer" />
            {run.state !== 'error' && (
              <span className="muted fs-small">
                {fmt(totalHits)} match{totalHits === 1 ? '' : 'es'} in {plural(withHits, 'collection')}
                {errors > 0 && <span className="error-text"> · {errors} failed</span>} · {duration(elapsed)}
              </span>
            )}
          </div>
          {running && (
            <div className={`progress fs-progress ${run.total ? '' : 'indeterminate'}`}>
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}

      <div className="fs-results">
        {!run && (
          <div className="fs-empty">
            <Icon name="search" size={34} />
            <div className="muted">Search a value across the collections of {db}.</div>
            <div className="faint fs-small fs-tips">
              Text matches any string field (fields are learned from a sample of each collection; use <b>Deep scan</b> for rare fields). In <b>Auto</b>, <span className="mono">42</span> also
              matches numbers, a 24-hex id also matches ObjectIds and <span className="mono">/^ord-\d+/i</span> is a regex.
            </div>
          </div>
        )}
        {run && !running && run.state !== 'error' && !results.length && (
          <div className="fs-empty">
            <Icon name="search" size={34} />
            <div className="muted">No matches{run.req.field ? ` in ${run.req.field}` : ''}.</div>
            {!run.req.deep && <div className="faint fs-small">Rare fields may be missing from the sample; try Deep scan.</div>}
          </div>
        )}
        {results.map((r) => (
          <Group
            key={r.coll}
            r={r}
            re={re}
            max={run!.req.maxPerCollection}
            onOpen={(h) => void openQuery(r.coll, formatQuery({ _id: h._id }))}
            onOpenAll={() => void openQuery(r.coll, formatQuery({ _id: { $in: r.hits.map((h) => h._id) } }))}
          />
        ))}
      </div>
    </div>
  )
}
