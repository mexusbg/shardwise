import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { JSON_FLAVOR_LABELS, TEXT_ENCODING_LABELS } from '@shared/api'
import type { CollectionInfo, CsvColumnType, ExportRequest, FileDialogOptions, FilePreview, ImportRequest, JsonFlavor, TextEncoding, ToolsStatus, TransferFormat } from '@shared/api'
import { cellText, shellText } from '@shared/bsonValue'
import { exportScopes } from '@shared/exportScopes'
import type { ExportScope, ExportScopeId } from '@shared/exportScopes'
import { api } from '../../lib/api'
import { connName, errorText, toast } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { openSaveTaskDialog } from '../tasks/SaveTaskDialog'
import './transfer.css'

/** What the jobs panel needs to know about a job this UI started. */
export interface JobMeta {
  kind: 'import' | 'export'
  connId: string
  db: string
  target?: string
}
export const jobMeta = new Map<string, JobMeta>()

type Filters = NonNullable<FileDialogOptions['filters']>

const FORMATS: { id: TransferFormat; label: string; sub: string; icon: string }[] = [
  { id: 'json', label: 'JSON', sub: 'Shell / EJSON / pure', icon: 'json' },
  { id: 'csv', label: 'CSV', sub: 'Delimited text', icon: 'table' },
  { id: 'xlsx', label: 'Excel', sub: '.xlsx workbook', icon: 'table' },
  { id: 'bson-folder', label: 'BSON folder', sub: 'mongodump', icon: 'folder' },
  { id: 'bson-archive', label: 'BSON archive', sub: 'mongodump --archive', icon: 'database' }
]

const FILE_FILTERS: Record<TransferFormat, Filters> = {
  json: [{ name: 'JSON', extensions: ['json', 'jsonl', 'ndjson'] }],
  csv: [{ name: 'CSV / delimited text', extensions: ['csv', 'tsv', 'txt'] }],
  xlsx: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  'bson-folder': [],
  'bson-archive': [{ name: 'mongodump archive', extensions: ['archive', 'gz'] }]
}
const ALL_FILES = { name: 'All files', extensions: ['*'] }
const ALL_SUPPORTED = { name: 'All supported files', extensions: ['json', 'jsonl', 'ndjson', 'csv', 'tsv', 'txt', 'xlsx', 'archive', 'gz'] }

const DELIMS: [string, string][] = [
  [',', 'Comma ( , )'],
  [';', 'Semicolon ( ; )'],
  ['\t', 'Tab'],
  ['|', 'Pipe ( | )']
]

const COLUMN_TYPES: [CsvColumnType, string][] = [
  ['auto', 'Auto'],
  ['string', 'String'],
  ['number', 'Number'],
  ['bool', 'Boolean'],
  ['date', 'Date'],
  ['objectId', 'ObjectId'],
  ['skip', 'Skip column']
]

const isBson = (f: TransferFormat): boolean => f === 'bson-folder' || f === 'bson-archive'
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const withExt = (p: string, ext: string): string => (/\.(json|csv|xlsx|archive\.gz|archive)$/i.test(p) ? p.replace(/\.(json|csv|xlsx|archive\.gz|archive)$/i, ext) : p)

