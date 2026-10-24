import { useState } from 'react'
import type { ReactElement } from 'react'
import type { HistoryEntry, HistoryFilter, QueryPayload, SavedQueryEntry } from '@shared/api'
import { api } from '../../lib/api'
import { connect, dbKey, errorText, openAggregationTab, openCollectionTab, patchTab, toast, useStore } from '../../state/store'
import { runQuery, syncTextToVqb } from '../../state/queryActions'
import { confirmDialog, Modal, openModal } from '../Modal'
import { fmtDate, fmtDateTime } from '../../lib/datetime'

export type FindPayload = Extract<QueryPayload, { kind: 'find' }>
export type AnyEntry = HistoryEntry | SavedQueryEntry

export const isSaved = (e: AnyEntry): e is SavedQueryEntry => 'name' in e

/** Live connection id of a saved connection config, if connected. */
export function liveConnId(configId?: string): string | null {
  if (!configId) return null
  return Object.values(useStore.getState().live).find((l) => l.configId === configId)?.connId ?? null
}

export const configIdOf = (connId: string): string | undefined => useStore.getState().live[connId]?.configId

export function configName(configId?: string, fallback?: string): string {
  if (!configId) return fallback ?? 'Any connection'
  return useStore.getState().connections.find((c) => c.id === configId)?.name ?? fallback ?? 'Deleted connection'
}

/** A live connection for the entry: connects on confirmation, or falls back to `fallbackConnId`. */
export async function resolveConn(configId: string | undefined, fallbackConnId?: string, label?: string): Promise<string | null> {
  const s = useStore.getState()
  const fallback = fallbackConnId && s.live[fallbackConnId] ? fallbackConnId : null
  if (!configId) {
    if (fallback) return fallback
    toast('Connect to a server first', 'error')
    return null
  }
  const existing = liveConnId(configId)
  if (existing) return existing
  const cfg = s.connections.find((c) => c.id === configId)
  if (cfg) {
    const ok = await confirmDialog({
      title: 'Connect',
      message: (
        <>
          This query belongs to <b>{cfg.name}</b>, which is not connected. Connect now?
        </>
      ),
      confirmLabel: 'Connect'
    })
    return ok ? connect(configId) : null
  }
  if (!fallback) {
    toast(`The connection${label ? ` "${label}"` : ''} of this query no longer exists`, 'error')
    return null
  }
  const ok = await confirmDialog({
    title: 'Connection not found',
    message: (
      <>
        The connection{label ? <> <b>{label}</b></> : ''} of this query no longer exists. Open it on <b>{s.live[fallback].name}</b> instead?
      </>
    ),
    confirmLabel: 'Open'
  })
  return ok ? fallback : null
}

/** Put a find payload into a query tab's fields and run it. */
export function applyFind(tabId: string, p: FindPayload, run = true): void {
  // Payloads without a collation (older entries, queries from other tools) keep the tab's collation.
  const collation = typeof p.collation === 'string' ? { collationText: p.collation } : {}
  patchTab(tabId, { queryText: p.query, projectionText: p.projection, sortText: p.sort, skipText: p.skip, limitText: p.limit, ...collation, error: undefined })
  syncTextToVqb(tabId, 'query')
  syncTextToVqb(tabId, 'projection')
  syncTextToVqb(tabId, 'sort')
  patchTab(tabId, (t) => ({
    vqb: { ...t.vqb, ...(p.projection.trim() ? {} : { projection: [] }), ...(p.sort.trim() ? {} : { sort: [] }) }
  }))
  if (run) void runQuery(tabId)
}

/** Open the entry's collection in a new query tab and run the query there. */
export async function openFindInNewTab(e: AnyEntry, fallbackConnId?: string): Promise<void> {
  if (e.payload.kind !== 'find') return
  const connId = await resolveConn(e.configId, fallbackConnId, isSaved(e) ? undefined : e.connName)
  if (!connId) return
  const isView = useStore.getState().collections[dbKey(connId, e.db)]?.find((c) => c.name === e.coll)?.type === 'view'
  const id = openCollectionTab(connId, e.db, e.coll, isView)
  // `loading` keeps the new tab from applying its default query on mount.
  patchTab(id, { loading: true })
  applyFind(id, e.payload, false)
  await runQuery(id)
  patchTab(id, (t) => (t.loading && !t.docs ? { loading: false } : {}))
}

export async function openInAggregation(e: AnyEntry, fallbackConnId?: string): Promise<void> {
  const connId = await resolveConn(e.configId, fallbackConnId, isSaved(e) ? undefined : e.connName)
  if (!connId) return
  const p = e.payload
  if (p.kind === 'aggregate') openAggregationTab(connId, e.db, e.coll, { pipeline: p.pipeline })
  else openAggregationTab(connId, e.db, e.coll, { query: { query: p.query, projection: p.projection, sort: p.sort, skip: p.skip, limit: p.limit }, collation: p.collation?.trim() || undefined })
}

export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Compact single-line summary of a payload. */
export function previewOf(p: QueryPayload): string {
  if (p.kind === 'aggregate') return oneLine(p.pipeline) || '[]'
  const parts = [oneLine(p.query) || '{}']
  if (p.projection.trim()) parts.push(`project ${oneLine(p.projection)}`)
  if (p.sort.trim()) parts.push(`sort ${oneLine(p.sort)}`)
  if (p.skip.trim()) parts.push(`skip ${p.skip.trim()}`)
  if (p.limit.trim()) parts.push(`limit ${p.limit.trim()}`)
  if (p.collation?.trim()) parts.push(`collation ${oneLine(p.collation)}`)
  return parts.join('  ·  ')
}

