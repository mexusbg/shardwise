import { ExplainIndexHint } from './IndexAdvice'
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { shellText } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import type { AppliedQuery, ExplainVerbosity, QueryTab } from '../../state/store'
import { runExplain } from '../../state/queryActions'
import { formatQuery } from '../../lib/queryText'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { findNode, parseExplain } from './explainModel'
import type { ExplainSummary, ParsedExplain, PlanNode } from './explainModel'
import { explainPlanWithAi } from '../ai/AiActions'
import './profiler.css'

const VERBOSITY: [ExplainVerbosity, string][] = [
  ['queryPlanner', 'Query planner'],
  ['executionStats', 'Execution stats'],
  ['allPlansExecution', 'All plans']
]

const fmt = (n: number | undefined): string => (n === undefined ? '—' : n.toLocaleString())
const inline = (v: unknown): string => formatQuery(v).replace(/\s*\n\s*/g, ' ')
const hasKeys = (v: unknown): v is Doc => !!v && typeof v === 'object' && Object.keys(v).length > 0
const ratioText = (r: number): string => (r === 0 ? '0' : r < 100 ? r.toFixed(1) : Math.round(r).toLocaleString())

function queryLabel(q?: AppliedQuery): string {
  if (!q) return ''
  let s = `find(${inline(q.filter)})`
  if (hasKeys(q.projection)) s += `.projection(${inline(q.projection)})`
  if (hasKeys(q.sort)) s += `.sort(${inline(q.sort)})`
  if (q.skip) s += `.skip(${q.skip})`
  if (q.limit) s += `.limit(${q.limit})`
  return s
}

function stageKind(stage: string): string {
  if (stage === 'COLLSCAN') return 'collscan'
  if (stage === 'SORT' || stage === 'sort' || stage === '$sort') return 'sort'
  if (/^(EXPRESS_)?(IXSCAN|IDHACK)$|^(COUNT_SCAN|DISTINCT_SCAN|ixseek|ixscan)$/.test(stage)) return 'ixscan'
  if (/^SHARD|^SINGLE_SHARD/.test(stage)) return 'shard'
  return ''
}

function Stat({ label, value, sub, tone, small }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; small?: boolean }): ReactElement {
  return (
    <div className={`xp-stat ${tone ?? ''}`}>
      <div className="xp-stat-label">{label}</div>
      <div className={`xp-stat-value ${small ? 'small' : ''}`} title={typeof value === 'string' ? value : undefined}>
        {value}
      </div>
      {sub && <div className="xp-stat-sub">{sub}</div>}
    </div>
  )
}

