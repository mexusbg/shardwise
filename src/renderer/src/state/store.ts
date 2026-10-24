import { create } from 'zustand'
import type {
  AppSettings,
  CollectionInfo,
  DatabaseInfo,
  DefaultQueryScope,
  Doc,
  JobProgress,
  SavedSession,
  PlaygroundLanguage,
  PlaygroundLog,
  PlaygroundResult
} from '@shared/api'
import type { ConnectionConfig } from '@shared/connection'
import { askSecrets } from '../components/connections/askSecrets'
import { newGroup } from '@shared/vqb/types'
import type { Group, ProjectionItem, SortItem } from '@shared/vqb/types'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { effectiveCollation, formatCollation } from '@shared/collation'
import { applyDateSettings } from '../lib/datetime'
import { applyUiSettings } from '../lib/uiPrefs'
import { rememberedView } from '../lib/viewMemory'
import { api } from '../lib/api'

export interface LiveConn {
  connId: string
  configId: string
  name: string
  color?: string
  serverVersion: string
  topology: string
  databases?: DatabaseInfo[]
  loading?: boolean
  error?: string
  /** The saved connection is read-only: every write is refused (here and in the main process). */
  readOnly?: boolean
}

export type ViewMode = 'table' | 'tree' | 'json' | 'explain' | 'code'

export interface VqbState {
  root: Group
  projection: ProjectionItem[]
  sort: SortItem[]
  useQuery: boolean
  useProjection: boolean
  useSort: boolean
  /** Set when the query text cannot be shown in the builder. */
  unsupported?: string
  /** Rule id with an invalid value. */
  errorRuleId?: string
  errorMessage?: string
}

export interface AppliedQuery {
  filter: Doc
  projection: Doc | null
  sort: Doc | null
  skip: number
  limit: number
  /** null = none. */
  collation: Doc | null
}

export type ExplainVerbosity = 'queryPlanner' | 'executionStats' | 'allPlansExecution'

export interface ExplainState {
  loading: boolean
  verbosity: ExplainVerbosity
  result?: Doc
  error?: string
  /** The query that was explained. */
  query?: AppliedQuery
}

export interface QueryTab {
  kind: 'query'
  id: string
  connId: string
  db: string
  coll: string
  isView: boolean
  queryText: string
  projectionText: string
  sortText: string
  skipText: string
  limitText: string
  /** Collation as shell text (`{ locale: 'bg', strength: 2 }`); empty = none. */
  collationText: string
  pageSize: number
  page: number
  docs: Doc[] | null
  hasMore: boolean
  loading: boolean
  error?: { part: 'query' | 'projection' | 'sort' | 'collation' | 'run'; message: string }
  ms?: number
  count?: number | null
  counting?: boolean
  applied?: AppliedQuery
  view: ViewMode
  tablePath: string[]
  hiddenColumns: string[]
  readOnly: boolean
  vqbOpen: boolean
  vqb: VqbState
  selection: number[]
  /** Bumped to make views re-render after in-place edits. */
  rev: number
  /** Scope of the saved default query applied when the tab opened. */
  defaultScope?: DefaultQueryScope
  explain?: ExplainState
  /** Number of query values auto-cast to ObjectId / Date on the last run. */
  casts?: number
  /** Set on restored tabs: the tab neither loads the default query nor runs on open. */
  noAutoLoad?: boolean
}

/** Query Profiler / current operations for one database. */
export interface ProfilerTab {
  kind: 'profiler'
  id: string
  connId: string
  db: string
}

/** JS / TS / Mongoose playground bound to a connection and database. */
export interface PlaygroundTab {
  kind: 'playground'
  id: string
  connId: string
  db: string
  title: string
  code: string
  language: PlaygroundLanguage
  filePath?: string
  dirty: boolean
  running: boolean
  runId?: string
  logs: PlaygroundLog[]
  result?: PlaygroundResult
  view: ViewMode
}

/** Phase 2 tools. Each view keeps its own working state while the tab stays mounted. */
export type ToolKind = 'aggregation' | 'indexes' | 'shell' | 'queries' | 'schema' | 'sql' | 'users' | 'compare' | 'migration' | 'masking' | 'reschema' | 'history' | 'tasks' | 'gridfs' | 'search' | 'server' | 'validation'

export interface ToolTab {
  kind: ToolKind
  id: string
  connId: string
  db: string
  coll?: string
  title: string
  icon: string
  /** Initial content passed by whoever opened the tab (e.g. a pipeline from a query tab). */
  init?: unknown
}

export type AnyTab = QueryTab | ProfilerTab | PlaygroundTab | ToolTab