const collRef = (coll: string): string => (/^[A-Za-z_$][\w$]*$/.test(coll) ?`db.${coll}` : `db.getCollection(${JSON.stringify(coll)})`)

/** mongosh form of the entry. */
export function shellText(db: string, coll: string, p: QueryPayload): string {
  const head = `use ${db}\n`
  if (p.kind === 'aggregate') return `${head}${collRef(coll)}.aggregate(${p.pipeline.trim() || '[]'})`
  const q = p.query.trim() || '{}'
  const proj = p.projection.trim()
  let s = `${collRef(coll)}.find(${q}${proj ? `, ${proj}` : ''})`
  if (p.collation?.trim()) s += `.collation(${p.collation.trim()})`
  if (p.sort.trim()) s += `.sort(${p.sort.trim()})`
  if (p.skip.trim()) s += `.skip(${p.skip.trim()})`
  if (p.limit.trim()) s += `.limit(${p.limit.trim()})`
  return head + s
}

export async function copyText(text: string): Promise<void> {
  try {
    await api.copyText(text)
    toast('Copied to clipboard', 'success')
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

export function relativeTime(d: Date, now = Date.now()): string {
  const s = Math.round((now - d.getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.round(h / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} d ago`
  return fmtDate(d)
}

export const fullTime = (d: Date): string => fmtDateTime(d)

export function matches(e: AnyEntry, f: HistoryFilter, conn = ''): boolean {
  if (f.configId && e.configId && e.configId !== f.configId) return false
  if (f.configId && !e.configId && !isSaved(e)) return false
  if (f.db && e.db !== f.db) return false
  if (f.coll && e.coll !== f.coll) return false
  if (f.kind && e.payload.kind !== f.kind) return false
  const text = f.text?.trim().toLowerCase()
  if (!text) return true
  const p = e.payload
  const body = p.kind === 'aggregate' ? p.pipeline : [p.query, p.projection, p.sort, p.skip, p.limit, p.collation ?? ''].join('\n')
  const hay = [isSaved(e) ? `${e.name}\n${e.folder ?? ''}` : e.connName, conn, e.db, e.coll, `${e.db}.${e.coll}`, body].join('\n').toLowerCase()
  return hay.includes(text)
}

function SaveForm(props: { title: string; name: string; folder: string; folders: string[]; askName: boolean; askFolder: boolean; confirmLabel: string; done: (v: { name: string; folder: string } | null) => void }): ReactElement {
  const [name, setName] = useState(props.name)
  const [folder, setFolder] = useState(props.folder)
  const ok = !props.askName || !!name.trim()
  const submit = (): void => {
    if (ok) props.done({ name: name.trim(), folder: folder.trim() })
  }
  const key = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') submit()
  }
  return (
    <Modal
      title={props.title}
      icon="star"
      width={440}
      onClose={() => props.done(null)}
      footer={
        <>
          <button className="btn" onClick={() => props.done(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok} onClick={submit}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <div className="col qh-form">
        {props.askName && (
          <>
            <label className="muted">Name</label>
            <input className="input" value={name} placeholder="e.g. Open orders this week" onChange={(e) => setName(e.target.value)} onKeyDown={key} onFocus={(e) => e.target.select()} autoFocus />
          </>
        )}
        {props.askFolder && (
          <>
            <label className="muted">
              Folder <span className="faint">(optional)</span>
            </label>
            <input className="input" list="qh-folders" value={folder} placeholder="No folder" onChange={(e) => setFolder(e.target.value)} onKeyDown={key} autoFocus={!props.askName} />
            <datalist id="qh-folders">
              {props.folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </>
        )}
      </div>
    </Modal>
  )
}

/** Ask for a name and folder. */
export function saveQueryDialog(o: { title?: string; name?: string; folder?: string; folders: string[]; askName?: boolean; askFolder?: boolean; confirmLabel?: string }): Promise<{ name: string; folder: string } | null> {
  return openModal<{ name: string; folder: string } | null>((close) => (
    <SaveForm
      title={o.title ?? 'Save Query'}
      name={o.name ?? ''}
      folder={o.folder ?? ''}
      folders={o.folders}
      askName={o.askName ?? true}
      askFolder={o.askFolder ?? true}
      confirmLabel={o.confirmLabel ?? 'Save'}
      done={close}
    />
  ))
}

export const foldersOf = (list: SavedQueryEntry[]): string[] => [...new Set(list.map((q) => q.folder).filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b))

/** Save a payload as a new saved query, asking for its name and folder. */
export async function saveAsNew(src: { configId?: string; db: string; coll: string; payload: QueryPayload }, suggested = ''): Promise<SavedQueryEntry | null> {
  const folders = foldersOf(await api.listSavedQueries().catch(() => []))
  const r = await saveQueryDialog({ name: suggested, folders })
  if (!r) return null
  try {
    const q = await api.saveQuery({ name: r.name, folder: r.folder || undefined, configId: src.configId, db: src.db, coll: src.coll, payload: src.payload })
    toast(`Saved “${q.name}”`, 'success')
    return q
  } catch (e) {
    toast(errorText(e), 'error')
    return null
  }
}
