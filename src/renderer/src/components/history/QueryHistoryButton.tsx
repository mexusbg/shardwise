import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { HistoryEntry, SavedQueryEntry } from '@shared/api'
import { api } from '../../lib/api'
import { errorText, openQueryManagerTab, toast, useStore } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { Icon } from '../Icon'
import { findPayload } from '../../state/queryActions'
import { applyFind, configIdOf, matches, previewOf, relativeTime, saveAsNew } from './historyActions'
import './history.css'
import { fmtDateTime } from '../../lib/datetime'

type Section = 'history' | 'saved'

const WIDTH = 540

function usePosition(anchor: React.RefObject<HTMLElement | null>, open: boolean): { top: number; left: number; maxHeight: number } {
  const [pos, setPos] = useState({ top: 0, left: 0, maxHeight: 440 })
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      const left = Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8))
      const top = r.bottom + 4
      setPos({ top, left, maxHeight: Math.max(220, Math.min(480, window.innerHeight - top - 12)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, open])
  return pos
}

export function QueryHistoryButton({ tab }: { tab: QueryTab }): ReactElement {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={btn} className={`btn icon ${open ? 'active' : ''}`} title="Query history & saved queries" onClick={() => setOpen((o) => !o)}>
        <Icon name="history" />
      </button>
      {open && createPortal(<HistoryPopover tab={tab} anchor={btn} close={() => setOpen(false)} />, document.body)}
    </>
  )
}