const TOOL_KINDS: string[] = ['aggregation', 'indexes', 'shell', 'queries', 'schema', 'sql', 'users', 'compare', 'migration', 'masking', 'reschema', 'history', 'tasks', 'gridfs', 'search', 'server', 'validation']
export const isToolTab = (t: AnyTab): t is ToolTab => TOOL_KINDS.includes(t.kind)

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

interface State {
  settings: AppSettings
  connections: ConnectionConfig[]
  live: Record<string, LiveConn>
  expanded: Record<string, boolean>
  collections: Record<string, CollectionInfo[] | undefined>
  counts: Record<string, number | undefined>
  tabs: AnyTab[]
  activeTab: string | null
  toasts: Toast[]
  jobs: Record<string, JobProgress>
  treeSelection: string | null
  /** Previous session waiting for the user's restore decision. */
  pendingSession: SavedSession | null
}

export const useStore = create<State>(() => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  connections: [],
  live: {},
  expanded: {},
  collections: {},
  counts: {},
  tabs: [],
  activeTab: null,
  toasts: [],
  jobs: {},
  treeSelection: null,
  pendingSession: null
}))

const set = useStore.setState
const get = useStore.getState

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastSeq = 0
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastSeq
  set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 8000 : 3500)
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ---------------------------------------------------------------------------
// Settings & saved connections
// ---------------------------------------------------------------------------

export async function loadInitial(): Promise<void> {
  const [settings, connections, sysDates] = await Promise.all([api.getSettings(), api.listConnections(), api.systemDateFormat().catch(() => null)])
  applyDateSettings(settings, sysDates)
  applyUiSettings(settings)
  set({ settings, connections })
  const secrets = await api.secretStorageStatus().catch(() => null)
  if (secrets && !secrets.secure) {
    toast(
      `Saved passwords are not protected by a system keyring (${secrets.backend}). Install and unlock a keyring such as GNOME Keyring or KWallet to encrypt them.`,
      'error'
    )
  }
}

export async function saveSettings(s: Partial<AppSettings>): Promise<void> {
  const settings = await api.saveSettings(s)
  applyDateSettings(settings)
  applyUiSettings(settings)
  set({ settings })
}

export async function reloadConnections(): Promise<void> {
  const connections = await api.listConnections()
  const before = get().connections
  // Open connections follow edits that apply without reconnecting (the main process does the same).
  set((s) => ({
    connections,
    live: Object.fromEntries(
      Object.entries(s.live).map(([id, l]) => {
        const c = connections.find((x) => x.id === l.configId)
        return [id, c ? { ...l, name: c.name, color: c.color, readOnly: !!c.readOnly } : l]
      })
    ),
    tabs: s.tabs.map((t) => {
      const l = s.live[t.connId]
      const c = l && connections.find((x) => x.id === l.configId)
      return t.kind === 'query' && c?.readOnly && !t.readOnly ? { ...t, readOnly: true } : t
    })
  }))
  // A changed "Databases to show" list is reflected in the tree right away.
  const dbs = (list: ConnectionConfig[], id: string): string => JSON.stringify(list.find((c) => c.id === id)?.databases ?? null)
  for (const l of Object.values(get().live)) if (dbs(before, l.configId) !== dbs(connections, l.configId)) void refreshDatabases(l.connId)
}

/** Saved settings of an open connection. */
export function connConfig(connId: string): ConnectionConfig | undefined {
  const l = get().live[connId]
  return l ? get().connections.find((c) => c.id === l.configId) : undefined
}

export const isConnReadOnly = (connId: string): boolean => !!get().live[connId]?.readOnly

export const READ_ONLY_HINT = 'Turn off "Read-only" in the connection settings to make changes.'

/** False (with a message) when the connection is read-only; use before starting any write. */
export function guardWrite(connId: string, what = 'Changes'): boolean {
  if (!isConnReadOnly(connId)) return true
  toast(`${connName(connId)} is a read-only connection. ${what} are not allowed. ${READ_ONLY_HINT}`, 'error')
  return false
}

// ---------------------------------------------------------------------------
// Live connections & tree
// ---------------------------------------------------------------------------

export const dbKey = (connId: string, db: string): string => `${connId}/${db}`
export const collKey = (connId: string, db: string, coll: string): string => `${connId}/${db}/${coll}`

