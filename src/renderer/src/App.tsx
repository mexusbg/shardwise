import { memo, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { newConnectionConfig } from '@shared/connection'
import { onEvent } from './lib/api'
import { installCommandDispatcher, shortcutLabel, useCommandHandlers, useShortcut, withShortcut } from './lib/commands'
import {
  closeTab,
  connName,
  disconnect,
  guardWrite,
  isToolTab,
  loadInitial,
  openCollectionTab,
  openPlaygroundTab,
  openProfilerTab,
  openSearchTab,
  openShellTab,
  openSqlTab,
  openToolTab,
  patchTab,
  reloadConnections,
  toast,
  updateJob,
  useStore
} from './state/store'
import type { AnyTab } from './state/store'
import { runQuery } from './state/queryActions'
import { editConnection } from './components/connections/ConnectionEditor'
import { ContextMenuHost, showMenu } from './components/ContextMenu'
import { Icon } from './components/Icon'
import { ModalHost } from './components/Modal'
import { QueryTab } from './components/QueryTab'
import { Sidebar } from './components/Sidebar'
import { openConnectionManager } from './components/connections/ConnectionManager'
import { openSettings } from './components/SettingsDialog'
import { openExportDialog, openImportDialog } from './components/transfer/TransferDialogs'
import { JobsPanel } from './components/transfer/JobsPanel'
import { ProfilerView } from './components/profiler/ProfilerView'
import { PlaygroundView } from './components/playground/PlaygroundView'
import { ToolView } from './components/tools/ToolView'
import { ErrorBoundary } from './components/ErrorBoundary'
import { openQuickOpen } from './components/QuickOpen'
import { UpdateNotice } from './components/UpdateNotice'
import { McpApprovalHost } from './components/mcp/McpApproval'
import { AssistantPanel, useAssistant } from './components/ai/AssistantPanel'
import { initSession, restoreSession } from './lib/session'
import { valueColorsCss } from '@shared/valueColors'

/** The startup Connection Manager opens once per launch (effects run twice in development). */
let startupManagerShown = false

function useTheme(): void {
  const theme = useStore((s) => s.settings.theme)
  const valueColors = useStore((s) => s.settings.valueColors)
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
  useEffect(() => {
    // Settings → Browsing data → Value colours: overrides of the --t-* theme tokens.
    let el = document.getElementById('value-colors') as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = 'value-colors'
      document.head.appendChild(el)
    }
    el.textContent = valueColorsCss(valueColors ?? {})
  }, [valueColors])
}

