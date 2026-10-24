import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { flattenFields, reportJson } from '@shared/schema'
import type { FieldQuery, SchemaReport } from '@shared/schema'
import { api } from '../../lib/api'
import { errorText, toast } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { FieldDetails } from './FieldDetails'
import { FieldTree } from './FieldTree'
import { showJsonSchema } from './JsonSchemaDialog'
import { fmtInt, fmtMs, openFieldQuery } from './schemaUi'
import './schema.css'

const SIZES = [100, 1000, 5000, 10000]

interface Result {
  report: SchemaReport
  total: number | null
  ms: number
}

/** Paths of object fields expanded by default (the first level). */
const defaultExpanded = (r: SchemaReport): Set<string> =>
  new Set(r.fields.filter((f) => f.children.length && (f.children.length <= 30 || r.fields.length <= 3)).map((f) => f.path))

export function SchemaView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const coll = tab.coll ?? ''
  const [size, setSize] = useState(1000)
  const [result, setResult] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [mixedOnly, setMixedOnly] = useState(false)
  const runId = useRef(0)
  const analysed = useRef(false)

  const analyze = useCallback(async () => {
    const id = ++runId.current
    setLoading(true)
    setError(null)
    const t0 = performance.now()
    try {
      const [report, total] = await Promise.all([api.analyzeSample(connId, db, coll, size), api.estimatedCount(connId, db, coll).catch(() => null)])
      if (id !== runId.current) return
      const all = flattenFields(report.fields)
      if (!analysed.current) setExpanded(defaultExpanded(report))
      analysed.current = true
      setResult({ report, total, ms: performance.now() - t0 })
      setSelected((s) => (s && all.some((f) => f.path === s) ? s : (report.fields[0]?.path ?? null)))
    } catch (e) {
      if (id === runId.current) setError(errorText(e))
    } finally {
      if (id === runId.current) setLoading(false)
    }
  }, [connId, db, coll, size])

  useEffect(() => {
    void analyze()
    // Analyse once when the tab opens; later runs are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const report = result?.report
  const byPath = useMemo(() => new Map(report ? flattenFields(report.fields).map((f) => [f.path, f]) : []), [report])
  const field = selected ? byPath.get(selected) : undefined

  const toggle = (path: string, open?: boolean): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (open ?? !next.has(path)) next.add(path)
      else next.delete(path)
      return next
    })

  const onQuery = (q: FieldQuery): void => {
    if (field) void openFieldQuery(connId, db, coll, field, q).catch((e) => toast(errorText(e), 'error'))
  }

  const copyReport = (): void => {
    if (!report) return
    api
      .copyText(reportJson(report))
      .then(() => toast('Report copied', 'success'))
      .catch((e) => toast(errorText(e), 'error'))
  }

  const sampledText = (r: Result): string =>
    r.total != null
      ? `${fmtInt(r.report.docCount)} of ${fmtInt(Math.max(r.total, r.report.docCount))} documents sampled`
      : `${fmtInt(r.report.docCount)} documents sampled`

  return (
    <div className="sx">
      {loading && <div className="loading-bar" />}
      <div className="sx-toolbar">
        <Icon name="schema" />
        <span className="sx-title ellipsis" title={`${db}.${coll}`}>
          <span className="faint">{db}.</span>
          {coll}
        </span>
        <span className="sx-sep" />
        <label className="muted" htmlFor={`sx-size-${tab.id}`}>
          Sample
        </label>
        <select id={`sx-size-${tab.id}`} className="select small" value={size} onChange={(e) => setSize(Number(e.target.value))}>
          {SIZES.map((n) => (
            <option key={n} value={n}>
              {fmtInt(n)} documents
            </option>
          ))}
        </select>
        <button className="btn primary small" onClick={() => void analyze()} disabled={loading}>
          <Icon name={result ? 'refresh' : 'play'} size={13} />
          {result ? 'Re-analyze' : 'Analyze'}
        </button>
        <span className="sx-meta ellipsis">
          {loading ? 'Sampling…' : result ? `${sampledText(result)} · ${fmtMs(result.ms)}` : ''}
        </span>
        <span className="spacer" />
        <button className="btn small" disabled={!report?.docCount} onClick={() => report && showJsonSchema(report, coll)}>
          <Icon name="export" size={13} /> Export JSON Schema…
        </button>
        <button className="btn small" disabled={!report} onClick={copyReport}>
          <Icon name="copy" size={13} /> Copy report JSON
        </button>
      </div>

      {error && <div className="notice error sx-error selectable">{error}</div>}

      {!report ? (
        <div className="result-empty">{loading ? 'Sampling documents…' : 'Pick a sample size and click Analyze.'}</div>
      ) : report.docCount === 0 ? (
        <div className="result-empty">The collection is empty — there is nothing to analyse.</div>
      ) : (
        <div className="sx-body">
          <div className="sx-left">
            <div className="sx-filterbar">
              <div className="sx-search">
                <Icon name="search" size={13} />
                <input className="input" placeholder="Filter fields" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              {report.mixedCount > 0 && (
                <button
                  className={`btn small sx-mixed-btn${mixedOnly ? ' active' : ''}`}
                  onClick={() => setMixedOnly((v) => !v)}
                  title="Show only fields with mixed types"
                >
                  <Icon name="warn" size={12} /> {report.mixedCount} mixed
                </button>
              )}
              <button className="btn ghost icon small" title="Expand all" onClick={() => setExpanded(new Set(byPath.keys()))}>
                <Icon name="plus" size={13} />
              </button>
              <button className="btn ghost icon small" title="Collapse all" onClick={() => setExpanded(new Set())}>
                <Icon name="minus" size={13} />
              </button>
            </div>
            <div className="sx-cols">
              <span>Field</span>
              <span>Type</span>
              <span className="r">Present</span>
              <span>Types</span>
            </div>
            <FieldTree
              fields={report.fields}
              selected={selected}
              onSelect={setSelected}
              expanded={expanded}
              onToggle={toggle}
              filter={filter}
              mixedOnly={mixedOnly}
            />
            <div className="sx-foot faint">
              {fmtInt(report.fieldCount)} fields · {fmtInt(report.docCount)} documents · analysed in {fmtMs(report.ms)}
            </div>
          </div>
          <div className="sx-right">
            {field ? (
              <FieldDetails field={field} sampled={report.docCount} onQuery={field.dynamic ? undefined : onQuery} />
            ) : (
              <div className="result-empty">Select a field to see its details.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
