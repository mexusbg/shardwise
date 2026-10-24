import { useEffect, useRef, useState } from 'react'
import type { Dispatch, ReactElement, SetStateAction } from 'react'
import { shellText } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import { SQL_CONVERTS } from '@shared/migrationApi'
import type { FromSqlColumn, FromSqlEmbed, FromSqlSource, SqlConnectionConfig, SqlConvert } from '@shared/migrationApi'
import { errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { openSaveTaskDialog } from '../tasks/SaveTaskDialog'
import { migrationApi } from './migrationClient'
import { JobStatus } from './common'

const ID_PREFIX = /^_id(\.|$)/

function ColumnsGrid({ columns, onPatch, disabled }: { columns: FromSqlColumn[]; onPatch: (i: number, p: Partial<FromSqlColumn>) => void; disabled?: boolean }): ReactElement {
  return (
    <div className={`mig-ccols ${disabled ? 'off' : ''}`}>
      <div className="mig-crow head">
        <span />
        <span>Column</span>
        <span>SQL type</span>
        <span />
        <span>Field</span>
        <span>Convert to</span>
      </div>
      {columns.map((c, i) => (
        <div key={c.column} className={`mig-crow ${c.include ? '' : 'off'}`}>
          <span>
            <input type="checkbox" checked={c.include} disabled={disabled} onChange={(e) => onPatch(i, { include: e.target.checked })} />
          </span>
          <span className="mono ellipsis" title={c.column}>
            {c.column}
          </span>
          <span className="faint mono ellipsis mig-small" title={c.type}>
            {c.type || '—'}
          </span>
          <span className="faint">→</span>
          <span>
            <input className={`input small mono ${ID_PREFIX.test(c.field) ? 'mig-idfield' : ''}`} value={c.field} disabled={disabled || !c.include} onChange={(e) => onPatch(i, { field: e.target.value })} placeholder={c.column} title="Field name; dots create sub-documents" />
          </span>
          <span>
            <select className="select small" value={c.convert} disabled={disabled || !c.include} onChange={(e) => onPatch(i, { convert: e.target.value as SqlConvert })}>
              {SQL_CONVERTS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </span>
        </div>
      ))}
    </div>
  )
}

function idChoice(s: FromSqlSource): string {
  const ids = s.columns.filter((c) => c.include && ID_PREFIX.test(c.field))
  if (!ids.length) return 'new'
  const pk = s.idColumns
  if (pk.length && ids.length === pk.length && ids.every((c) => pk.includes(c.column))) return 'pk'
  return ids.length === 1 && ids[0].field === '_id' ? `col:${ids[0].column}` : 'custom'
}

function applyId(s: FromSqlSource, choice: string): FromSqlSource {
  const reset = s.columns.map((c) => (ID_PREFIX.test(c.field) ? { ...c, field: c.column === '_id' ? '_id_' : c.column } : c))
  if (choice === 'pk') {
    const pk = s.idColumns
    return { ...s, idMode: 'pk', columns: reset.map((c) => (pk.includes(c.column) ? { ...c, include: true, field: pk.length === 1 ? '_id' : `_id.${c.column}` } : c)) }
  }
  if (choice.startsWith('col:')) {
    const col = choice.slice(4)
    return { ...s, idMode: 'pk', columns: reset.map((c) => (c.column === col ? { ...c, include: true, field: '_id' } : c)) }
  }
  return { ...s, idMode: 'new', columns: reset }
}

function EmbedRow({ e, onPatch }: { e: FromSqlEmbed; onPatch: (p: Partial<FromSqlEmbed>) => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const how = e.as === 'array' ? `${e.table}.${e.foreignColumns.join(', ')} = ${e.localColumns.join(', ')}` : `${e.localColumns.join(', ')} → ${e.table}.${e.foreignColumns.join(', ')}`
  return (
    <div className={`mig-embed ${e.include ? 'on' : ''}`}>
      <div className="mig-embed-head">
        <input type="checkbox" checked={e.include} onChange={(ev) => onPatch({ include: ev.target.checked })} />
        <Icon name="link" size={13} className="mig-accent" />
        <div className="grow mig-embed-title">
          <div className="ellipsis">
            <b>{e.table}</b> <span className="faint mig-small">{e.as === 'array' ? 'child rows' : 'referenced row'}</span>
          </div>
          <div className="faint mono mig-small ellipsis" title={how}>
            {how}
          </div>
        </div>
        <select className="select small" value={e.as} disabled={!e.include} onChange={(ev) => onPatch({ as: ev.target.value as 'array' | 'object' })}>
          <option value="array">Array of documents</option>
          <option value="object">Single document</option>
        </select>
        <input className="input small mono" style={{ width: 130 }} value={e.field} disabled={!e.include} onChange={(ev) => onPatch({ field: ev.target.value })} placeholder="field" title="Field holding the embedded rows" />
        <button className="btn ghost icon small" disabled={!e.include} onClick={() => setOpen((o) => !o)} title="Columns of the embedded rows">
          <Icon name={open && e.include ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
      </div>
      {open && e.include && <ColumnsGrid columns={e.columns} onPatch={(i, p) => onPatch({ columns: e.columns.map((c, k) => (k === i ? { ...c, ...p } : c)) })} />}
    </div>
  )
}

interface Props {
  tab: ToolTab
  sqlConn: SqlConnectionConfig | null
  hidden: boolean
  sources: FromSqlSource[]
  setSources: Dispatch<SetStateAction<FromSqlSource[]>>
  selected: string | null
  setSelected: (id: string | null) => void
}

/** SQL → MongoDB: tables or custom queries, column → field mapping, relationships, preview, run. */
export function FromSqlPanel({ tab, sqlConn, hidden, sources, setSources, selected, setSelected }: Props): ReactElement {
  const connected = !!useStore((s) => s.live[tab.connId])
  const [targetDb, setTargetDb] = useState(tab.db)
  const [mode, setMode] = useState<'insert' | 'upsert'>('insert')
  const [dropTarget, setDropTarget] = useState(false)
  const [batch, setBatch] = useState(1000)
  const [preview, setPreview] = useState<{ docs?: Doc[]; error?: string; loading: boolean }>({ loading: false })
  const [loadingCols, setLoadingCols] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useStore((s) => (jobId ? s.jobs[jobId] : undefined))
  const running = !!job && job.state === 'running'

  const src = sources.find((s) => s.id === selected) ?? null
  const patch = (id: string, p: Partial<FromSqlSource> | ((s: FromSqlSource) => FromSqlSource)): void =>
    setSources((list) => list.map((s) => (s.id !== id ? s : typeof p === 'function' ? p(s) : { ...s, ...p })))

  const addQuery = (): void => {
    const id = `q-${Date.now()}`
    setSources((l) => [...l, { id, kind: 'query', query: 'SELECT * FROM ', include: true, collection: `query_${l.filter((s) => s.kind === 'query').length + 1}`, idMode: 'new', idColumns: [], columns: [], embeds: [] }])
    setSelected(id)
  }

  const loadColumns = async (s: FromSqlSource): Promise<void> => {
    if (!sqlConn || !s.query?.trim()) return
    setLoadingCols(true)
    try {
      const d = await migrationApi.migrationDefaultSource(sqlConn.id, { query: s.query })
      patch(s.id, (cur) => {
        const old = new Map(cur.columns.map((c) => [c.column, c]))
        return { ...cur, columns: d.columns.map((c) => ({ ...c, ...(old.get(c.column) ? { field: old.get(c.column)!.field, include: old.get(c.column)!.include, convert: old.get(c.column)!.convert } : {}) })) }
      })
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setLoadingCols(false)
    }
  }

  const srcKey = src ? JSON.stringify(src) : ''
  const seq = useRef(0)
  useEffect(() => {
    if (!src || !sqlConn || hidden || (src.kind === 'query' && !src.columns.length)) {
      setPreview({ loading: false })
      return
    }
    const n = ++seq.current
    setPreview((p) => ({ ...p, loading: true }))
    const t = setTimeout(() => {
      migrationApi
        .migrationPreviewFromSql(sqlConn.id, src)
        .then((r) => n === seq.current && setPreview({ docs: r.docs, loading: false }))
        .catch((e) => n === seq.current && setPreview({ error: errorText(e), loading: false }))
    }, 450)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, sqlConn?.id, hidden])

  const finished = useRef<string | null>(null)
  useEffect(() => {
    if (!job || job.state === 'running' || finished.current === job.jobId) return
    finished.current = job.jobId
    if (job.state === 'done') toast(job.message ?? 'Import finished', 'success')
  }, [job])

  const included = sources.filter((s) => s.include)
  const problem = !sqlConn
    ? 'Choose a SQL connection on the left'
    : !connected
      ? 'The MongoDB connection is closed'
      : !included.length
        ? 'Add tables from the schema browser or a custom query'
        : !targetDb.trim()
          ? 'Choose a target database'
          : included.some((s) => !s.collection.trim())
            ? 'Every source needs a collection name'
            : included.some((s) => !s.columns.length)
              ? 'Load the columns of each custom query'
              : null

  const start = async (): Promise<void> => {
    if (problem || running || !sqlConn) return
    if (dropTarget) {
      const names = [...new Set(included.map((s) => s.collection.trim()))]
      const ok = await confirmDialog({
        title: 'Drop target collections',
        message: (
          <>
            These collections in <b>{targetDb}</b> will be dropped before importing: <span className="mono">{names.join(', ')}</span>. Continue?
          </>
        ),
        confirmLabel: 'Drop & import',
        danger: true
      })
      if (!ok) return
    }
    try {
      setJobId(await migrationApi.migrationStartFromSql({ sqlConnId: sqlConn.id, connId: tab.connId, db: targetDb.trim(), sources: included, mode, dropTarget, batchSize: batch }))
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const saveTask = async (): Promise<void> => {
    if (problem || !sqlConn) return
    const request = { sqlConnId: sqlConn.id, connId: tab.connId, db: targetDb.trim(), sources: included, mode, dropTarget, batchSize: batch }
    await openSaveTaskDialog({ kind: 'sqlImport', request }, `Import ${sqlConn.name} → ${request.db}`)
  }

  const idValue = src ? idChoice(src) : 'new'

  return (
    <div className="mig-main" hidden={hidden}>
      <div className="mig-cols">
        <section className="mig-mid">
          <div className="mig-sec-head">
            <span className="mig-label">Tables & queries</span>
            <span className="badge">{included.length}</span>
            <span className="spacer" />
            <button className="btn ghost small" onClick={addQuery} disabled={!sqlConn} title="Import the result of a SELECT">
              <Icon name="plus" size={12} /> Query
            </button>
          </div>
          <div className="mig-list">
            {sources.map((s) => (
              <div key={s.id} className={`mig-item ${selected === s.id ? 'sel' : ''} ${s.include ? '' : 'off'}`} onClick={() => setSelected(s.id)}>
                <input type="checkbox" checked={s.include} onClick={(e) => e.stopPropagation()} onChange={(e) => patch(s.id, { include: e.target.checked })} />
                <Icon name={s.kind === 'table' ? 'table' : 'code'} size={13} className="mig-item-ico" />
                <div className="grow mig-item-text">
                  <div className="ellipsis">{s.kind === 'table' ? s.table : (s.query?.replace(/\s+/g, ' ').trim() || 'Custom query')}</div>
                  <div className="faint mig-small ellipsis">
                    → {s.collection || '?'}
                    {s.embeds.some((e) => e.include) ? ` · embeds ${s.embeds.filter((e) => e.include).map((e) => e.table).join(', ')}` : ''}
                  </div>
                </div>
                <button
                  className="btn ghost icon small mig-item-del"
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSources((l) => l.filter((x) => x.id !== s.id))
                    if (selected === s.id) setSelected(null)
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
            {!sources.length && (
              <div className="mig-hint faint">
                {sqlConn ? (
                  <>
                    Add tables with <Icon name="plus" size={11} /> in the schema browser (or double-click them), or import the result of a custom query.
                  </>
                ) : (
                  'Choose a SQL connection first.'
                )}
              </div>
            )}
          </div>
        </section>

        <section className="mig-right">
          {!src ? (
            <div className="mig-intro">
              <Icon name="import" size={34} />
              <h3>SQL → MongoDB</h3>
              <p className="muted">
                Each table (or query) becomes a collection. Map columns to fields (dots create sub-documents), convert types, take <span className="mono">_id</span> from
                the primary key, and embed related rows through foreign keys as arrays or sub-documents.
              </p>
            </div>
          ) : (
            <div className="mig-src">
              <div className="mig-map-head">
                <Icon name={src.kind === 'table' ? 'table' : 'code'} size={14} className="mig-accent" />
                <span className="mono ellipsis mig-src-name" title={src.kind === 'table' ? `${src.schema}.${src.table}` : 'Custom query'}>
                  {src.kind === 'table' ? (
                    <>
                      <span className="faint">{src.schema}.</span>
                      {src.table}
                    </>
                  ) : (
                    'Custom query'
                  )}
                </span>
                <Icon name="chevronRight" size={12} className="faint" />
                <Icon name="collection" size={13} className="mig-accent" />
                <input className="input small mono" style={{ width: 170 }} value={src.collection} onChange={(e) => patch(src.id, { collection: e.target.value })} title="Target collection" placeholder="collection" />
                <span className="spacer" />
                <label className="faint mig-small">_id</label>
                <select className="select small" value={idValue} onChange={(e) => patch(src.id, (s) => applyId(s, e.target.value))}>
                  <option value="new">New ObjectId</option>
                  {src.idColumns.length > 0 && <option value="pk">Primary key ({src.idColumns.join(', ')})</option>}
                  {idValue === 'custom' && <option value="custom">Custom</option>}
                  {src.columns.map((c) => (
                    <option key={c.column} value={`col:${c.column}`}>
                      Column {c.column}
                    </option>
                  ))}
                </select>
              </div>
              {src.kind === 'query' && (
                <div className="mig-query">
                  <textarea
                    className="input mono"
                    rows={4}
                    spellCheck={false}
                    value={src.query ?? ''}
                    onChange={(e) => patch(src.id, { query: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void loadColumns(src)
                    }}
                    placeholder="SELECT …"
                  />
                  <button className="btn small" onClick={() => void loadColumns(src)} disabled={loadingCols || !sqlConn}>
                    {loadingCols ? <span className="mig-spinner" /> : <Icon name="refresh" size={12} />} Load columns
                  </button>
                </div>
              )}
              <div className="mig-src-scroll">
                <div className="mig-sec">Columns</div>
                {src.columns.length ? (
                  <ColumnsGrid columns={src.columns} onPatch={(i, p) => patch(src.id, (s) => ({ ...s, columns: s.columns.map((c, k) => (k === i ? { ...c, ...p } : c)) }))} />
                ) : (
                  <div className="faint mig-pad">Write the query and load its columns (Ctrl+Enter).</div>
                )}
                {src.kind === 'table' && (
                  <>
                    <div className="mig-sec">
                      Relationships <span className="faint mig-small">— unchecked keys stay plain reference fields</span>
                    </div>
                    {src.embeds.length ? (
                      src.embeds.map((e) => <EmbedRow key={e.id} e={e} onPatch={(p) => patch(src.id, (s) => ({ ...s, embeds: s.embeds.map((x) => (x.id === e.id ? { ...x, ...p } : x)) }))} />)
                    ) : (
                      <div className="faint mig-pad">No foreign keys from or to this table.</div>
                    )}
                  </>
                )}
                <div className="mig-sec">
                  Preview <span className="faint mig-small">— first 10 documents</span>
                  {preview.loading && <span className="mig-spinner" />}
                </div>
                {preview.error ? (
                  <div className="notice error mig-m selectable">{preview.error}</div>
                ) : (
                  <pre className="mig-docs selectable">{(preview.docs ?? []).map((d, i) => `// ${i + 1}\n${shellText(d, 2)}`).join('\n')}</pre>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      <footer className="mig-foot">
        <div className="mig-opt">
          <label className="mig-label">Database</label>
          <input className="input small mono" value={targetDb} onChange={(e) => setTargetDb(e.target.value)} style={{ width: 130 }} title="Target MongoDB database" />
        </div>
        <div className="mig-opt">
          <label className="mig-label">Mode</label>
          <div className="segmented small">
            <button className={mode === 'insert' ? 'on' : ''} onClick={() => setMode('insert')} title="Insert documents; existing _id values are reported as errors">
              Insert
            </button>
            <button className={mode === 'upsert' ? 'on' : ''} onClick={() => setMode('upsert')} title="Replace documents with the same _id, insert the others">
              Upsert by _id
            </button>
          </div>
        </div>
        <label className="check mig-small">
          <input type="checkbox" checked={dropTarget} onChange={(e) => setDropTarget(e.target.checked)} /> Drop target collections first
        </label>
        <div className="mig-opt">
          <label className="mig-label" title="Rows read and written per batch">
            Batch
          </label>
          <input className="input small" type="number" min={1} value={batch} onChange={(e) => setBatch(Math.max(1, Number(e.target.value) || 1))} style={{ width: 76 }} />
        </div>
        <span className="spacer" />
        <JobStatus job={job} onCancel={() => jobId && void migrationApi.migrationCancel(jobId)} />
        {!running && (
          <button className="btn" onClick={() => void saveTask()} disabled={!!problem} title={problem ?? 'Run this import again later, on demand or on a schedule'}>
            <Icon name="tasks" size={13} /> Save as task…
          </button>
        )}
        {!running && (
          <button className="btn primary" onClick={() => void start()} disabled={!!problem} title={problem ?? ''}>
            <Icon name="import" size={13} /> Import
          </button>
        )}
      </footer>
    </div>
  )
}