export async function connect(configId: string): Promise<string | null> {
  const cfg = get().connections.find((c) => c.id === configId)
  if (!cfg) return null
  const existing = Object.values(get().live).find((l) => l.configId === configId)
  if (existing) {
    set((s) => ({ expanded: { ...s.expanded, [existing.connId]: true }, treeSelection: existing.connId }))
    return existing.connId
  }
  // Connections that do not save their password ask for it now (also when a session is restored).
  const secrets = await askSecrets(cfg)
  if (!secrets) return null
  try {
    const r = await api.connect(configId, Object.keys(secrets).length ? secrets : undefined)
    const live: LiveConn = { connId: r.connId, configId, name: cfg.name, color: cfg.color, serverVersion: r.serverVersion, topology: r.topology, readOnly: !!cfg.readOnly }
    set((s) => ({ live: { ...s.live, [r.connId]: live }, expanded: { ...s.expanded, [r.connId]: true }, treeSelection: r.connId }))
    await refreshDatabases(r.connId)
    return r.connId
  } catch (e) {
    toast(`Could not connect to ${cfg.name}: ${errorText(e)}`, 'error')
    return null
  }
}

export async function disconnect(connId: string): Promise<void> {
  await api.disconnect(connId).catch(() => {})
  set((s) => {
    const live = { ...s.live }
    delete live[connId]
    const tabs = s.tabs.filter((t) => t.connId !== connId)
    const activeTab = tabs.some((t) => t.id === s.activeTab) ? s.activeTab : (tabs[tabs.length - 1]?.id ?? null)
    return { live, tabs, activeTab }
  })
}

function patchLive(connId: string, p: Partial<LiveConn>): void {
  set((s) => (s.live[connId] ? { live: { ...s.live, [connId]: { ...s.live[connId], ...p } } } : {}))
}

export async function refreshDatabases(connId: string): Promise<void> {
  patchLive(connId, { loading: true, error: undefined })
  try {
    const databases = await api.listDatabases(connId)
    patchLive(connId, { databases, loading: false })
  } catch (e) {
    patchLive(connId, { loading: false, error: errorText(e) })
  }
}

// Collection counts arrive one by one; they are applied in batches so a database with many
// collections does not re-render the tree once per collection.
let countBuffer: Record<string, number> | null = null
function queueCount(key: string, n: number): void {
  if (!countBuffer) {
    countBuffer = {}
    setTimeout(() => {
      const batch = countBuffer
      countBuffer = null
      set((s) => ({ counts: { ...s.counts, ...batch } }))
    }, 50)
  }
  countBuffer[key] = n
}

export async function refreshCollections(connId: string, db: string): Promise<void> {
  const key = dbKey(connId, db)
  try {
    const list = await api.listCollections(connId, db)
    set((s) => ({ collections: { ...s.collections, [key]: list } }))
    for (const c of list) {
      if (c.type === 'view') continue
      api.estimatedCount(connId, db, c.name).then(
        (n) => queueCount(collKey(connId, db, c.name), n),
        () => {}
      )
    }
  } catch (e) {
    toast(`Could not list collections of ${db}: ${errorText(e)}`, 'error')
  }
}

export function toggleExpanded(key: string, value?: boolean): void {
  set((s) => ({ expanded: { ...s.expanded, [key]: value ?? !s.expanded[key] } }))
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let tabSeq = 0

export function emptyVqb(): VqbState {
  return { root: newGroup('and'), projection: [], sort: [], useQuery: true, useProjection: true, useSort: true }
}

export function openCollectionTab(connId: string, db: string, coll: string, isView = false): string {
  const id = `tab${++tabSeq}`
  const { settings, live } = get()
  const configId = live[connId]?.configId
  const view: ViewMode = (settings.rememberResultView && configId ? rememberedView(configId, db, coll) : null) ?? settings.defaultResultView ?? 'table'
  const cfg = configId ? get().connections.find((c) => c.id === configId) : undefined
  const tab: QueryTab = {
    kind: 'query',
    id,
    connId,
    db,
    coll,
    isView,
    queryText: '',
    projectionText: '',
    sortText: '',
    skipText: '',
    limitText: '',
    // The connection's default collation, else the one from Settings → Browsing data.
    collationText: formatCollation(effectiveCollation(cfg?.overrides?.defaultCollation, settings.defaultCollation)),
    pageSize: cfg?.overrides?.pageSize || settings.pageSize || 50,
    page: 0,
    docs: null,
    hasMore: false,
    loading: false,
    view,
    tablePath: [],
    hiddenColumns: [],
    // Tabs of read-only connections start (and stay) locked.
    readOnly: isView || !!live[connId]?.readOnly,
    vqbOpen: settings.filterBuilderOnOpen,
    vqb: emptyVqb(),
    selection: [],
    rev: 0
  }
  set((s) => ({ tabs: [...s.tabs, tab], activeTab: id }))
  return id
}

export function closeTab(id: string): void {
  set((s) => {
    const i = s.tabs.findIndex((t) => t.id === id)
    const tabs = s.tabs.filter((t) => t.id !== id)
    let activeTab = s.activeTab
    if (activeTab === id) activeTab = tabs[Math.min(i, tabs.length - 1)]?.id ?? null
    return { tabs, activeTab }
  })
}

export function patchTab(id: string, p: Partial<QueryTab> | ((t: QueryTab) => Partial<QueryTab>)): void {
  set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id && t.kind === 'query' ? { ...t, ...(typeof p === 'function' ? p(t) : p) } : t))
  }))
}

