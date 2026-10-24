import { useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { shellText } from '@shared/bsonValue'
import { parseExplain } from '@shared/explain'
import type { PlanNode } from '@shared/explain'
import type { Doc } from '@shared/api'
import { emptyVqb } from '../../state/store'
import type { QueryTab, ViewMode } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { TableView } from '../views/TableView'
import { TreeView } from '../views/TreeView'
import { JsonView } from '../views/JsonView'
import '../profiler/profiler.css'

/** Read-only stand-in so the collection result views can render aggregation documents. */
export function docsTab(id: string, connId: string, db: string, docs: Doc[], view: ViewMode): QueryTab {
  return {
    kind: 'query',
    id,
    connId,
    db,
    coll: 'aggregation',
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

export function DocsView({ tab }: { tab: QueryTab }): ReactElement {
  if (!tab.docs?.length) return <div className="result-empty">No documents</div>
  if (tab.view === 'tree') return <TreeView tab={tab} />
  if (tab.view === 'json') return <JsonView tab={tab} />
  return <TableView tab={tab} />
}

export const VIEWS: [ViewMode, string, string][] = [
  ['table', 'Table', 'table'],
  ['tree', 'Tree', 'tree'],
  ['json', 'JSON', 'json']
]

export function ViewSwitch({ value, onChange, views = VIEWS }: { value: ViewMode; onChange: (v: ViewMode) => void; views?: [ViewMode, string, string][] }): ReactElement {
  return (
    <div className="segmented small">
      {views.map(([v, label, icon]) => (
        <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)} title={`${label} View`}>
          <Icon name={icon} size={13} /> {label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

const fmt = (n: number | undefined): string => (n === undefined ? '—' : n.toLocaleString())

function Stat({ label, value, sub, tone, small }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; small?: boolean }): ReactElement {
  return (
    <div className={`xp-stat ${tone ?? ''}`}>
      <div className="xp-stat-label">{label}</div>
      <div className={`xp-stat-value ${small ? 'small' : ''}`}>{value}</div>
      {sub && <div className="xp-stat-sub">{sub}</div>}
    </div>
  )
}

/** Plan nodes from the data source up to the result, with their depth below the root. */
function flatten(root: PlanNode): { node: PlanNode; depth: number }[] {
  const out: { node: PlanNode; depth: number }[] = []
  const walk = (n: PlanNode, depth: number): void => {
    n.children.forEach((c) => walk(c, n.children.length > 1 ? depth + 1 : depth))
    out.push({ node: n, depth })
  }
  walk(root, 0)
  return out
}

function stageTone(stage: string): string {
  if (stage === 'COLLSCAN') return 'danger'
  if (/^(SORT|sort|\$sort)$/.test(stage)) return 'warn'
  if (/IXSCAN|IDHACK|COUNT_SCAN|DISTINCT_SCAN|ixseek|ixscan/.test(stage)) return 'ok'
  return ''
}

export function AggExplain({ doc }: { doc: Doc }): ReactElement {
  const [mode, setMode] = useState<'visual' | 'raw'>('visual')
  const parsed = useMemo(() => {
    try {
      return parseExplain(doc)
    } catch {
      return null
    }
  }, [doc])
  const raw = useMemo(() => (mode === 'raw' ? shellText(doc, 2) : ''), [mode, doc])
  const [open, setOpen] = useState<string | null>(null)
  const s = parsed?.summary
  return (
    <div className="agg-explain">
      <div className="agg-explain-bar">
        <div className="segmented small">
          <button className={mode === 'visual' ? 'on' : ''} onClick={() => setMode('visual')}>
            <Icon name="gauge" size={12} /> Summary
          </button>
          <button className={mode === 'raw' ? 'on' : ''} onClick={() => setMode('raw')}>
            <Icon name="json" size={12} /> Raw JSON
          </button>
        </div>
        <span className="faint">Execution stats of the whole pipeline (enabled stages, no sampling).</span>
      </div>
      {mode === 'raw' || !parsed || !s ? (
        <>
          {!parsed && mode === 'visual' && <div className="notice xp-error">This explain output could not be summarised; showing the raw document.</div>}
          <CodeEditor value={raw || shellText(doc, 2)} readOnly full className="cm-json-view" />
        </>
      ) : (
        <div className="agg-explain-body">
          <div className="xp-stats">
            <Stat label="Documents returned" value={fmt(s.nReturned)} />
            <Stat label="Documents examined" value={fmt(s.docsExamined)} tone={s.ratio !== undefined && s.ratio > 10 ? 'warn' : ''} />
            <Stat label="Index keys examined" value={fmt(s.keysExamined)} />
            <Stat label="Execution time" value={s.timeMs === undefined ? '—' : `${s.timeMs.toLocaleString()} ms`} />
            <Stat
              label={s.indexes.length > 1 ? 'Indexes used' : 'Index used'}
              value={s.indexes.length ? s.indexes.join(', ') : s.collscan ? 'Collection scan' : 'None'}
              small
              tone={s.indexes.length ? (s.collscan ? 'warn' : 'ok') : s.collscan ? 'danger' : ''}
            />
            <Stat label="Engine" value={s.engine === 'sbe' ? 'SBE' : 'Classic'} small sub={s.sharded ? `${s.shardCount} shards` : undefined} />
          </div>
          {s.warnings.length > 0 && (
            <div className="xp-flags">
              {s.warnings.map((w) => (
                <span key={w.kind} className={`xp-flag ${w.kind === 'collscan' || w.kind === 'failed' ? 'danger' : 'warn'}`}>
                  <Icon name="warn" size={12} /> {w.text}
                </span>
              ))}
            </div>
          )}
          <div className="agg-plan-title">Execution plan · data flows from top to bottom</div>
          <div className="agg-plan">
            {flatten(parsed.root).map(({ node: n, depth }) => {
              const st = n.stats
              const ix = typeof n.details.indexName === 'string' ? n.details.indexName : undefined
              const isOpen = open === n.id
              return (
                <div key={n.id} className={`agg-plan-step ${stageTone(n.stage)}`} style={{ marginLeft: depth * 18 }}>
                  <button className="agg-plan-head" onClick={() => setOpen(isOpen ? null : n.id)}>
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} />
                    <b>{n.stage}</b>
                    {n.label && <span className="xp-label">{n.label}</span>}
                    {ix && (
                      <span className="agg-plan-ix">
                        <Icon name="key" size={11} /> {ix}
                      </span>
                    )}
                    <span className="spacer" />
                    {st?.nReturned !== undefined && <span className="agg-plan-metric">{fmt(st.nReturned)} out</span>}
                    {st?.docsExamined !== undefined && <span className="agg-plan-metric">{fmt(st.docsExamined)} examined</span>}
                    {st?.keysExamined !== undefined && <span className="agg-plan-metric">{fmt(st.keysExamined)} keys</span>}
                    {st?.timeMs !== undefined && <span className="agg-plan-metric">{st.timeMs.toLocaleString()} ms</span>}
                    {st?.usedDisk && <span className="agg-plan-metric warn">disk</span>}
                  </button>
                  {isOpen && <pre className="agg-plan-details selectable">{shellText(st ? { ...n.details, executionStats: st.raw } : n.details, 2)}</pre>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
