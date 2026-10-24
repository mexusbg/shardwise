import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { HistoryEntry, HistoryFilter, QueryPayload, SavedQueryEntry } from '@shared/api'
import { api } from '../../lib/api'
import { errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { showMenu } from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import {
  configIdOf,
  configName,
  copyText,
  foldersOf,
  fullTime,
  isSaved,
  matches,
  openFindInNewTab,
  openInAggregation,
  previewOf,
  relativeTime,
  saveAsNew,
  saveQueryDialog,
  shellText
} from './historyActions'
import type { AnyEntry } from './historyActions'
import './history.css'

type Section = 'history' | 'saved'
type KindFilter = '' | QueryPayload['kind']

const NO_FOLDER = '\u0000'

export function QueryManagerView({ tab }: { tab: ToolTab }): ReactElement {
  const active = useStore((s) => s.activeTab === tab.id)
  const connections = useStore((s) => s.connections)
  const [section, setSection] = useState<Section>('history')
  const [conn, setConn] = useState<string>(() => configIdOf(tab.connId) ?? '')
  const [db, setDb] = useState(tab.db)
  const [coll, setColl] = useState(tab.coll ?? '')
  const [kind, setKind] = useState<KindFilter>('')
  const [text, setText] = useState('')
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [saved, setSaved] = useState<SavedQueryEntry[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [h, s] = await Promise.all([api.listHistory({}), api.listSavedQueries()])
      setHistory(h)
      setSaved(s)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const filter: HistoryFilter = useMemo(
    () => ({ configId: conn || undefined, db: db.trim() || undefined, coll: coll.trim() || undefined, kind: kind || undefined, text: text.trim() || undefined }),
    [conn, db, coll, kind, text]
  )
  const filtered = !!(filter.configId || filter.db || filter.coll || filter.kind || filter.text)

  const nameOf = useCallback((e: AnyEntry): string => (isSaved(e) ? configName(e.configId) : configName(e.configId, e.connName)), [connections]) // eslint-disable-line react-hooks/exhaustive-deps

  const historyRows = useMemo(() => (history ?? []).filter((e) => matches(e, filter, nameOf(e))), [history, filter, nameOf])
  const savedRows = useMemo(() => (saved ?? []).filter((q) => matches(q, filter, nameOf(q))), [saved, filter, nameOf])
  const rows: AnyEntry[] = section === 'history' ? historyRows : savedRows

  /** Saved queries by folder; rows hidden by a collapsed folder are left out of `visible`. */
  const groups = useMemo(() => {
    const m = new Map<string, SavedQueryEntry[]>()
    for (const q of savedRows) {
      const k = q.folder ?? NO_FOLDER
      m.set(k, [...(m.get(k) ?? []), q])
    }
    return [...m.entries()].sort(([a], [b]) => (a === NO_FOLDER ? -1 : b === NO_FOLDER ? 1 : a.localeCompare(b)))
  }, [savedRows])
  const visible: AnyEntry[] = section === 'history' ? historyRows : groups.flatMap(([k, list]) => (collapsed.has(k) ? [] : list))

  const currentEntry = rows.find((r) => r.id === current) ?? null

  const connOptions = useMemo(() => {
    const m = new Map<string, string>(connections.map((c) => [c.id, c.name]))
    for (const e of history ?? []) if (e.configId && !m.has(e.configId)) m.set(e.configId, `${e.connName || 'Unknown'} (deleted)`)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [connections, history])

  const suggestions = useMemo(() => {
    const all: AnyEntry[] = [...(history ?? []), ...(saved ?? [])].filter((e) => !conn || !e.configId || e.configId === conn)
    const dbs = [...new Set(all.map((e) => e.db).filter(Boolean))].sort()
    const colls = [...new Set(all.filter((e) => !db.trim() || e.db === db.trim()).map((e) => e.coll).filter(Boolean))].sort()
    return { dbs, colls }
  }, [history, saved, conn, db])

  const switchSection = (s: Section): void => {
    setSection(s)
    setSelected(new Set())
    setCurrent(null)
  }

  const clickRow = (e: React.MouseEvent, id: string): void => {
    if (e.shiftKey && anchor.current) {
      const a = visible.findIndex((r) => r.id === anchor.current)
      const b = visible.findIndex((r) => r.id === id)
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a]
        setSelected(new Set(visible.slice(from, to + 1).map((r) => r.id)))
      }
    } else if (e.ctrlKey || e.metaKey) {
      toggle(id)
      anchor.current = id
    } else {
      anchor.current = id
    }
    setCurrent(id)
  }

  const toggle = (id: string): void =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const allChecked = visible.length > 0 && visible.every((r) => selected.has(r.id))
  const toggleAll = (): void => setSelected(allChecked ? new Set() : new Set(visible.map((r) => r.id)))

  const removeIds = async (ids: string[], ask = true): Promise<void> => {
    if (!ids.length) return
    const isHist = section === 'history'
    if (ask) {
      const ok = await confirmDialog({
        title: isHist ? 'Delete History Entries' : 'Delete Saved Queries',
        message: ids.length === 1 ? `Delete this ${isHist ? 'history entry' : 'saved query'}?` : `Delete ${ids.length} ${isHist ? 'history entries' : 'saved queries'}?`,
        confirmLabel: 'Delete',
        danger: true
      })
      if (!ok) return
    }
    try {
      if (isHist) await api.deleteHistory(ids)
      else for (const id of ids) await api.deleteSavedQuery(id)
    } catch (e) {
      toast(errorText(e), 'error')
    }
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))))
    if (current && ids.includes(current)) setCurrent(null)
    await load()
  }

  const clearHistory = async (): Promise<void> => {
    const n = historyRows.length
    if (!n) return
    const ok = await confirmDialog({
      title: 'Clear History',
      message: filtered ? `Delete the ${n.toLocaleString()} history entr${n === 1 ? 'y' : 'ies'} matching the current filters?` : `Delete all ${n.toLocaleString()} entries of the query history?`,
      confirmLabel: 'Clear',
      danger: true
    })
    if (!ok) return
    try {
      const removed = await api.clearHistory(filter)
      toast(`Removed ${removed.toLocaleString()} history entr${removed === 1 ? 'y' : 'ies'}`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
    setSelected(new Set())
    setCurrent(null)
    await load()
  }

  const open = (e: AnyEntry): void => {
    if (e.payload.kind === 'find') void openFindInNewTab(e, tab.connId)
    else void openInAggregation(e, tab.connId)
  }

  const saveHistory = async (e: HistoryEntry): Promise<void> => {
    const q = await saveAsNew(e)
    if (q) await load()
  }

  const updateSaved = async (q: SavedQueryEntry, ask: { askName?: boolean; askFolder?: boolean; title: string; confirmLabel: string }): Promise<void> => {
    const r = await saveQueryDialog({ ...ask, name: q.name, folder: q.folder, folders: foldersOf(saved ?? []) })
    if (!r) return
    try {
      await api.saveQuery({ id: q.id, name: ask.askName === false ? q.name : r.name, folder: (ask.askFolder === false ? q.folder : r.folder) || undefined, configId: q.configId, db: q.db, coll: q.coll, payload: q.payload })
    } catch (e) {
      toast(errorText(e), 'error')
    }
    await load()
  }
  const rename = (q: SavedQueryEntry): Promise<void> => updateSaved(q, { askFolder: false, title: 'Rename Saved Query', confirmLabel: 'Rename' })
  const move = (q: SavedQueryEntry): Promise<void> => updateSaved(q, { askName: false, title: 'Move to Folder', confirmLabel: 'Move' })

  const rowMenu = (ev: React.MouseEvent, e: AnyEntry): void => {
    setCurrent(e.id)
    const multi = selected.has(e.id) && selected.size > 1
    const items: MenuItem[] = [
      e.payload.kind === 'find'
        ? { label: 'Open in New Tab', icon: 'play', onClick: () => open(e) }
        : { label: 'Open in Pipeline Editor', icon: 'aggregate', onClick: () => open(e) },
      ...(e.payload.kind === 'find' ? [{ label: 'Open in Pipeline Editor', icon: 'aggregate', onClick: () => void openInAggregation(e, tab.connId) }] : []),
      { label: 'Copy as Shell Code', icon: 'copy', onClick: () => void copyText(shellText(e.db, e.coll, e.payload)) },
      { separator: true },
      ...(isSaved(e)
        ? [
            { label: 'Rename…', icon: 'edit', onClick: () => void rename(e) },
            { label: 'Move to Folder…', icon: 'folder', onClick: () => void move(e) }
          ]
        : [{ label: 'Save…', icon: 'star', onClick: () => void saveHistory(e) }]),
      { separator: true },
      { label: multi ? `Delete ${selected.size} Selected` : 'Delete', icon: 'trash', danger: true, onClick: () => void removeIds(multi ? [...selected] : [e.id]) }
    ]
    showMenu(ev, items)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.target !== listRef.current) return
    const i = visible.findIndex((r) => r.id === current)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) {
        setCurrent(next.id)
        anchor.current = next.id
        listRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
      }
    } else if (e.key === 'Enter' && currentEntry) {
      open(currentEntry)
    } else if (e.key === 'Delete') {
      void removeIds(selected.size ? [...selected] : current ? [current] : [])
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelected(new Set(visible.map((r) => r.id)))
    }
  }

  const loading = section === 'history' ? history === null : saved === null
  const total = section === 'history' ? (history?.length ?? 0) : (saved?.length ?? 0)

  const renderRow = (e: AnyEntry): ReactElement => (
    <tr
      key={e.id}
      data-id={e.id}
      className={`${e.id === current ? 'current' : ''} ${selected.has(e.id) ? 'checked' : ''}`}
      onClick={(ev) => clickRow(ev, e.id)}
      onDoubleClick={() => open(e)}
      onContextMenu={(ev) => rowMenu(ev, e)}
    >
      <td className="qm-check" onClick={(ev) => ev.stopPropagation()}>
        <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
      </td>
      {isSaved(e) ? (
        <td className="qm-name">
          <div className="ellipsis">
            <Icon name="star" size={12} className="qm-star" /> {e.name}
          </div>
        </td>
      ) : (
        <td className="qm-time" title={fullTime(e.at)}>
          {relativeTime(e.at)}
        </td>
      )}
      <td className="ellipsis qm-conn">{nameOf(e)}</td>
      <td className="ellipsis qm-ns" title={`${e.db}.${e.coll}`}>
        {e.db}
        <span className="faint">.</span>
        {e.coll}
      </td>
      <td>
        <KindBadge kind={e.payload.kind} />
      </td>
      <td className="qm-preview">
        <div className="ellipsis">{previewOf(e.payload)}</div>
      </td>
      {isSaved(e) ? (
        <td className="qm-num faint" title={fullTime(e.updatedAt)}>
          {relativeTime(e.updatedAt)}
        </td>
      ) : (
        <>
          <td className="qm-num">{e.ms !== undefined ? e.ms.toLocaleString() : <span className="faint">—</span>}</td>
          <td className="qm-num">{e.count !== undefined ? e.count.toLocaleString() : <span className="faint">—</span>}</td>
        </>
      )}
    </tr>
  )

  return (
    <div className="qm">
      <div className="qm-head">
        <Icon name="history" size={16} className="qm-head-icon" />
        <span className="qm-title">Query Library</span>
        <div className="segmented qm-sections">
          <button className={section === 'history' ? 'on' : ''} onClick={() => switchSection('history')}>
            <Icon name="history" size={13} /> History
            <span className="qm-count">{history?.length ?? ''}</span>
          </button>
          <button className={section === 'saved' ? 'on' : ''} onClick={() => switchSection('saved')}>
            <Icon name="star" size={13} /> Saved queries
            <span className="qm-count">{saved?.length ?? ''}</span>
          </button>
        </div>
        <span className="spacer" />
        {section === 'history' && (
          <button className="btn small danger" onClick={() => void clearHistory()} disabled={!historyRows.length} title="Delete every history entry matching the filters">
            <Icon name="trash" size={13} /> Clear history…
          </button>
        )}
        <button className="btn ghost icon small" title="Refresh" onClick={() => void load()}>
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <div className="qm-filters">
        <label className="qm-filter">
          <span>Connection</span>
          <select className="select small" value={conn} onChange={(e) => setConn(e.target.value)}>
            <option value="">All connections</option>
            {connOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="qm-filter">
          <span>Database</span>
          <input className="input small" list={`qm-dbs-${tab.id}`} value={db} placeholder="Any" onChange={(e) => setDb(e.target.value)} />
          <datalist id={`qm-dbs-${tab.id}`}>
            {suggestions.dbs.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label className="qm-filter">
          <span>Collection</span>
          <input className="input small" list={`qm-colls-${tab.id}`} value={coll} placeholder="Any" onChange={(e) => setColl(e.target.value)} />
          <datalist id={`qm-colls-${tab.id}`}>
            {suggestions.colls.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="qm-filter">
          <span>Kind</span>
          <select className="select small" value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
            <option value="">All</option>
            <option value="find">Find</option>
            <option value="aggregate">Aggregate</option>
          </select>
        </label>
        <div className="qm-search">
          <Icon name="search" size={13} />
          <input className="input small" value={text} placeholder={section === 'history' ? 'Search queries…' : 'Search names, folders, queries…'} onChange={(e) => setText(e.target.value)} />
          {text && (
            <button className="btn ghost icon small" title="Clear search" onClick={() => setText('')}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
        {filtered && (
          <button
            className="btn ghost small"
            title="Show everything"
            onClick={() => {
              setConn('')
              setDb('')
              setColl('')
              setKind('')
              setText('')
            }}
          >
            Reset
          </button>
        )}
      </div>

      <div className="qm-body">
        <div className="qm-listwrap">
          <div className={`qm-selbar ${selected.size ? 'on' : ''}`}>
            <span>
              <b>{selected.size}</b> selected
            </span>
            <button className="btn small danger" onClick={() => void removeIds([...selected])}>
              <Icon name="trash" size={13} /> Delete
            </button>
            <button className="btn ghost small" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
            <span className="spacer" />
            <span className="faint">
              {rows.length.toLocaleString()} of {total.toLocaleString()} shown
            </span>
          </div>
          <div className="qm-list" ref={listRef} tabIndex={0} onKeyDown={onKey}>
            {error && <div className="notice error qm-msg">{error}</div>}
            {!error && loading && <div className="qm-msg faint">Loading…</div>}
            {!error && !loading && rows.length === 0 && (
              <div className="qm-empty">
                <Icon name={section === 'history' ? 'history' : 'star'} size={34} />
                <h3>{total === 0 ? (section === 'history' ? 'No query history yet' : 'No saved queries yet') : 'Nothing matches the filters'}</h3>
                <p className="muted">
                  {total === 0
                    ? section === 'history'
                      ? 'Queries and aggregations you run are recorded here.'
                      : 'Save a query from the history button in a query tab, or from an entry of the history.'
                    : 'Change or reset the filters to see more.'}
                </p>
              </div>
            )}
            {!error && rows.length > 0 && (
              <table className="qm-table">
                <thead>
                  <tr>
                    <th className="qm-check">
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} title="Select all" />
                    </th>
                    <th className={section === 'history' ? 'qm-time' : 'qm-name'}>{section === 'history' ? 'Time' : 'Name'}</th>
                    <th className="qm-conn">Connection</th>
                    <th className="qm-ns">Namespace</th>
                    <th className="qm-kind">Kind</th>
                    <th>Query</th>
                    {section === 'history' ? (
                      <>
                        <th className="qm-num">ms</th>
                        <th className="qm-num">Docs</th>
                      </>
                    ) : (
                      <th className="qm-num">Updated</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {section === 'history'
                    ? historyRows.map(renderRow)
                    : groups.map(([folder, list]) => (
                        <FolderGroup
                          key={folder}
                          name={folder === NO_FOLDER ? null : folder}
                          count={list.length}
                          collapsed={collapsed.has(folder)}
                          onToggle={() =>
                            setCollapsed((c) => {
                              const n = new Set(c)
                              if (n.has(folder)) n.delete(folder)
                              else n.add(folder)
                              return n
                            })
                          }
                        >
                          {list.map(renderRow)}
                        </FolderGroup>
                      ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <Detail
          entry={currentEntry}
          connLabel={currentEntry ? nameOf(currentEntry) : ''}
          onOpen={open}
          onAggregate={(e) => void openInAggregation(e, tab.connId)}
          onSave={(e) => void saveHistory(e)}
          onRename={(q) => void rename(q)}
          onMove={(q) => void move(q)}
          onDelete={(e) => void removeIds([e.id])}
        />
      </div>
    </div>
  )
}

function KindBadge({ kind }: { kind: QueryPayload['kind'] }): ReactElement {
  return <span className={`qm-kind-badge ${kind}`}>{kind === 'find' ? 'find' : 'aggregate'}</span>
}

function FolderGroup(p: { name: string | null; count: number; collapsed: boolean; onToggle: () => void; children: ReactElement[] }): ReactElement {
  return (
    <>
      <tr className="qm-group" onClick={p.onToggle}>
        <td colSpan={7}>
          <span className="row">
            <Icon name={p.collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
            <Icon name="folder" size={13} className="qm-folder-icon" />
            <span className={p.name ? '' : 'faint'}>{p.name ?? 'No folder'}</span>
            <span className="qm-count">{p.count}</span>
          </span>
        </td>
      </tr>
      {!p.collapsed && p.children}
    </>
  )
}

function Detail(p: {
  entry: AnyEntry | null
  connLabel: string
  onOpen: (e: AnyEntry) => void
  onAggregate: (e: AnyEntry) => void
  onSave: (e: HistoryEntry) => void
  onRename: (q: SavedQueryEntry) => void
  onMove: (q: SavedQueryEntry) => void
  onDelete: (e: AnyEntry) => void
}): ReactElement {
  const e = p.entry
  if (!e) {
    return (
      <div className="qm-detail">
        <div className="qm-detail-empty faint">
          <Icon name="code" size={28} />
          <div>Select an entry to see the full query.</div>
          <div className="small">Double-click to open it.</div>
        </div>
      </div>
    )
  }
  const code = shellText(e.db, e.coll, e.payload)
  const find = e.payload.kind === 'find'
  return (
    <div className="qm-detail">
      <div className="qm-detail-head">
        {isSaved(e) ? (
          <>
            <Icon name="star" size={15} className="qm-star" />
            <span className="qm-detail-title ellipsis selectable">{e.name}</span>
          </>
        ) : (
          <>
            <Icon name="history" size={15} />
            <span className="qm-detail-title ellipsis">{relativeTime(e.at)}</span>
          </>
        )}
        <KindBadge kind={e.payload.kind} />
      </div>
      <dl className="qm-meta selectable">
        <dt>Connection</dt>
        <dd className="ellipsis">{p.connLabel}</dd>
        <dt>Namespace</dt>
        <dd className="ellipsis mono">
          {e.db}.{e.coll}
        </dd>
        {isSaved(e) ? (
          <>
            <dt>Folder</dt>
            <dd>{e.folder ?? <span className="faint">None</span>}</dd>
            <dt>Created</dt>
            <dd>{fullTime(e.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{fullTime(e.updatedAt)}</dd>
          </>
        ) : (
          <>
            <dt>Ran at</dt>
            <dd>{fullTime(e.at)}</dd>
            <dt>Duration</dt>
            <dd>{e.ms !== undefined ? `${e.ms.toLocaleString()} ms` : <span className="faint">—</span>}</dd>
            <dt>Documents</dt>
            <dd>{e.count !== undefined ? e.count.toLocaleString() : <span className="faint">{find ? 'more than one page' : '—'}</span>}</dd>
          </>
        )}
      </dl>
      <div className="qm-code">
        <CodeEditor value={code} readOnly full className="qm-editor" />
      </div>
      <div className="qm-actions">
        {find ? (
          <button className="btn primary small" onClick={() => p.onOpen(e)}>
            <Icon name="play" size={12} /> Open in new tab
          </button>
        ) : (
          <button className="btn primary small" onClick={() => p.onOpen(e)}>
            <Icon name="aggregate" size={12} /> Open in Pipeline Editor
          </button>
        )}
        {find && (
          <button className="btn small" onClick={() => p.onAggregate(e)} title="Start a pipeline from this query">
            <Icon name="aggregate" size={12} /> Aggregate
          </button>
        )}
        <button className="btn small" onClick={() => void copyText(code)} title="Copy as mongosh code">
          <Icon name="copy" size={12} /> Copy
        </button>
        <span className="spacer" />
        {isSaved(e) ? (
          <>
            <button className="btn ghost icon small" title="Rename…" onClick={() => p.onRename(e)}>
              <Icon name="edit" size={13} />
            </button>
            <button className="btn ghost icon small" title="Move to folder…" onClick={() => p.onMove(e)}>
              <Icon name="folder" size={13} />
            </button>
          </>
        ) : (
          <button className="btn small" onClick={() => p.onSave(e)}>
            <Icon name="star" size={12} /> Save…
          </button>
        )}
        <button className="btn ghost icon small danger" title="Delete" onClick={() => p.onDelete(e)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  )
}