export const getTab = (id: string): QueryTab | undefined => {
  const t = get().tabs.find((x) => x.id === id)
  return t?.kind === 'query' ? t : undefined
}

export function patchPlayground(id: string, p: Partial<PlaygroundTab> | ((t: PlaygroundTab) => Partial<PlaygroundTab>)): void {
  set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id && t.kind === 'playground' ? { ...t, ...(typeof p === 'function' ? p(t) : p) } : t))
  }))
}

export const getPlayground = (id: string): PlaygroundTab | undefined => {
  const t = get().tabs.find((x) => x.id === id)
  return t?.kind === 'playground' ? t : undefined
}

const PLAYGROUND_STARTER = [
  '// Playground: JavaScript / TypeScript with the MongoDB driver and Mongoose.',
  "// Available: db (current database), client, mongoose, ObjectId, ISODate, use('otherDb'), console.log",
  '// mongosh style: db.customers.find({ age: { $gt: 30 } }).limit(5)',
  '// Mongoose: any model name maps to its collection (User -> users), no schema needed:',
  '//   await User.find({ vip: true }).sort({ name: 1 }).limit(10).lean()',
  '// The value of the last expression (or a top-level return) is shown below.',
  '// Top-level statements are awaited in order, as in mongosh.',
  '',
  '// --- Mongoose example: remove the // of the lines below and press Run ---',
  "// const Customer = mongoose.model('Customer', new mongoose.Schema({",
  '//   name: { type: String, required: true },',
  '//   age: Number,',
  '//   vip: { type: Boolean, default: false },',
  '//   tags: [String],',
  '//   createdAt: { type: Date, default: Date.now }',
  "// }), 'customers')                                // third argument: the collection",
  "// await Customer.find({ age: { $gte: 30 } }).select('name age vip').sort({ age: -1 }).limit(10).lean()",
  '// await Customer.updateMany({ age: { $gte: 65 } }, { $set: { vip: true } })   // validated by the schema',
  "// await Customer.aggregate([{ $group: { _id: '$vip', count: { $sum: 1 } } }])",
  '',
  'db.getCollectionNames()',
  ''
].join('\n')

let playgroundSeq = 0
export function openPlaygroundTab(connId: string, db: string, init?: { code?: string; language?: PlaygroundLanguage; filePath?: string; title?: string }): string {
  const id = `tab${++tabSeq}`
  const tab: PlaygroundTab = {
    kind: 'playground',
    id,
    connId,
    db,
    title: init?.title ?? `Playground ${++playgroundSeq}`,
    code: init?.code ?? PLAYGROUND_STARTER,
    language: init?.language ?? 'javascript',
    filePath: init?.filePath,
    dirty: false,
    running: false,
    logs: [],
    view: 'table'
  }
  set((s) => ({ tabs: [...s.tabs, tab], activeTab: id }))
  return id
}

/** Open a tool tab; with `reuse`, focus an existing tab of the same kind and target instead. */
export function openToolTab(t: Omit<ToolTab, 'id'>, reuse = false): string {
  if (reuse) {
    const existing = get().tabs.find((x) => x.kind === t.kind && x.connId === t.connId && x.db === t.db && (x as ToolTab).coll === t.coll)
    if (existing) {
      set({ activeTab: existing.id })
      return existing.id
    }
  }
  const id = `tab${++tabSeq}`
  set((s) => ({ tabs: [...s.tabs, { ...t, id }], activeTab: id }))
  return id
}

export function patchToolTab(id: string, p: Partial<Omit<ToolTab, 'id' | 'kind'>>): void {
  set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && isToolTab(t) ? { ...t, ...p } : t)) }))
}

export const openAggregationTab = (connId: string, db: string, coll: string, init?: unknown): string =>
  openToolTab({ kind: 'aggregation', connId, db, coll, title: `${coll} · Pipeline`, icon: 'aggregate', init })

export const openIndexesTab = (connId: string, db: string, coll: string): string =>
  openToolTab({ kind: 'indexes', connId, db, coll, title: `${coll} · Indexes`, icon: 'key' }, true)

