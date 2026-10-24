import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { DatabaseInfo, Doc } from '@shared/api'
import type { CopyConflict, CopyItem, CopyOptions, CopyPlanEntry, CopyRequest } from '@shared/copyApi'
import { COPY_CONFLICT_LABELS } from '@shared/copyApi'
import { api, onEvent } from '../../lib/api'
import { tryParse } from '../../lib/queryText'
import { connName, errorText, refreshCollections, refreshDatabases, toast, useStore } from '../../state/store'
import type { TreeClipboard } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { copyApi } from './copyClient'
import './copy.css'

export interface PasteRequest {
  source: TreeClipboard
  target: { connId: string; db?: string }
}

interface Row {
  source: string
  target: string
  type: CopyPlanEntry['type']
  count: number
  viewOn?: string
  checked: boolean
  /** The user typed a target name: keep it when the target database changes. */
  edited: boolean
}

const fmt = (n: number): string => n.toLocaleString()

const CONFLICT_HINTS: Record<CopyConflict, string> = {
  abort: 'Stop before writing anything if a target collection exists',
  drop: 'Drop existing target collections, then copy',
  merge: 'Insert into existing collections, skip documents whose _id already exists',
  replace: 'Insert new documents and replace existing ones with the same _id'
}

/** First free name among `base`, `base_copy`, `base_copy2`… */
function freeName(base: string, taken: Set<string>, forceCopy: boolean, existing: Set<string> = taken): string {
  if (!forceCopy && !taken.has(base)) return base
  // GridFS collections keep their bucket pairing: fs.files → fs_copy.files.
  const gfs = /^(.+)\.(files|chunks)$/.exec(base)
  const name = (n: string): string => (gfs ? `${gfs[1]}_copy${n}.${gfs[2]}` : `${base}_copy${n}`)
  const free = (n: string): boolean => !taken.has(name(n)) && (!gfs || !existing.has(`${gfs[1]}_copy${n}.${gfs[2] === 'files' ? 'chunks' : 'files'}`))
  if (free('')) return name('')
  for (let i = 2; ; i++) if (free(String(i))) return name(String(i))
}

function defaultTargetDb(req: PasteRequest, dbs: string[]): string {
  const s = req.source
  if (req.target.db) return req.target.db
  if (s.kind === 'collection') return s.db
  if (req.target.connId !== s.connId) return s.db
  return freeName(s.db, new Set(dbs), true)
}

function TypeIcon({ type }: { type: Row['type'] }): ReactElement {
  return <Icon name={type === 'view' ? 'view' : 'collection'} size={13} className={`cp-type cp-type-${type}`} />
}

