import { useEffect, useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import { collectPaths } from '@shared/docPaths'
import { connName, openAggregationTab, patchTab, useStore } from '../state/store'
import type { QueryTab as Tab, ViewMode } from '../state/store'
import {
  clearDefaultQuery,
  countDocuments,
  gotoLastPage,
  listDefaultScopes,
  loadDefaultQuery,
  refreshPage,
  runQuery,
  saveDefaultQuery,
  syncTextToVqb
} from '../state/queryActions'
import { shortcutLabel, useCommandHandlers, useShortcut, withShortcut } from '../lib/commands'
import type { CommandId } from '../lib/commands'
import { rememberView } from '../lib/viewMemory'
import { CodeEditor } from './CodeEditor'
import { Icon } from './Icon'
import { showMenu, showMenuAt } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { deleteMatching, editDocumentDialog, insertDocumentDialog, pasteDocuments, viewDocumentDialog } from './editing/dialogs'
import { updateDocumentsDialog } from './editing/UpdateDocumentsDialog'
import { deleteDocumentsDialog } from './editing/DeleteDocumentsDialog'
import { TableView } from './views/TableView'
import { TreeView } from './views/TreeView'
import { JsonView } from './views/JsonView'
import { ExplainView } from './profiler/ExplainView'
import { CodeView, findCodeQuery } from './codegen/CodeView'
import { openAskAi } from './ai/AskAi'
import { explainQueryWithAi, fixQueryWithAi } from './ai/AiActions'
import { QueryHistoryButton } from './history/QueryHistoryButton'
import { VqbPanel } from './vqb/VqbPanel'
import { openExportDialog } from './transfer/TransferDialogs'
import { CollationButton } from './collation/CollationPicker'

const PAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000]

function QueryBar({ tab, fields }: { tab: Tab; fields: string[] }): ReactElement {
  const run = (): void => void runQuery(tab.id)
  const err = tab.error && tab.error.part !== 'run' ? tab.error : null
  const runKey = useShortcut('query.run')
  const setText = (k: 'queryText' | 'projectionText' | 'sortText', v: string): void => patchTab(tab.id, { [k]: v, error: undefined })
  return (
    <div className="querybar">
      <div className="qlabel">Query</div>
      <CodeEditor
        value={tab.queryText}
        onChange={(v) => setText('queryText', v)}
        onSubmit={run}
        submitCommand="query.run"
        onBlur={() => syncTextToVqb(tab.id, 'query')}
        placeholder="{ field: 'value' }   — empty matches all documents"
        fields={fields}
        maxHeight={160}
        invalid={err?.part === 'query'}
      />
      <div className="row">
        <button className="btn primary" onClick={run} title={runKey ? `Run query (${runKey})` : 'Run query'} disabled={tab.loading}>
          <Icon name="play" size={12} /> Run
        </button>
        <button className={`btn icon ${tab.vqbOpen ? 'active' : ''}`} title="Toggle Filter Builder" onClick={() => patchTab(tab.id, { vqbOpen: !tab.vqbOpen })}>
          <Icon name="builder" />
        </button>
        <button className="btn icon" title="Ask AI to write the query" onClick={() => openAskAi(tab)}>
          <Icon name="sparkle" />
        </button>
        <QueryHistoryButton tab={tab} />
        <button
          className={`btn icon ${tab.defaultScope ? 'active' : ''}`}
          title={tab.defaultScope ? `Default query (saved for this ${tab.defaultScope})` : 'Default query'}
          onClick={(e) => defaultQueryMenu(e, tab)}
        >
          <Icon name="bookmark" />
        </button>
        <CollationButton tab={tab} />
      </div>

      <div className="qlabel">Projection</div>
      <div className="qrow2">
        <CodeEditor
          value={tab.projectionText}
          onChange={(v) => setText('projectionText', v)}
          onSubmit={run}
          submitCommand="query.run"
          onBlur={() => syncTextToVqb(tab.id, 'projection')}
          placeholder="{ field: 1 }"
          fields={fields}
          maxHeight={90}
          invalid={err?.part === 'projection'}
        />
        <div className="qlabel">Sort</div>
        <CodeEditor
          value={tab.sortText}
          onChange={(v) => setText('sortText', v)}
          onSubmit={run}
          submitCommand="query.run"
          onBlur={() => syncTextToVqb(tab.id, 'sort')}
          placeholder="{ field: -1 }"
          fields={fields}
          maxHeight={90}
          invalid={err?.part === 'sort'}
        />
        <div className="qlabel">Skip</div>
        <input className="input mono" value={tab.skipText} placeholder="0" onChange={(e) => patchTab(tab.id, { skipText: e.target.value.replace(/\D/g, '') })} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <div className="qlabel">Limit</div>
        <input className="input mono" value={tab.limitText} placeholder="none" onChange={(e) => patchTab(tab.id, { limitText: e.target.value.replace(/\D/g, '') })} onKeyDown={(e) => e.key === 'Enter' && run()} />
      </div>
      {err && (
        <div className="qerr">
          {err.part}: {err.message}{' '}
          <button className="link" onClick={() => void fixQueryWithAi(tab)} title="Ask the AI to correct the query">
            Fix with AI
          </button>
        </div>
      )}
      {!err && !!tab.casts && (
        <div className="qerr" style={{ color: 'var(--text-3)' }} title="Strings were converted to the type stored in the field (Settings → Auto-cast)">
          {tab.casts} value{tab.casts === 1 ? '' : 's'} auto-cast to ObjectId / Date
        </div>
      )}
    </div>
  )
}

