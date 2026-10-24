import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { TYPE_LABELS } from '@shared/bsonValue'
import type { Doc } from '@shared/api'
import { dialectLabel, SQL_DIALECTS } from '@shared/migrationApi'
import type { SqlConnectionConfig, SqlDialect, ToSqlCollection, ToSqlField, ToSqlMode, ToSqlPreview, ToSqlRequest, ToSqlRunMode } from '@shared/migrationApi'
import { api } from '../../lib/api'
import { tryParse } from '../../lib/queryText'
import { errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { openSaveTaskDialog } from '../tasks/SaveTaskDialog'
import { migrationApi } from './migrationClient'
import { JobStatus, PreviewTable } from './common'

const MODES: { id: ToSqlRunMode; label: string; hint: string }[] = [
  { id: 'create', label: 'Create tables', hint: 'Fails when a table already exists' },
  { id: 'dropCreate', label: 'Drop & create', hint: 'Drops existing tables first (data is lost)' },
  { id: 'append', label: 'Append', hint: 'Creates missing tables and adds rows to existing ones' },
  { id: 'truncate', label: 'Empty & append', hint: 'Creates missing tables and deletes all rows of existing ones first' }
]

function updateAt(fields: ToSqlField[], path: number[], patch: Partial<ToSqlField>): ToSqlField[] {
  const [i, ...rest] = path
  return fields.map((f, k) => (k !== i ? f : rest.length ? { ...f, fields: updateAt(f.fields ?? [], rest, patch) } : { ...f, ...patch }))
}

function setAll(fields: ToSqlField[], include: boolean): ToSqlField[] {
  return fields.map((f) => ({ ...f, include: f.name === '_id' ? true : include, fields: f.fields ? setAll(f.fields, include) : undefined }))
}

const typeLabel = (f: ToSqlField): string => (f.kind === 'array' ? `[${TYPE_LABELS[f.bson] ?? f.bson}]` : (TYPE_LABELS[f.bson] ?? f.bson))

interface RowCtx {
  coll: string
  sampled: number
  auto: Record<string, string>
  childTables: Map<string, string>
  typesList: string
  expanded: Record<string, boolean>
  toggle: (path: string) => void
  patch: (path: number[], p: Partial<ToSqlField>) => void
}

function FieldRows({ fields, depth, at, base, off, ctx }: { fields: ToSqlField[]; depth: number; at: number[]; base: string; off: boolean; ctx: RowCtx }): ReactElement {
  return (
    <>
      {fields.map((f, i) => {
        const path = base ? `${base}.${f.name}` : f.name
        const idx = [...at, i]
        const disabled = off || !f.include
        const nested = !!f.fields?.length && f.mode !== 'json' && (f.kind === 'object' || f.mode === 'table')
        const open = ctx.expanded[path] ?? depth < 2
        const isId = depth === 0 && f.name === '_id'
        const asTable = f.mode === 'table'
        const asColumn = f.kind === 'scalar' || f.mode === 'json'
        const valueTable = f.kind === 'array' && asTable && !(f.bson === 'object' && f.fields?.length)
        const present = ctx.sampled ? Math.round(((f.count - f.nulls) / (depth === 0 ? ctx.sampled : Math.max(1, f.count))) * 100) : 0
        return (
          <div key={f.name} className="mig-frow-group">
            <div className={`mig-frow ${disabled ? 'off' : ''} ${asTable && f.include ? 'is-table' : ''}`}>
              <span>
                <input type="checkbox" checked={f.include} disabled={isId || off} onChange={(e) => ctx.patch(idx, { include: e.target.checked })} title={isId ? '_id is the primary key' : 'Include'} />
              </span>
              <span className="mig-fname" style={{ paddingLeft: depth * 16 }}>
                {nested ? (
                  <button className="mig-twisty-btn" onClick={() => ctx.toggle(path)}>
                    <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
                  </button>
                ) : (
                  <span className="mig-twisty-pad" />
                )}
                {asTable && f.include && <Icon name="table" size={12} className="mig-fname-ico" />}
                <span className="ellipsis mono" title={f.rest ? 'Top-level keys that differ from document to document' : `${path}${depth === 0 ? ` — in ${present}% of sampled documents` : ''}`}>
                  {f.rest ? <i className="faint">other fields</i> : f.name}
                </span>
                {isId && <Icon name="key" size={11} className="mig-pk" />}
              </span>
              <span
                className="mig-ftype ellipsis"
                title={
                  f.distinctKeys
                    ? `${f.distinctKeys.toLocaleString()} different keys in the sample (keys are data, e.g. ids): stored as one JSON column`
                    : f.mixed
                      ? `${f.mixed} value(s) of another type will be converted or stored as NULL`
                      : TYPE_LABELS[f.bson]
                }
              >
                <span className={`t-${f.bson}`}>{typeLabel(f)}</span>
                {f.mixed > 0 && f.mode !== 'json' && <Icon name="warn" size={11} className="mig-warn" />}
              </span>
              <span>
                {f.kind !== 'scalar' && !isId ? (
                  <select className="select small mig-mode" value={f.mode} disabled={disabled} onChange={(e) => ctx.patch(idx, { mode: e.target.value as ToSqlMode })}>
                    {/* Maps (keys differ per document) have no fixed fields to flatten or put in a table. */}
                    {f.kind === 'object' && !f.distinctKeys && <option value="flatten">Flatten</option>}
                    {!f.distinctKeys && <option value="table">{f.kind === 'object' ? '1:1 table' : 'Child table'}</option>}
                    <option value="json">JSON column</option>
                  </select>
                ) : (
                  <span className="faint mig-small">{isId ? 'primary key' : 'column'}</span>
                )}
              </span>
              <span>
                {asTable ? (
                  <input className="input small mono mig-name" value={f.table ?? ''} placeholder={ctx.childTables.get(path) ?? 'table'} disabled={disabled} onChange={(e) => ctx.patch(idx, { table: e.target.value })} title="Child table name" />
                ) : (
                  <div className="mig-name-wrap">
                    <input className="input small mono mig-name" value={f.column} placeholder={f.name} disabled={disabled} onChange={(e) => ctx.patch(idx, { column: e.target.value })} title={asColumn ? 'Column name' : 'Prefix of the flattened columns'} />
                    {!asColumn && <span className="faint mono mig-suffix">_…</span>}
                  </div>
                )}
              </span>
              <span>
                {asColumn || valueTable ? (
                  <input
                    className="input small mono mig-type"
                    list={ctx.typesList}
                    value={f.sqlType}
                    placeholder={ctx.auto[path] ?? 'auto'}
                    disabled={disabled}
                    onChange={(e) => ctx.patch(idx, { sqlType: e.target.value })}
                    title={valueTable ? 'Type of the value column' : 'SQL type (empty = automatic)'}
                  />
                ) : (
                  <span className="faint mig-small">—</span>
                )}
              </span>
            </div>
            {nested && open && <FieldRows fields={f.fields!} depth={depth + 1} at={idx} base={path} off={disabled} ctx={ctx} />}
          </div>
        )
      })}
    </>
  )
}

interface Props {
  tab: ToolTab
  sqlConn: SqlConnectionConfig | null
  hidden: boolean
  onFinished: () => void
}

/** MongoDB → SQL: pick collections, edit the inferred relational mapping, preview, run. */
export function ToSqlPanel({ tab, sqlConn, hidden, onFinished }: Props): ReactElement {
  const { connId, db } = tab
  const init = tab.init as { direction?: string; collections?: string[] } | undefined
  const connected = !!useStore((s) => s.live[connId])
  const [colls, setColls] = useState<string[] | null>(null)
  const [checked, setChecked] = useState<string[]>(init?.direction === 'fromSql' ? [] : (init?.collections ?? []))
  const [maps, setMaps] = useState<Record<string, ToSqlCollection>>({})
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set())
  const [sample, setSample] = useState(1000)
  const [selected, setSelected] = useState<string | null>(init?.collections?.[0] ?? null)
  const [targetKind, setTargetKind] = useState<'connection' | 'file'>('connection')
  const [fileDialect, setFileDialect] = useState<SqlDialect>('postgres')
  const [schema, setSchema] = useState('')
  const [mode, setMode] = useState<ToSqlRunMode>('create')
  const [batch, setBatch] = useState(500)
  const [preview, setPreview] = useState<{ value?: ToSqlPreview; error?: string; loading: boolean }>({ loading: false })
  const [pane, setPane] = useState<'ddl' | 'data' | 'warnings'>('ddl')
  const [dataTable, setDataTable] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [types, setTypes] = useState<string[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [lastFile, setLastFile] = useState<string | null>(null)
  const job = useStore((s) => (jobId ? s.jobs[jobId] : undefined))
  const running = !!job && job.state === 'running'

  const dialect: SqlDialect | null = targetKind === 'file' ? fileDialect : (sqlConn?.dialect ?? null)

  useEffect(() => {
    if (!connected) return
    api
      .listCollections(connId, db)
      .then((l) => setColls(l.map((c) => c.name).filter((n) => !n.startsWith('system.')).sort((a, b) => a.localeCompare(b))))
      .catch((e) => toast(errorText(e), 'error'))
  }, [connId, db, connected])

  useEffect(() => {
    if (!dialect) return
    migrationApi.sqlDialectTypes(dialect).then(setTypes).catch(() => setTypes([]))
  }, [dialect])

  const analyze = async (names: string[], force = false): Promise<void> => {
    const todo = names.filter((n) => force || (!maps[n] && !analyzing.has(n)))
    if (!todo.length || !connected) return
    setAnalyzing((s) => new Set([...s, ...todo]))
    try {
      const res = await migrationApi.migrationInferToSql(connId, db, todo, sample)
      setMaps((m) => {
        const next = { ...m }
        for (const c of res) next[c.coll] = { ...c, filter: m[c.coll]?.filter }
        return next
      })
    } catch (e) {
      toast(`Could not analyze: ${errorText(e)}`, 'error')
    } finally {
      setAnalyzing((s) => new Set([...s].filter((n) => !todo.includes(n))))
    }
  }

  useEffect(() => {
    void analyze(checked)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, connected])

  useEffect(() => {
    if (!selected && checked.length) setSelected(checked[0])
  }, [checked, selected])

  const toggleColl = (name: string, on: boolean): void => {
    setChecked((c) => (on ? [...c.filter((x) => x !== name), name] : c.filter((x) => x !== name)))
    if (on) setSelected(name)
  }

  const req = useMemo<ToSqlRequest | null>(() => {
    const collections = (colls ? checked.filter((c) => colls.includes(c)) : checked).map((c) => maps[c]).filter(Boolean)
    if (!collections.length) return null
    const s = schema.trim() || undefined
    if (targetKind === 'file') return { connId, db, collections, target: { kind: 'file', path: '', dialect: fileDialect, schema: s }, mode, batchSize: batch }
    if (!sqlConn) return null
    return { connId, db, collections, target: { kind: 'connection', sqlConnId: sqlConn.id, schema: s }, mode, batchSize: batch }
  }, [colls, checked, maps, schema, targetKind, fileDialect, sqlConn, connId, db, mode, batch])

  const reqKey = req ? JSON.stringify(req) : ''
  const seq = useRef(0)
  useEffect(() => {
    if (!req || hidden || !connected) return
    const n = ++seq.current
    setPreview((p) => ({ ...p, loading: true }))
    const t = setTimeout(() => {
      migrationApi
        .migrationPreviewToSql(req)
        .then((value) => n === seq.current && setPreview({ value, loading: false }))
        .catch((e) => n === seq.current && setPreview({ error: errorText(e), loading: false }))
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, hidden, connected])

  const finished = useRef<string | null>(null)
  useEffect(() => {
    if (!job || job.state === 'running' || finished.current === job.jobId) return
    finished.current = job.jobId
    if (job.state === 'done') toast(job.message ?? 'Migration finished', 'success')
    onFinished()
  }, [job, onFinished])

  const cur = selected ? maps[selected] : undefined
  const patchColl = (p: Partial<ToSqlCollection>): void => {
    if (!selected) return
    setMaps((m) => ({ ...m, [selected]: { ...m[selected], ...p } }))
  }
  const ctx: RowCtx | null = cur
    ? {
        coll: cur.coll,
        sampled: cur.sampled,
        auto: preview.value?.autoTypes[cur.coll] ?? {},
        childTables: new Map((preview.value?.tables ?? []).filter((t) => t.coll === cur.coll && t.path).map((t) => [t.path, t.name])),
        typesList: `mig-types-${tab.id}`,
        expanded,
        toggle: (p) => setExpanded((e) => ({ ...e, [p]: !(e[p] ?? p.split('.').length < 2) })),
        patch: (path, p) => setMaps((m) => ({ ...m, [cur.coll]: { ...m[cur.coll], fields: updateAt(m[cur.coll].fields, path, p) } }))
      }
    : null

  const filterText = selected ? (filters[selected] ?? '') : ''
  const filterValid = tryParse('query', filterText) !== undefined
  const setFilter = (text: string): void => {
    if (!selected) return
    setFilters((f) => ({ ...f, [selected]: text }))
    const parsed = tryParse('query', text)
    if (parsed !== undefined) patchColl({ filter: parsed && Object.keys(parsed).length ? (parsed as Doc) : undefined })
  }

  const problem = !connected
    ? 'The MongoDB connection is closed'
    : !checked.length
      ? 'Choose collections to migrate'
      : checked.some((c) => !maps[c])
        ? 'Analyzing…'
        : targetKind === 'connection' && !sqlConn
          ? 'Choose a SQL connection on the left, or generate a .sql file'
          : Object.values(filters).some((f) => tryParse('query', f) === undefined)
            ? 'A filter is not valid'
            : null

  const start = async (): Promise<void> => {
    if (!req || problem || running) return
    let target = req.target
    if (target.kind === 'file') {
      const path = await api.saveFile({ title: 'Generate SQL script', defaultPath: `${db}-${target.dialect}.sql`, filters: [{ name: 'SQL script', extensions: ['sql'] }] })
      if (!path) return
      target = { ...target, path }
      setLastFile(path)
    } else {
      setLastFile(null)
      const tables = preview.value?.tables.length ?? 0
      if (mode === 'dropCreate' || mode === 'truncate') {
        const ok = await confirmDialog({
          title: mode === 'dropCreate' ? 'Drop and recreate tables' : 'Empty tables',
          message: (
            <>
              {mode === 'dropCreate' ? 'Existing tables with these names will be dropped' : 'All rows of existing tables with these names will be deleted'} in <b>{sqlConn?.name}</b>
              {tables ? ` (${tables} table${tables === 1 ? '' : 's'})` : ''}. Continue?
            </>
          ),
          confirmLabel: mode === 'dropCreate' ? 'Drop & migrate' : 'Empty & migrate',
          danger: true
        })
        if (!ok) return
      }
    }
    try {
      setJobId(await migrationApi.migrationStartToSql({ ...req, target }))
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const saveTask = async (): Promise<void> => {
    if (!req || problem) return
    let target = req.target
    if (target.kind === 'file') {
      const path = await api.saveFile({ title: 'SQL script written by the task', defaultPath: `${db}-${target.dialect}.sql`, filters: [{ name: 'SQL script', extensions: ['sql'] }] })
      if (!path) return
      target = { ...target, path }
    }
    const into = target.kind === 'file' ? (target.path.split(/[\\/]/).pop() ?? 'SQL') : (sqlConn?.name ?? 'SQL')
    await openSaveTaskDialog({ kind: 'sqlExport', request: { ...req, target } }, `Migrate ${db} → ${into}`)
  }

  const tables = preview.value?.tables ?? []
  const shownTable = tables.find((t) => t.name === dataTable) ?? tables.find((t) => t.coll === selected) ?? tables[0]
  const shownRows = preview.value?.rows.find((r) => r.table === shownTable?.name)
  const warnings = preview.value?.warnings ?? []

  if (!connected)
    return (
      <div className="mig-main" hidden={hidden}>
        <div className="mig-empty">
          <Icon name="unplug" size={34} />
          <h3>Disconnected</h3>
          <p className="muted">Reconnect to {db} to migrate its collections.</p>
        </div>
      </div>
    )

  return (
    <div className="mig-main" hidden={hidden}>
      <div className="mig-cols">
        <section className="mig-mid">
          <div className="mig-sec-head">
            <span className="mig-label">Collections</span>
            <span className="badge">{checked.length}</span>
            <span className="spacer" />
            <button className="btn ghost small" onClick={() => setChecked(colls ?? [])} disabled={!colls?.length}>
              All
            </button>
            <button className="btn ghost small" onClick={() => setChecked([])} disabled={!checked.length}>
              None
            </button>
          </div>
          <div className="mig-list">
            {!colls && <div className="faint mig-pad">Loading…</div>}
            {colls?.length === 0 && <div className="faint mig-pad">No collections in {db}</div>}
            {colls?.map((c) => {
              const on = checked.includes(c)
              const n = tables.filter((t) => t.coll === c).length
              return (
                <div key={c} className={`mig-item ${selected === c ? 'sel' : ''} ${on ? '' : 'off'}`} onClick={() => (on ? setSelected(c) : toggleColl(c, true))}>
                  <input type="checkbox" checked={on} onClick={(e) => e.stopPropagation()} onChange={(e) => toggleColl(c, e.target.checked)} />
                  <Icon name="collection" size={13} className="mig-item-ico" />
                  <span className="ellipsis grow">{c}</span>
                  {analyzing.has(c) ? <span className="mig-spinner" /> : on && n > 0 ? <span className="badge" title={`${n} table(s)`}>{n}</span> : null}
                </div>
              )
            })}
          </div>
          <div className="mig-mid-foot">
            <label className="faint mig-small" title="Documents sampled to infer the mapping">
              Sample
            </label>
            <input className="input small" type="number" min={1} value={sample} onChange={(e) => setSample(Math.max(1, Number(e.target.value) || 1))} style={{ width: 80 }} />
            <span className="spacer" />
            <button className="btn small" disabled={!checked.length || analyzing.size > 0} onClick={() => void analyze(checked, true)} title="Infer the mapping again (resets your edits)">
              <Icon name="refresh" size={12} /> Re-analyze
            </button>
          </div>
        </section>

        <section className="mig-right">
          {!cur ? (
            <div className="mig-intro">
              <Icon name="sql" size={34} />
              <h3>MongoDB → SQL</h3>
              <p className="muted">
                Choose collections: a relational mapping is inferred from a sample. Nested objects become flattened columns (or 1:1 tables), arrays become child tables
                with a foreign key to the parent <span className="mono">_id</span>. Review and edit it, then create the tables on a SQL connection or generate a .sql script.
              </p>
            </div>
          ) : (
            <>
              <div className="mig-map-head">
                <Icon name="table" size={14} className="mig-accent" />
                <input className="input small mono mig-table-name" value={cur.table} onChange={(e) => patchColl({ table: e.target.value })} title="Root table name" />
                <span className="faint mig-small ellipsis">
                  from <b>{cur.coll}</b> · {cur.sampled.toLocaleString()} sampled
                </span>
                <span className="spacer" />
                <label className="faint mig-small">Filter</label>
                <div className={`mig-filter ${filterValid ? '' : 'invalid'}`}>
                  <CodeEditor value={filterText} onChange={setFilter} invalid={!filterValid} placeholder="{ } — all documents" maxHeight={60} />
                </div>
              </div>
              <div className="mig-fields">
                <div className="mig-frow head">
                  <span>
                    <input
                      type="checkbox"
                      checked={cur.fields.every((f) => f.include)}
                      onChange={(e) => patchColl({ fields: setAll(cur.fields, e.target.checked) })}
                      title="All fields"
                    />
                  </span>
                  <span>Field</span>
                  <span>Type</span>
                  <span>Store as</span>
                  <span>Column / table</span>
                  <span>SQL type</span>
                </div>
                {ctx && <FieldRows fields={cur.fields} depth={0} at={[]} base="" off={false} ctx={ctx} />}
              </div>
              <datalist id={`mig-types-${tab.id}`}>
                {types.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <div className="mig-preview">
                <div className="mig-tabs">
                  <button className={pane === 'ddl' ? 'on' : ''} onClick={() => setPane('ddl')}>
                    DDL
                  </button>
                  <button className={pane === 'data' ? 'on' : ''} onClick={() => setPane('data')}>
                    Rows
                  </button>
                  <button className={pane === 'warnings' ? 'on' : ''} onClick={() => setPane('warnings')}>
                    Warnings {warnings.length > 0 && <span className="badge warn">{warnings.length}</span>}
                  </button>
                  <span className="spacer" />
                  {preview.loading && <span className="mig-spinner" />}
                  {pane === 'data' && tables.length > 0 && (
                    <select className="select small" value={shownTable?.name ?? ''} onChange={(e) => setDataTable(e.target.value)}>
                      {tables.map((t) => (
                        <option key={t.id} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {pane === 'ddl' && preview.value && (
                    <button className="btn ghost small" onClick={() => void api.copyText(preview.value!.ddl).then(() => toast('DDL copied', 'success'))}>
                      <Icon name="copy" size={12} /> Copy
                    </button>
                  )}
                </div>
                <div className="mig-preview-body">
                  {preview.error && <div className="notice error mig-m">{preview.error}</div>}
                  {!preview.error && pane === 'ddl' && <pre className="mig-ddl selectable">{preview.value?.ddl ?? ''}</pre>}
                  {!preview.error && pane === 'data' && (shownRows ? <PreviewTable columns={shownRows.columns} rows={shownRows.rows} /> : <div className="faint mig-pad">No rows</div>)}
                  {!preview.error && pane === 'warnings' && (
                    <div className="mig-warnings">
                      {warnings.length ? warnings.map((w, i) => (
                        <div key={i} className="mig-warning">
                          <Icon name="warn" size={12} /> <span className="selectable">{w}</span>
                        </div>
                      )) : <div className="faint">No conversion warnings in the sample</div>}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <footer className="mig-foot">
        <div className="mig-opt">
          <label className="mig-label">Target</label>
          <div className="segmented small">
            <button className={targetKind === 'connection' ? 'on' : ''} onClick={() => setTargetKind('connection')} title="Create tables and insert rows on the SQL connection">
              <Icon name="database" size={12} /> {sqlConn ? sqlConn.name : 'SQL connection'}
            </button>
            <button className={targetKind === 'file' ? 'on' : ''} onClick={() => setTargetKind('file')} title="Write CREATE TABLE and INSERT statements to a file">
              <Icon name="export" size={12} /> .sql file
            </button>
          </div>
          {targetKind === 'file' && (
            <select className="select small" value={fileDialect} onChange={(e) => setFileDialect(e.target.value as SqlDialect)} title="SQL dialect of the script">
              {SQL_DIALECTS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="mig-opt">
          <label className="mig-label">Schema</label>
          <input className="input small mono" value={schema} onChange={(e) => setSchema(e.target.value)} placeholder={dialect === 'postgres' ? 'public' : dialect === 'mssql' ? 'dbo' : 'default'} style={{ width: 100 }} disabled={dialect === 'sqlite'} />
        </div>
        <div className="mig-opt">
          <label className="mig-label">Mode</label>
          <select className="select small" value={mode} onChange={(e) => setMode(e.target.value as ToSqlRunMode)} title={MODES.find((m) => m.id === mode)?.hint}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="mig-opt">
          <label className="mig-label" title="Documents per transaction">
            Batch
          </label>
          <input className="input small" type="number" min={1} value={batch} onChange={(e) => setBatch(Math.max(1, Number(e.target.value) || 1))} style={{ width: 76 }} />
        </div>
        <span className="spacer" />
        <JobStatus job={job} onCancel={() => jobId && void migrationApi.migrationCancel(jobId)} extra={lastFile && job?.state === 'done' ? (
          <button className="btn small" onClick={() => void api.revealPath(lastFile)}>
            Show file
          </button>
        ) : null} />
        {!running && (
          <button className="btn" onClick={() => void saveTask()} disabled={!!problem} title={problem ?? 'Run this migration again later, on demand or on a schedule'}>
            <Icon name="tasks" size={13} /> Save as task…
          </button>
        )}
        {!running && (
          <button className="btn primary" onClick={() => void start()} disabled={!!problem} title={problem ?? (dialect ? `${dialectLabel(dialect)}` : '')}>
            <Icon name={targetKind === 'file' ? 'export' : 'play'} size={13} /> {targetKind === 'file' ? 'Generate .sql…' : 'Migrate'}
          </button>
        )}
      </footer>
    </div>
  )
}
