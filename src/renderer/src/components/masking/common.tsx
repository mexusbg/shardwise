import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { EJSON } from 'bson'
import { bsonTypeOf, cellText, parseShellValue, shellText, TYPE_LABELS } from '@shared/bsonValue'
import type { BsonTypeName } from '@shared/bsonValue'
import { collectPaths, getPath, hasPath } from '@shared/docPaths'
import { flattenFields } from '@shared/schema'
import type { Doc, JobProgress } from '@shared/api'
import type { PreviewPair } from '@shared/maskingApi'
import { api } from '../../lib/api'
import { tryParse } from '../../lib/queryText'
import { errorText, useStore } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'

export const fmt = (n: number): string => n.toLocaleString()
export const plural = (n: number, w: string): string => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`

export interface FieldInfo {
  path: string
  depth: number
  type: BsonTypeName
  typeLabel: string
  /** Share of sampled documents with the field (0..1). */
  presence: number
  hasChildren: boolean
  sample?: unknown
}

/** Field paths and dominant types from a `$sample` of the collection. */
export function useSampledFields(connId: string, db: string, coll: string, enabled: boolean): { fields: FieldInfo[]; loading: boolean; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ fields: FieldInfo[]; loading: boolean; error: string | null }>({ fields: [], loading: false, error: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    api
      .analyzeSample(connId, db, coll, 500, { samples: 1 })
      .then((report) => {
        if (!alive) return
        const seen = new Set<string>()
        const fields: FieldInfo[] = []
        for (const f of flattenFields(report.fields)) {
          // Merged map keys (`perms.*`) have no path a rule could target.
          if (f.isElement || f.dynamic || seen.has(f.queryPath)) continue
          seen.add(f.queryPath)
          const main = f.types.find((t) => t.type !== 'null' && t.type !== 'undefined') ?? f.types[0]
          const type = main?.type ?? 'null'
          fields.push({
            path: f.queryPath,
            depth: f.queryPath.split('.').length - 1,
            type,
            typeLabel: f.mixed ? 'Mixed' : TYPE_LABELS[type],
            presence: f.presence,
            hasChildren: f.children.some((c) => !c.dynamic),
            sample: f.samples[0]
          })
        }
        setState({ fields, loading: false, error: null })
      })
      .catch((e) => alive && setState({ fields: [], loading: false, error: errorText(e) }))
    return () => {
      alive = false
    }
  }, [connId, db, coll, enabled, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}

export function useJob(jobId: string | null): JobProgress | undefined {
  return useStore((s) => (jobId ? s.jobs[jobId] : undefined))
}

/** Shell-syntax filter editor (red border while invalid). */
export function FilterBox({ value, onChange, fields, onSubmit }: { value: string; onChange: (v: string) => void; fields: string[]; onSubmit?: () => void }): ReactElement {
  const invalid = tryParse('query', value) === undefined
  return (
    <div className="mk-filter">
      <CodeEditor value={value} onChange={onChange} fields={fields} invalid={invalid} placeholder="{ } — all documents" onSubmit={onSubmit} maxHeight={84} />
    </div>
  )
}

const short = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function Val({ v, has = true }: { v: unknown; has?: boolean }): ReactElement {
  if (!has) return <span className="mk-missing">missing</span>
  const t = bsonTypeOf(v)
  const text = t === 'object' || t === 'array' ? short(shellText(v)) : t === 'string' ? short((v as string).replace(/\n/g, '⏎'), 200) : cellText(v)
  return (
    <span className={`t-${t}`} title={t === 'string' ? (v as string) : undefined}>
      {t === 'string' && !(v as string).length ? <span className="faint">""</span> : text}
    </span>
  )
}

interface FieldChange {
  path: string
  before: unknown
  after: unknown
  hadBefore: boolean
  hasAfter: boolean
  kind: 'same' | 'changed' | 'removed' | 'added'
}

const canon = (v: unknown): string => {
  try {
    return EJSON.stringify(v as never, { relaxed: false })
  } catch {
    return String(v)
  }
}

function diffPair(p: PreviewPair): FieldChange[] {
  const paths = collectPaths([p.before, p.after], true)
  return paths.map((path) => {
    const hadBefore = hasPath(p.before, path)
    const hasAfter = hasPath(p.after, path)
    const before = getPath(p.before, path)
    const after = getPath(p.after, path)
    const kind = !hadBefore ? 'added' : !hasAfter ? 'removed' : canon(before) === canon(after) && bsonTypeOf(before) === bsonTypeOf(after) ? 'same' : 'changed'
    return { path, before, after, hadBefore, hasAfter, kind }
  })
}

type PreviewMode = 'table' | 'docs'

/** Before / after preview of up to 20 documents: changed fields as a table, or one document side by side. */
export function PairsPreview(p: {
  pairs: PreviewPair[] | null
  loading: boolean
  error: string | null
  focus?: string[]
  empty?: ReactNode
  title?: ReactNode
  actions?: ReactNode
}): ReactElement {
  const [mode, setMode] = useState<PreviewMode>('table')
  const [sel, setSel] = useState(0)
  const diffs = useMemo(() => (p.pairs ?? []).map(diffPair), [p.pairs])
  const columns = useMemo(() => {
    const changed = new Set<string>()
    for (const d of diffs) for (const c of d) if (c.kind !== 'same') changed.add(c.path)
    const focus = (p.focus ?? []).flatMap((f) => [...changed].filter((c) => c === f || c.startsWith(`${f}.`)))
    return [...new Set([...focus, ...changed])].filter((c) => c !== '_id').slice(0, 40)
  }, [diffs, p.focus])
  const changedDocs = diffs.filter((d) => d.some((c) => c.kind !== 'same')).length
  const pair = p.pairs?.[Math.min(sel, (p.pairs?.length ?? 1) - 1)]
  const detail = pair ? diffs[Math.min(sel, diffs.length - 1)] : null

  useEffect(() => {
    setSel(0)
  }, [p.pairs])

  let body: ReactNode
  if (p.error) body = <div className="notice error mk-preview-msg">{p.error}</div>
  else if (!p.pairs) body = <div className="mk-preview-empty">{p.loading ? <span className="mk-spinner" /> : p.empty}</div>
  else if (!p.pairs.length) body = <div className="mk-preview-empty">No documents match the filter.</div>
  else if (mode === 'table')
    body = (
      <div className="mk-table-wrap">
        <table className="mk-table">
          <thead>
            <tr>
              <th className="mk-num">#</th>
              <th>_id</th>
              {columns.map((c) => (
                <th key={c} className="mono">
                  {c}
                </th>
              ))}
              {!columns.length && <th className="faint">No changes</th>}
            </tr>
          </thead>
          <tbody>
            {p.pairs.map((pr, i) => {
              const byPath = new Map(diffs[i].map((c) => [c.path, c]))
              return (
                <tr
                  key={i}
                  onClick={() => {
                    setSel(i)
                    setMode('docs')
                  }}
                  title="Open side by side"
                >
                  <td className="mk-num faint">{i + 1}</td>
                  <td className="mono ellipsis mk-id">
                    <Val v={pr.before._id ?? pr.after._id} has={'_id' in pr.before || '_id' in pr.after} />
                  </td>
                  {columns.map((c) => {
                    const ch = byPath.get(c)
                    if (!ch) return <td key={c} />
                    if (ch.kind === 'same')
                      return (
                        <td key={c} className="mk-same">
                          <Val v={ch.after} />
                        </td>
                      )
                    return (
                      <td key={c} className={`mk-cell k-${ch.kind}`}>
                        <div className="mk-before">
                          <Val v={ch.before} has={ch.hadBefore} />
                        </div>
                        <div className="mk-after">
                          <Val v={ch.after} has={ch.hasAfter} />
                        </div>
                      </td>
                    )
                  })}
                  {!columns.length && <td />}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  else
    body = (
      <div className="mk-docs">
        <div className="mk-doc-list">
          {p.pairs.map((pr, i) => {
            const n = diffs[i].filter((c) => c.kind !== 'same').length
            return (
              <button key={i} className={`mk-doc-item ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)}>
                <span className="faint mk-num">{i + 1}</span>
                <span className="mono ellipsis grow">{cellText(pr.before._id ?? pr.after._id)}</span>
                {n > 0 && <span className="mk-count">{n}</span>}
              </button>
            )
          })}
        </div>
        <div className="mk-doc-detail">
          <div className="mk-doc-grid head">
            <span>Field</span>
            <span>Before</span>
            <span>After</span>
          </div>
          {detail?.map((c) => (
            <div key={c.path} className={`mk-doc-grid k-${c.kind}`}>
              <span className="mono ellipsis" title={c.path}>
                {c.path}
              </span>
              <span className="mono mk-v">
                <Val v={c.before} has={c.hadBefore} />
              </span>
              <span className="mono mk-v">
                <Val v={c.after} has={c.hasAfter} />
              </span>
            </div>
          ))}
        </div>
      </div>
    )

  return (
    <section className="mk-preview">
      <div className="mk-preview-bar">
        <span className="mk-section-title">{p.title ?? 'Preview'}</span>
        {p.pairs && p.pairs.length > 0 && (
          <span className="faint mk-small">
            {plural(p.pairs.length, 'document')} · {fmt(changedDocs)} changed
          </span>
        )}
        {p.loading && p.pairs && <span className="mk-spinner small" />}
        <span className="spacer" />
        <div className="segmented small">
          <button className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')} title="Changed fields of every document">
            <Icon name="table" size={12} /> Changes
          </button>
          <button className={mode === 'docs' ? 'on' : ''} onClick={() => setMode('docs')} title="One document, before and after">
            <Icon name="compare" size={12} /> Side by side
          </button>
        </div>
        {p.actions}
      </div>
      {body}
    </section>
  )
}

