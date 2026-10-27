import { useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { CollectionInfo } from '@shared/api'
import { TYPE_AHEAD_RESET_MS, typeAheadTarget } from '@shared/typeAhead'
import { api } from '../lib/api'
import { byUsage } from '@shared/connectionUsage'
import { connectionUsage } from '../lib/connectionUsage'
import { openInMongosh } from './shell/openInMongosh'
import {
  collKey,
  connect,
  dbKey,
  disconnect,
  errorText,
  isConnReadOnly,
  openCollectionTab,
  openAggregationTab,
  openCollectionHistoryTab,
  openGridFsTab,
  openSearchTab,
  openServerStatusTab,
  openTasksTab,
  openValidationTab,
  useTreeClipboard,
  openCompareTab,
  openMaskingTab,
  openMigrationTab,
  openReschemaTab,
  openIndexesTab,
  openPlaygroundTab,
  openProfilerTab,
  openQueryManagerTab,
  openSchemaTab,
  openShellTab,
  openSqlTab,
  openUsersTab,
  refreshCollections,
  refreshDatabases,
  reloadConnections,
  toast,
  toggleExpanded,
  useStore
} from '../state/store'
import type { LiveConn } from '../state/store'
import { showMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { confirmDialog, promptDialog } from './Modal'
import { openConnectionManager } from './connections/ConnectionManager'
import { editConnection } from './connections/ConnectionEditor'
import { openExportDialog, openImportDialog } from './transfer/TransferDialogs'
import { openPasteDialog } from './copy/PasteDialog'

const nameRule = (v: string): string | null => {
  if (!v.trim()) return 'Name is required'
  if (/[$\0]/.test(v)) return 'Name cannot contain $ or null characters'
  return null
}

const dbNameRule = (v: string): string | null => {
  if (!v.trim()) return 'Name is required'
  if (/[/\\. "$*<>:|?]/.test(v)) return 'Database names cannot contain /\\. "$*<>:|?'
  return null
}

const fmtCount = (n: number | undefined): string => {
  if (n === undefined || n < 0) return ''
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(n)
}

async function addCollection(connId: string, db: string): Promise<void> {
  const name = await promptDialog({ title: 'Add collection', label: `New collection in ${db}`, validate: nameRule, confirmLabel: 'Create' })
  if (!name) return
  try {
    await api.createCollection(connId, db, name)
    await refreshCollections(connId, db)
    toggleExpanded(dbKey(connId, db), true)
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

async function addDatabase(connId: string): Promise<void> {
  const db = await promptDialog({ title: 'Add database', label: 'Database name', validate: dbNameRule, confirmLabel: 'Next' })
  if (!db) return
  const coll = await promptDialog({ title: 'Add database', label: `MongoDB creates a database with its first collection. Collection name in ${db}:`, validate: nameRule, confirmLabel: 'Create' })
  if (!coll) return
  try {
    await api.createCollection(connId, db, coll)
    await refreshDatabases(connId)
    await refreshCollections(connId, db)
    toggleExpanded(dbKey(connId, db), true)
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

const firstUserDb = (l: LiveConn): string => l.databases?.find((d) => !['admin', 'local', 'config'].includes(d.name))?.name ?? 'test'

/** "Paste …" for collections / databases copied in the tree (opens the copy dialog). */
function pasteItem(connId: string, db?: string): MenuItem {
  const item = useTreeClipboard.getState().item
  const label = !item ? 'Paste' : item.kind === 'database' ? `Paste Database "${item.db}"…` : `Paste ${item.colls.length > 1 ? `${item.colls.length} Collections` : `Collection "${item.colls[0]}"`}…`
  return {
    label,
    icon: 'paste',
    disabled: !item || (item.kind === 'collection' && !db) || isConnReadOnly(connId),
    onClick: () => item && void openPasteDialog({ source: item, target: { connId, db } })
  }
}

function connMenu(l: LiveConn): MenuItem[] {
  const ro = !!l.readOnly
  return [
    { label: 'Refresh', icon: 'refresh', onClick: () => refreshDatabases(l.connId) },
    { label: 'Add database…', icon: 'plus', disabled: ro, onClick: () => addDatabase(l.connId) },
    { separator: true },
    { label: 'Open Shell', icon: 'terminal', onClick: () => openShellTab(l.connId, firstUserDb(l)) },
    { label: 'Open in mongosh', icon: 'terminal', onClick: () => void openInMongosh(l.connId) },
    { label: 'Open Playground (JS / TS / Mongoose)', icon: 'code', onClick: () => openPlaygroundTab(l.connId, firstUserDb(l)) },
    { label: 'Query Library', icon: 'history', onClick: () => openQueryManagerTab(l.connId) },
    { label: 'Users & Roles', icon: 'users', onClick: () => openUsersTab(l.connId, 'admin') },
    { label: 'Server Status', icon: 'activity', onClick: () => openServerStatusTab(l.connId) },
    { label: 'Tasks', icon: 'tasks', onClick: () => openTasksTab(l.connId) },
    pasteItem(l.connId),
    { label: 'Query Profiler / Current Operations', icon: 'gauge', onClick: () => openProfilerTab(l.connId, 'admin') },
    { separator: true },
    { label: 'Import…', icon: 'import', disabled: ro, onClick: () => openImportDialog({ connId: l.connId }) },
    { separator: true },
    {
      label: 'Edit connection…',
      icon: 'edit',
      onClick: async () => {
        const cfg = useStore.getState().connections.find((c) => c.id === l.configId)
        if (cfg && (await editConnection(cfg))) await reloadConnections()
      }
    },
    { label: 'Disconnect', icon: 'unplug', onClick: () => disconnect(l.connId) }
  ]
}

function dbMenu(connId: string, db: string): MenuItem[] {
  const ro = isConnReadOnly(connId)
  return [
    { label: 'Refresh', icon: 'refresh', onClick: () => refreshCollections(connId, db) },
    { label: 'Add collection…', icon: 'plus', disabled: ro, onClick: () => addCollection(connId, db) },
    { separator: true },
    { label: 'Open Shell', icon: 'terminal', onClick: () => openShellTab(connId, db) },
    { label: 'Open in mongosh', icon: 'terminal', onClick: () => void openInMongosh(connId, db) },
    { label: 'Find in Database…', icon: 'search', onClick: () => openSearchTab(connId, db) },
    { label: 'GridFS Files', icon: 'files', onClick: () => openGridFsTab(connId, db) },
    { label: 'Change History', icon: 'history', onClick: () => openCollectionHistoryTab(connId, db) },
    { separator: true },
    { label: 'Copy Database', icon: 'copy', onClick: () => useTreeClipboard.setState({ item: { kind: 'database', connId, db } }) },
    pasteItem(connId, db),
    { label: 'SQL Query', icon: 'sql', onClick: () => openSqlTab(connId, db) },
    { label: 'Users & Roles', icon: 'users', onClick: () => openUsersTab(connId, db) },
    { label: 'Open Playground (JS / TS / Mongoose)', icon: 'code', onClick: () => openPlaygroundTab(connId, db) },
    { label: 'Query Profiler', icon: 'gauge', onClick: () => openProfilerTab(connId, db) },
    { separator: true },
    { label: 'Export collections…', icon: 'export', onClick: () => openExportDialog({ connId, db }) },
    { label: 'Migrate to SQL…', icon: 'sql', onClick: () => openMigrationTab(connId, db, { direction: 'toSql' }) },
    { label: 'Import from SQL…', icon: 'sql', disabled: ro, onClick: () => openMigrationTab(connId, db, { direction: 'fromSql' }) },
    { label: 'Import…', icon: 'import', disabled: ro, onClick: () => openImportDialog({ connId, db }) },
    { separator: true },
    { label: 'Copy name', icon: 'copy', onClick: () => api.copyText(db) },
    {
      label: 'Drop database…',
      icon: 'trash',
      danger: true,
      disabled: ro,
      onClick: async () => {
        const typed = await promptDialog({
          title: 'Drop database',
          label: `This permanently deletes the database "${db}" and all its collections. Type the database name to confirm:`,
          validate: (v) => (v === db ? null : 'Name does not match'),
          confirmLabel: 'Drop database'
        })
        if (typed !== db) return
        try {
          await api.dropDatabase(connId, db)
          await refreshDatabases(connId)
          toast(`Dropped database ${db}`, 'success')
        } catch (e) {
          toast(errorText(e), 'error')
        }
      }
    }
  ]
}

function collMenu(connId: string, db: string, c: CollectionInfo): MenuItem[] {
  const ro = isConnReadOnly(connId)
  return [
    { label: 'Open', icon: 'table', onClick: () => openCollectionTab(connId, db, c.name, c.type === 'view') },
    { label: 'Pipeline Editor', icon: 'aggregate', onClick: () => openAggregationTab(connId, db, c.name) },
    { label: 'Manage Indexes', icon: 'key', disabled: c.type === 'view', onClick: () => openIndexesTab(connId, db, c.name) },
    { label: 'Validation Rules…', icon: 'shield', disabled: c.type === 'view', onClick: () => openValidationTab(connId, db, c.name) },
    ...(c.type === 'view' ? [{ label: 'Edit View…', icon: 'aggregate', onClick: () => openAggregationTab(connId, db, c.name, { view: c.name }) } as MenuItem] : []),
    { label: 'Change History', icon: 'history', onClick: () => openCollectionHistoryTab(connId, db, c.name) },
    { separator: true },
    { label: 'Copy Collection', icon: 'copy', onClick: () => useTreeClipboard.setState({ item: { kind: 'collection', connId, db, colls: [c.name] } }) },
    { label: 'Schema Analysis', icon: 'schema', onClick: () => openSchemaTab(connId, db, c.name) },
    { label: 'SQL Query', icon: 'sql', onClick: () => openSqlTab(connId, db, c.name) },
    { label: 'Diff & Sync…', icon: 'compare', onClick: () => openCompareTab(connId, db, c.name) },
    { label: 'Data Masking…', icon: 'mask', onClick: () => openMaskingTab(connId, db, c.name) },
    { label: 'Restructure Fields…', icon: 'reschema', disabled: c.type === 'view' || ro, onClick: () => openReschemaTab(connId, db, c.name) },
    { label: 'Migrate to SQL…', icon: 'sql', disabled: c.type === 'view', onClick: () => openMigrationTab(connId, db, { direction: 'toSql', collections: [c.name] }) },
    { label: 'Query Library', icon: 'history', onClick: () => openQueryManagerTab(connId, db, c.name) },
    { separator: true },
    { label: 'Export…', icon: 'export', onClick: () => openExportDialog({ connId, db, collections: [c.name] }) },
    { label: 'Import into…', icon: 'import', disabled: c.type === 'view' || ro, onClick: () => openImportDialog({ connId, db, collection: c.name }) },
    { separator: true },
    { label: 'Copy name', icon: 'copy', onClick: () => api.copyText(c.name) },
    {
      label: 'Rename…',
      icon: 'edit',
      disabled: c.type === 'view' || ro,
      onClick: async () => {
        const n = await promptDialog({ title: 'Rename collection', label: `New name for ${db}.${c.name}`, initial: c.name, validate: nameRule, confirmLabel: 'Rename' })
        if (!n || n === c.name) return
        try {
          await api.renameCollection(connId, db, c.name, n)
          await refreshCollections(connId, db)
        } catch (e) {
          toast(errorText(e), 'error')
        }
      }
    },
    {
      label: c.type === 'view' ? 'Drop view…' : 'Drop collection…',
      icon: 'trash',
      danger: true,
      disabled: ro,
      onClick: async () => {
        const ok = await confirmDialog({
          title: c.type === 'view' ? 'Drop view' : 'Drop collection',
          message: (
            <>
              Permanently drop <b>{db}.{c.name}</b>
              {c.type !== 'view' ? ' and all its documents and indexes' : ''}? This cannot be undone.
            </>
          ),
          confirmLabel: 'Drop',
          danger: true
        })
        if (!ok) return
        try {
          await api.dropCollection(connId, db, c.name)
          await refreshCollections(connId, db)
          toast(`Dropped ${db}.${c.name}`, 'success')
        } catch (e) {
          toast(errorText(e), 'error')
        }
      }
    }
  ]
}

function ConnectionNode({ l, filter }: { l: LiveConn; filter: string }): ReactElement {
  const expanded = useStore((s) => s.expanded)
  const collections = useStore((s) => s.collections)
  const counts = useStore((s) => s.counts)
  const selection = useStore((s) => s.treeSelection)
  const select = (k: string): void => useStore.setState({ treeSelection: k })
  const open = expanded[l.connId]

  const toggleDb = (db: string): void => {
    const k = dbKey(l.connId, db)
    if (!expanded[k] && !collections[k]) void refreshCollections(l.connId, db)
    toggleExpanded(k)
  }

  const f = filter.toLowerCase()
  return (
    <>
      <div
        className={`tree-row ${selection === l.connId ? 'selected' : ''}`}
        style={{ paddingLeft: 4 }}
        data-tree-key={l.connId}
        data-tree-parent=""
        data-tree-name={l.name}
        onClick={() => select(l.connId)}
        onDoubleClick={() => toggleExpanded(l.connId)}
        onContextMenu={(e) => {
          select(l.connId)
          showMenu(e, connMenu(l))
        }}
        title={`MongoDB ${l.serverVersion} — ${l.topology}`}
      >
        <span className="twisty" onClick={() => toggleExpanded(l.connId)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </span>
        <span className="ico server" style={l.color ? { color: l.color } : undefined}>
          <Icon name="server" />
        </span>
        <span className="label" style={{ fontWeight: 600 }}>
          {l.name}
        </span>
        {l.readOnly && (
          <span className="ro-badge" title="Read-only connection: changes are blocked">
            <Icon name="lock" size={11} /> read-only
          </span>
        )}
        {l.loading && <span className="count">…</span>}
      </div>
      {open && l.error && (
        <div className="tree-row" style={{ paddingLeft: 40, color: 'var(--danger)' }} title={l.error}>
          <span className="label">{l.error}</span>
        </div>
      )}
      {open &&
        l.databases?.map((d) => {
          const k = dbKey(l.connId, d.name)
          const colls = collections[k]
          const visible = colls?.filter((c) => !f || c.name.toLowerCase().includes(f))
          if (f && colls && !visible?.length && !d.name.toLowerCase().includes(f)) return null
          const dbOpen = expanded[k] || (!!f && !!visible?.length)
          return (
            <div key={d.name}>
              <div
                className={`tree-row ${selection === k ? 'selected' : ''}`}
                style={{ paddingLeft: 22 }}
                data-tree-key={k}
                data-tree-parent={l.connId}
                data-tree-name={d.name}
                onClick={() => select(k)}
                onDoubleClick={() => toggleDb(d.name)}
                onContextMenu={(e) => {
                  select(k)
                  showMenu(e, dbMenu(l.connId, d.name))
                }}
              >
                <span className="twisty" onClick={() => toggleDb(d.name)}>
                  <Icon name={dbOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                </span>
                <span className="ico">
                  <Icon name="database" />
                </span>
                <span className="label">{d.name}</span>
              </div>
              {dbOpen &&
                (visible ?? []).map((c) => {
                  const ck = collKey(l.connId, d.name, c.name)
                  return (
                    <div
                      key={c.name}
                      className={`tree-row ${selection === ck ? 'selected' : ''}`}
                      style={{ paddingLeft: 40 }}
                      data-tree-key={ck}
                      data-tree-parent={k}
                      data-tree-name={c.name}
                      onClick={() => select(ck)}
                      onDoubleClick={() => openCollectionTab(l.connId, d.name, c.name, c.type === 'view')}
                      onContextMenu={(e) => {
                        select(ck)
                        showMenu(e, collMenu(l.connId, d.name, c))
                      }}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', c.name)}
                    >
                      <span className="twisty" />
                      <span className="ico">
                        <Icon name={c.type === 'view' ? 'view' : 'collection'} />
                      </span>
                      <span className="label" style={c.name.startsWith('system.') ? { color: 'var(--text-3)' } : undefined}>
                        {c.name}
                      </span>
                      <span className="count">{fmtCount(counts[ck])}</span>
                    </div>
                  )
                })}
              {dbOpen && colls?.length === 0 && (
                <div className="tree-row faint" style={{ paddingLeft: 58 }}>
                  no collections
                </div>
              )}
            </div>
          )
        })}
    </>
  )
}

export function Sidebar(): ReactElement {
  const live = useStore((s) => s.live)
  const saved = useStore((s) => s.connections)
  const [filter, setFilter] = useState('')
  const lives = Object.values(live)
  const typed = useRef({ text: '', at: 0 })

  // Type-to-jump: letters select the next row at the same level whose name starts with them.
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.target !== e.currentTarget) return
    const now = Date.now()
    const fresh = now - typed.current.at > TYPE_AHEAD_RESET_MS
    if (e.key === ' ' && fresh) return
    typed.current = { text: fresh ? e.key : typed.current.text + e.key, at: now }
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tree-key]')]
    const items = rows.map((r) => ({ key: r.dataset.treeKey ?? '', parent: r.dataset.treeParent ?? '', name: r.dataset.treeName ?? '' }))
    const hit = typeAheadTarget(items, useStore.getState().treeSelection, typed.current.text)
    e.preventDefault()
    if (!hit) return
    useStore.setState({ treeSelection: hit })
    rows.find((r) => r.dataset.treeKey === hit)?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <>
      <div className="tree-header">
        <span className="grow">Connections</span>
        <button className="btn ghost icon small" title="Connection Manager" onClick={() => openConnectionManager()}>
          <Icon name="plug" size={14} />
        </button>
        <button
          className="btn ghost icon small"
          title="Refresh all"
          onClick={() => lives.forEach((l) => refreshDatabases(l.connId))}
          disabled={!lives.length}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {lives.length > 0 && (
        <div className="tree-filter">
          <input className="input small" style={{ width: '100%' }} placeholder="Filter collections…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="tree" tabIndex={0} onKeyDown={onTreeKey}>
        {lives.map((l) => (
          <ConnectionNode key={l.connId} l={l} filter={filter} />
        ))}
        {lives.length === 0 && (
          <div className="tree-empty">
            <div>Not connected.</div>
            {saved.length > 0 ? (
              <div className="col" style={{ marginTop: 12, alignItems: 'stretch' }}>
                {byUsage(saved, connectionUsage()).slice(0, 8).map((c) => (
                  <button key={c.id} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => connect(c.id)}>
                    <Icon name="server" style={{ color: c.color ?? 'var(--leaf)' }} />
                    <span className="ellipsis">{c.name}</span>
                    {c.readOnly && <Icon name="lock" size={11} style={{ marginLeft: 'auto', opacity: 0.7 }} />}
                  </button>
                ))}
                <button className="link" style={{ marginTop: 6 }} onClick={() => openConnectionManager()}>
                  Open Connection Manager…
                </button>
              </div>
            ) : (
              <button className="btn primary" style={{ marginTop: 12 }} onClick={() => openConnectionManager()}>
                <Icon name="plug" /> Connect…
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
