import { useState } from 'react'
import type { ReactElement } from 'react'
import { connectionHostLabel } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import type { ConnectionImportPreview } from '@shared/api'
import { api } from '../../lib/api'
import { errorText, reloadConnections, toast, useStore } from '../../state/store'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'

function ExportBody({ preselected, close }: { preselected: string[]; close: () => void }): ReactElement {
  const connections = useStore((s) => s.connections)
  const [ids, setIds] = useState<string[]>(preselected.length ? preselected : connections.map((c) => c.id))
  const [format, setFormat] = useState<'shardwise' | 'uri'>('shardwise')
  const [withPasswords, setWithPasswords] = useState(false)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const problem = !ids.length
    ? 'Select at least one connection'
    : withPasswords && format === 'shardwise' && pass.length < 8
      ? 'Passphrase must have at least 8 characters'
      : withPasswords && format === 'shardwise' && pass !== pass2
        ? 'Passphrases do not match'
        : null

  const run = async (): Promise<void> => {
    const path = await api.saveFile({
      title: 'Export connections',
      defaultPath: format === 'uri' ? 'shardwise-connections.txt' : 'shardwise-connections.json',
      filters: format === 'uri' ? [{ name: 'Text', extensions: ['txt'] }] : [{ name: 'JSON', extensions: ['json'] }]
    })
    if (!path) return
    try {
      const n = await api.exportConnectionsToFile(ids, path, { format, includePasswords: withPasswords, passphrase: pass || undefined })
      toast(`Exported ${n} connection${n === 1 ? '' : 's'}`, 'success')
      close()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  return (
    <Modal
      title="Export connections"
      icon="export"
      onClose={close}
      width={620}
      footer={
        <>
          <span className="muted grow">{problem}</span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!problem} onClick={run}>
            Export…
          </button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 6 }}>
        <b className="grow">Connections ({ids.length} of {connections.length})</b>
        <button className="link" onClick={() => setIds(connections.map((c) => c.id))}>
          All
        </button>
        <button className="link" onClick={() => setIds([])}>
          None
        </button>
      </div>
      <div className="list" style={{ maxHeight: 220, marginBottom: 14 }}>
        {connections.map((c) => (
          <label key={c.id} className="list-row check">
            <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
            <b>{c.name}</b>
            <span className="muted mono ellipsis">{connectionHostLabel(c)}</span>
          </label>
        ))}
      </div>
      <div className="field">
        <label>Format</label>
        <div className="segmented">
          <button className={format === 'shardwise' ? 'on' : ''} onClick={() => setFormat('shardwise')}>
            Shardwise (.json)
          </button>
          <button className={format === 'uri' ? 'on' : ''} onClick={() => setFormat('uri')}>
            Connection strings (.txt)
          </button>
        </div>
      </div>
      <div className="field">
        <label>Passwords</label>
        <label className="check">
          <input type="checkbox" checked={withPasswords} onChange={(e) => setWithPasswords(e.target.checked)} />
          {format === 'uri' ? 'Include passwords in the connection strings (plain text!)' : 'Include passwords, encrypted with a passphrase'}
        </label>
      </div>
      {withPasswords && format === 'shardwise' && (
        <>
          <div className="field">
            <label>Passphrase</label>
            <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Repeat passphrase</label>
            <input className="input" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
          </div>
        </>
      )}
      {withPasswords && format === 'uri' && <div className="notice error">Anyone with the file can read these passwords.</div>}
      {format === 'shardwise' && (
        <div className="faint" style={{ fontSize: 12 }}>
          SSH, TLS and all other settings are included. Without passwords, the file can be shared safely.
        </div>
      )}
    </Modal>
  )
}

export function openExportConnections(preselected: string[] = []): Promise<void> {
  return openModal<void>((close) => <ExportBody preselected={preselected} close={() => close()} />)
}