function Summary({ s, onStats, loading }: { s: ExplainSummary; onStats: () => void; loading: boolean }): ReactElement {
  const index = s.indexes.length ? s.indexes.join(', ') + (s.collscan ? ' + COLLSCAN' : '') : s.collscan ? 'No index — collection scan' : 'None'
  const indexTone = s.indexes.length ? (s.collscan ? 'warn' : 'ok') : s.collscan ? 'danger' : ''
  return (
    <div className="xp-summary">
      {!s.hasStats && (
        <div className="notice xp-hint">
          <Icon name="gauge" size={14} />
          <span className="grow">Run with Execution stats for timings and document counts.</span>
          <button className="btn small" onClick={onStats} disabled={loading}>
            <Icon name="play" size={10} /> Execution stats
          </button>
        </div>
      )}
      <div className="xp-stats">
        {s.hasStats && (
          <>
            <Stat label="Documents returned" value={fmt(s.nReturned)} />
            <Stat label="Documents examined" value={fmt(s.docsExamined)} tone={s.ratio !== undefined && s.ratio > 10 ? 'warn' : ''} />
            <Stat label="Index keys examined" value={fmt(s.keysExamined)} />
            <Stat label="Execution time" value={s.timeMs === undefined ? '—' : `${s.timeMs.toLocaleString()} ms`} />
            <Stat
              label="Examined / returned"
              value={s.ratio === undefined ? '—' : ratioText(s.ratio)}
              sub="documents per result"
              tone={s.ratio === undefined ? '' : s.ratio > 10 ? 'warn' : s.ratio <= 1 ? 'ok' : ''}
            />
          </>
        )}
        <Stat
          label={s.indexes.length > 1 ? 'Indexes used' : 'Index used'}
          value={index}
          small
          sub={s.covered ? 'Covered query' : undefined}
          tone={indexTone}
        />
        <Stat label="Sorted in memory" value={s.inMemorySort ? 'Yes' : 'No'} sub={s.sortUsedDisk ? 'Spilled to disk' : undefined} tone={s.inMemorySort ? 'warn' : 'ok'} />
        <Stat
          label="Plan cache"
          value={s.isCached === undefined ? '—' : s.isCached ? 'Cached plan' : 'Not cached'}
          small
          sub={[s.engine === 'sbe' ? 'SBE engine' : 'Classic engine', s.queryHash && `hash ${s.queryHash}`, s.indexFilterSet && 'index filter set'].filter(Boolean).join(' · ')}
        />
        <Stat label="Rejected plans" value={String(s.rejectedPlans)} sub={s.sharded ? `${s.shardCount} shard${s.shardCount === 1 ? '' : 's'}` : undefined} />
      </div>
      {s.warnings.length > 0 ? (
        <div className="xp-flags">
          {s.warnings.map((w) => (
            <span key={w.kind} className={`xp-flag ${w.kind === 'collscan' || w.kind === 'failed' ? 'danger' : 'warn'}`}>
              <Icon name="warn" size={12} /> {w.text}
            </span>
          ))}
        </div>
      ) : (
        s.hasStats && (
          <div className="xp-flags">
            <span className="xp-flag ok">
              <Icon name="check" size={12} /> No obvious problems in this plan.
            </span>
          </div>
        )
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="xp-metric">
      <span className="xp-metric-label">{label}</span>
      <span className="xp-metric-value">{value}</span>
    </div>
  )
}

function StageCard({ node, selected, onSelect }: { node: PlanNode; selected: boolean; onSelect: (id: string) => void }): ReactElement {
  const [bounds, setBounds] = useState(false)
  const d = node.details
  const st = node.stats
  const indexName = typeof d.indexName === 'string' ? d.indexName : undefined
  const extra: [string, unknown][] = (
    [
      ['Sort', d.sortPattern],
      ['Projection', d.transformBy],
      ['Limit', d.limitAmount],
      ['Skip', d.skipAmount]
    ] as [string, unknown][]
  ).filter(([, v]) => v !== undefined)
  return (
    <div
      className={`xp-card ${stageKind(node.stage)} ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      title="Show stage details"
      onClick={() => onSelect(node.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(node.id)
        }
      }}
    >
      <div className="xp-card-head">
        <span className="xp-stage">{node.stage}</span>
        {node.label && <span className="xp-label">{node.label}</span>}
        {st?.timeMs !== undefined && (
          <span className="xp-time" title="Execution time (estimate)">
            <Icon name="gauge" size={11} /> {st.timeMs.toLocaleString()} ms
          </span>
        )}
      </div>
      <div className="xp-card-body">
        {st && (
          <div className="xp-metrics">
            <Metric label="Returned" value={fmt(st.nReturned)} />
            {st.docsExamined !== undefined && <Metric label="Docs examined" value={fmt(st.docsExamined)} />}
            {st.keysExamined !== undefined && <Metric label="Keys examined" value={fmt(st.keysExamined)} />}
            {st.works !== undefined && <Metric label="Works / advanced" value={`${fmt(st.works)} / ${fmt(st.advanced)}`} />}
            {st.usedDisk && <Metric label="Disk" value="spilled" />}
          </div>
        )}
        {indexName && (
          <div className="xp-row">
            <Icon name="key" size={12} />
            <b className="ellipsis" title={indexName}>
              {indexName}
            </b>
            {typeof d.direction === 'string' && <span className="faint">{d.direction}</span>}
            {d.isMultiKey === true && <span className="xp-label">multikey</span>}
          </div>
        )}
        {hasKeys(d.keyPattern) && <pre className="xp-code">{inline(d.keyPattern)}</pre>}
        {hasKeys(d.indexBounds) && (
          <div>
            <button
              className="xp-toggle"
              onClick={(e) => {
                e.stopPropagation()
                setBounds(!bounds)
              }}
            >
              <Icon name={bounds ? 'chevronDown' : 'chevronRight'} size={11} /> Index bounds
            </button>
            {bounds && <pre className="xp-code">{shellText(d.indexBounds, 2)}</pre>}
          </div>
        )}
        {hasKeys(d.filter) && (
          <div>
            <div className="xp-row faint">
              <Icon name="filter" size={11} /> Filter
            </div>
            <pre className="xp-code">{inline(d.filter)}</pre>
          </div>
        )}
        {extra.map(([k, v]) => (
          <div key={k} className="xp-row">
            <span className="faint">{k}</span>
            <code className="xp-inline ellipsis" title={inline(v)}>
              {inline(v)}
            </code>
          </div>
        ))}
      </div>
    </div>
  )
}

function Branch({ node, sel, onSelect }: { node: PlanNode; sel: string | null; onSelect: (id: string) => void }): ReactElement {
  return (
    <div className="xp-branch">
      <StageCard node={node} selected={sel === node.id} onSelect={onSelect} />
      {node.children.length > 0 && (
        <div className={`xp-children ${node.children.length === 1 ? 'single' : ''}`}>
          {node.children.map((c) => (
            <div key={c.id} className="xp-child">
              <Branch node={c} sel={sel} onSelect={onSelect} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DetailsPanel({ node, onClose }: { node: PlanNode; onClose: () => void }): ReactElement {
  const text = useMemo(() => {
    const obj: Doc = { ...node.details }
    if (node.stats) obj.executionStats = node.stats.raw
    return shellText(obj, 2)
  }, [node])
  return (
    <aside className="xp-side">
      <div className="xp-side-head">
        <b className="xp-stage">{node.stage}</b>
        {node.label && <span className="xp-label">{node.label}</span>}
        <span className="spacer" />
        <button className="btn ghost icon small" title="Close" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <CodeEditor key={node.id} value={text} readOnly full className="cm-json-view" />
    </aside>
  )
}

function Visual({ parsed, onStats, loading, hint }: { parsed: ParsedExplain; onStats: () => void; loading: boolean; hint?: ReactNode }): ReactElement {
  const [sel, setSel] = useState<string | null>(null)
  const [showRejected, setShowRejected] = useState(false)
  useEffect(() => {
    setSel(null)
  }, [parsed])
  const selected = sel ? (findNode(parsed.root, sel) ?? parsed.rejected.map((r) => findNode(r, sel)).find(Boolean)) : undefined
  const toggle = (id: string): void => setSel((cur) => (cur === id ? null : id))
  return (
    <div className="xp-body">
      <div className="xp-main">
        <Summary s={parsed.summary} onStats={onStats} loading={loading} />
        {hint}
        <div className="xp-section">
          Winning plan
          <span className="xp-section-hint">data flows from the bottom stages up to the result · click a stage for details</span>
        </div>
        <div className="xp-canvas">
          <div className="xp-tree">
            <Branch node={parsed.root} sel={sel} onSelect={toggle} />
          </div>
        </div>
        {parsed.rejected.length > 0 && (
          <>
            <div className="xp-section">
              <button className="xp-toggle" onClick={() => setShowRejected(!showRejected)}>
                <Icon name={showRejected ? 'chevronDown' : 'chevronRight'} size={12} /> Rejected plans ({parsed.rejected.length})
              </button>
            </div>
            {showRejected && (
              <div className="xp-canvas">
                <div className="xp-tree xp-rejected">
                  {parsed.rejected.map((r, i) => (
                    <div key={r.id} className="xp-rejected-plan">
                      <div className="xp-rejected-title">Plan {i + 1}</div>
                      <Branch node={r} sel={sel} onSelect={toggle} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {selected && <DetailsPanel node={selected} onClose={() => setSel(null)} />}
    </div>
  )
}

export function ExplainView({ tab }: { tab: QueryTab }): ReactElement {
  const ex = tab.explain
  const [mode, setMode] = useState<'visual' | 'raw'>('visual')
  useEffect(() => {
    if (!tab.explain) void runExplain(tab.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])
  const result = ex?.result
  const parsed = useMemo(() => {
    if (!result) return null
    try {
      return parseExplain(result)
    } catch {
      return null
    }
  }, [result])
  const rawText = useMemo(() => (mode === 'raw' && result ? shellText(result, 2) : ''), [mode, result])
  const label = queryLabel(ex?.query)
  const loading = !!ex?.loading
  return (
    <div className="xp">
      {loading && <div className="loading-bar" />}
      <div className="xp-toolbar">
        <button className="btn primary small" onClick={() => runExplain(tab.id)} disabled={loading}>
          <Icon name={loading ? 'refresh' : 'play'} size={11} /> {loading ? 'Explaining…' : 'Run Explain'}
        </button>
        <div className="segmented small" title="Verbosity">
          {VERBOSITY.map(([v, l]) => (
            <button key={v} className={(ex?.verbosity ?? 'executionStats') === v ? 'on' : ''} disabled={loading} onClick={() => runExplain(tab.id, v)}>
              {l}
            </button>
          ))}
        </div>
        <div className="segmented small">
          <button className={mode === 'visual' ? 'on' : ''} onClick={() => setMode('visual')}>
            <Icon name="gauge" size={12} /> Visual
          </button>
          <button className={mode === 'raw' ? 'on' : ''} onClick={() => setMode('raw')}>
            <Icon name="json" size={12} /> Raw JSON
          </button>
        </div>
        {label && (
          <span className="xp-query ellipsis" title={label}>
            {label}
          </span>
        )}
        <button
          className="btn small"
          style={{ marginLeft: 'auto', flex: 'none' }}
          disabled={!result || loading}
          title="Ask the AI to explain this plan and suggest indexes"
          onClick={() => result && void explainPlanWithAi({ connId: tab.connId, db: tab.db, coll: tab.coll, explain: result, label })}
        >
          <Icon name="sparkle" size={12} /> Explain this plan with AI
        </button>
      </div>
      {ex?.error && <div className="notice error selectable xp-error">{ex.error}</div>}
      {!result && !ex?.error && <div className="result-empty">{loading ? 'Explaining query…' : 'Run Explain to see how MongoDB executes this query.'}</div>}
      {result && mode === 'raw' && <CodeEditor value={rawText} readOnly full className="cm-json-view" />}
      {result && mode === 'visual' && parsed && (
        <Visual
          parsed={parsed}
          loading={loading}
          onStats={() => runExplain(tab.id, 'executionStats')}
          hint={
            ex?.query && ((parsed.summary.collscan && Object.keys(ex.query.filter).length > 0) || parsed.summary.inMemorySort) ? (
              <ExplainIndexHint connId={tab.connId} db={tab.db} coll={tab.coll} filter={ex.query.filter} sort={ex.query.sort} />
            ) : undefined
          }
        />
      )}
      {result && mode === 'visual' && !parsed && <div className="notice xp-error">This explain output could not be visualised. Switch to Raw JSON to inspect it.</div>}
    </div>
  )
}