function PasteBody({ req, close }: { req: PasteRequest; close: (jobId: string | null) => void }): ReactElement {
  const src = req.source
  const live = useStore((s) => s.live)
  const sourceLive = !!live[src.connId]
  const targetLive = !!live[req.target.connId]
  const sameConn = src.connId === req.target.connId
  const isDb = src.kind === 'database'

  const [dbs, setDbs] = useState<DatabaseInfo[] | null>(null)
  const [targetDb, setTargetDb] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [existing, setExisting] = useState<Set<string> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')
  const [fields, setFields] = useState<string[]>([])
  const [opts, setOpts] = useState<CopyOptions>({ documents: true, indexes: true, collectionOptions: true, views: true, conflict: 'abort', batchSize: 1000 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const patchOpts = (p: Partial<CopyOptions>): void => setOpts((o) => ({ ...o, ...p }))

  // Target databases (for the default name and the datalist).
  useEffect(() => {
    if (!targetLive) return
    api
      .listDatabases(req.target.connId)
      .then((list) => {
        setDbs(list)
        setTargetDb((cur) => cur ?? defaultTargetDb(req, list.map((d) => d.name)))
      })
      .catch(() => {
        setDbs([])
        setTargetDb((cur) => cur ?? defaultTargetDb(req, []))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.target.connId, targetLive])

  // Source entries: the whole database or the copied collections.
  useEffect(() => {
    if (!sourceLive || targetDb === null || rows) return
    const items: CopyItem[] | undefined = src.kind === 'collection' ? src.colls.map((c) => ({ source: c, target: c })) : undefined
    copyApi
      .copyPlan({ source: { connId: src.connId, db: src.db }, target: { connId: req.target.connId, db: targetDb || src.db }, items, options: opts })
      .then((plan) => {
        if (plan.missing.length) setLoadError(`No longer in ${src.db}: ${plan.missing.join(', ')}`)
        setRows(plan.entries.map((e) => ({ source: e.source, target: e.source, type: e.type, count: e.count, viewOn: e.viewOn, checked: true, edited: false })))
        if (plan.entries.length && plan.entries.every((e) => e.type === 'view')) patchOpts({ views: true })
      })
      .catch((e) => setLoadError(errorText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceLive, targetDb === null])

  // Collections already in the target database.
  useEffect(() => {
    if (targetDb === null || !targetLive) return
    setExisting(null)
    const name = targetDb.trim()
    if (!name) return
    let alive = true
    const t = setTimeout(() => {
      api
        .listCollections(req.target.connId, name)
        .then((list) => alive && setExisting(new Set(list.map((c) => c.name))))
        .catch(() => alive && setExisting(new Set()))
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [targetDb, req.target.connId, targetLive])

  // Default target names: `<name>_copy` when pasting into the source database itself.
  const intoSource = sameConn && (targetDb ?? '').trim() === src.db
  useEffect(() => {
    if (!rows || !existing) return
    const taken = new Set(existing)
    setRows((rs) =>
      rs!.map((r) => {
        if (r.edited) return r
        // Elsewhere keep the name: an existing collection is handled by the conflict policy.
        const target = intoSource ? freeName(r.source, taken, true, existing) : r.source
        taken.add(target)
        return target === r.target ? r : { ...r, target }
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, intoSource, rows === null])

  const single = rows && rows.length === 1 && rows[0].type !== 'view' && src.kind === 'collection' ? rows[0] : null
  useEffect(() => {
    if (!single || !sourceLive) return
    api
      .sampleFields(src.connId, src.db, single.source, 200)
      .then(setFields)
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single?.source, sourceLive])

  const chosen = (rows ?? []).filter((r) => r.checked)
  const views = (rows ?? []).filter((r) => r.type === 'view')
  const effective = chosen.filter((r) => r.type !== 'view' || opts.views)
  const conflicts = existing ? effective.filter((r) => existing.has(r.target.trim())) : []
  const docTotal = effective.filter((r) => r.type !== 'view').reduce((n, r) => n + Math.max(0, r.count), 0)
  const filter = single ? tryParse('query', filterText) : {}

  const problem = ((): string | null => {
    if (!sourceLive) return `The source connection (${connName(src.connId)}) is closed. Copy again after reconnecting.`
    if (!targetLive) return 'The target connection is closed.'
    const db = (targetDb ?? '').trim()
    if (!db) return 'Enter a target database name.'
    if (/[/\\. "$*<>:|?]/.test(db)) return 'The database name contains invalid characters.'
    if (!rows) return null
    if (!effective.length) return chosen.length ? 'Enable "Views" to copy the selected views.' : 'Select at least one collection.'
    const seen = new Set<string>()
    for (const r of effective) {
      const t = r.target.trim()
      if (!t) return `Enter a target name for ${r.source}.`
      if (t.includes('$') || t.startsWith('system.')) return `"${t}" is not a valid collection name.`
      if (seen.has(t)) return `Two collections would be copied to "${t}".`
      seen.add(t)
      if (intoSource && t === r.source) return `"${t}" would be copied onto itself; rename the target.`
    }
    if (filter === undefined) return 'The filter is not valid.'
    return null
  })()

  const willAbort = opts.conflict === 'abort' && conflicts.length > 0

  const setRow = (i: number, p: Partial<Row>): void => setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...p } : r)))

  const start = async (): Promise<void> => {
    if (problem || !rows) return
    setBusy(true)
    setError(null)
    const db = (targetDb ?? '').trim()
    const items: CopyItem[] = effective.map((r) => {
      const it: CopyItem = { source: r.source, target: r.target.trim() }
      if (single && filter && Object.keys(filter).length) it.filter = filter as Doc
      return it
    })
    const wholeDb = isDb && effective.length === rows.length && effective.every((r) => r.target.trim() === r.source)
    const request: CopyRequest = { source: { connId: src.connId, db: src.db }, target: { connId: req.target.connId, db }, items: wholeDb ? undefined : items, options: opts }
    try {
      const jobId = await copyApi.copyStart(request)
      const off = onEvent('job:progress', (p) => {
        if (p.jobId !== jobId || p.state === 'running') return
        off()
        if (!useStore.getState().live[req.target.connId]) return
        void refreshDatabases(req.target.connId)
        void refreshCollections(req.target.connId, db)
        if (p.state === 'done') toast(`Copy finished: ${p.message ?? ''}`, 'success')
      })
      close(jobId)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  const title = isDb ? `Paste Database "${src.db}"` : src.colls.length > 1 ? `Paste ${src.colls.length} Collections` : `Paste "${src.colls[0]}"`
  const allChecked = !!rows && rows.every((r) => r.checked)

  return (
    <Modal
      title={title}
      icon="paste"
      width={720}
      onClose={() => close(null)}
      footer={
        <>
          <span className="cp-foot-summary muted ellipsis">
            {rows && !problem && (
              <>
                {effective.length} {effective.length === 1 ? 'item' : 'items'}
                {opts.documents && docTotal > 0 && <> · ~{fmt(docTotal)} documents</>}
                {conflicts.length > 0 && <> · {conflicts.length} existing</>}
              </>
            )}
          </span>
          <button className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className={`btn ${opts.conflict === 'drop' && conflicts.length ? 'danger solid' : 'primary'}`} disabled={busy || !!problem || !rows || willAbort} onClick={() => void start()}>
            <Icon name="paste" size={13} /> {opts.conflict === 'drop' && conflicts.length ? 'Drop & Paste' : 'Paste'}
          </button>
        </>
      }
    >
      <div className="cp">
        <div className="cp-flow">
          <div className="cp-end source">
            <div className="cp-end-label">From</div>
            <div className="cp-end-conn ellipsis" title={connName(src.connId)}>
              <Icon name="server" size={12} /> {connName(src.connId)}
            </div>
            <div className="cp-end-ns mono ellipsis" title={src.db}>
              <Icon name="database" size={12} /> {src.db}
            </div>
          </div>
          <div className="cp-flow-arrow">
            <Icon name="chevronRight" size={18} />
          </div>
          <div className="cp-end target">
            <div className="cp-end-label">To</div>
            <div className="cp-end-conn ellipsis" title={connName(req.target.connId)}>
              <Icon name="server" size={12} /> {connName(req.target.connId)}
              {sameConn && <span className="badge">same connection</span>}
            </div>
            <div className="cp-end-ns">
              <Icon name="database" size={12} />
              <input
                className="input small mono grow"
                list="cp-dbs"
                value={targetDb ?? ''}
                placeholder="database"
                disabled={targetDb === null}
                onChange={(e) => setTargetDb(e.target.value)}
              />
              <datalist id="cp-dbs">
                {(dbs ?? []).map((d) => (
                  <option key={d.name} value={d.name} />
                ))}
              </datalist>
              {targetDb !== null && dbs && !dbs.some((d) => d.name === targetDb.trim()) && targetDb.trim() && <span className="badge cp-new">new</span>}
            </div>
          </div>
        </div>

        <div className="cp-list">
          <div className="cp-list-head">
            <label className="check">
              <input type="checkbox" checked={allChecked} disabled={!rows || rows.length < 2} onChange={(e) => setRows((rs) => rs!.map((r) => ({ ...r, checked: e.target.checked })))} />
            </label>
            <span className="grow">Source</span>
            <span className="cp-col-arrow" />
            <span className="cp-col-target">Target name</span>
            <span className="cp-col-count">Documents</span>
            <span className="cp-col-state" />
          </div>
          <div className="cp-list-body">
            {!rows && !loadError && <div className="cp-empty faint">Reading {src.db}…</div>}
            {loadError && <div className="cp-empty error-text">{loadError}</div>}
            {rows && !rows.length && !loadError && <div className="cp-empty faint">{src.db} has no collections.</div>}
            {rows?.map((r, i) => {
              const exists = !!existing?.has(r.target.trim())
              const off = !r.checked || (r.type === 'view' && !opts.views)
              return (
                <div key={r.source} className={`cp-row ${off ? 'off' : ''}`}>
                  <label className="check">
                    <input type="checkbox" checked={r.checked} disabled={rows.length < 2} onChange={(e) => setRow(i, { checked: e.target.checked })} />
                  </label>
                  <span className="grow cp-src ellipsis" title={r.viewOn ? `View on ${r.viewOn}` : r.source}>
                    <TypeIcon type={r.type} />
                    <span className="mono">{r.source}</span>
                    {r.type !== 'collection' && <span className="badge">{r.type}</span>}
                  </span>
                  <span className="cp-col-arrow faint">→</span>
                  <input className={`input small mono cp-col-target ${exists && !off ? 'cp-exists' : ''}`} value={r.target} disabled={off} onChange={(e) => setRow(i, { target: e.target.value, edited: true })} />
                  <span className="cp-col-count faint mono">{r.type === 'view' ? '—' : r.count < 0 ? '?' : fmt(r.count)}</span>
                  <span className="cp-col-state">
                    {!off && existing && (exists ? <span className={`cp-pill ${opts.conflict === 'abort' ? 'bad' : 'warn'}`}>exists</span> : <span className="cp-pill new">new</span>)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {single && (
          <div className="cp-filter">
            <label className="cp-label">
              Filter <span className="faint">(optional — copy only matching documents)</span>
            </label>
            <CodeEditor value={filterText} onChange={setFilterText} fields={fields} invalid={filter === undefined} placeholder="{ } — all documents" maxHeight={80} />
          </div>
        )}

        <div className="cp-options">
          <div className="cp-opt-group">
            <div className="cp-label">Copy</div>
            <label className="check">
              <input type="checkbox" checked={opts.documents} onChange={(e) => patchOpts({ documents: e.target.checked })} /> Documents
            </label>
            <label className="check">
              <input type="checkbox" checked={opts.indexes} onChange={(e) => patchOpts({ indexes: e.target.checked })} /> Indexes
            </label>
            <label className="check" title="Validator, collation, capped, time-series and clustered options">
              <input type="checkbox" checked={opts.collectionOptions} onChange={(e) => patchOpts({ collectionOptions: e.target.checked })} /> Collection options
            </label>
            {views.length > 0 && (
              <label className="check" title="Recreated last, with the same pipeline">
                <input type="checkbox" checked={opts.views} onChange={(e) => patchOpts({ views: e.target.checked })} /> Views ({views.length})
              </label>
            )}
          </div>
          <div className="cp-opt-group grow">
            <div className="cp-label">If a target collection exists</div>
            <div className="cp-conflicts">
              {(Object.keys(COPY_CONFLICT_LABELS) as CopyConflict[]).map((c) => (
                <label key={c} className={`cp-conflict ${opts.conflict === c ? 'on' : ''} ${c === 'drop' ? 'danger' : ''}`} title={CONFLICT_HINTS[c]}>
                  <input type="radio" name="cp-conflict" checked={opts.conflict === c} onChange={() => patchOpts({ conflict: c })} />
                  {COPY_CONFLICT_LABELS[c]}
                </label>
              ))}
            </div>
          </div>
          <div className="cp-opt-group">
            <div className="cp-label">Batch size</div>
            <input className="input small mono cp-batch" type="number" min={1} max={100000} value={opts.batchSize} onChange={(e) => patchOpts({ batchSize: Math.max(1, Number(e.target.value) || 1) })} />
          </div>
        </div>

        {willAbort && (
          <div className="notice cp-msg">
            {conflicts.length === 1 ? (
              <>
                <b className="mono">{conflicts[0].target}</b> already exists in {targetDb}.
              </>
            ) : (
              <>
                {conflicts.length} target collections already exist in {targetDb}.
              </>
            )}{' '}
            Rename the target, or choose what to do with existing collections.
          </div>
        )}
        {opts.conflict === 'drop' && conflicts.length > 0 && (
          <div className="notice error cp-msg">
            <Icon name="warn" size={13} /> {conflicts.map((c) => c.target).join(', ')} will be dropped before copying.
          </div>
        )}
        {problem && <div className="error-text cp-msg">{problem}</div>}
        {error && <div className="notice error cp-msg selectable">{error}</div>}
      </div>
    </Modal>
  )
}

/** Paste copied collections / a copied database into a connection or database (runs as a job). */
export function openPasteDialog(req: PasteRequest): Promise<string | null> {
  return openModal<string | null>((close) => <PasteBody req={req} close={close} />)
}