async function defaultQueryMenu(e: React.MouseEvent, tab: Tab): Promise<void> {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const scopes = await listDefaultScopes(tab.id)
  const conn = connName(tab.connId)
  const items: MenuItem[] = [
    { label: `Save as default for collection "${tab.coll}"`, icon: 'bookmark', onClick: () => saveDefaultQuery(tab.id, 'collection') },
    { label: `Save as default for database "${tab.db}"`, onClick: () => saveDefaultQuery(tab.id, 'database') },
    { label: `Save as default for connection "${conn}"`, onClick: () => saveDefaultQuery(tab.id, 'connection') },
    { separator: true },
    {
      label: 'Reset to default query',
      icon: 'refresh',
      disabled: !scopes.length,
      onClick: async () => {
        if (await loadDefaultQuery(tab.id)) void runQuery(tab.id)
      }
    },
    ...(scopes.length ? ([{ separator: true }] as MenuItem[]) : []),
    ...scopes.map(
      (s): MenuItem => ({
        label: `Remove default for this ${s}${s === 'collection' ? '' : s === 'database' ? ` (${tab.db})` : ` (${conn})`}`,
        icon: 'trash',
        danger: true,
        onClick: () => clearDefaultQuery(tab.id, s)
      })
    )
  ]
  showMenuAt(rect.left, rect.bottom + 4, items)
}

