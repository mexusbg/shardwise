import { useEffect, useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import { bsonTypeOf, shellText, TYPE_LABELS } from '@shared/bsonValue'
import type { Doc, PlaygroundLog, PlaygroundResult } from '@shared/api'
import { emptyVqb, patchPlayground } from '../../state/store'
import type { PlaygroundTab, QueryTab, ViewMode } from '../../state/store'
import { shortcutLabel } from '../../lib/commands'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { TableView } from '../views/TableView'
import { TreeView } from '../views/TreeView'
import { JsonView } from '../views/JsonView'

export type ResultPane = 'result' | 'console'

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

function resultDocs(r: PlaygroundResult | undefined): Doc[] | null {
  if (!r?.ok) return null
  if (r.valueKind === 'documents') return r.value as Doc[]
  if (r.valueKind === 'document') return [r.value as Doc]
  return null
}

export function resultSummary(r: PlaygroundResult | undefined): string {
  if (!r) return ''
  if (!r.ok) return r.cancelled ? 'stopped' : 'error'
  const docs = resultDocs(r)
  if (docs) return `${docs.length.toLocaleString()} document${docs.length === 1 ? '' : 's'}`
  if (r.valueKind === 'undefined') return 'no value'
  return TYPE_LABELS[bsonTypeOf(r.value)] ?? 'value'
}

/** Read-only stand-in so the collection result views can render playground documents. */
function resultTab(tab: PlaygroundTab, docs: Doc[], view: ViewMode, rev: number): QueryTab {
  return {
    kind: 'query',
    id: `${tab.id}:result`,
    connId: tab.connId,
    db: tab.db,
    coll: 'result',
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
    rev
  }
}

function ErrorPanel({ r }: { r: PlaygroundResult }): ReactElement {
  return (
    <div className={`pg-error ${r.cancelled ? 'stopped' : ''}`}>
      <div className="pg-error-head">
        <Icon name="warn" size={16} />
        <span className="selectable">{r.error ?? 'Failed'}</span>
      </div>
      {r.stack && <pre className="pg-error-stack selectable">{r.stack}</pre>}
    </div>
  )
}

const VIEWS: [ViewMode, string, string][] = [
  ['table', 'Table', 'table'],
  ['tree', 'Tree', 'tree'],
  ['json', 'JSON', 'json']
]

export function ResultView({ tab }: { tab: PlaygroundTab }): ReactElement {
  const r = tab.result
  const docs = useMemo(() => resultDocs(r), [r])
  const view: ViewMode = tab.view === 'explain' ? 'table' : tab.view
  const fake = useMemo(() => (docs ? resultTab(tab, docs, view, 0) : null), [docs, view, tab.id, tab.connId, tab.db])
  const valueText = useMemo(() => {
    if (!r?.ok || docs || r.valueKind === 'undefined') return null
    return typeof r.value === 'string' ? null : shellText(r.value, 2)
  }, [r, docs])

  if (tab.running && !r) return <div className="result-empty">Running…</div>
  if (!r) {
    return (
      <div className="result-empty pg-hint">
        <div>
          Press {shortcutLabel('playground.run') ? <span className="kbd">{shortcutLabel('playground.run')}</span> : 'Run'} to run the script, or select some lines to run just those.
        </div>
        <div className="faint">The value of the last expression is shown here; console output goes to the Console tab.</div>
      </div>
    )
  }
  if (!r.ok) return <ErrorPanel r={r} />
  if (fake && docs) {
    return (
      <div className="pg-docs">
        <div className="pg-views">
          <div className="segmented small">
            {VIEWS.map(([v, label, icon]) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => patchPlayground(tab.id, { view: v })} title={`${label} View`}>
                <Icon name={icon} size={13} /> {label}
              </button>
            ))}
          </div>
        </div>
        {docs.length === 0 ? (
          <div className="result-empty">No documents</div>
        ) : view === 'tree' ? (
          <TreeView tab={fake} />
        ) : view === 'json' ? (
          <JsonView tab={fake} />
        ) : (
          <TableView tab={fake} />
        )}
      </div>
    )
  }
  if (r.valueKind === 'undefined') {
    return (
      <div className="result-empty pg-hint">
        <div>
          <Icon name="check" size={14} style={{ verticalAlign: -2, color: 'var(--ok)' }} /> Finished in {fmtMs(r.ms)} — no value returned.
        </div>
        {r.logs.length > 0 && <div className="faint">See the Console tab for {r.logs.length.toLocaleString()} line{r.logs.length === 1 ? '' : 's'} of output.</div>}
      </div>
    )
  }
  if (valueText === null) return <pre className="pg-value-text selectable">{String(r.value)}</pre>
  return <CodeEditor value={valueText} readOnly full className="cm-json-view" />
}

function logTime(ms: number): string {
  return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(2)}s`
}

export function ConsoleView({ logs, running }: { logs: PlaygroundLog[]; running: boolean }): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [logs])
  if (!logs.length) return <div className="result-empty">{running ? 'Waiting for output…' : 'No console output. Use console.log(), print() or printjson().'}</div>
  return (
    <div
      className="pg-console selectable"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {logs.map((l, i) => (
        <div key={i} className={`pg-log ${l.level}`}>
          <span className="pg-log-time">{logTime(l.at)}</span>
          <span className="pg-log-level">{l.level}</span>
          <pre>{l.text}</pre>
        </div>
      ))}
    </div>
  )
}