function Toasts(): ReactElement {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

function closeOtherTabs(id: string): void {
  useStore.setState((s) => ({ tabs: s.tabs.filter((x) => x.id === id), activeTab: id }))
}

/** Open the same collection, script or tool again in a new tab. */
function duplicateTab(t: AnyTab): void {
  if (t.kind === 'query') {
    const id = openCollectionTab(t.connId, t.db, t.coll, t.isView)
    // `noAutoLoad` keeps the new tab's default-query loader from replacing the copied text.
    patchTab(id, {
      noAutoLoad: true,
      queryText: t.queryText,
      projectionText: t.projectionText,
      sortText: t.sortText,
      skipText: t.skipText,
      limitText: t.limitText,
      collationText: t.collationText,
      pageSize: t.pageSize,
      view: t.view,
      readOnly: t.readOnly
    })
    void runQuery(id)
  } else if (t.kind === 'playground') {
    openPlaygroundTab(t.connId, t.db, { code: t.code, language: t.language, title: `${t.title} (copy)` })
  } else if (t.kind === 'profiler') {
    openProfilerTab(t.connId, t.db)
  } else {
    const { id: _id, ...rest } = t
    openToolTab(rest)
  }
}

/** Connection / database / collection the toolbar and app commands act on: the tree selection, else the active tab. */
function currentTarget(): { connId: string; db?: string; coll?: string } | null {
  const s = useStore.getState()
  if (s.treeSelection) {
    const [connId, db, ...rest] = s.treeSelection.split('/')
    if (s.live[connId]) return { connId, db, coll: rest.length ? rest.join('/') : undefined }
  }
  const tab = s.tabs.find((t) => t.id === s.activeTab)
  if (tab) return { connId: tab.connId, db: tab.db || undefined, coll: tab.kind === 'query' ? tab.coll : undefined }
  const first = Object.keys(s.live)[0]
  return first ? { connId: first } : null
}

function targetDb(what: string): { connId: string; db: string } | null {
  const t = currentTarget()
  if (t?.db) return { connId: t.connId, db: t.db }
  toast(Object.keys(useStore.getState().live).length ? `Select a database in the tree to ${what}` : 'Connect to a server first', 'info')
  return null
}

function switchTab(delta: 1 | -1): boolean {
  const { tabs, activeTab } = useStore.getState()
  if (tabs.length < 2) return false
  const i = tabs.findIndex((t) => t.id === activeTab)
  useStore.setState({ activeTab: tabs[(i + delta + tabs.length) % tabs.length].id })
  return true
}

function startImport(): void {
  const t = currentTarget()
  if (!t) return toast('Connect to a server first', 'info')
  if (guardWrite(t.connId, 'Imports')) void openImportDialog({ connId: t.connId, db: t.db, collection: t.coll })
}

function startExport(): void {
  const t = currentTarget()
  if (!t) return toast('Connect to a server first', 'info')
  if (!t.db) return toast('Select a database or collection in the tree to export', 'info')
  void openExportDialog({ connId: t.connId, db: t.db, collections: t.coll ? [t.coll] : undefined })
}

/** App-wide keyboard commands (Settings → Shortcuts → Application / Tabs). */
function useAppCommands(): void {
  useEffect(() => {
    return installCommandDispatcher()
  }, [])
  useCommandHandlers(true, {
    'app.connectionManager': () => void openConnectionManager(),
    'app.newConnection': () =>
      void editConnection(newConnectionConfig()).then((c) => {
        if (c) void reloadConnections()
      }),
    'app.preferences': () => void openSettings(),
    'app.quickOpen': () => openQuickOpen(),
    'app.findInDatabase': () => {
      const t = targetDb('search it')
      if (t) openSearchTab(t.connId, t.db)
    },
    'app.import': () => startImport(),
    'app.export': () => startExport(),
    'app.openShell': () => {
      const t = targetDb('open a shell')
      if (t) openShellTab(t.connId, t.db)
    },
    'app.openPlayground': () => {
      const t = targetDb('open a playground')
      if (t) openPlaygroundTab(t.connId, t.db)
    },
    'app.openSql': () => {
      const t = targetDb('open a SQL query')
      if (t) openSqlTab(t.connId, t.db, currentTarget()?.coll)
    },
    'app.toggleAssistant': () => useAssistant.getState().toggle(),
    'tab.close': () => {
      const id = useStore.getState().activeTab
      // Without tabs the key goes on to the window menu (Close Window).
      if (!id) return false
      closeTab(id)
    },
    'tab.next': () => switchTab(1),
    'tab.previous': () => switchTab(-1),
    'tab.duplicate': () => {
      const s = useStore.getState()
      const t = s.tabs.find((x) => x.id === s.activeTab)
      if (!t) return false
      duplicateTab(t)
    },
    'tab.closeOthers': () => {
      const id = useStore.getState().activeTab
      if (!id) return false
      closeOtherTabs(id)
    },
    'tab.closeAll': () => {
      if (!useStore.getState().tabs.length) return false
      useStore.setState({ tabs: [], activeTab: null })
    }
  })
}

function TabBar(): ReactElement {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.activeTab)
  const live = useStore((s) => s.live)
  useShortcut('tab.close')
  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === active ? 'active' : ''}`}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              closeTab(t.id)
            } else useStore.setState({ activeTab: t.id })
          }}
          onContextMenu={(e) =>
            showMenu(e, [
              { label: 'Close', shortcut: t.id === active ? shortcutLabel('tab.close') : undefined, onClick: () => closeTab(t.id) },
              { label: 'Close Others', shortcut: t.id === active ? shortcutLabel('tab.closeOthers') : undefined, onClick: () => closeOtherTabs(t.id) },
              { label: 'Close All', shortcut: shortcutLabel('tab.closeAll'), onClick: () => useStore.setState({ tabs: [], activeTab: null }) },
              { separator: true },
              { label: 'Duplicate', icon: 'duplicate', shortcut: t.id === active ? shortcutLabel('tab.duplicate') : undefined, onClick: () => duplicateTab(t) }
            ])
          }
          title={
            t.kind === 'query'
              ? `${connName(t.connId)} › ${t.db}.${t.coll}`
              : t.kind === 'profiler'
                ? `${connName(t.connId)} › ${t.db} — Query Profiler`
                : t.kind === 'playground'
                  ? `${connName(t.connId)} › ${t.db} — ${t.filePath ?? t.title}`
                  : `${connName(t.connId)} › ${t.db}${t.coll ? `.${t.coll}` : ''} — ${t.title}`
          }
        >
          <span className="conn-dot" style={{ background: live[t.connId]?.color ?? 'var(--leaf)' }} />
          {live[t.connId]?.readOnly && (
            <span className="ro-lock" title="Read-only connection">
              <Icon name="lock" size={11} />
            </span>
          )}
          <Icon name={isToolTab(t) ? t.icon : t.kind === 'profiler' ? 'gauge' : t.kind === 'playground' ? 'code' : t.isView ? 'view' : 'collection'} size={13} />
          <span className="ellipsis">
            {t.kind === 'query' ? t.coll : t.kind === 'profiler' ? 'Profiler' : t.kind === 'playground' ? `${t.title}${t.dirty ? ' •' : ''}` : t.title}
          </span>
          <span className="faint ellipsis" style={{ fontSize: 11 }}>
            {t.db}
          </span>
          <button
            className="btn ghost icon small close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => closeTab(t.id)}
            title={withShortcut('Close tab', 'tab.close')}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Tools that only read: no read-only banner. Query tabs show their own lock. */
const READ_TOOLS = new Set(['query', 'queries', 'schema', 'search', 'server'])

function ReadOnlyBanner({ kind }: { kind: AnyTab['kind'] }): ReactElement {
  const scripted = kind === 'shell' || kind === 'playground'
  return (
    <div className="ro-banner">
      <Icon name="lock" size={13} />
      <span>
        {scripted
          ? 'Read-only connection: write commands and driver write methods are refused in this session. For a hard guarantee, connect with a database user that only has read roles.'
          : 'Read-only connection: changes are blocked. Turn off "Read-only" in the connection settings to make changes.'}
      </span>
    </div>
  )
}

/** One tab's content. Memoized: store updates replace only the changed tab object, so other tabs skip re-rendering. */
const TabPane = memo(function TabPane({ tab: t, active }: { tab: AnyTab; active: boolean }): ReactElement {
  const banner = useStore((s) => !!s.live[t.connId]?.readOnly) && !READ_TOOLS.has(t.kind)
  const pane = (
    <div style={{ display: active ? 'flex' : 'none', flex: 1, minHeight: 0, minWidth: 0 }}>
      <ErrorBoundary label={t.kind === 'query' ? t.coll : t.kind === 'profiler' ? 'Query Profiler' : t.title}>
        {t.kind === 'query' ? (
          <QueryTab tab={t} />
        ) : t.kind === 'profiler' ? (
          <ProfilerView tab={t} />
        ) : t.kind === 'playground' ? (
          <PlaygroundView tab={t} />
        ) : (
          <ToolView tab={t} />
        )}
      </ErrorBoundary>
    </div>
  )
  if (!banner) return pane
  return (
    <div style={{ display: active ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      <ReadOnlyBanner kind={t.kind} />
      {pane}
    </div>
  )
})

function RestoreCard(): ReactElement | null {
  const pending = useStore((s) => s.pendingSession)
  const connections = useStore((s) => s.connections)
  const [busy, setBusy] = useState(false)
  if (!pending) return null
  const names = [...new Set(pending.tabs.map((t) => connections.find((c) => c.id === t.configId)?.name).filter(Boolean))]
  return (
    <div className="restore-card">
      <Icon name="history" size={16} />
      <div className="grow">
        <b>
          Restore your last session? {pending.tabs.length} tab{pending.tabs.length === 1 ? '' : 's'}
        </b>
        <div className="faint">{names.length ? `on ${names.join(', ')}` : 'connections no longer saved'}</div>
      </div>
      <button className="btn" onClick={() => useStore.setState({ pendingSession: null })}>
        Dismiss
      </button>
      <button
        className="btn primary"
        disabled={busy || !names.length}
        onClick={async () => {
          setBusy(true)
          await restoreSession(pending)
          setBusy(false)
        }}
      >
        {busy ? 'Reconnecting…' : 'Restore'}
      </button>
    </div>
  )
}

function Welcome(): ReactElement {
  const live = useStore((s) => s.live)
  const hasLive = Object.keys(live).length > 0
  const runKey = useShortcut('query.run')
  const closeKey = useShortcut('tab.close')
  return (
    <div className="welcome">
      <div className="welcome-card">
        <Icon name="leaf" size={48} style={{ color: 'var(--leaf)' }} />
        <h1>Shardwise</h1>
        <RestoreCard />
        {hasLive ? (
          <div>Double-click a collection in the tree to open it.</div>
        ) : (
          <div>Connect to a MongoDB server to browse databases, build queries visually and edit documents.</div>
        )}
        <div className="row">
          <button className="btn primary" onClick={() => openConnectionManager()}>
            <Icon name="plug" /> Connect…
          </button>
        </div>
        {(runKey || closeKey) && (
          <div className="faint" style={{ marginTop: 18, fontSize: 12 }}>
            {runKey && (
              <>
                <span className="kbd">{runKey}</span> runs the query
              </>
            )}
            {runKey && closeKey && ' · '}
            {closeKey && (
              <>
                <span className="kbd">{closeKey}</span> closes the tab
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusBar(): ReactElement {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeTab)
  const live = useStore((s) => s.live)
  const tab = tabs.find((t) => t.id === activeId)
  const conn = tab ? live[tab.connId] : undefined
  return (
    <div className="statusbar">
      <span>{Object.keys(live).length} connection(s)</span>
      {conn && (
        <>
          <span>
            {conn.name} · MongoDB {conn.serverVersion}
          </span>
          <span>{conn.topology}</span>
        </>
      )}
      <span className="spacer" />
      <UpdateNotice />
      {conn?.readOnly && tab?.kind !== 'query' && (
        <span className="row" style={{ gap: 4 }}>
          <Icon name="lock" size={12} /> read-only connection
        </span>
      )}
      {tab?.kind === 'query' && tab.readOnly && (
        <span className="row" style={{ gap: 4 }}>
          <Icon name="lock" size={12} /> read-only
        </span>
      )}
    </div>
  )
}

export function App(): ReactElement {
  useTheme()
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeTab)
  const active = tabs.find((t) => t.id === activeId)
  const [sidebarW, setSidebarW] = useState(() => Number(localStorageGet('sidebarW')) || 280)
  const [dragging, setDragging] = useState(false)
  const treeSel = useStore((s) => s.treeSelection)
  const live = useStore((s) => s.live)
  const assistantOpen = useAssistant((s) => s.open)
  useAppCommands()
  useShortcut('app.connectionManager')

  useEffect(() => {
    loadInitial()
      .then(() => initSession())
      .then(() => {
        // Settings → Workspace: start in the Connection Manager unless tabs came back or a restore offer is shown.
        const s = useStore.getState()
        if (startupManagerShown || !s.settings.connectionManagerOnStart || s.tabs.length || s.pendingSession || document.querySelector('.modal')) return
        startupManagerShown = true
        void openConnectionManager()
      })
      .catch((e) => toast(String(e), 'error'))
    const offJob = onEvent('job:progress', updateJob)
    const offLost = onEvent('connection:lost', ({ connId, error }) => {
      toast(`Connection ${connName(connId)} lost: ${error}`, 'error')
      void disconnect(connId)
    })
    // Keyboard shortcuts: lib/commands.ts (installed by useAppCommands); tabs register their own commands.
    return () => {
      offJob()
      offLost()
    }
  }, [])

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    setDragging(true)
    const move = (ev: MouseEvent): void => setSidebarW(Math.max(180, Math.min(600, ev.clientX)))
    const up = (ev: MouseEvent): void => {
      setDragging(false)
      localStorageSet('sidebarW', String(Math.max(180, Math.min(600, ev.clientX))))
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="app">
      <div className="toolbar">
        <div className="brand">
          <Icon name="leaf" size={18} /> Shardwise
        </div>
        <button className="btn ghost" onClick={() => openConnectionManager()} title={withShortcut('Open the Connection Manager', 'app.connectionManager')}>
          <Icon name="plug" /> Connect
        </button>
        <span className="sep" />
        <button className="btn ghost" disabled={!Object.keys(live).length} onClick={startImport} title={withShortcut('Import into the selected database or collection', 'app.import')}>
          <Icon name="import" /> Import
        </button>
        <button
          className="btn ghost"
          disabled={!Object.keys(live).length}
          onClick={startExport}
          title={withShortcut('Export the selected database or collection', 'app.export')}
        >
          <Icon name="export" /> Export
        </button>
        <span className="spacer" />
        <button className={`btn ghost ${assistantOpen ? 'active' : ''}`} title={withShortcut('AI assistant', 'app.toggleAssistant')} onClick={() => useAssistant.getState().toggle()}>
          <Icon name="sparkle" /> Assistant
        </button>
        <button className="btn ghost icon" title="Settings" onClick={() => openSettings()}>
          <Icon name="settings" />
        </button>
      </div>
      <div className="main">
        <div className="sidebar" style={{ width: sidebarW }}>
          <Sidebar />
        </div>
        <div className={`splitter ${dragging ? 'dragging' : ''}`} onMouseDown={startDrag} />
        <div className="content">
          {tabs.length > 0 && <TabBar />}
          {tabs.map((t) => (
            <TabPane key={t.id} tab={t} active={t.id === activeId} />
          ))}
          {!active && <Welcome />}
        </div>
        {assistantOpen && <AssistantPanel />}
      </div>
      <StatusBar />
      <Toasts />
      <JobsPanel />
      <ModalHost />
      <McpApprovalHost />
      <ContextMenuHost />
    </div>
  )
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

function localStorageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v)
  } catch {
    // Non-essential UI preference.
  }
}
