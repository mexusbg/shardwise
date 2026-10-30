import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { connectionHostLabel, newConnectionConfig } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import { api } from '../../lib/api'
import { connect, errorText, reloadConnections, toast, useStore } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog, Modal, openModal } from '../Modal'
import { editConnection } from './ConnectionEditor'
import { byName, byUsage } from '@shared/connectionUsage'
import { connectionSort, connectionUsage, setConnectionSort } from '../../lib/connectionUsage'
import type { ConnectionSort } from '../../lib/connectionUsage'
import { openExportConnections, openImportConnections } from './ConnectionTransfer'

function Manager({ close }: { close: () => void }): ReactElement {
  const connections = useStore((s) => s.connections)
  const live = useStore((s) => s.live)
  const [selected, setSelected] = useState<string | null>(connections[0]?.id ?? null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<ConnectionSort>(connectionSort)
  const sel = connections.find((c) => c.id === selected)

  const groups = useMemo(() => {
    const f = filter.toLowerCase()
    const matching = connections.filter((c) => !f || c.name.toLowerCase().includes(f) || connectionHostLabel(c).toLowerCase().includes(f))
    const sorted = byName(matching)
    const list = sort === 'usage' ? byUsage(sorted, connectionUsage()) : sorted
    const map = new Map<string, ConnectionConfig[]>()
    for (const c of list) {
      const k = c.folder ?? ''
      map.set(k, [...(map.get(k) ?? []), c])
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [connections, filter, sort])

  const doConnect = async (id: string): Promise<void> => {
    close()
    await connect(id)
  }

  const create = async (): Promise<void> => {
    const c = await editConnection(newConnectionConfig())
    if (c) {
      await reloadConnections()
      setSelected(c.id)
    }
  }

  const edit = async (c: ConnectionConfig): Promise<void> => {
    if (await editConnection(c)) await reloadConnections()
  }

  const clone = async (c: ConnectionConfig): Promise<void> => {
    try {
      const copy = await api.saveConnection({ ...structuredClone(c), id: '', name: `${c.name} (copy)` })
      await reloadConnections()
      setSelected(copy.id)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const remove = async (c: ConnectionConfig): Promise<void> => {
    if (!(await confirmDialog({ title: 'Delete connection', message: <>Delete the saved connection <b>{c.name}</b>?</>, confirmLabel: 'Delete', danger: true }))) return
    await api.deleteConnection(c.id)
    await reloadConnections()
    setSelected(null)
  }

  const copyUri = async (c: ConnectionConfig): Promise<void> => {
    await api.copyText(await api.buildUri(c, false))
    toast('Connection string copied (without password)', 'success')
  }

  return (
    <Modal
      title="Connection Manager"
      icon="server"
      onClose={close}
      width={760}
      footer={
        <>
          <button className="btn" onClick={create}>
            <Icon name="plus" /> New connection
          </button>
          <button className="btn" onClick={() => openImportConnections()} title="Import connections from Shardwise, Studio 3T, Compass, Robo 3T or a URI list">
            <Icon name="import" /> Import…
          </button>
          <button className="btn" onClick={() => openExportConnections(sel ? [sel.id] : [])} disabled={!connections.length}>
            <Icon name="export" /> Export…
          </button>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" disabled={!sel} onClick={() => sel && doConnect(sel.id)}>
            <Icon name="plug" /> Connect
          </button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="input grow" placeholder="Filter connections…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="segmented" title="Order of the connections (within each folder)">
          {(
            [
              ['name', 'A–Z'],
              ['usage', 'Most used']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={sort === k ? 'on' : ''}
              onClick={() => {
                setSort(k)
                setConnectionSort(k)
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="btn" disabled={!sel} onClick={() => sel && edit(sel)}>
          <Icon name="edit" /> Edit
        </button>
        <button className="btn" disabled={!sel} onClick={() => sel && clone(sel)}>
          <Icon name="duplicate" /> Clone
        </button>
        <button className="btn" disabled={!sel} onClick={() => sel && copyUri(sel)}>
          <Icon name="link" /> Copy URI
        </button>
        <button className="btn danger" disabled={!sel} onClick={() => sel && remove(sel)}>
          <Icon name="trash" /> Delete
        </button>
      </div>
      <div className="list" style={{ height: 360 }}>
        {connections.length === 0 && (
          <div className="tree-empty">
            No saved connections yet.
            <br />
            <button className="btn primary" style={{ marginTop: 10 }} onClick={create}>
              <Icon name="plus" /> New connection
            </button>
          </div>
        )}
        {groups.map(([folder, list]) => (
          <div key={folder}>
            {folder && (
              <div className="list-row" style={{ background: 'var(--bg-2)', fontWeight: 600 }}>
                <Icon name="folder" /> {folder}
              </div>
            )}
            {list.map((c) => {
              const isLive = Object.values(live).some((l) => l.configId === c.id)
              return (
                <div
                  key={c.id}
                  className={`list-row ${selected === c.id ? 'selected' : ''}`}
                  onClick={() => setSelected(c.id)}
                  onDoubleClick={() => doConnect(c.id)}
                  style={{ paddingLeft: folder ? 26 : 10 }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color ?? 'transparent', border: c.color ? 0 : '1px solid var(--border-strong)' }} />
                  <Icon name="server" />
                  <b className="ellipsis" style={{ minWidth: 120 }}>
                    {c.name}
                  </b>
                  <span className="muted mono ellipsis grow">{connectionHostLabel(c)}</span>
                  {c.readOnly && (
                    <span className="badge" style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }} title="Read-only connection: changes are blocked">
                      Read-only
                    </span>
                  )}
                  {c.ssh.enabled && <span className="badge">SSH</span>}
                  {c.tls.enabled && <span className="badge">TLS</span>}
                  {c.auth.mechanism !== 'none' && <span className="badge">{c.auth.username ?? c.auth.mechanism}</span>}
                  {c.exposeToMcp && (
                    <span className="badge" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }} title="Exposed to MCP clients">
                      MCP
                    </span>
                  )}
                  {isLive && <span className="badge" style={{ color: 'var(--ok)' }}>connected</span>}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function openConnectionManager(): Promise<void> {
  return openModal<void>((close) => <Manager close={() => close()} />)
}