/** Progress of the running job (or the outcome of the last one) with cancel / dismiss. */
export function JobStrip({ job, onCancel, onDismiss }: { job: JobProgress | undefined; onCancel: () => void; onDismiss: () => void }): ReactElement | null {
  if (!job) return null
  const running = job.state === 'running'
  const pct = job.total ? Math.min(100, (job.done / job.total) * 100) : 0
  const icon = job.state === 'done' ? 'check' : job.state === 'error' ? 'warn' : job.state === 'cancelled' ? 'close' : null
  return (
    <div className={`mk-job s-${job.state}`}>
      {running ? (
        <div className={`progress ${job.total ? '' : 'indeterminate'}`}>
          <div style={{ width: `${pct}%` }} />
        </div>
      ) : (
        icon && <Icon name={icon} size={14} className="mk-job-icon" />
      )}
      <span className="ellipsis grow mk-small" title={job.error ?? job.message}>
        {job.error ?? job.message ?? job.title}
      </span>
      {running ? (
        <button className="btn small" onClick={onCancel}>
          <Icon name="close" size={12} /> Cancel
        </button>
      ) : (
        <button className="btn small ghost icon" onClick={onDismiss} title="Dismiss">
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  )
}

/** Debounced value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export const parsedFilter = (text: string): Doc | undefined => {
  const v = tryParse('query', text)
  return v === undefined ? undefined : ((v ?? {}) as Doc)
}

/** A value typed in shell syntax; anything that does not parse is taken as a plain string. */
export function parseConstant(text: string): unknown {
  const t = text.trim()
  if (!t) return ''
  try {
    return parseShellValue(t)
  } catch {
    return text
  }
}