function ResultToolbar({ tab }: { tab: Tab }): ReactElement {
  const docs = tab.docs ?? []
  const start = tab.page * tab.pageSize + 1
  const end = tab.page * tab.pageSize + docs.length
  // Re-render when shortcuts change (tooltips below show them).
  useShortcut('query.run')
  const views: [ViewMode, string, string][] = [
    ['table', 'Table View', 'table'],
    ['tree', 'Tree View', 'tree'],
    ['json', 'JSON View', 'json'],
    ['explain', 'Explain Plan', 'gauge'],
    ['code', 'Query Code', 'code']
  ]
  const lastPage = tab.count != null ? Math.max(0, Math.ceil(tab.count / tab.pageSize) - 1) : null
  const connLocked = useStore((s) => !!s.live[tab.connId]?.readOnly)
  const readOnly = tab.readOnly || tab.isView || connLocked
  return (
    <div className="result-toolbar">
      <div className="segmented small">
        {views.map(([v, label, icon]) => (
          <button key={v} className={tab.view === v ? 'on' : ''} onClick={() => selectView(tab, v)} title={withShortcut(label, VIEW_COMMANDS[v])}>
            <Icon name={icon} size={13} /> {label.replace(' View', '').replace(' Plan', '').replace('Query ', '')}
          </button>
        ))}
      </div>
      <span style={{ width: 8 }} />
      <button className="btn ghost icon small" title={withShortcut('Refresh', 'query.refresh')} onClick={() => (tab.applied ? refreshPage(tab.id) : runQuery(tab.id))}>
        <Icon name="refresh" size={14} />
      </button>
      <div className="pager">
        <button className="btn ghost icon small" title="First page" disabled={tab.page === 0 || tab.loading} onClick={() => runQuery(tab.id, 0, { keepApplied: true })}>
          <Icon name="first" size={14} />
        </button>
        <button className="btn ghost icon small" title="Previous page" disabled={tab.page === 0 || tab.loading} onClick={() => runQuery(tab.id, tab.page - 1, { keepApplied: true })}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <select
          className="select small"
          value={tab.pageSize}
          title="Page size"
          onChange={(e) => {
            patchTab(tab.id, { pageSize: Number(e.target.value) })
            if (tab.applied) void runQuery(tab.id, 0, { keepApplied: true })
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="btn ghost icon small" title="Next page" disabled={!tab.hasMore || tab.loading} onClick={() => runQuery(tab.id, tab.page + 1, { keepApplied: true })}>
          <Icon name="chevronRight" size={14} />
        </button>
        <button className="btn ghost icon small" title="Last page" disabled={(!tab.hasMore && lastPage === null) || tab.loading || (lastPage !== null && tab.page >= lastPage)} onClick={() => gotoLastPage(tab.id)}>
          <Icon name="last" size={14} />
        </button>
      </div>
      <span className="muted" style={{ marginLeft: 4 }}>
        {tab.docs ? (docs.length ? `Documents ${start.toLocaleString()} to ${end.toLocaleString()}` : 'No documents') : ''}
        {tab.count != null && ` of ${tab.count.toLocaleString()}`}
        {tab.docs && tab.ms !== undefined && (
          <span className="faint" title="Time the server took to return this page">
            {' '}
            · {tab.ms} ms
          </span>
        )}
      </span>
      <button className="btn ghost small" onClick={() => countDocuments(tab.id)} disabled={tab.counting || !tab.applied} title={withShortcut('Count documents matching the query', 'query.count')}>
        <Icon name="count" size={13} /> {tab.counting ? 'Counting…' : 'Count'}
      </button>
      <span className="spacer" />
      {/* One group, so it wraps to the next line as a whole and keeps its order. */}
      <div className="rt-actions">
        <button className="btn ghost small" title={withShortcut('New document', 'query.insertDocument')} disabled={readOnly} onClick={() => insertDocumentDialog(tab)}>
          <Icon name="plus" size={14} /> Insert
        </button>
        <button className="btn ghost icon small" title={withShortcut('Edit the selected document as JSON', 'query.editJson')} disabled={readOnly || !docs.length} onClick={() => void editDocumentDialog(tab, tab.selection[0] ?? 0)}>
          <Icon name="edit" size={14} />
        </button>
        <button className="btn ghost icon small" title={withShortcut('Show the selected document as JSON', 'query.showJson')} disabled={!docs.length} onClick={() => void viewDocumentDialog(tab, tab.selection[0] ?? 0)}>
          <Icon name="json" size={14} />
        </button>
        <span className="rt-sep" />
        <button className="btn ghost small" title={withShortcut('Update documents (edit the query and the update)…', 'query.updateDocuments')} disabled={readOnly} onClick={() => updateDocumentsDialog(tab)}>
          <Icon name="update" size={14} /> Update
        </button>
        <button className="btn ghost small" title="Delete documents (edit the query: selection, the tab's query or all)…" disabled={readOnly} onClick={() => deleteDocumentsDialog(tab)}>
          <Icon name="trash" size={14} /> Delete
        </button>
        <span className="rt-sep" />
        <button
          className="btn ghost icon small"
          title="More"
          onClick={(e) =>
            showMenu(e, [
              { label: 'New Document…', icon: 'plus', disabled: readOnly, shortcut: shortcutLabel('query.insertDocument'), onClick: () => insertDocumentDialog(tab) },
              { label: 'Paste as New Document(s)…', disabled: readOnly, onClick: () => pasteDocuments(tab) },
              { label: 'Update Documents…', icon: 'update', disabled: readOnly, shortcut: shortcutLabel('query.updateDocuments'), onClick: () => updateDocumentsDialog(tab) },
              { separator: true },
              { label: 'Open in Pipeline Editor', icon: 'aggregate', shortcut: shortcutLabel('query.openPipeline'), onClick: () => openInPipeline(tab) },
              { label: 'Explain with AI…', icon: 'sparkle', onClick: () => void explainQueryWithAi(tab) },
              { label: 'Export Query Results…', icon: 'export', shortcut: shortcutLabel('query.export'), onClick: () => exportResults(tab) },
              { separator: true },
              { label: 'Delete All Matching…', icon: 'trash', danger: true, disabled: readOnly, onClick: () => deleteMatching(tab) }
            ])
          }
        >
          <Icon name="more" size={14} />
        </button>
        <button
          className={`btn ghost icon small ${tab.readOnly ? 'active' : ''}`}
          title={tab.isView ? 'Views are read-only' : connLocked ? 'Read-only connection (change it in the connection settings)' : withShortcut(tab.readOnly ? 'Read-only mode on' : 'Read-only mode', 'query.toggleReadOnly')}
          disabled={tab.isView || connLocked}
          onClick={() => patchTab(tab.id, { readOnly: !tab.readOnly })}
        >
          <Icon name={tab.readOnly || tab.isView ? 'lock' : 'unlock'} size={14} />
        </button>
      </div>
    </div>
  )
}

function selectView(tab: Tab, view: ViewMode): void {
  patchTab(tab.id, { view })
  const configId = useStore.getState().live[tab.connId]?.configId
  if (configId && useStore.getState().settings.rememberResultView) rememberView(configId, tab.db, tab.coll, view)
}

const VIEW_COMMANDS: Record<ViewMode, CommandId> = {
  table: 'query.viewTable',
  tree: 'query.viewTree',
  json: 'query.viewJson',
  explain: 'query.explain',
  code: 'query.viewCode'
}

function openInPipeline(tab: Tab): void {
  openAggregationTab(tab.connId, tab.db, tab.coll, {
    query: { query: tab.queryText, projection: tab.projectionText, sort: tab.sortText, skip: tab.skipText, limit: tab.limitText },
    collation: tab.collationText.trim() || undefined
  })
}

function exportResults(tab: Tab): void {
  const a = tab.applied
  void openExportDialog({
    connId: tab.connId,
    db: tab.db,
    collections: [tab.coll],
    query: a ? { filter: a.filter, projection: a.projection, sort: a.sort, skip: a.skip, limit: a.limit, collation: a.collation } : undefined
  })
}

/** Keyboard commands of the active collection tab (Settings → Shortcuts → Collection tab). */
function useQueryTabCommands(tab: Tab, root: React.RefObject<HTMLDivElement | null>): void {
  const active = useStore((s) => s.activeTab === tab.id)
  const connLocked = useStore((s) => !!s.live[tab.connId]?.readOnly)
  const view = (v: ViewMode) => () => selectView(tab, v)
  useCommandHandlers(active, {
    'query.run': () => void runQuery(tab.id),
    'query.refresh': () => void (tab.applied ? refreshPage(tab.id) : runQuery(tab.id)),
    'query.count': () => {
      if (!tab.applied || tab.counting) return false
      void countDocuments(tab.id)
    },
    'query.explain': view('explain'),
    'query.viewTable': view('table'),
    'query.viewTree': view('tree'),
    'query.viewJson': view('json'),
    'query.viewCode': view('code'),
    'query.focusBar': () => {
      const el = root.current?.querySelector<HTMLElement>('.querybar .cm-content')
      if (!el) return false
      el.focus()
    },
    'query.toggleFilterBuilder': () => patchTab(tab.id, { vqbOpen: !tab.vqbOpen }),
    // The selected document (the first one when nothing is selected).
    'query.editJson': () => {
      if (!tab.docs?.length) return false
      void editDocumentDialog(tab, tab.selection[0] ?? 0)
    },
    'query.updateDocuments': () => {
      if (tab.readOnly || tab.isView || connLocked) return false
      updateDocumentsDialog(tab)
    },
    'query.showJson': () => {
      if (!tab.docs?.length) return false
      void viewDocumentDialog(tab, tab.selection[0] ?? 0)
    },
    'query.nextPage': () => {
      if (!tab.hasMore || tab.loading) return false
      void runQuery(tab.id, tab.page + 1, { keepApplied: true })
    },
    'query.previousPage': () => {
      if (tab.page === 0 || tab.loading) return false
      void runQuery(tab.id, tab.page - 1, { keepApplied: true })
    },
    'query.insertDocument': () => {
      if (tab.readOnly || tab.isView || connLocked) return false
      insertDocumentDialog(tab)
    },
    'query.export': () => exportResults(tab),
    'query.toggleReadOnly': () => {
      if (tab.isView || connLocked) return false
      patchTab(tab.id, { readOnly: !tab.readOnly })
    },
    'query.openPipeline': () => openInPipeline(tab)
  })
}

function PathCrumbs({ tab }: { tab: Tab }): ReactElement | null {
  if (tab.view !== 'table' || !tab.tablePath.length) return null
  return (
    <div className="path-crumbs">
      <button className="btn ghost small" onClick={() => patchTab(tab.id, { tablePath: tab.tablePath.slice(0, -1) })} title="Back to parent">
        <Icon name="stepOut" size={13} /> Up
      </button>
      <button onClick={() => patchTab(tab.id, { tablePath: [] })}>{tab.coll}</button>
      {tab.tablePath.map((seg, i) => (
        <span key={i} className="row" style={{ gap: 4 }}>
          <Icon name="chevronRight" size={11} />
          {i === tab.tablePath.length - 1 ? <b>{seg}</b> : <button onClick={() => patchTab(tab.id, { tablePath: tab.tablePath.slice(0, i + 1) })}>{seg}</button>}
        </span>
      ))}
    </div>
  )
}

export function QueryTab({ tab }: { tab: Tab }): ReactElement {
  const live = useStore((s) => s.live[tab.connId])
  const fields = useMemo(() => collectPaths((tab.docs ?? []).slice(0, 200)), [tab.docs])
  const runError = tab.error?.part === 'run' ? tab.error.message : null
  const autoRun = useStore((s) => s.settings.runQueryOnOpen)
  const root = useRef<HTMLDivElement>(null)
  useQueryTabCommands(tab, root)
  const runKey = useShortcut('query.run')
  useEffect(() => {
    // Opening a collection fills in its default query and, unless turned off in Settings, shows the first page.
    if (tab.docs || tab.applied || tab.loading || tab.noAutoLoad) return
    const run = useStore.getState().settings.runQueryOnOpen
    void loadDefaultQuery(tab.id).finally(() => run && runQuery(tab.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])
  return (
    <div className="qtab" ref={root}>
      <div className="qtab-main">
        <div className="crumbs">
          <Icon name="server" size={13} style={{ color: live?.color ?? 'var(--leaf)' }} />
          <span>{connName(tab.connId)}</span>
          <Icon name="chevronRight" size={11} />
          <Icon name="database" size={13} />
          <span>{tab.db}</span>
          <Icon name="chevronRight" size={11} />
          <Icon name={tab.isView ? 'view' : 'collection'} size={13} />
          <b>{tab.coll}</b>
          {tab.isView && <span className="badge">view</span>}
        </div>
        <QueryBar tab={tab} fields={fields} />
        <ResultToolbar tab={tab} />
        <PathCrumbs tab={tab} />
        <div className="result-area">
          {tab.loading && <div className="loading-bar" />}
          {runError && (
            <div className="notice error selectable" style={{ margin: 10 }}>
              {runError}{' '}
              <button className="link" onClick={() => void fixQueryWithAi(tab)} title="Ask the AI to correct the query">
                Fix with AI
              </button>
            </div>
          )}
          {!tab.docs && !runError && tab.view !== 'explain' && tab.view !== 'code' && (
            <div className="result-empty">
              {tab.loading ? (
                'Running query…'
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <div>{runKey ? `Press Run (${runKey}) to query ${tab.coll}` : `Press Run to query ${tab.coll}`}</div>
                  {!autoRun && <div className="faint" style={{ marginTop: 6, fontSize: 12 }}>Collections open without querying (Settings → Browsing data).</div>}
                </div>
              )}
            </div>
          )}
          {tab.docs && tab.docs.length === 0 && !runError && tab.view !== 'explain' && tab.view !== 'code' && <div className="result-empty">No documents match the query.</div>}
          {tab.docs && tab.docs.length > 0 && tab.view === 'table' && <TableView tab={tab} />}
          {tab.docs && tab.docs.length > 0 && tab.view === 'tree' && <TreeView tab={tab} />}
          {tab.docs && tab.docs.length > 0 && tab.view === 'json' && <JsonView tab={tab} />}
          {tab.view === 'explain' && <ExplainView tab={tab} />}
          {tab.view === 'code' && (
            <CodeView
              build={() => findCodeQuery(tab.db, tab.coll, { query: tab.queryText, projection: tab.projectionText, sort: tab.sortText, skip: tab.skipText, limit: tab.limitText, collation: tab.collationText })}
              deps={[tab.queryText, tab.projectionText, tab.sortText, tab.skipText, tab.limitText, tab.collationText]}
            />
          )}
        </div>
      </div>
      {tab.vqbOpen && <VqbPanel tab={tab} />}
    </div>
  )
}
