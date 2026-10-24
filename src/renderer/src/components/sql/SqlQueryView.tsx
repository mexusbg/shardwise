import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { EditorView } from '@codemirror/view'
import { generateCode } from '@shared/codegen'
import type { CodeQuery } from '@shared/codegen'
import { prefDocText } from '../../lib/docText'
import { SqlError, sqlPosition, sqlStatementAt, sqlToMongo } from '@shared/sqlToMongo'
import type { SqlTranslation } from '@shared/sqlToMongo'
import { sqlIdent } from '@shared/mongoToSql'
import type { CollectionInfo, Doc } from '@shared/api'
import { api } from '../../lib/api'
import { useCommandHandlers, useShortcut, withShortcuts } from '../../lib/commands'
import { formatQuery } from '../../lib/queryText'
import { runQuery } from '../../state/queryActions'
import { connName, dbKey, emptyVqb, errorText, openAggregationTab, openCollectionTab, patchTab, patchToolTab, toast, useStore } from '../../state/store'
import type { QueryTab, ToolTab, ViewMode } from '../../state/store'
import { CodeView } from '../codegen/CodeView'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { JsonView } from '../views/JsonView'
import { TableView } from '../views/TableView'
import { TreeView } from '../views/TreeView'
import { SqlEditor } from './SqlEditor'
import type { SqlCompletionData } from './SqlEditor'
import './sql.css'

/** Rows fetched when the SQL has no (smaller) LIMIT. */
const ROW_CAP = 1000
const LS_SPLIT = 'shardwise.sql.split'
const LS_PANEL = 'shardwise.sql.panel'

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable
  }
}

const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

type Translated = { ok: true; t: SqlTranslation; text: string; offset: number } | { ok: false; error: RunError; text: string }

interface RunError {
  message: string
  /** Absolute offsets in the editor text. */
  from?: number
  to?: number
  line?: number
  col?: number
}

interface RunResult {
  docs: Doc[]
  ms: number
  truncated: boolean
  t: SqlTranslation
  db: string
}

function translateAt(sql: string, cursor: number, selection: { from: number; to: number } | null): Translated {
  const { text, offset } = selection ? { text: sql.slice(selection.from, selection.to), offset: selection.from } : sqlStatementAt(sql, cursor)
  try {
    return { ok: true, t: sqlToMongo(text), text, offset }
  } catch (e) {
    if (e instanceof SqlError) {
      const from = offset + e.pos
      const { line, col } = sqlPosition(sql, from)
      return { ok: false, text, error: { message: e.message, from, to: offset + e.end, line, col } }
    }
    return { ok: false, text, error: { message: errorText(e) } }
  }
}

const codeQuery = (t: SqlTranslation, db: string): CodeQuery =>
  t.kind === 'find'
    ? { kind: 'find', db, coll: t.coll, filter: t.filter, projection: t.projection, sort: t.sort, skip: t.skip, limit: t.limit }
    : { kind: 'aggregate', db, coll: t.coll, pipeline: t.pipeline }

/** A find query as the equivalent pipeline (for the Pipeline Editor). */
function asPipeline(t: SqlTranslation): Doc[] {
  if (t.kind === 'aggregate') return t.pipeline
  const p: Doc[] = []
  if (Object.keys(t.filter).length) p.push({ $match: t.filter })
  if (t.sort) p.push({ $sort: t.sort })
  if (t.skip) p.push({ $skip: t.skip })
  if (t.limit) p.push({ $limit: t.limit })
  if (t.projection) p.push({ $project: t.projection })
  return p
}

/** One stage per line (wrapped only when long). */
const pipelineText = (p: Doc[]): string => (p.length ? `[\n${p.map((s) => `  ${formatQuery(s).replace(/\n/g, '\n  ')}`).join(',\n')}\n]` : '[]')