export const openShellTab = (connId: string, db: string): string => openToolTab({ kind: 'shell', connId, db, title: 'Shell', icon: 'terminal' })

export const openQueryManagerTab = (connId: string, db = '', coll?: string): string =>
  openToolTab({ kind: 'queries', connId, db, coll, title: 'Query Library', icon: 'history' }, true)

export const openSchemaTab = (connId: string, db: string, coll: string): string =>
  openToolTab({ kind: 'schema', connId, db, coll, title: `${coll} · Schema`, icon: 'schema' }, true)

export const openSqlTab = (connId: string, db: string, coll?: string): string => openToolTab({ kind: 'sql', connId, db, coll, title: 'SQL Query', icon: 'sql' })

export const openCompareTab = (connId: string, db: string, coll: string): string =>
  openToolTab({ kind: 'compare', connId, db, coll, title: `${coll} · Diff`, icon: 'compare' })

/** SQL ⇄ MongoDB migration. `init.direction` preselects 'toSql' or 'fromSql'. */
export const openMigrationTab = (connId: string, db: string, init?: { direction: 'toSql' | 'fromSql'; collections?: string[] }): string =>
  openToolTab({ kind: 'migration', connId, db, title: init?.direction === 'fromSql' ? 'SQL Import' : 'SQL Export', icon: 'sql', init })

export const openMaskingTab = (connId: string, db: string, coll: string): string =>
  openToolTab({ kind: 'masking', connId, db, coll, title: `${coll} · Mask`, icon: 'mask' })

export const openReschemaTab = (connId: string, db: string, coll: string): string =>
  openToolTab({ kind: 'reschema', connId, db, coll, title: `${coll} · Restructure`, icon: 'reschema' })

export const openCollectionHistoryTab = (connId: string, db: string, coll?: string): string =>
  openToolTab({ kind: 'history', connId, db, coll, title: coll ? `${coll} · History` : 'Change History', icon: 'history' }, true)

export const openTasksTab = (connId: string): string => openToolTab({ kind: 'tasks', connId, db: '', title: 'Tasks', icon: 'tasks' }, true)

export const openGridFsTab = (connId: string, db: string, bucket?: string): string =>
  openToolTab({ kind: 'gridfs', connId, db, coll: bucket, title: `GridFS${bucket ? ` · ${bucket}` : ''}`, icon: 'files' }, true)

export const openSearchTab = (connId: string, db: string): string => openToolTab({ kind: 'search', connId, db, title: `Find in ${db}`, icon: 'search' })

export const openServerStatusTab = (connId: string): string => openToolTab({ kind: 'server', connId, db: 'admin', title: 'Server Status', icon: 'activity' }, true)

export const openValidationTab = (connId: string, db: string, coll: string): string =>
  openToolTab({ kind: 'validation', connId, db, coll, title: `${coll} · Validation`, icon: 'shield' }, true)

/** Collections / databases copied in the tree, pasted elsewhere (possibly another connection). */
export type TreeClipboard = { kind: 'collection'; connId: string; db: string; colls: string[] } | { kind: 'database'; connId: string; db: string }

export const useTreeClipboard = create<{ item: TreeClipboard | null }>(() => ({ item: null }))

export const openUsersTab = (connId: string, db: string): string => openToolTab({ kind: 'users', connId, db, title: 'Users & Roles', icon: 'users' }, true)

export function openProfilerTab(connId: string, db: string): string {
  const existing = get().tabs.find((t) => t.kind === 'profiler' && t.connId === connId && t.db === db)
  if (existing) {
    set({ activeTab: existing.id })
    return existing.id
  }
  const id = `tab${++tabSeq}`
  set((s) => ({ tabs: [...s.tabs, { kind: 'profiler', id, connId, db }], activeTab: id }))
  return id
}

export function connName(connId: string): string {
  return get().live[connId]?.name ?? 'disconnected'
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const AUTO_DISMISS_MS = 8000

export function updateJob(p: JobProgress): void {
  const prev = get().jobs[p.jobId]
  set((s) => ({ jobs: { ...s.jobs, [p.jobId]: p } }))
  // Successful jobs clear themselves; errors and cancellations stay until dismissed.
  if (p.state === 'done' && prev?.state !== 'done') {
    setTimeout(() => {
      if (get().jobs[p.jobId]?.state === 'done') dismissJob(p.jobId)
    }, AUTO_DISMISS_MS)
  }
}

export function dismissJob(id: string): void {
  set((s) => {
    const jobs = { ...s.jobs }
    delete jobs[id]
    return { jobs }
  })
}