function ImportBody({ close }: { close: () => void }): ReactElement {
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState<ConnectionImportPreview | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const existing = useStore((s) => s.connections)

  const [fromClipboard, setFromClipboard] = useState(false)

  /** `p` = file path; '' with `clipboard` set = what is on the clipboard. */
  const load = async (p: string, passphrase?: string, clipboard = fromClipboard): Promise<void> => {
    setError(null)
    try {
      const r = clipboard ? await api.previewConnectionImportFromClipboard(passphrase) : await api.previewConnectionImport(p, passphrase)
      setPreview(r)
      setSelected(r.connections.map((_, i) => i))
    } catch (e) {
      setPreview(null)
      setError(errorText(e))
    }
  }

  const pick = async (): Promise<void> => {
    const r = await api.openFile({
      title: 'Import connections',
      filters: [
        { name: 'Connection exports', extensions: ['json', 'txt', 'uri'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (!r?.[0]) return
    setPath(r[0])
    setPass('')
    setFromClipboard(false)
    await load(r[0], undefined, false)
  }

  const paste = async (): Promise<void> => {
    setPath('')
    setPass('')
    setFromClipboard(true)
    await load('', undefined, true)
  }

  const run = async (): Promise<void> => {
    if (!preview) return
    const names = new Set(existing.map((c) => c.name))
    const list: ConnectionConfig[] = preview.connections
      .filter((_, i) => selected.includes(i))
      .map((c) => {
        let name = c.name
        for (let n = 2; names.has(name); n++) name = `${c.name} (${n})`
        names.add(name)
        return { ...c, name }
      })
    try {
      const n = await api.importConnections(list)
      await reloadConnections()
      toast(`Imported ${n} connection${n === 1 ? '' : 's'}`, 'success')
      close()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <Modal
      title="Import connections"
      icon="import"
      onClose={close}
      width={680}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!preview || !selected.length || preview.needsPassphrase} onClick={run}>
            Import {selected.length || ''}
          </button>
        </>
      }
    >
      <div className="muted" style={{ marginBottom: 10, lineHeight: 1.5 }}>
        Supported: Shardwise exports, Studio 3T connection exports (<span className="mono">.uri</span> files or copied connection strings, with or without
        passwords and SSH settings), MongoDB Compass exports, Robo 3T <span className="mono">robo3t.json</span>, and text with one
        <span className="mono"> mongodb:// </span>or<span className="mono"> mongodb+srv:// </span>URI per line. Passwords are stored encrypted; delete the export
        file afterwards, as it holds them in plain text.
      </div>
      <div className="field">
        <label>File</label>
        <div className="row">
          <input
            className="input grow mono"
            value={fromClipboard ? '' : path}
            placeholder={fromClipboard ? 'From the clipboard' : 'Choose a file…'}
            onChange={(e) => {
              setFromClipboard(false)
              setPath(e.target.value)
            }}
            onKeyDown={(e) => e.key === 'Enter' && path && load(path, undefined, false)}
          />
          <button className="btn" onClick={pick}>
            <Icon name="folder" size={14} /> Browse…
          </button>
          <button className="btn" onClick={paste} title="Connection strings or an export copied to the clipboard (e.g. Studio 3T → Copy connection string)">
            <Icon name="paste" size={14} /> Paste
          </button>
        </div>
      </div>
      {error && <div className="notice error selectable">{error}</div>}
      {preview?.needsPassphrase && (
        <div className="field">
          <label>Passphrase</label>
          <div className="row">
            <input className="input grow" type="password" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load(path, pass)} autoFocus />
            <button className="btn" onClick={() => load(path, pass)}>
              Unlock
            </button>
          </div>
        </div>
      )}
      {preview && (
        <>
          <div className="row" style={{ margin: '10px 0 6px' }}>
            <b className="grow">
              {preview.connections.length} connection{preview.connections.length === 1 ? '' : 's'} found <span className="badge">{preview.format}</span>
            </b>
            <button className="link" onClick={() => setSelected(preview.connections.map((_, i) => i))}>
              All
            </button>
            <button className="link" onClick={() => setSelected([])}>
              None
            </button>
          </div>
          <div className="list" style={{ maxHeight: 260 }}>
            {preview.connections.map((c, i) => (
              <label key={i} className="list-row check">
                <input type="checkbox" checked={selected.includes(i)} onChange={(e) => setSelected(e.target.checked ? [...selected, i] : selected.filter((x) => x !== i))} />
                <b>{c.name}</b>
                <span className="muted mono ellipsis grow">{connectionHostLabel(c)}</span>
                {c.ssh.enabled && <span className="badge">SSH</span>}
                {c.tls.enabled && <span className="badge">TLS</span>}
                {c.auth.username && <span className="badge">{c.auth.username}</span>}
                {existing.some((x) => x.name === c.name) && <span className="badge">renamed</span>}
              </label>
            ))}
          </div>
          {preview.warnings.map((w, i) => (
            <div key={i} className="notice" style={{ marginTop: 8 }}>
              {w}
            </div>
          ))}
        </>
      )}
    </Modal>
  )
}

export function openImportConnections(): Promise<void> {
  return openModal<void>((close) => <ImportBody close={() => close()} />)
}