/** Read-only stand-in so the collection result views can render SQL results. */
function resultTab(id: string, connId: string, db: string, coll: string, docs: Doc[], view: ViewMode): QueryTab {
  return {
    kind: 'query',
    id: `${id}:sql`,
    connId,
    db,
    coll,
    isView: true,
    queryText: '',
    projectionText: '',
    sortText: '',
    skipText: '',
    limitText: '',
    collationText: '',
    pageSize: Math.max(1, docs.length),
    page: 0,
    docs,
    hasMore: false,
    loading: false,
    view,
    tablePath: [],
    hiddenColumns: [],
    readOnly: true,
    vqbOpen: false,
    vqb: emptyVqb(),
    selection: [],
    rev: 0
  }
}

/** Field paths of the result documents, two levels deep, for autocomplete. */
function fieldNames(docs: Doc[]): string[] {
  const out = new Set<string>()
  const add = (d: unknown, prefix: string, depth: number): void => {
    if (!d || typeof d !== 'object' || Array.isArray(d) || (d as { _bsontype?: string })._bsontype || d instanceof Date) return
    for (const [k, v] of Object.entries(d)) {
      const p = prefix ? `${prefix}.${k}` : k
      out.add(p)
      if (depth < 1) add(v, p, depth + 1)
    }
  }
  for (const d of docs.slice(0, 200)) add(d, '', 0)
  return [...out]
}

const initialSql = (tab: ToolTab): string => {
  const init = tab.init as { sql?: string } | undefined
  if (typeof init?.sql === 'string') return init.sql
  if (!tab.coll) return ''
  const name = tab.coll.split('.').every((s) => sqlIdent(s) === s) ? tab.coll : sqlIdent(tab.coll)
  return `SELECT *\nFROM ${name}\nLIMIT 50`
}

const VIEWS: [ViewMode, string, string][] = [
  ['table', 'Table', 'table'],
  ['tree', 'Tree', 'tree'],
  ['json', 'JSON', 'json']
]

type Panel = 'query' | 'code'