function HistoryPopover({ tab, anchor, close }: { tab: QueryTab; anchor: React.RefObject<HTMLButtonElement | null>; close: () => void }): ReactElement {
  const [section, setSection] = useState<Section>('history')
  const [text, setText] = useState('')
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [saved, setSaved] = useState<SavedQueryEntry[] | null>(null)
  const [allColls, setAllColls] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const pos = usePosition(anchor, true)
  const configId = useStore((s) => s.live[tab.connId]?.configId)
  const connections = useStore((s) => s.connections)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [h, s] = await Promise.all([
        configId ? api.listHistory({ configId, db: tab.db, coll: tab.coll, kind: 'find', limit: 200 }) : Promise.resolve([]),
        api.listSavedQueries()
      ])
      setHistory(h)
      setSaved(s.filter((q) => q.payload.kind === 'find'))
    } catch (e) {
      setError(errorText(e))
    }
  }, [configId, tab.db, tab.coll])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return
      if ((t as Element).closest?.('.modal-backdrop, .ctx')) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.modal')) {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, close])

  const here = (q: SavedQueryEntry): boolean => q.db === tab.db && q.coll === tab.coll && (!q.configId || q.configId === configId)
  const historyRows = useMemo(() => (history ?? []).filter((e) => matches(e, { text })), [history, text])
  const savedRows = useMemo(() => {
    const list = (saved ?? []).filter((q) => matches(q, { text }, connections.find((c) => c.id === q.configId)?.name))
    const mine = list.filter(here)
    return allColls ? [...mine, ...list.filter((q) => !here(q))] : mine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, text, allColls, configId, tab.db, tab.coll, connections])
  const otherCount = useMemo(() => (saved ?? []).filter((q) => !here(q)).length, [saved, configId, tab.db, tab.coll]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (p: HistoryEntry['payload']): void => {
    if (p.kind !== 'find') return
    close()
    applyFind(tab.id, p)
  }

  const removeHistory = async (id: string): Promise<void> => {
    await api.deleteHistory([id]).catch((e) => toast(errorText(e), 'error'))
    setHistory((h) => h?.filter((x) => x.id !== id) ?? null)
  }

  const saveCurrent = (): void => {
    close()
    void saveAsNew({
      configId: configIdOf(tab.connId),
      db: tab.db,
      coll: tab.coll,
      payload: findPayload(tab)
    })
  }

  const saveEntry = async (e: HistoryEntry): Promise<void> => {
    const q = await saveAsNew(e)
    if (q) setSaved((s) => [...(s ?? []), q])
  }

  const empty = section === 'history' ? historyRows.length === 0 : savedRows.length === 0
  const loading = section === 'history' ? history === null : saved === null

  return (
    <div ref={panel} className="qh-pop" style={{ top: pos.top, left: pos.left, width: WIDTH, maxHeight: pos.maxHeight }} role="dialog" aria-label="Query history">
      <div className="qh-pop-head">
        <div className="segmented small">
          <button className={section === 'history' ? 'on' : ''} onClick={() => setSection('history')}>
            <Icon name="history" size={12} /> History
          </button>
          <button className={section === 'saved' ? 'on' : ''} onClick={() => setSection('saved')}>
            <Icon name="star" size={12} /> Saved
          </button>
        </div>
        <div className="qh-search">
          <Icon name="search" size={12} />
          <input className="input small" placeholder="Filter…" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </div>
      </div>
      <div className="qh-pop-sub faint">
        {section === 'history' ? (
          <>
            Recent runs on <b className="muted">{tab.coll}</b>
          </>
        ) : (
          <>
            <span>
              Saved for <b className="muted">{tab.coll}</b>
            </span>
            <span className="spacer" />
            <label className="check" title="Also list queries saved for other collections">
              <input type="checkbox" checked={allColls} onChange={(e) => setAllColls(e.target.checked)} />
              Other collections{otherCount ? ` (${otherCount})` : ''}
            </label>
          </>
        )}
      </div>
      <div className="qh-pop-list">
        {error && <div className="notice error qh-pop-msg">{error}</div>}
        {!error && loading && <div className="qh-pop-msg faint">Loading…</div>}
        {!error && !loading && empty && (
          <div className="qh-pop-empty">
            <Icon name={section === 'history' ? 'history' : 'star'} size={22} />
            <div>{text ? 'Nothing matches the filter.' : section === 'history' ? 'No queries run on this collection yet.' : 'No saved queries for this collection.'}</div>
          </div>
        )}
        {section === 'history' &&
          historyRows.map((e) => (
            <div key={e.id} className="qh-item" onClick={() => pick(e.payload)} title="Load into the query bar and run">
              <div className="qh-item-main">
                <div className="qh-code ellipsis">{previewOf(e.payload)}</div>
                <div className="qh-meta">
                  <span title={fmtDateTime(e.at)}>{relativeTime(e.at)}</span>
                  {e.ms !== undefined && <span>{e.ms.toLocaleString()} ms</span>}
                  {e.count !== undefined && (
                    <span>
                      {e.count.toLocaleString()} doc{e.count === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>
              <div className="qh-item-actions">
                <button
                  className="btn ghost icon small"
                  title="Save…"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void saveEntry(e)
                  }}
                >
                  <Icon name="star" size={13} />
                </button>
                <button
                  className="btn ghost icon small"
                  title="Remove from history"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void removeHistory(e.id)
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          ))}
        {section === 'saved' &&
          savedRows.map((q) => {
            const other = !here(q)
            return (
              <div
                key={q.id}
                className={`qh-item ${other ? 'other' : ''}`}
                onClick={() => pick(q.payload)}
                title={other ? `Saved for ${q.db}.${q.coll} — load into this tab and run` : 'Load into the query bar and run'}
              >
                <Icon name="star" size={13} className="qh-star" />
                <div className="qh-item-main">
                  <div className="qh-name ellipsis">
                    {q.name}
                    {q.folder && <span className="qh-folder">{q.folder}</span>}
                    {other && (
                      <span className="qh-ns">
                        {q.db}.{q.coll}
                      </span>
                    )}
                  </div>
                  <div className="qh-code small ellipsis">{previewOf(q.payload)}</div>
                </div>
              </div>
            )
          })}
      </div>
      <div className="qh-pop-foot">
        <button className="btn small" onClick={saveCurrent}>
          <Icon name="star" size={12} /> Save current query…
        </button>
        <span className="spacer" />
        <button
          className="btn ghost small"
          onClick={() => {
            close()
            openQueryManagerTab(tab.connId, tab.db, tab.coll)
          }}
        >
          Open Query Library <Icon name="chevronRight" size={12} />
        </button>
      </div>
    </div>
  )
}
