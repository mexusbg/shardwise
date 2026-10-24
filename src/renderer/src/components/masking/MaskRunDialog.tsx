import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { CollectionInfo, DatabaseInfo } from '@shared/api'
import type { MaskRule, MaskSource, MaskTarget } from '@shared/maskingApi'
import { api } from '../../lib/api'
import { connName, errorText, useStore } from '../../state/store'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { openSaveTaskDialog } from '../tasks/SaveTaskDialog'
import { fmt, plural } from './common'
import { maskingApi } from './maskingClient'

type Kind = MaskTarget['kind']

const KINDS: { id: Kind; label: string; icon: string; hint: string }[] = [
  { id: 'collection', label: 'Copy to collection', icon: 'duplicate', hint: 'Write masked copies into another collection, on any open connection' },
  { id: 'file', label: 'Export JSON', icon: 'export', hint: 'Relaxed Extended JSON, one document per line' },
  { id: 'inPlace', label: 'Mask in place', icon: 'warn', hint: 'Overwrite the documents of this collection' }
]

function RunBody({ source, rules, salt, close }: { source: MaskSource; rules: MaskRule[]; salt: string; close: (jobId: string | null) => void }): ReactElement {
  const live = useStore((s) => s.live)
  const [kind, setKind] = useState<Kind>('collection')
  const [conn, setConn] = useState(source.connId)
  const [db, setDb] = useState(source.db)
  const [coll, setColl] = useState(`${source.coll}_masked`)
  const [dropFirst, setDropFirst] = useState(false)
  const [path, setPath] = useState('')
  const [confirm, setConfirm] = useState('')
  const [count, setCount] = useState<number | null>(null)
  const [dbs, setDbs] = useState<DatabaseInfo[]>([])
  const [colls, setColls] = useState<CollectionInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .count(source.connId, source.db, source.coll, source.filter)
      .then((n) => alive && setCount(n))
      .catch(() => alive && setCount(null))
    return () => {
      alive = false
    }
  }, [source])

  useEffect(() => {
    if (!live[conn]) return
    let alive = true
    api
      .listDatabases(conn)
      .then((l) => alive && setDbs(l))
      .catch(() => alive && setDbs([]))
    return () => {
      alive = false
    }
  }, [conn, live])

  useEffect(() => {
    if (!live[conn] || !db.trim()) return setColls([])
    let alive = true
    api
      .listCollections(conn, db.trim())
      .then((l) => alive && setColls(l))
      .catch(() => alive && setColls([]))
    return () => {
      alive = false
    }
  }, [conn, db, live])

  const exists = colls.some((c) => c.name === coll.trim())
  const same = conn === source.connId && db.trim() === source.db && coll.trim() === source.coll
  const masked = rules.filter((r) => r.kind !== 'keep').length

  const problem =
    kind === 'collection'
      ? !live[conn]
        ? 'Choose a connected target'
        : !db.trim() || !coll.trim()
          ? 'Enter a target database and collection'
          : same
            ? 'The target is the source collection — choose "Mask in place" to overwrite it'
            : null
      : kind === 'file'
        ? !path
          ? 'Choose a file'
          : null
        : confirm !== source.coll
          ? `Type ${source.coll} to confirm`
          : null

  const browse = async (): Promise<void> => {
    const p = await api.saveFile({ title: 'Export masked documents', defaultPath: `${source.coll}.masked.json`, filters: [{ name: 'JSON', extensions: ['json', 'jsonl'] }] })
    if (p) setPath(p)
  }

  const targetOf = (): MaskTarget =>
    kind === 'collection' ? { kind, connId: conn, db: db.trim(), coll: coll.trim(), dropFirst } : kind === 'file' ? { kind, path } : { kind, confirm }

  const saveTask = async (): Promise<void> => {
    if (problem || busy) return
    const target = targetOf()
    const to = target.kind === 'collection' ? `${target.db}.${target.coll}` : target.kind === 'file' ? (target.path.split(/[\\/]/).pop() ?? 'file') : 'in place'
    if (await openSaveTaskDialog({ kind: 'mask', request: { source, rules, salt, target } }, `Mask ${source.db}.${source.coll} → ${to}`)) close(null)
  }

  const start = async (): Promise<void> => {
    if (problem || busy) return
    const target = targetOf()
    setBusy(true)
    setError(null)
    try {
      close(await maskingApi.maskingStart({ source, rules, salt, target }))
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Run data masking"
      icon="mask"
      width={600}
      onClose={() => close(null)}
      footer={
        <>
          {error && <span className="error-text ellipsis grow mk-small">{error}</span>}
          {!error && problem && <span className="faint ellipsis grow mk-small">{problem}</span>}
          <button className="btn" disabled={!!problem || busy} onClick={() => void saveTask()} title="Run this masking job again later, on demand or on a schedule">
            <Icon name="tasks" size={13} /> Save as task…
          </button>
          <button className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className={`btn ${kind === 'inPlace' ? 'danger solid' : 'primary'}`} disabled={!!problem || busy} onClick={() => void start()}>
            <Icon name={kind === 'inPlace' ? 'warn' : 'play'} size={13} /> {kind === 'inPlace' ? 'Mask in place' : kind === 'file' ? 'Export' : 'Copy'}
          </button>
        </>
      }
    >
      <div className="mk-run">
        <div className="mk-run-source">
          <Icon name="collection" size={14} />
          <span className="mono ellipsis">
            {connName(source.connId)} · {source.db}.{source.coll}
          </span>
          <span className="spacer" />
          <span className="badge">{count === null ? '…' : plural(count, 'document')}</span>
          <span className="badge accent">{plural(masked, 'masked field')}</span>
        </div>
        {Object.keys(source.filter).length > 0 && <div className="faint mk-small">Only documents matching the filter are processed.</div>}

        <div className="mk-run-kinds">
          {KINDS.map((k) => (
            <button key={k.id} className={`mk-run-kind ${kind === k.id ? 'on' : ''} ${k.id === 'inPlace' ? 'danger' : ''}`} onClick={() => setKind(k.id)}>
              <Icon name={k.icon} size={16} />
              <span className="mk-run-kind-label">{k.label}</span>
              <span className="mk-run-kind-hint">{k.hint}</span>
            </button>
          ))}
        </div>

        {kind === 'collection' && (
          <div className="mk-run-form">
            <label>Connection</label>
            <select className="select" value={conn} onChange={(e) => setConn(e.target.value)}>
              {Object.values(live).map((l) => (
                <option key={l.connId} value={l.connId}>
                  {l.name}
                </option>
              ))}
            </select>
            <label>Database</label>
            <input className="input mono" list="mk-run-dbs" value={db} onChange={(e) => setDb(e.target.value)} />
            <datalist id="mk-run-dbs">
              {dbs.map((d) => (
                <option key={d.name} value={d.name} />
              ))}
            </datalist>
            <label>Collection</label>
            <div className="row">
              <input className="input mono grow" list="mk-run-colls" value={coll} onChange={(e) => setColl(e.target.value)} />
              <span className={`badge ${exists ? 'warn' : ''}`}>{exists ? 'exists' : 'new'}</span>
            </div>
            <datalist id="mk-run-colls">
              {colls.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
            <span />
            <label className="check">
              <input type="checkbox" checked={dropFirst} onChange={(e) => setDropFirst(e.target.checked)} /> Drop the target collection first
            </label>
            {exists && !dropFirst && (
              <>
                <span />
                <div className="faint mk-small">Documents whose _id already exists in the target are reported as failed and skipped.</div>
              </>
            )}
          </div>
        )}

        {kind === 'file' && (
          <div className="mk-run-form">
            <label>File</label>
            <div className="row">
              <input className="input mono grow" value={path} readOnly placeholder="Choose where to save…" onClick={() => void browse()} />
              <button className="btn" onClick={() => void browse()}>
                Browse…
              </button>
            </div>
          </div>
        )}

        {kind === 'inPlace' && (
          <div className="mk-run-danger">
            <div className="mk-run-danger-title">
              <Icon name="warn" size={15} /> This permanently overwrites {count === null ? 'the matching' : fmt(count)} document{count === 1 ? '' : 's'} of {source.db}.{source.coll}
            </div>
            <p>Masked values cannot be restored. Make sure you are not connected to production, or take a backup first.</p>
            <label className="mk-small">
              Type <b className="mono">{source.coll}</b> to confirm
            </label>
            <input className={`input mono ${confirm && confirm !== source.coll ? 'invalid' : ''}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus spellCheck={false} />
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Choose the target and start the masking job; resolves with its id (null when cancelled). */
export function openMaskRunDialog(source: MaskSource, rules: MaskRule[], salt: string): Promise<string | null> {
  return openModal<string | null>((close) => <RunBody source={source} rules={rules} salt={salt} close={close} />)
}
