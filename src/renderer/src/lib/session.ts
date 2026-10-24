import type { SavedSession, SavedTab } from '@shared/api'
import { api } from './api'
import { runQuery, syncTextToVqb } from '../state/queryActions'
import { connect, isToolTab, openCollectionTab, openPlaygroundTab, openProfilerTab, openToolTab, patchTab, toast, useStore } from '../state/store'
import type { AnyTab, ToolKind } from '../state/store'

const SAVE_DELAY_MS = 1500

/** Plain-JSON snapshot of the open tabs, keyed by saved connection (not live connection ids). */
function snapshot(): SavedSession | null {
  const { tabs, activeTab, live } = useStore.getState()
  const out: SavedTab[] = []
  let active = -1
  for (const t of tabs) {
    const configId = live[t.connId]?.configId
    if (!configId) continue
    const s = saveTab(t, configId)
    if (!s) continue
    if (t.id === activeTab) active = out.length
    out.push(s)
  }
  return { savedAt: new Date(), tabs: out, active }
}

function saveTab(t: AnyTab, configId: string): SavedTab | null {
  if (t.kind === 'query') {
    return {
      kind: 'query',
      configId,
      db: t.db,
      coll: t.coll,
      isView: t.isView,
      query: { query: t.queryText, projection: t.projectionText, sort: t.sortText, skip: t.skipText, limit: t.limitText, collation: t.collationText },
      view: t.view === 'explain' ? 'table' : t.view,
      pageSize: t.pageSize
    }
  }
  if (t.kind === 'playground') return { kind: 'playground', configId, db: t.db, title: t.title, code: t.code, language: t.language, filePath: t.filePath }
  if (t.kind === 'profiler') return { kind: 'profiler', configId, db: t.db }
  // Tool tabs reopen empty; `init` payloads (pipelines etc.) are kept when they are plain JSON.
  if (isToolTab(t)) {
    let init: unknown
    try {
      init = t.init === undefined ? undefined : JSON.parse(JSON.stringify(t.init))
    } catch {
      init = undefined
    }
    return { kind: 'tool', tool: t.kind, configId, db: t.db, coll: t.coll, title: t.title, icon: t.icon, init }
  }
  return null
}

let timer: ReturnType<typeof setTimeout> | undefined
let lastJson = ''

function scheduleSave(): void {
  clearTimeout(timer)
  timer = setTimeout(() => {
    const s = snapshot()
    if (!s) return
    const json = JSON.stringify({ ...s, savedAt: 0 })
    // Don't overwrite a saved session with an empty one before the user decided whether to restore it.
    if (json === lastJson || (useStore.getState().pendingSession && !s.tabs.length)) return
    lastJson = json
    void api.saveSession(s).catch(() => {})
  }, SAVE_DELAY_MS)
}

/** Start persisting the tab list (call once after the initial load). */
export function trackSession(): () => void {
  const unsub = useStore.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs || state.activeTab !== prev.activeTab) scheduleSave()
  })
  return unsub
}

/** Reconnect the saved connections and reopen the tabs. */
export async function restoreSession(session: SavedSession): Promise<void> {
  useStore.setState({ pendingSession: null })
  const configIds = [...new Set(session.tabs.map((t) => t.configId))]
  const known = new Set(useStore.getState().connections.map((c) => c.id))
  const connIds = new Map<string, string>()
  for (const id of configIds) {
    if (!known.has(id)) continue
    const connId = await connect(id)
    if (connId) connIds.set(id, connId)
  }
  const opened: string[] = []
  for (const t of session.tabs) {
    const connId = connIds.get(t.configId)
    if (!connId) {
      opened.push('')
      continue
    }
    if (t.kind === 'query') {
      const id = openCollectionTab(connId, t.db, t.coll, t.isView)
      // `noAutoLoad` keeps the tab's own default-query loader from replacing the restored text.
      // Sessions saved before collation support keep the tab's default collation.
      const collation = typeof t.query.collation === 'string' ? { collationText: t.query.collation } : {}
      patchTab(id, { noAutoLoad: true, queryText: t.query.query, projectionText: t.query.projection, sortText: t.query.sort, skipText: t.query.skip, limitText: t.query.limit, ...collation, view: t.view, pageSize: t.pageSize })
      // Show the restored query in the Filter Builder too, so editing there does not replace it.
      syncTextToVqb(id, 'query')
      syncTextToVqb(id, 'projection')
      syncTextToVqb(id, 'sort')
      // Settings → Browsing data → "Run the query when a collection opens" applies to restored tabs too.
      if (useStore.getState().settings.runQueryOnOpen) void runQuery(id)
      opened.push(id)
    } else if (t.kind === 'playground') {
      opened.push(openPlaygroundTab(connId, t.db, { code: t.code, language: t.language, filePath: t.filePath, title: t.title }))
    } else if (t.kind === 'profiler') {
      opened.push(openProfilerTab(connId, t.db))
    } else {
      opened.push(openToolTab({ kind: t.tool as ToolKind, connId, db: t.db, coll: t.coll, title: t.title, icon: t.icon, init: t.init }))
    }
  }
  const active = opened[session.active]
  if (active) useStore.setState({ activeTab: active })
  const missing = session.tabs.filter((t) => !connIds.has(t.configId)).length
  if (missing) toast(`${missing} tab${missing === 1 ? '' : 's'} could not be restored (connection unavailable)`, 'error')
}

/** Decide what to do with the previous session at startup. */
export async function initSession(): Promise<void> {
  const [session, settings] = await Promise.all([api.getSession().catch(() => null), Promise.resolve(useStore.getState().settings)])
  if (session && session.tabs.length) {
    if (settings.restoreSession === 'always') await restoreSession(session)
    else if (settings.restoreSession !== 'never') useStore.setState({ pendingSession: session })
  }
  trackSession()
}