function detectFormat(path: string, current: TransferFormat): TransferFormat {
  const p = path.toLowerCase()
  if (/\.(json|jsonl|ndjson)$/.test(p)) return 'json'
  if (/\.(csv|tsv)$/.test(p)) return 'csv'
  if (p.endsWith('.xlsx')) return 'xlsx'
  if (/\.(archive|gz)$/.test(p)) return 'bson-archive'
  return current
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Field({ label, children, top }: { label: string; children: ReactNode; top?: boolean }): ReactElement {
  return (
    <div className={`field ${top ? 'top' : ''}`}>
      <label>{label}</label>
      <div className="row">{children}</div>
    </div>
  )
}

function Section({ n, title, aside, children }: { n: number; title: string; aside?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section className="tr-section">
      <div className="tr-section-head">
        <span className="tr-step">{n}</span>
        <span>{title}</span>
        <span className="spacer" />
        {aside}
      </div>
      {children}
    </section>
  )
}

export const Spinner = ({ size = 13 }: { size?: number }): ReactElement => <Icon name="refresh" size={size} className="tr-spin" />

function FormatCards({ formats, value, onChange }: { formats: typeof FORMATS; value: TransferFormat; onChange: (f: TransferFormat) => void }): ReactElement {
  return (
    <div className="tr-formats">
      {formats.map((f) => (
        <button key={f.id} className={`tr-format ${value === f.id ? 'on' : ''}`} onClick={() => onChange(f.id)}>
          <Icon name={f.icon} size={18} />
          <b>{f.label}</b>
          <small>{f.sub}</small>
        </button>
      ))}
    </div>
  )
}

function CheckList(p: { items: string[]; selected: string[]; onChange: (s: string[]) => void; render?: (s: string) => ReactNode; grid?: boolean; empty?: string }): ReactElement {
  const toggle = (x: string): void => p.onChange(p.selected.includes(x) ? p.selected.filter((y) => y !== x) : [...p.selected, x])
  return (
    <div className={`list tr-checklist ${p.grid ? 'tr-grid' : ''}`}>
      {p.items.map((x) => (
        <label key={x} className="list-row check">
          <input type="checkbox" checked={p.selected.includes(x)} onChange={() => toggle(x)} />
          {p.render ? p.render(x) : <span className="ellipsis" title={x}>{x}</span>}
        </label>
      ))}
      {!p.items.length && <div className="list-row faint">{p.empty ?? 'Nothing to show'}</div>}
    </div>
  )
}

function AllNone({ items, selected, onChange }: { items: string[]; selected: string[]; onChange: (s: string[]) => void }): ReactElement {
  return (
    <span className="row">
      <span className="faint tr-small">
        {selected.length} of {items.length} selected
      </span>
      <button className="btn ghost small" onClick={() => onChange([...new Set([...selected, ...items])])}>
        All
      </button>
      <button className="btn ghost small" onClick={() => onChange(selected.filter((s) => !items.includes(s)))}>
        None
      </button>
    </span>
  )
}

function DelimiterInput({ value, onChange }: { value: string; onChange: (v: string) => void }): ReactElement {
  const [custom, setCustom] = useState(!DELIMS.some(([d]) => d === value))
  return (
    <>
      <select
        className="select"
        value={custom ? 'custom' : value}
        onChange={(e) => {
          const v = e.target.value
          setCustom(v === 'custom')
          if (v !== 'custom') onChange(v)
        }}
      >
        {DELIMS.map(([d, l]) => (
          <option key={l} value={d}>
            {l}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom && <input className={`input mono tr-delim ${value ? '' : 'invalid'}`} value={value} maxLength={4} placeholder="e.g. ~" onChange={(e) => onChange(e.target.value)} autoFocus />}
    </>
  )
}

function PathInput(p: { value: string; onChange: (v: string) => void; onCommit?: (v: string) => void; onBrowse: () => void; placeholder: string; browseLabel?: string }): ReactElement {
  return (
    <>
      <input
        className="input grow mono"
        value={p.value}
        placeholder={p.placeholder}
        spellCheck={false}
        onChange={(e) => p.onChange(e.target.value)}
        onBlur={(e) => p.onCommit?.(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && p.onCommit?.(e.currentTarget.value)}
      />
      <button className="btn" onClick={p.onBrowse}>
        <Icon name="folder" size={14} />
        {p.browseLabel ?? 'Browse…'}
      </button>
    </>
  )
}

function useTools(active: boolean): { status: ToolsStatus | null; busy: boolean; download: () => Promise<void> } {
  const [status, setStatus] = useState<ToolsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (active && !status) api.toolsStatus().then(setStatus, () => setStatus({ found: false }))
  }, [active, status])
  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.downloadTools()
      const s = await api.toolsStatus()
      setStatus(s)
      if (s.found) toast(`MongoDB Database Tools ${s.version ?? ''} installed`, 'success')
      else toast('Download finished but the tools were not found', 'error')
    } catch (e) {
      toast(`Could not download the tools: ${errorText(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  return { status, busy, download }
}

function ToolsNotice({ t }: { t: ReturnType<typeof useTools> }): ReactElement {
  if (!t.status)
    return (
      <div className="row muted tr-small">
        <Spinner /> Looking for mongodump / mongorestore…
      </div>
    )
  if (t.status.found)
    return (
      <div className="row faint tr-small">
        <Icon name="check" size={13} className="tr-ok" />
        <span className="ellipsis">
          MongoDB Database Tools {t.status.version ?? ''}
          {t.status.dir && <> — <span className="mono">{t.status.dir}</span></>}
        </span>
      </div>
    )
  return (
    <div className="notice col">
      <div className="row">
        <Icon name="warn" />
        <b>mongodump/mongorestore (MongoDB Database Tools) not found</b>
      </div>
      <div className="muted">Shardwise can download the official tools for this computer. You can also point to an existing install folder in Settings.</div>
      <div className="row">
        <button className="btn" disabled={t.busy} onClick={() => void t.download()}>
          {t.busy ? <Spinner /> : <Icon name="import" size={14} />}
          {t.busy ? 'Downloading…' : 'Download tools'}
        </button>
      </div>
    </div>
  )
}

function Footer(p: { error: string | null; busy: boolean; label: string; onCancel: () => void; onStart: () => void; onSave?: () => void }): ReactElement {
  const { error, busy, label, onCancel, onStart, onSave } = p
  return (
    <>
      <span className="tr-foot-msg ellipsis">{error}</span>
      {onSave && (
        <button className="btn" disabled={!!error || busy} onClick={onSave} title="Save this job as a task to run again or on a schedule">
          <Icon name="tasks" size={13} /> Save as task…
        </button>
      )}
      <button className="btn" onClick={onCancel}>
        Cancel
      </button>
      <button className="btn primary" disabled={!!error || busy} onClick={onStart}>
        {busy ? <Spinner /> : <Icon name="play" size={12} />}
        {label}
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface ExportOpts {
  connId: string
  db: string
  collections?: string[]
  /** From a collection tab: which documents of collections[0] can be exported (query result, page, selection, all). */
  scopes?: ExportScope[]
  /** Preselected scope. */
  scope?: ExportScopeId
}

function hasKeys(d: unknown): boolean {
  return !!d && typeof d === 'object' && Object.keys(d).length > 0
}

function QueryBox({ q }: { q: NonNullable<ExportRequest['query']> }): ReactElement {
  const rows: [string, string][] = [['filter', shellText(q.filter ?? {})]]
  if (hasKeys(q.projection)) rows.push(['projection', shellText(q.projection)])
  if (hasKeys(q.sort)) rows.push(['sort', shellText(q.sort)])
  if (q.skip) rows.push(['skip', String(q.skip)])
  if (q.limit) rows.push(['limit', String(q.limit)])
  if (hasKeys(q.collation)) rows.push(['collation', shellText(q.collation)])
  return (
    <div className="tr-query mono selectable">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span className="faint">{k}:</span> {v}
        </div>
      ))}
    </div>
  )
}

function ExportDialog({ o, close }: { o: ExportOpts; close: () => void }): ReactElement {
  const [format, setFormat] = useState<TransferFormat>('json')
  const [colls, setColls] = useState<CollectionInfo[] | null>(null)
  const [sel, setSel] = useState<string[]>(o.collections ?? [])
  const [filter, setFilter] = useState('')
  const [scopeId, setScopeId] = useState<ExportScopeId | undefined>(o.scope ?? o.scopes?.find((x) => !x.disabled)?.id)
  const [queryCount, setQueryCount] = useState<number | null>(o.scopes?.find((x) => x.id === 'query')?.count ?? null)
  const [flavor, setFlavor] = useState<JsonFlavor>('shell')
  const [layout, setLayout] = useState<'lines' | 'array'>('array')
  const [pretty, setPretty] = useState(true)
  const [delimiter, setDelimiter] = useState(',')
  const [header, setHeader] = useState(true)
  const [bom, setBom] = useState(true)
  const [fields, setFields] = useState<string[] | null>(null)
  const [fieldSel, setFieldSel] = useState<string[]>([])
  const [detecting, setDetecting] = useState(false)
  const [gzip, setGzip] = useState(false)
  const [file, setFile] = useState('')
  const [folder, setFolder] = useState('')
  const [starting, setStarting] = useState(false)
  const tools = useTools(isBson(format))

  useEffect(() => {
    // Runs after Modal's own autofocus, which would otherwise jump to an input further down.
    const modals = document.querySelectorAll('.modal')
    modals[modals.length - 1]?.querySelector<HTMLElement>('.tr-format.on')?.focus()
  }, [])

  useEffect(() => {
    api.listCollections(o.connId, o.db).then(
      (l) => {
        const sorted = [...l].sort((a, b) => a.name.localeCompare(b.name))
        setColls(sorted)
        if (sorted.length) setSel((s) => s.filter((n) => sorted.some((c) => c.name === n)))
      },
      (e) => {
        toast(`Could not list collections: ${errorText(e)}`, 'error')
        setColls([])
      }
    )
  }, [o.connId, o.db])

  // The tab may not have counted its query: count it here, within the query's skip and limit.
  useEffect(() => {
    const qs = o.scopes?.find((x) => x.id === 'query')
    if (!qs?.query || qs.count !== null || !o.collections?.[0]) return
    let alive = true
    const { filter, collation, skip = 0, limit = 0 } = qs.query
    api.count(o.connId, o.db, o.collections[0], filter, collation ?? null).then(
      (n) => alive && setQueryCount(limit ? Math.min(limit, Math.max(0, n - skip)) : Math.max(0, n - skip)),
      () => {}
    )
    return () => {
      alive = false
    }
  }, [o])

  const all = colls ?? (o.collections ?? []).map((name) => ({ name, type: 'collection' as const }))
  const names = all.map((c) => c.name)
  const visible = filter ? names.filter((n) => n.toLowerCase().includes(filter.toLowerCase())) : names
  const chosen = names.filter((n) => sel.includes(n))
  const typeOf = (n: string): CollectionInfo['type'] | undefined => all.find((c) => c.name === n)?.type

  // The tab's scopes apply while only the tab's own collection is chosen.
  const scopesApply = !!o.scopes && chosen.length === 1 && (!o.collections?.length || o.collections[0] === chosen[0])
  const scope = scopesApply ? o.scopes!.find((x) => x.id === scopeId) : undefined
  const countOf = (x: ExportScope): number | null => (x.id === 'query' ? queryCount : x.count)
  const q = scope?.query
  // mongodump takes only a filter: the page and the selection are exported by _id, but a query result's
  // projection, sort, skip and limit are dropped.
  const bsonDrops = isBson(format) && !!q && (hasKeys(q.projection) || hasKeys(q.sort) || !!q.skip || !!q.limit)
  const tabular = format === 'csv' || format === 'xlsx'
  const ext = format === 'bson-archive' ? (gzip ? '.archive.gz' : '.archive') : format === 'json' ? '.json' : format === 'csv' ? '.csv' : '.xlsx'
  const toFile = format === 'bson-archive' || (!isBson(format) && chosen.length === 1)
  const target = toFile ? (file ? withExt(file, ext) : '') : folder

  const browseFile = async (): Promise<void> => {
    const name = format === 'bson-archive' ? o.db : (chosen[0] ?? o.db)
    const r = await api.saveFile({ title: 'Export to file', defaultPath: target || `${name}${ext}`, filters: [...FILE_FILTERS[format], ALL_FILES] })
    if (r) setFile(r)
  }
  const browseFolder = async (): Promise<void> => {
    const r = await api.openFile({ title: 'Choose export folder', directory: true, defaultPath: folder || undefined })
    if (r?.[0]) setFolder(r[0])
  }

  const detect = async (): Promise<void> => {
    if (!chosen[0]) return
    setDetecting(true)
    try {
      const f = await api.sampleFields(o.connId, o.db, chosen[0], 1000)
      setFields(f)
      setFieldSel(f)
    } catch (e) {
      toast(`Could not sample fields: ${errorText(e)}`, 'error')
    } finally {
      setDetecting(false)
    }
  }

  const error = ((): string | null => {
    if (!colls) return 'Loading collections…'
    if (!chosen.length) return 'Select at least one collection'
    if (format === 'csv' && !delimiter) return 'Enter a delimiter'
    if (tabular && fields && !fieldSel.length) return 'Select at least one field'
    if (isBson(format) && !tools.status?.found) return tools.status ? 'MongoDB Database Tools are required' : 'Looking for MongoDB Database Tools…'
    if (!target.trim()) return toFile ? 'Choose a target file' : 'Choose a target folder'
    return null
  })()

  const build = (): ExportRequest => {
    const pickedFields = fields ? fields.filter((f) => fieldSel.includes(f)) : []
    const req: ExportRequest = { connId: o.connId, db: o.db, collections: chosen, format, target: target.trim() }
    if (q) req.query = q
    if (format === 'json') req.json = { flavor, layout, pretty }
    if (format === 'csv') req.csv = { fields: pickedFields, delimiter, header, bom }
    if (format === 'xlsx') req.xlsx = { fields: pickedFields }
    if (isBson(format)) req.bson = { gzip }
    return req
  }

  const saveTask = async (): Promise<void> => {
    const req = build()
    const what = req.collections.length === 1 ? req.collections[0] : req.db
    if (await openSaveTaskDialog({ kind: 'export', request: req }, `Export ${what}`)) close()
  }

  const start = async (): Promise<void> => {
    const req = build()
    setStarting(true)
    try {
      const jobId = await api.startExport(req)
      jobMeta.set(jobId, { kind: 'export', connId: o.connId, db: o.db, target: req.target })
      close()
      toast('Export started')
    } catch (e) {
      toast(`Could not start export: ${errorText(e)}`, 'error')
      setStarting(false)
    }
  }

  return (
    <Modal
      title={
        <>
          Export <span className="faint tr-title-sub">{o.db}</span>
        </>
      }
      icon="export"
      width={720}
      onClose={close}
      footer={<Footer error={error} busy={starting} label="Start export" onCancel={close} onStart={() => void start()} onSave={() => void saveTask()} />}
    >
      <Section n={1} title="Format">
        <FormatCards formats={FORMATS} value={format} onChange={setFormat} />
      </Section>

      <Section n={2} title="Source" aside={<AllNone items={visible} selected={sel} onChange={setSel} />}>
        {names.length > 8 && (
          <input className="input tr-filter" placeholder="Filter collections…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        {colls === null && !names.length ? (
          <div className="row muted">
            <Spinner /> Loading collections…
          </div>
        ) : (
          <CheckList
            items={visible}
            selected={sel}
            onChange={setSel}
            empty={filter ? 'No matching collections' : 'This database has no collections'}
            render={(n) => (
              <>
                <Icon name={typeOf(n) === 'view' ? 'view' : 'collection'} size={14} className="faint" />
                <span className="grow ellipsis">{n}</span>
                {typeOf(n) && typeOf(n) !== 'collection' && <span className="badge">{typeOf(n)}</span>}
              </>
            )}
          />
        )}
        {scopesApply && (
          <div className="col tr-gap">
            <Field label="Documents">
              <div className="segmented tr-scopes">
                {o.scopes!.map((x) => (
                  <button key={x.id} className={x.id === scopeId ? 'on' : ''} disabled={!!x.disabled} title={x.disabled} onClick={() => setScopeId(x.id)}>
                    {x.label}
                    {countOf(x) !== null && !x.disabled && <span className="faint"> ({countOf(x)!.toLocaleString()})</span>}
                  </button>
                ))}
              </div>
            </Field>
            {q && scope?.id === 'query' && <QueryBox q={q} />}
            {bsonDrops && <div className="faint tr-small">BSON export (mongodump) uses only the filter: projection, sort, skip and limit are not applied.</div>}
          </div>
        )}
      </Section>

      <Section n={3} title="Options">
        {format === 'json' && (
          <>
            <Field label="JSON flavour">
              <select className="select grow" value={flavor} onChange={(e) => setFlavor(e.target.value as JsonFlavor)}>
                {(Object.keys(JSON_FLAVOR_LABELS) as JsonFlavor[]).map((k) => (
                  <option key={k} value={k}>
                    {JSON_FLAVOR_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Layout">
              <div className="segmented">
                <button className={layout === 'array' ? 'on' : ''} onClick={() => setLayout('array')}>
                  JSON array
                </button>
                <button className={layout === 'lines' ? 'on' : ''} onClick={() => setLayout('lines')}>
                  One document per line
                </button>
              </div>
            </Field>
            <Field label="">
              <label className="check">
                <input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} />
                Pretty print
              </label>
            </Field>
          </>
        )}
        {format === 'csv' && (
          <>
            <Field label="Delimiter">
              <DelimiterInput value={delimiter} onChange={setDelimiter} />
            </Field>
            <Field label="">
              <label className="check">
                <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
                Include header row
              </label>
            </Field>
            <Field label="">
              <label className="check" title="Starts the file with a UTF-8 byte order mark. Without it, Excel on Windows reads the file in the system code page and non-Latin text (e.g. Cyrillic) is garbled.">
                <input type="checkbox" checked={bom} onChange={(e) => setBom(e.target.checked)} />
                Excel-compatible (UTF-8 with BOM)
              </label>
            </Field>
          </>
        )}
        {tabular && (
          <Field label="Fields" top>
            <div className="col grow">
              <div className="row">
                <button className="btn small" disabled={detecting || !chosen.length} onClick={() => void detect()}>
                  {detecting ? <Spinner size={12} /> : <Icon name="search" size={12} />}
                  {fields ? 'Re-detect' : 'Auto-detect'}
                </button>
                {fields && (
                  <>
                    <span className="spacer" />
                    <AllNone items={fields} selected={fieldSel} onChange={setFieldSel} />
                    <button className="btn ghost small" title="Discover fields automatically" onClick={() => setFields(null)}>
                      Reset
                    </button>
                  </>
                )}
              </div>
              {fields ? (
                <CheckList items={fields} selected={fieldSel} onChange={setFieldSel} grid empty="No fields found" />
              ) : (
                <div className="faint tr-small">
                  Fields are discovered automatically{chosen.length > 1 ? ' for each collection' : ''}. Use Auto-detect to choose them
                  {chosen.length > 1 ? ` (sampled from ${chosen[0]})` : ''}.
                </div>
              )}
            </div>
          </Field>
        )}
        {isBson(format) && (
          <div className="col">
            <ToolsNotice t={tools} />
            <label className="check tr-gap">
              <input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} />
              Compress with gzip
            </label>
          </div>
        )}
      </Section>

      <Section n={4} title="Target">
        {toFile ? (
          <Field label="Save to file">
            <PathInput value={target} onChange={setFile} onBrowse={() => void browseFile()} placeholder={`${format === 'bson-archive' ? o.db : (chosen[0] ?? 'export')}${ext}`} />
          </Field>
        ) : (
          <Field label="Save to folder">
            <PathInput value={folder} onChange={setFolder} onBrowse={() => void browseFolder()} placeholder="Choose a folder" />
          </Field>
        )}
        {!toFile && (
          <div className="faint tr-small tr-indent">
            {isBson(format) ? 'mongodump writes a sub-folder per database with one .bson file per collection.' : `One ${ext} file per collection is written into this folder.`}
          </div>
        )}
      </Section>
    </Modal>
  )
}

export function openExportDialog(o: ExportOpts): Promise<void> {
  return openModal<void>((close) => <ExportDialog o={o} close={() => close()} />)
}

/** Export from a collection tab: the query result by default, the selection when several rows are selected. */
export function openTabExport(tab: QueryTab): Promise<void> {
  const scopes = exportScopes({ applied: tab.applied, docs: tab.docs ?? [], selection: tab.selection, page: tab.page, pageSize: tab.pageSize, count: tab.count ?? null })
  const scope = tab.selection.length > 1 && scopes.some((x) => x.id === 'selected' && !x.disabled) ? 'selected' : scopes[0].id
  return openExportDialog({ connId: tab.connId, db: tab.db, collections: [tab.coll], scopes, scope })
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface ImportOpts {
  connId: string
  db?: string
  collection?: string
}

const IMPORT_FORMATS = FORMATS.map((f) => (f.id === 'json' ? { ...f, sub: 'Any flavour, array or lines' } : f.id.startsWith('bson') ? { ...f, sub: f.id === 'bson-folder' ? 'mongorestore' : 'mongorestore --archive' } : f))

function SampleTable({ preview, types, setType }: { preview: FilePreview; types: Record<string, CsvColumnType>; setType: (c: string, t: CsvColumnType) => void }): ReactElement {
  const rows = preview.sample.slice(0, 8)
  return (
    <div className="tr-table-wrap">
      <table className="tr-table">
        <thead>
          <tr>
            {preview.columns.map((c) => (
              <th key={c} className={types[c] === 'skip' ? 'skip' : ''}>
                <div className="ellipsis" title={c}>
                  {c}
                </div>
                <select className="select small" value={types[c] ?? 'auto'} onChange={(e) => setType(c, e.target.value as CsvColumnType)}>
                  {COLUMN_TYPES.map(([t, l]) => (
                    <option key={t} value={t}>
                      {l}
                    </option>
                  ))}
                </select>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {preview.columns.map((c) => (
                <td key={c} className={types[c] === 'skip' ? 'skip' : ''}>
                  {r[c] === undefined ? '' : cellText(r[c])}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td className="faint" colSpan={Math.max(1, preview.columns.length)}>
                No data rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function ImportDialog({ o, close }: { o: ImportOpts; close: () => void }): ReactElement {
  const [format, setFormat] = useState<TransferFormat>('json')
  const [draft, setDraft] = useState('')
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [delimiter, setDelimiter] = useState(',')
  const [encoding, setEncoding] = useState<TextEncoding>('auto')
  const [sheet, setSheet] = useState<string | undefined>()
  const [types, setTypes] = useState<Record<string, CsvColumnType>>({})
  const [nsSel, setNsSel] = useState<string[] | null>(null)
  const [dbs, setDbs] = useState<string[]>([])
  const [db, setDb] = useState(o.db ?? '')
  const [colls, setColls] = useState<string[]>([])
  const [coll, setColl] = useState(o.collection ?? '')
  const [rename, setRename] = useState('')
  const [mode, setMode] = useState<'insert' | 'upsert'>('insert')
  const [dropFirst, setDropFirst] = useState(false)
  const [stopOnError, setStopOnError] = useState(false)
  const [gzip, setGzip] = useState(false)
  const [starting, setStarting] = useState(false)
  const collTouched = useRef(!!o.collection)
  const seq = useRef(0)
  const bson = isBson(format)
  const tabular = format === 'csv' || format === 'xlsx'
  const textFile = format === 'csv' || format === 'json'
  const tools = useTools(bson)

  useEffect(() => {
    api.listDatabases(o.connId).then(
      (l) => setDbs(l.map((d) => d.name).sort()),
      () => setDbs([])
    )
  }, [o.connId])

  const dbExists = dbs.includes(db.trim())
  useEffect(() => {
    if (!dbExists) {
      setColls([])
      return
    }
    let live = true
    api.listCollections(o.connId, db.trim()).then(
      (l) => live && setColls(l.filter((c) => c.type === 'collection').map((c) => c.name).sort()),
      () => live && setColls([])
    )
    return () => {
      live = false
    }
  }, [o.connId, db, dbExists])

  useEffect(() => {
    const id = ++seq.current
    if (!source || (format === 'csv' && !delimiter)) {
      setPreview(null)
      setPreviewErr(null)
      setReading(false)
      return
    }
    setReading(true)
    setPreviewErr(null)
    api
      .previewImport(format, source, {
        delimiter: format === 'csv' ? delimiter : undefined,
        sheet: format === 'xlsx' ? sheet : undefined,
        encoding: format === 'csv' || format === 'json' ? encoding : undefined
      })
      .then(
        (p) => {
          if (id !== seq.current) return
          setPreview(p)
          setTypes((t) => Object.fromEntries(p.columns.map((c) => [c, t[c] ?? 'auto'])))
          const nsDb = p.namespaces?.[0]?.split('.')[0]
          if (nsDb) setDb((d) => d || nsDb)
        },
        (e) => {
          if (id !== seq.current) return
          setPreview(null)
          setPreviewErr(errorText(e))
        }
      )
      .finally(() => id === seq.current && setReading(false))
  }, [format, source, delimiter, sheet, encoding])

  const applySource = (p: string): void => {
    p = p.trim()
    setDraft(p)
    if (p === source) return
    setSource(p)
    setSheet(undefined)
    setNsSel(null)
    setRename('')
    if (!p) return
    const f = format === 'bson-folder' ? format : detectFormat(p, format)
    if (f !== format) setFormat(f)
    if (f === 'csv' && /\.tsv$/i.test(p)) setDelimiter('\t')
    if (f === 'bson-archive') setGzip(/\.gz$/i.test(p))
    if (!collTouched.current && !isBson(f)) setColl(baseName(p).replace(/\.[^.]+$/, ''))
  }

  const browse = async (): Promise<void> => {
    const r =
      format === 'bson-folder'
        ? await api.openFile({ title: 'Choose a mongodump folder', directory: true })
        : await api.openFile({ title: 'Choose a file to import', filters: [...FILE_FILTERS[format], ALL_SUPPORTED, ALL_FILES] })
    if (r?.[0]) applySource(r[0])
  }

  const nsAll = preview?.namespaces ?? []
  const nsChosen = nsSel ? nsAll.filter((n) => nsSel.includes(n)) : nsAll
  const single = bson && nsChosen.length === 1 ? nsChosen[0] : null
  const allSkipped = tabular && !!preview?.columns.length && preview.columns.every((c) => types[c] === 'skip')

  const error = ((): string | null => {
    if (!source) return format === 'bson-folder' ? 'Choose a dump folder' : 'Choose a file to import'
    if (format === 'csv' && !delimiter) return 'Enter a delimiter'
    if (reading) return 'Reading file…'
    if (previewErr) return 'The source could not be read'
    if (bson && nsAll.length && !nsChosen.length) return 'Select at least one collection to restore'
    if (allSkipped) return 'All columns are skipped'
    if (!db.trim()) return 'Enter a target database'
    if (/[/\\. "$*<>:|?]/.test(db.trim())) return 'Invalid database name'
    if (!bson && !coll.trim()) return 'Enter a target collection'
    if (!bson && (coll.includes('$') || coll.trim().startsWith('system.'))) return 'Invalid collection name'
    if (bson && !tools.status?.found) return tools.status ? 'MongoDB Database Tools are required' : 'Looking for MongoDB Database Tools…'
    return null
  })()

  const build = (): ImportRequest => {
    const req: ImportRequest = {
      connId: o.connId,
      db: db.trim(),
      collection: bson ? (single ? rename.trim() : '') : coll.trim(),
      format,
      source,
      mode: bson ? 'insert' : mode,
      dropFirst,
      stopOnError
    }
    if (textFile && encoding !== 'auto') req.encoding = encoding
    if (format === 'csv') req.csv = { delimiter, columnTypes: types }
    if (format === 'xlsx') req.xlsx = { sheet: sheet ?? preview?.sheets?.[0], columnTypes: types }
    if (bson) req.bson = { gzip, nsInclude: nsSel && nsChosen.length !== nsAll.length ? nsChosen : undefined }
    return req
  }

  const saveTask = async (): Promise<void> => {
    const req = build()
    const into = req.collection ? `${req.db}.${req.collection}` : req.db
    if (await openSaveTaskDialog({ kind: 'import', request: req }, `Import into ${into}`)) close()
  }

  const start = async (): Promise<void> => {
    const req = build()
    setStarting(true)
    try {
      const jobId = await api.startImport(req)
      jobMeta.set(jobId, { kind: 'import', connId: o.connId, db: req.db })
      close()
      toast('Import started')
    } catch (e) {
      toast(`Could not start import: ${errorText(e)}`, 'error')
      setStarting(false)
    }
  }

  const sourceLabel = format === 'bson-folder' ? 'Dump folder' : 'File'

  return (
    <Modal
      title={
        <>
          Import <span className="faint tr-title-sub">{o.db ?? connName(o.connId)}</span>
        </>
      }
      icon="import"
      width={720}
      onClose={close}
      footer={<Footer error={error} busy={starting} label="Start import" onCancel={close} onStart={() => void start()} onSave={() => void saveTask()} />}
    >
      <Section n={1} title="Source">
        <FormatCards formats={IMPORT_FORMATS} value={format} onChange={setFormat} />
        <div className="tr-gap">
          <Field label={sourceLabel}>
            <PathInput
              value={draft}
              onChange={setDraft}
              onCommit={applySource}
              onBrowse={() => void browse()}
              placeholder={format === 'bson-folder' ? 'Folder created by mongodump' : 'Choose a file…'}
            />
          </Field>
          {format === 'csv' && (
            <Field label="Delimiter">
              <DelimiterInput value={delimiter} onChange={setDelimiter} />
            </Field>
          )}
          {textFile && (
            <Field label="Encoding">
              <select className="select grow" value={encoding} onChange={(e) => setEncoding(e.target.value as TextEncoding)}>
                {(Object.keys(TEXT_ENCODING_LABELS) as TextEncoding[]).map((k) => (
                  <option key={k} value={k}>
                    {k === 'auto' && preview?.encoding ? `${TEXT_ENCODING_LABELS.auto} (${TEXT_ENCODING_LABELS[preview.encoding]})` : TEXT_ENCODING_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {textFile && encoding === 'auto' && preview?.encodingNote && <div className="notice">{preview.encodingNote}</div>}
          {format === 'xlsx' && !!preview?.sheets?.length && (
            <Field label="Sheet">
              <select className="select grow" value={sheet ?? preview.sheets[0]} onChange={(e) => setSheet(e.target.value)}>
                {preview.sheets.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {bson && <ToolsNotice t={tools} />}
        </div>
      </Section>

      {source && (
        <Section
          n={2}
          title={bson ? 'Collections in dump' : 'Preview'}
          aside={bson && nsAll.length ? <AllNone items={nsAll} selected={nsChosen} onChange={setNsSel} /> : reading ? <Spinner /> : undefined}
        >
          {previewErr ? (
            <div className="notice error selectable">{previewErr}</div>
          ) : !preview ? (
            <div className="row muted">
              <Spinner /> Reading {baseName(source)}…
            </div>
          ) : bson ? (
            <CheckList
              items={nsAll}
              selected={nsChosen}
              onChange={setNsSel}
              empty="No collections found in the dump"
              render={(n) => (
                <>
                  <Icon name="collection" size={14} className="faint" />
                  <span className="grow ellipsis mono">{n}</span>
                </>
              )}
            />
          ) : tabular ? (
            <>
              <SampleTable preview={preview} types={types} setType={(c, t) => setTypes((x) => ({ ...x, [c]: t }))} />
              <div className="faint tr-small tr-gap">
                {preview.columns.length} columns · first {Math.min(8, preview.sample.length)} rows. Choose a type per column; Auto detects numbers, booleans and dates.
              </div>
            </>
          ) : preview.sample.length ? (
            <>
              <CodeEditor value={preview.sample.map((d) => shellText(d, 2)).join('\n')} readOnly minHeight={80} maxHeight={240} />
              <div className="faint tr-small tr-gap">First {preview.sample.length} documents</div>
            </>
          ) : (
            <div className="faint">No documents found in the file</div>
          )}
        </Section>
      )}

      <Section n={source ? 3 : 2} title="Target">
        <Field label="Database">
          <input
            className="input grow"
            list="tr-import-dbs"
            value={db}
            placeholder="Existing or new database"
            spellCheck={false}
            onChange={(e) => setDb(e.target.value)}
          />
          <datalist id="tr-import-dbs">
            {dbs.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          {db.trim() && !dbExists && <span className="badge tr-new">new</span>}
        </Field>
        {!bson && (
          <Field label="Collection">
            <input
              className="input grow"
              list="tr-import-colls"
              value={coll}
              placeholder="Existing or new collection"
              spellCheck={false}
              onChange={(e) => {
                collTouched.current = true
                setColl(e.target.value)
              }}
            />
            <datalist id="tr-import-colls">
              {colls.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            {coll.trim() && !colls.includes(coll.trim()) && <span className="badge tr-new">new</span>}
          </Field>
        )}
        {single && (
          <Field label="Restore as">
            <input className="input grow" value={rename} placeholder={single.slice(single.indexOf('.') + 1)} spellCheck={false} onChange={(e) => setRename(e.target.value)} />
          </Field>
        )}
      </Section>

      <Section n={source ? 4 : 3} title="Options">
        {!bson && (
          <Field label="Mode">
            <div className="segmented">
              <button className={mode === 'insert' ? 'on' : ''} onClick={() => setMode('insert')}>
                Insert
              </button>
              <button className={mode === 'upsert' ? 'on' : ''} onClick={() => setMode('upsert')}>
                Upsert by _id
              </button>
            </div>
          </Field>
        )}
        {bson && (
          <Field label="">
            <label className="check">
              <input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} />
              Dump is gzip-compressed
            </label>
          </Field>
        )}
        <Field label="">
          <label className="check">
            <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} />
            Stop on first error
          </label>
        </Field>
        <Field label="">
          <label className="check tr-danger">
            <input type="checkbox" checked={dropFirst} onChange={(e) => setDropFirst(e.target.checked)} />
            {bson ? 'Drop each collection before restoring' : 'Drop collection before import'}
          </label>
        </Field>
        {dropFirst && (
          <div className="notice error row">
            <Icon name="warn" />
            <span>
              {bson
                ? 'Existing collections with the same names will be dropped and all their documents deleted.'
                : `All documents in ${db.trim() || '…'}.${coll.trim() || '…'} will be deleted before importing.`}
            </span>
          </div>
        )}
      </Section>
    </Modal>
  )
}

export function openImportDialog(o: ImportOpts): Promise<void> {
  return openModal<void>((close) => <ImportDialog o={o} close={() => close()} />)
}