export function SqlQueryView({ tab }: { tab: ToolTab }): ReactElement {
  const live = useStore((s) => s.live[tab.connId])
  const isActive = useStore((s) => s.activeTab === tab.id)
  const storeColls = useStore((s) => s.collections[dbKey(tab.connId, tab.db)])
  const [fetched, setFetched] = useState<Record<string, CollectionInfo[]>>({})
  const [sql, setSql] = useState(() => initialSql(tab))
  const [cursor, setCursor] = useState<{ pos: number; sel: { from: number; to: number } | null }>({ pos: sql.length, sel: null })
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<RunError | null>(null)
  const [running, setRunning] = useState(false)
  const [view, setView] = useState<ViewMode>('table')
  const [panel, setPanel] = useState<Panel | null>(() => {
    const v = lsGet(LS_PANEL)
    return v === 'none' ? null : v === 'code' ? 'code' : 'query'
  })
  const [split, setSplit] = useState(() => Math.min(0.8, Math.max(0.15, Number(lsGet(LS_SPLIT)) || 0.36)))
  const [dragging, setDragging] = useState(false)
  const editor = useRef<EditorView | null>(null)
  const splitBox = useRef<HTMLDivElement>(null)

  const collections = storeColls ?? fetched[tab.db]
  const databases = (live?.databases ?? []).map((d) => d.name)
  if (!databases.includes(tab.db)) databases.unshift(tab.db)

  useEffect(() => {
    if (storeColls || fetched[tab.db] || !live) return
    api
      .listCollections(tab.connId, tab.db)
      .then((list) => setFetched((f) => ({ ...f, [tab.db]: list })))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connId, tab.db, !!storeColls, !!live])

  const fields = useMemo(() => fieldNames(result?.docs ?? []), [result])
  const dataRef = useRef<SqlCompletionData>({ collections: [], fields: [] })
  dataRef.current = { collections: (collections ?? []).map((c) => c.name), fields }

  const current = useMemo(() => translateAt(sql, cursor.pos, cursor.sel), [sql, cursor])

  const run = useCallback(async (): Promise<void> => {
    if (running) return
    const tr = translateAt(sql, cursor.pos, cursor.sel)
    if (!tr.ok) {
      if (!tr.text.trim()) return
      setError(tr.error)
      return
    }
    if (!useStore.getState().live[tab.connId]) {
      toast('The connection is closed', 'error')
      return
    }
    const t = tr.t
    const db = tab.db
    setRunning(true)
    setError(null)
    try {
      let docs: Doc[]
      let ms: number
      if (t.kind === 'find') {
        const limit = t.limit && t.limit <= ROW_CAP ? t.limit : ROW_CAP + 1
        const r = await api.find(tab.connId, db, t.coll, { filter: t.filter, projection: t.projection, sort: t.sort, skip: t.skip, limit })
        docs = r.docs
        ms = r.ms
      } else {
        const last = t.pipeline[t.pipeline.length - 1]
        const limited = typeof last?.$limit === 'number' && last.$limit <= ROW_CAP
        const r = await api.aggregate(tab.connId, db, t.coll, limited ? t.pipeline : [...t.pipeline, { $limit: ROW_CAP + 1 }], { allowDiskUse: true })
        docs = r.docs
        ms = r.ms
      }
      const truncated = docs.length > ROW_CAP
      setResult({ docs: truncated ? docs.slice(0, ROW_CAP) : docs, ms, truncated, t, db })
    } catch (e) {
      setError({ message: errorText(e) })
    } finally {
      setRunning(false)
    }
  }, [running, sql, cursor, tab.connId, tab.db])

  const latestRun = useRef(run)
  latestRun.current = run
  // Settings → Shortcuts → SQL query (the editor handles the keys itself while it has focus).
  useCommandHandlers(isActive, { 'sql.run': () => void latestRun.current() })
  const runKey = useShortcut('sql.run')

  const choosePanel = (p: Panel | null): void => {
    setPanel(p)
    lsSet(LS_PANEL, p ?? 'none')
  }

  const t = current.ok ? current.t : null

  const openAsQuery = async (): Promise<void> => {
    if (t?.kind !== 'find') return
    const isView = (collections ?? []).find((c) => c.name === t.coll)?.type === 'view'
    const id = openCollectionTab(tab.connId, tab.db, t.coll, isView)
    // `loading` keeps the new tab from applying its default query on mount.
    patchTab(id, {
      loading: true,
      queryText: Object.keys(t.filter).length ? formatQuery(t.filter) : '',
      projectionText: t.projection ? formatQuery(t.projection) : '',
      sortText: t.sort ? formatQuery(t.sort) : '',
      skipText: t.skip ? String(t.skip) : '',
      limitText: t.limit ? String(t.limit) : ''
    })
    await runQuery(id)
    patchTab(id, (x) => (x.loading && !x.docs ? { loading: false } : {}))
  }

  const openInAggregation = (): void => {
    if (!t) return
    openAggregationTab(tab.connId, tab.db, t.coll, { pipeline: pipelineText(asPipeline(t)) })
  }

  const copyQuery = async (): Promise<void> => {
    if (!t) return
    await api.copyText(generateCode(codeQuery(t, tab.db), 'mongosh'))
    toast('MongoDB query copied', 'success')
  }

  const jumpToError = (): void => {
    const v = editor.current
    if (!v || error?.from === undefined) return
    v.dispatch({ selection: { anchor: Math.min(error.from, v.state.doc.length) }, scrollIntoView: true })
    v.focus()
  }

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const box = splitBox.current?.getBoundingClientRect()
    if (!box) return
    setDragging(true)
    let last = split
    const move = (ev: MouseEvent): void => {
      last = Math.min(0.8, Math.max(0.12, (ev.clientY - box.top) / box.height))
      setSplit(last)
    }
    const up = (): void => {
      setDragging(false)
      lsSet(LS_SPLIT, String(last))
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const fake = useMemo(() => (result ? resultTab(tab.id, tab.connId, result.db, result.t.coll, result.docs, view) : null), [result, view, tab.id, tab.connId])
  const editorError = useMemo(() => (error?.from !== undefined ? { from: error.from, to: error.to ?? error.from } : null), [error])

  return (
    <div className="sql">
      <div className="crumbs">
        <Icon name="server" size={13} style={{ color: live?.color ?? 'var(--leaf)' }} />
        <span>{connName(tab.connId)}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name="database" size={13} />
        <span>{tab.db}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name="sql" size={13} />
        <b>SQL Query</b>
        {t && <span className="sql-target faint">→ {t.coll}</span>}
      </div>

      <div className="sql-toolbar">
        <button className="btn primary" onClick={() => void run()} disabled={!live || running} title={withShortcuts('Run the statement at the cursor, or the selection', 'sql.run')}>
          <Icon name="play" size={12} /> Run
        </button>
        <label className="sql-field" title="Database">
          <Icon name="database" size={13} />
          <select className="select small" value={tab.db} onChange={(e) => patchToolTab(tab.id, { db: e.target.value })} disabled={running}>
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <span className="sql-sep" />
        <button className={`btn small ${panel ? 'active' : ''}`} onClick={() => choosePanel(panel ? null : 'query')} title="Show the translated MongoDB query next to the results">
          <Icon name="code" size={13} /> Show MongoDB query
        </button>
        <span className="sql-sep" />
        <button className="btn ghost small" disabled={t?.kind !== 'find'} onClick={() => void openAsQuery()} title={t?.kind === 'aggregate' ? 'This SQL needs an aggregation pipeline' : 'Open the find query in a new collection tab'}>
          <Icon name="collection" size={13} /> Open as query tab
        </button>
        <button className="btn ghost small" disabled={!t} onClick={openInAggregation} title="Open the pipeline in the Pipeline Editor">
          <Icon name="aggregate" size={13} /> Open in Pipeline Editor
        </button>
        <button className="btn ghost small" disabled={!t} onClick={() => void copyQuery()} title="Copy the MongoDB query as mongo shell code">
          <Icon name="copy" size={13} /> Copy query
        </button>
        <span className="spacer" />
        {t && <span className={`sql-kind ${t.kind}`}>{t.kind === 'find' ? 'find()' : 'aggregate()'}</span>}
      </div>

      <div className={`sql-split ${dragging ? 'dragging' : ''}`} ref={splitBox}>
        <div className="sql-editor-box" style={{ height: `${split * 100}%` }}>
          <SqlEditor
            value={sql}
            onChange={(v) => {
              setSql(v)
              if (error?.from !== undefined) setError(null)
            }}
            onRun={() => void latestRun.current()}
            onCursor={(pos, sel) => setCursor((c) => (c.pos === pos && c.sel?.from === sel?.from && c.sel?.to === sel?.to ? c : { pos, sel }))}
            error={editorError}
            completionData={() => dataRef.current}
            onView={(v) => (editor.current = v)}
          />
        </div>
        {error && (
          <div className="sql-error" role="alert">
            <Icon name="warn" size={14} />
            {error.line !== undefined && (
              <button className="sql-error-pos" onClick={jumpToError} title="Show in the editor">
                Line {error.line}, col {error.col}
              </button>
            )}
            <span className="selectable sql-error-msg">{error.message}</span>
            <button className="btn icon small ghost" onClick={() => setError(null)} title="Dismiss">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <div className="sql-resizer" onMouseDown={startDrag} title="Drag to resize" />

        <div className="sql-bottom">
          <div className="sql-results">
            <div className="result-toolbar sql-results-bar">
              <div className="segmented small">
                {VIEWS.map(([v, label, icon]) => (
                  <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={`${label} View`}>
                    <Icon name={icon} size={13} /> {label}
                  </button>
                ))}
              </div>
              {result && (
                <span className="sql-count">
                  {result.docs.length.toLocaleString()} document{result.docs.length === 1 ? '' : 's'}
                  {result.truncated && <span className="sql-trunc"> · first {ROW_CAP.toLocaleString()} (add LIMIT to fetch a different page)</span>}
                  <span className="faint"> · {fmtMs(result.ms)}</span>
                </span>
              )}
              <span className="spacer" />
              {result && result.docs.length > 0 && (
                <button
                  className="btn ghost small"
                  title="Copy the results (JSON style from Settings → Browsing data)"
                  onClick={() => void api.copyText(prefDocText(result.docs)).then(() => toast('Results copied', 'success'))}
                >
                  <Icon name="copy" size={13} /> Copy
                </button>
              )}
            </div>
            <div className="result-area">
              {running && <div className="loading-bar" />}
              {!fake ? (
                <div className="result-empty sql-hint">
                  <div>
                    Write a <b>SELECT</b> and press {runKey ? <span className="kbd">{runKey}</span> : 'Run'} to run it as a MongoDB query.
                  </div>
                  <div className="faint">WHERE, ORDER BY, LIMIT / OFFSET, GROUP BY with COUNT / SUM / AVG / MIN / MAX, HAVING, DISTINCT and INNER / LEFT JOIN are supported.</div>
                </div>
              ) : result!.docs.length === 0 ? (
                <div className="result-empty">No documents</div>
              ) : view === 'tree' ? (
                <TreeView tab={fake} />
              ) : view === 'json' ? (
                <JsonView tab={fake} />
              ) : (
                <TableView tab={fake} />
              )}
            </div>
          </div>

          {panel && (
            <div className="sql-panel">
              <div className="sql-panel-bar">
                <div className="sql-tabs">
                  <button className={panel === 'query' ? 'on' : ''} onClick={() => choosePanel('query')}>
                    MongoDB query
                  </button>
                  <button className={panel === 'code' ? 'on' : ''} onClick={() => choosePanel('code')}>
                    Code
                  </button>
                </div>
                <span className="spacer" />
                <button className="btn icon small ghost" onClick={() => choosePanel(null)} title="Hide">
                  <Icon name="close" size={12} />
                </button>
              </div>
              {!current.ok ? (
                <div className="sql-panel-empty">
                  {current.text.trim() ? (
                    <>
                      <Icon name="warn" size={14} />
                      <span className="selectable">{current.error.message}</span>
                    </>
                  ) : (
                    <span className="faint">The MongoDB translation of the statement at the cursor appears here.</span>
                  )}
                </div>
              ) : panel === 'code' ? (
                <CodeView build={() => codeQuery(current.t, tab.db)} deps={[current.t, tab.db]} />
              ) : (
                <QueryPanel t={current.t} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Block({ label, text, extra }: { label: string; text: string; extra?: string }): ReactElement {
  return (
    <div className="sql-block">
      <div className="sql-block-label">
        {label}
        {extra && <span className="faint"> · {extra}</span>}
      </div>
      <CodeEditor value={text} readOnly className="sql-block-code" />
    </div>
  )
}

function QueryPanel({ t }: { t: SqlTranslation }): ReactElement {
  return (
    <div className="sql-query">
      <div className="sql-query-head">
        <span className={`sql-kind ${t.kind}`}>{t.kind}</span>
        <span className="faint">on</span>
        <b className="selectable">{t.coll}</b>
      </div>
      {t.kind === 'find' ? (
        <>
          <Block label="Filter" text={formatQuery(t.filter)} />
          {t.projection && <Block label="Projection" text={formatQuery(t.projection)} />}
          {t.sort && <Block label="Sort" text={formatQuery(t.sort)} />}
          {(t.skip > 0 || t.limit > 0) && (
            <div className="sql-paging">
              {t.skip > 0 && (
                <span>
                  <span className="faint">Skip</span> <b>{t.skip}</b>
                </span>
              )}
              {t.limit > 0 && (
                <span>
                  <span className="faint">Limit</span> <b>{t.limit}</b>
                </span>
              )}
            </div>
          )}
        </>
      ) : (
        <Block label="Pipeline" extra={`${t.pipeline.length} stage${t.pipeline.length === 1 ? '' : 's'}`} text={pipelineText(t.pipeline)} />
      )}
    </div>
  )
}
