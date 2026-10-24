import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { shellText } from '@shared/bsonValue'
import type { GridFsBucketInfo, GridFsFile, GridFsListResult, GridFsPreview, GridFsSortField } from '@shared/gridfsApi'
import { api } from '../../lib/api'
import { errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { showMenu } from '../ContextMenu'
import { Icon } from '../Icon'
import { confirmDialog, promptDialog } from '../Modal'
import { jobMeta } from '../transfer/TransferDialogs'
import { gridfsApi } from './gridfsClient'
import { openMetadataDialog, openUploadDialog } from './GridFsDialogs'
import './gridfs.css'
import { fmtDateTime } from '../../lib/datetime'

const PAGE = 50
const fmt = (n: number): string => n.toLocaleString()

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}

const dateText = (d: Date): string => fmtDateTime(d, false)
const idKey = (id: unknown): string => shellText(id)
const IMAGE_RE = /^image\//

function kindOf(f: GridFsFile): 'image' | 'text' | 'archive' | 'media' | 'doc' | 'other' {
  const t = (f.contentType ?? '').toLowerCase()
  const ext = f.filename.split('.').pop()?.toLowerCase() ?? ''
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image'
  if (t.startsWith('audio/') || t.startsWith('video/') || ['mp3', 'mp4', 'wav', 'webm', 'mov'].includes(ext)) return 'media'
  if (/zip|gzip|tar|rar|7z/.test(t) || ['zip', 'gz', 'tgz', 'rar', '7z'].includes(ext)) return 'archive'
  if (/pdf|word|excel|sheet|presentation/.test(t) || ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'doc'
  if (t.startsWith('text/') || /json|xml|yaml|javascript/.test(t) || ['txt', 'md', 'csv', 'json', 'log', 'xml', 'yml', 'yaml', 'js', 'ts', 'html', 'css'].includes(ext)) return 'text'
  return 'other'
}

function FileBadge({ f }: { f: GridFsFile }): ReactElement {
  const k = kindOf(f)
  const ext = (f.filename.includes('.') ? f.filename.split('.').pop() : '')?.slice(0, 4).toUpperCase() || '—'
  return <span className={`gfs-badge k-${k}`}>{ext}</span>
}

const COLUMNS: { id: GridFsSortField | null; label: string; cls: string }[] = [
  { id: 'filename', label: 'File name', cls: 'c-name' },
  { id: 'length', label: 'Size', cls: 'c-size' },
  { id: 'uploadDate', label: 'Uploaded', cls: 'c-date' },
  { id: 'contentType', label: 'Content type', cls: 'c-type' },
  { id: null, label: '_id', cls: 'c-id' }
]

function Preview({ file, preview, loading, error, onDownload }: { file: GridFsFile; preview: GridFsPreview | null; loading: boolean; error: string | null; onDownload: () => void }): ReactElement {
  if (loading) return <div className="gfs-preview-msg faint">Loading preview…</div>
  if (error) return <div className="gfs-preview-msg error-text">{error}</div>
  if (!preview) return <></>
  if (preview.kind === 'empty') return <div className="gfs-preview-msg faint">Empty file</div>
  if (preview.kind === 'image')
    return (
      <div className="gfs-preview-image">
        <img src={`data:${preview.mime};base64,${preview.data}`} alt={file.filename} />
      </div>
    )
  if (preview.kind === 'text')
    return (
      <div className="gfs-preview-text-wrap">
        <pre className="gfs-preview-text selectable">{preview.data}</pre>
        {preview.truncated && <div className="gfs-preview-more faint">Showing the first {fileSize(2 * 1024 * 1024)} of {fileSize(preview.length)}</div>}
      </div>
    )
  return (
    <div className="gfs-preview-msg">
      <Icon name="files" size={28} className="faint" />
      <div className="muted">{preview.truncated && IMAGE_RE.test(preview.mime) ? 'Image too large to preview' : 'No preview for this file type'}</div>
      <div className="faint mono">{preview.mime}</div>
      <button className="btn small" onClick={onDownload}>
        <Icon name="export" size={13} /> Download
      </button>
    </div>
  )
}

/** GridFS browser for one database: buckets, files with paging / search / sort, upload, download, preview. */
export function GridFsView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const connected = useStore((s) => !!s.live[connId])
  const jobs = useStore((s) => s.jobs)
  const [buckets, setBuckets] = useState<GridFsBucketInfo[] | null>(null)
  const [bucket, setBucket] = useState<string>(tab.coll ?? '')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ field: GridFsSortField; dir: 1 | -1 }>({ field: 'uploadDate', dir: -1 })
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<GridFsListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ key: string; data: GridFsPreview | null; loading: boolean; error: string | null } | null>(null)
  const [pending, setPending] = useState<string[]>([])
  const [rev, setRev] = useState(0)
  const anchor = useRef<number | null>(null)

  const files = result?.files ?? []
  const byKey = new Map(files.map((f) => [idKey(f._id), f]))
  const focused = focus ? byKey.get(focus) : undefined
  const chosen = files.filter((f) => selected.has(idKey(f._id)))

  const loadBuckets = useCallback(async (): Promise<void> => {
    try {
      const list = await gridfsApi.gridfsBuckets(connId, db)
      setBuckets(list)
      setBucket((cur) => cur || list[0]?.name || 'fs')
    } catch (e) {
      setBuckets([])
      setError(errorText(e))
    }
  }, [connId, db])

  useEffect(() => {
    if (connected) void loadBuckets()
  }, [connected, loadBuckets])

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim())
      setPage(0)
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    if (!connected || !bucket) return
    let alive = true
    setLoading(true)
    gridfsApi
      .gridfsList(connId, db, bucket, { search: query, sort, skip: page * PAGE, limit: PAGE })
      .then((r) => {
        if (!alive) return
        setResult(r)
        setError(null)
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [connId, db, bucket, query, sort, page, rev, connected])

  // Reload when uploads / deletes started here finish.
  useEffect(() => {
    if (!pending.length) return
    const finished = pending.filter((id) => jobs[id] && jobs[id].state !== 'running')
    if (!finished.length) return
    setPending((p) => p.filter((id) => !finished.includes(id)))
    setRev((r) => r + 1)
    void loadBuckets()
  }, [jobs, pending, loadBuckets])

  // Preview of the focused file.
  useEffect(() => {
    if (!focused || !focus) {
      setPreview(null)
      return
    }
    let alive = true
    setPreview({ key: focus, data: null, loading: true, error: null })
    gridfsApi
      .gridfsPreview(connId, db, bucket, focused._id)
      .then((data) => alive && setPreview({ key: focus, data, loading: false, error: null }))
      .catch((e) => alive && setPreview({ key: focus, data: null, loading: false, error: errorText(e) }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, focused?.length, focused?.uploadDate?.getTime(), bucket, connId, db])

  useEffect(() => {
    setSelected(new Set())
    setFocus(null)
    setPage(0)
  }, [bucket])

  // Deleting the last files of the last page leaves the page past the end: step back to the new last page.
  useEffect(() => {
    if (result && page > 0 && page * PAGE >= result.total) setPage(Math.max(0, Math.ceil(result.total / PAGE) - 1))
  }, [result, page])

  const reload = (): void => {
    setRev((r) => r + 1)
    void loadBuckets()
  }

  const sortBy = (field: GridFsSortField): void => {
    setSort((s) => (s.field === field ? { field, dir: s.dir === 1 ? -1 : 1 } : { field, dir: field === 'filename' || field === 'contentType' ? 1 : -1 }))
    setPage(0)
  }

  const clickRow = (e: ReactMouseEvent, f: GridFsFile, i: number): void => {
    const key = idKey(f._id)
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)]
      setSelected(new Set(files.slice(a, b + 1).map((x) => idKey(x._id))))
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s)
        if (n.has(key)) n.delete(key)
        else n.add(key)
        return n
      })
      anchor.current = i
    } else {
      setSelected(new Set([key]))
      anchor.current = i
    }
    setFocus(key)
  }

  const toggle = (f: GridFsFile, on: boolean): void => {
    const key = idKey(f._id)
    setSelected((s) => {
      const n = new Set(s)
      if (on) n.add(key)
      else n.delete(key)
      return n
    })
  }

  const download = async (list: GridFsFile[]): Promise<void> => {
    if (!list.length) return
    try {
      let target: { file: string } | { folder: string }
      if (list.length === 1) {
        const file = await api.saveFile({ title: 'Download file', defaultPath: list[0].filename || 'file' })
        if (!file) return
        target = { file }
      } else {
        const r = await api.openFile({ title: `Download ${list.length} files to folder`, directory: true })
        if (!r?.[0]) return
        target = { folder: r[0] }
      }
      const jobId = await gridfsApi.gridfsDownload(
        connId,
        db,
        bucket,
        list.map((f) => f._id),
        target
      )
      jobMeta.set(jobId, { kind: 'export', connId, db, target: 'file' in target ? target.file : target.folder })
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const upload = async (): Promise<void> => {
    const paths = await api.openFile({ title: `Upload to ${bucket || 'fs'}`, multi: true })
    if (!paths?.length) return
    const opts = await openUploadDialog({ paths, bucket: bucket || 'fs', db })
    if (!opts) return
    try {
      const jobId = await gridfsApi.gridfsUpload(connId, db, opts.bucket, paths, opts.options)
      if (opts.bucket !== bucket) setBucket(opts.bucket)
      setPending((p) => [...p, jobId])
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const remove = async (list: GridFsFile[]): Promise<void> => {
    if (!list.length) return
    const ok = await confirmDialog({
      title: list.length === 1 ? 'Delete file' : `Delete ${list.length} files`,
      danger: true,
      confirmLabel: 'Delete',
      message:
        list.length === 1 ? (
          <>
            Delete <b>{list[0].filename}</b> ({fileSize(list[0].length)}) from bucket <b>{bucket}</b>? Its chunks are removed too. This cannot be undone.
          </>
        ) : (
          <>
            Delete <b>{list.length} files</b> ({fileSize(list.reduce((n, f) => n + f.length, 0))}) from bucket <b>{bucket}</b>? This cannot be undone.
          </>
        )
    })
    if (!ok) return
    try {
      const n = await gridfsApi.gridfsDelete(
        connId,
        db,
        bucket,
        list.map((f) => f._id)
      )
      toast(`Deleted ${n} file${n === 1 ? '' : 's'}`, 'success')
      setSelected(new Set())
      setFocus(null)
      reload()
    } catch (e) {
      toast(errorText(e), 'error')
      reload()
    }
  }

  const rename = async (f: GridFsFile): Promise<void> => {
    const name = await promptDialog({ title: 'Rename file', label: 'File name', initial: f.filename, confirmLabel: 'Rename', validate: (v) => (v.trim() ? null : 'Enter a name') })
    if (name === null || name.trim() === f.filename) return
    try {
      await gridfsApi.gridfsRename(connId, db, bucket, f._id, name.trim())
      reload()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const editMetadata = async (f: GridFsFile): Promise<void> => {
    const r = await openMetadataDialog(f)
    if (r === undefined) return
    try {
      await gridfsApi.gridfsSetMetadata(connId, db, bucket, f._id, r)
      toast('Metadata saved', 'success')
      reload()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const newBucket = async (): Promise<void> => {
    const name = await promptDialog({
      title: 'New bucket',
      label: 'Bucket name (created with the first upload)',
      initial: '',
      placeholder: 'e.g. images',
      validate: (v) => (!v.trim() ? 'Enter a name' : /[$\0]/.test(v) || v.startsWith('system.') ? 'Invalid name' : buckets?.some((b) => b.name === v.trim()) ? 'This bucket exists' : null)
    })
    if (!name) return
    setBuckets((b) => [...(b ?? []), { name: name.trim(), files: 0 }])
    setBucket(name.trim())
  }

  const menu = (e: ReactMouseEvent, f: GridFsFile): void => {
    const key = idKey(f._id)
    const list = selected.has(key) ? chosen : [f]
    if (!selected.has(key)) {
      setSelected(new Set([key]))
      setFocus(key)
    }
    showMenu(e, [
      { label: list.length > 1 ? `Download ${list.length} Files…` : 'Download…', icon: 'export', onClick: () => void download(list) },
      { label: 'Rename…', icon: 'edit', disabled: list.length > 1, onClick: () => void rename(f) },
      { label: 'Edit Metadata…', icon: 'json', disabled: list.length > 1, onClick: () => void editMetadata(f) },
      { separator: true },
      { label: 'Copy File Name', icon: 'copy', onClick: () => void api.copyText(list.map((x) => x.filename).join('\n')) },
      { label: 'Copy _id', icon: 'copy', onClick: () => void api.copyText(list.map((x) => shellText(x._id)).join('\n')) },
      { separator: true },
      { label: list.length > 1 ? `Delete ${list.length} Files…` : 'Delete…', icon: 'trash', danger: true, onClick: () => void remove(list) }
    ])
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === 'Delete' && chosen.length) {
      e.preventDefault()
      void remove(chosen)
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelected(new Set(files.map((f) => idKey(f._id))))
    }
  }

  const total = result?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const running = pending.some((id) => jobs[id]?.state === 'running')
  const current = buckets?.find((b) => b.name === bucket)
  const allOnPage = files.length > 0 && files.every((f) => selected.has(idKey(f._id)))

  if (!connected)
    return (
      <div className="gfs">
        <div className="gfs-empty faint">Not connected</div>
      </div>
    )

  return (
    <div className="gfs" tabIndex={-1} onKeyDown={onKey}>
      <div className="gfs-head">
        <Icon name="files" className="gfs-head-icon" />
        <span className="gfs-title">GridFS</span>
        <span className="gfs-db mono faint ellipsis">{db}</span>
        <span className="gfs-sep" />
        <label className="faint gfs-small">Bucket</label>
        <select className="select small gfs-bucket" value={bucket} onChange={(e) => (e.target.value === '\u0000new' ? void newBucket() : setBucket(e.target.value))}>
          {!buckets?.some((b) => b.name === bucket) && bucket && <option value={bucket}>{bucket}</option>}
          {(buckets ?? []).map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
              {b.files >= 0 ? ` (${fmt(b.files)})` : ''}
            </option>
          ))}
          <option value={'\u0000new'}>New bucket…</option>
        </select>
        <button className="btn ghost icon small" title="Refresh" onClick={reload}>
          <Icon name="refresh" size={14} className={loading ? 'gfs-spin' : ''} />
        </button>
        <span className="spacer" />
        <button className="btn primary small" onClick={() => void upload()}>
          <Icon name="import" size={13} /> Upload…
        </button>
      </div>

      <div className="gfs-bar">
        <div className="gfs-search">
          <Icon name="search" size={13} />
          <input className="input small" value={search} placeholder="Search file names" onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button className="btn ghost icon small" title="Clear" onClick={() => setSearch('')}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
        <span className="faint gfs-small">
          {result ? (
            <>
              {fmt(total)} {query ? 'matching ' : ''}file{total === 1 ? '' : 's'}
              {running && ' · uploading…'}
            </>
          ) : (
            ''
          )}
        </span>
        <span className="spacer" />
        {chosen.length > 0 && (
          <>
            <span className="gfs-small muted">{chosen.length} selected</span>
            <button className="btn small" onClick={() => void download(chosen)}>
              <Icon name="export" size={13} /> Download
            </button>
            <button className="btn small danger" onClick={() => void remove(chosen)}>
              <Icon name="trash" size={13} /> Delete
            </button>
          </>
        )}
      </div>

      <div className={`gfs-body ${focused ? 'with-detail' : ''}`}>
        <div className="gfs-list">
          {error && <div className="notice error gfs-error selectable">{error}</div>}
          {loading && <div className="loading-bar" />}
          <table className="gfs-table">
            <thead>
              <tr>
                <th className="c-check">
                  <input type="checkbox" checked={allOnPage} disabled={!files.length} onChange={(e) => setSelected(e.target.checked ? new Set(files.map((f) => idKey(f._id))) : new Set())} />
                </th>
                {COLUMNS.map((c) => (
                  <th key={c.label} className={`${c.cls} ${c.id ? 'sortable' : ''} ${c.id && sort.field === c.id ? 'sorted' : ''}`} onClick={() => c.id && sortBy(c.id)}>
                    {c.label}
                    {c.id && sort.field === c.id && <span className="gfs-sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => {
                const key = idKey(f._id)
                return (
                  <tr
                    key={key}
                    className={`${selected.has(key) ? 'sel' : ''} ${focus === key ? 'focus' : ''}`}
                    onClick={(e) => clickRow(e, f, i)}
                    onDoubleClick={() => void download([f])}
                    onContextMenu={(e) => menu(e, f)}
                  >
                    <td className="c-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(key)} onChange={(e) => toggle(f, e.target.checked)} />
                    </td>
                    <td className="c-name">
                      <div className="gfs-name">
                        <FileBadge f={f} />
                        <span className="ellipsis" title={f.filename}>
                          {f.filename || <span className="faint">(no name)</span>}
                        </span>
                      </div>
                    </td>
                    <td className="c-size mono">{fileSize(f.length)}</td>
                    <td className="c-date">{dateText(f.uploadDate)}</td>
                    <td className="c-type ellipsis muted">{f.contentType ?? <span className="faint">—</span>}</td>
                    <td className="c-id mono faint ellipsis" title={shellText(f._id)}>
                      {shellText(f._id)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {result && !files.length && !loading && (
            <div className="gfs-empty">
              <Icon name="files" size={32} />
              {query ? (
                <div className="muted">No file names contain “{query}”.</div>
              ) : current || buckets?.length ? (
                <div className="muted">
                  Bucket <b>{bucket}</b> is empty.
                </div>
              ) : (
                <div className="muted">No GridFS buckets in {db} yet.</div>
              )}
              {!query && (
                <button className="btn small primary" onClick={() => void upload()}>
                  <Icon name="import" size={13} /> Upload files to {bucket || 'fs'}
                </button>
              )}
            </div>
          )}
        </div>

        {focused && (
          <aside className="gfs-detail">
            <div className="gfs-detail-head">
              <FileBadge f={focused} />
              <b className="grow ellipsis selectable" title={focused.filename}>
                {focused.filename || '(no name)'}
              </b>
              <button className="btn ghost icon small" title="Close" onClick={() => setFocus(null)}>
                <Icon name="close" size={13} />
              </button>
            </div>
            <div className="gfs-detail-actions">
              <button className="btn small" onClick={() => void download([focused])}>
                <Icon name="export" size={13} /> Download
              </button>
              <button className="btn small" onClick={() => void rename(focused)}>
                <Icon name="edit" size={13} /> Rename
              </button>
              <button className="btn small" onClick={() => void editMetadata(focused)}>
                <Icon name="json" size={13} /> Metadata
              </button>
              <span className="spacer" />
              <button className="btn small ghost danger icon" title="Delete" onClick={() => void remove([focused])}>
                <Icon name="trash" size={13} />
              </button>
            </div>
            <dl className="gfs-props">
              <dt>Size</dt>
              <dd>
                {fileSize(focused.length)} <span className="faint mono">({fmt(focused.length)} bytes)</span>
              </dd>
              <dt>Uploaded</dt>
              <dd>{fmtDateTime(focused.uploadDate)}</dd>
              <dt>Content type</dt>
              <dd className="mono">{focused.contentType ?? <span className="faint">—</span>}</dd>
              <dt>Chunk size</dt>
              <dd>{fileSize(focused.chunkSize)}</dd>
              <dt>_id</dt>
              <dd className="mono selectable gfs-break">{shellText(focused._id)}</dd>
              {focused.metadata && (
                <>
                  <dt>Metadata</dt>
                  <dd>
                    <pre className="gfs-meta selectable">{shellText(focused.metadata, 2)}</pre>
                  </dd>
                </>
              )}
            </dl>
            <div className="gfs-preview">
              <div className="gfs-preview-label">Preview</div>
              <Preview file={focused} preview={preview?.data ?? null} loading={!!preview?.loading} error={preview?.error ?? null} onDownload={() => void download([focused])} />
            </div>
          </aside>
        )}
      </div>

      <div className="gfs-foot">
        <button className="btn ghost icon small" disabled={page === 0} title="First page" onClick={() => setPage(0)}>
          <Icon name="first" size={13} />
        </button>
        <button className="btn ghost icon small" disabled={page === 0} title="Previous page" onClick={() => setPage((p) => p - 1)}>
          <Icon name="chevronLeft" size={13} />
        </button>
        <span className="gfs-small muted">
          {total ? `${fmt(page * PAGE + 1)}–${fmt(Math.min(total, (page + 1) * PAGE))} of ${fmt(total)}` : '0 files'}
        </span>
        <button className="btn ghost icon small" disabled={page >= pages - 1} title="Next page" onClick={() => setPage((p) => p + 1)}>
          <Icon name="chevronRight" size={13} />
        </button>
        <button className="btn ghost icon small" disabled={page >= pages - 1} title="Last page" onClick={() => setPage(pages - 1)}>
          <Icon name="last" size={13} />
        </button>
        <span className="spacer" />
        {chosen.length > 0 && <span className="gfs-small faint">{fileSize(chosen.reduce((n, f) => n + f.length, 0))} selected</span>}
      </div>
    </div>
  )
}
