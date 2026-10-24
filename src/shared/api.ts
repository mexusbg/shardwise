import type { SchemaOptions, SchemaReport } from './schema'
import type { UpdateInfo } from './updates'
import type { ValueColors } from './valueColors'
import type { ConnectionConfig, PromptedSecrets } from './connection'
import type { CompareApi } from './compareApi'
import type { MigrationApi } from './migrationApi'
import type { MaskingApi } from './maskingApi'
import type { AiApi, AiEvents } from './aiApi'
import type { TasksApi, TasksEvents } from './tasksApi'
import type { ServerApi } from './serverApi'
import type { ChangeHistoryApi, WriteOptions } from './changeHistoryApi'
import type { CopyApi } from './copyApi'
import type { GridFsApi } from './gridfsApi'
import type { SearchApi, SearchEvents } from './searchApi'
import type { Collation } from './collation'
import type { ProxySettings } from './proxy'
import type { ShellConfirmRequest, ShellEvalOptions, ShellOpenResult } from './shellOptions'

/**
 * Contract between renderer and main. Every method is invoked over one IPC channel; arguments and results
 * travel as canonical EJSON so BSON types survive the trip.
 */

export type Doc = Record<string, unknown>

export interface AppSettings {
  pageSize: number
  /** Folder containing mongodump / mongorestore; empty = PATH or auto-downloaded copy. */
  toolsPath: string
  /** 0 = no limit. */
  queryTimeoutMS: number
  theme: 'system' | 'light' | 'dark'
  /** Cast hex / ISO strings in queries to ObjectId / Date when the field is known to hold that type. */
  autoCast: boolean
  /** Reopen the previous session's tabs on launch. */
  restoreSession: 'ask' | 'always' | 'never'
  /** Interface date format: 'system' or a pattern such as 'dd.MM.yyyy' (tokens as in dateFormat.ts). */
  dateFormat: string
  /** Interface time format: 'system' or a pattern such as 'HH:mm:ss'. */
  timeFormat: string
  /** Zone for date values from the database: 'UTC', 'local' or an IANA name ('Europe/Sofia'). */
  dataTimeZone: string
  /** Database dates as ISO 8601 or in the interface date and time format. */
  dataDateStyle: 'iso' | 'interface'

  // --- Results ---
  /** Query a collection as soon as its tab opens; off = wait for Run. */
  runQueryOnOpen: boolean
  /** Result view of a newly opened collection tab. */
  defaultResultView: ResultViewKind
  /** Reopen a collection in the view it was last shown in (overrides `defaultResultView`). */
  rememberResultView: boolean
  /** New collection tabs open with the Filter Builder (visual query builder) shown. */
  filterBuilderOnOpen: boolean
  /** Tree view: open the first document of a result automatically. */
  treeExpandFirst: boolean
  /** Text style of the JSON view and of copied documents. */
  jsonStyle: JsonStyle
  /** Ask before deleting a single document (multi-document deletes always ask). */
  confirmSingleDelete: boolean
  /** Look for a newer GitHub release when the app starts (Settings → About). */
  checkUpdates: boolean
  /** Collation new query tabs start with; null = none (binary order). A connection can override it. */
  defaultCollation: Collation | null

  // --- Editor ---
  /** Monospace font of code editors; empty = built-in default. */
  editorFontFamily: string
  /** Font size of code editors in px; 0 = built-in default. */
  editorFontSize: number
  /** Spaces per indentation level. */
  editorTabWidth: number
  /** Insert the closing bracket / quote automatically. */
  editorCloseBrackets: boolean
  /** Wrap long lines in multi-line editors (JSON view, pipeline, SQL, playground, document editor). */
  editorLineWrapping: boolean
  /** Show completion suggestions while typing, per editor area (Ctrl+Space always works). */
  editorAutocomplete: Record<EditorArea, boolean>

  // --- General ---
  /** Zoom factor of the whole window (1 = 100 %). */
  uiZoom: number
  /** Entries kept in the query history. */
  historyLimit: number
  /** Show the Connection Manager at launch when no tabs are restored. */
  connectionManagerOnStart: boolean

  // --- Network (Settings → Network & tools) ---
  /** Outbound proxy for MongoDB, SSH, SQL and HTTPS traffic; a connection can override it. */
  proxy: ProxySettings

  // --- Keyboard (Settings → Shortcuts) ---
  /** Shortcut overrides: command id → its bindings ([] = none). Only commands that differ from the defaults (src/shared/commands.ts). */
  keymap: Record<string, string[]>
  /** Colours of value types in the result views, per theme; only changed types are stored. */
  valueColors: ValueColors

  // --- Shell (Settings → Shell & Playground) ---
  /** Where the startup script of every shell session comes from: typed in Settings or read from a file. */
  shellStartupSource: 'inline' | 'file'
  /** Startup script typed in Settings (run when `shellStartupSource` is 'inline'). */
  shellStartupScript: string
  /** Path of a startup script file (run when `shellStartupSource` is 'file'). */
  shellStartupFile: string
  /** Playground runs execute the shell startup script first. */
  playgroundRunStartup: boolean
  /** Documents per cursor batch in the shell (`it` shows the next batch). */
  shellBatchSize: number
  /** Output lines per command shown before "Show more". */
  shellMaxOutputLines: number
  /** Output characters per command shown before "Show more". */
  shellMaxOutputChars: number
  /** Nesting levels printed expanded. */
  shellPrintDepth: number
  /** typed = NumberInt('5') / NumberLong('7') / NumberDecimal('1.5'); plain = bare numbers. */
  shellNumberDisplay: 'typed' | 'plain'
  /** iso = ISODate('…'); data = the Dates & times format of database dates. */
  shellDateDisplay: 'iso' | 'data'
  /** Ask before running shell commands: never, destructive ones (drops, empty-filter deletes…) or every write. */
  shellConfirm: ShellConfirmMode
  /** Commands kept in the shell history. */
  shellHistoryLimit: number
  /** Do not store a command that repeats the previous one. */
  shellHistoryDedupe: boolean
  /** One history per saved connection, or one shared by every shell. */
  shellHistoryScope: 'connection' | 'global'
  /** Default time limit of shell commands; 0 = none. */
  shellTimeoutMS: number
  /** Default time limit of playground runs; 0 = none. */
  playgroundTimeoutMS: number
  /** mongosh executable; empty = find it on PATH or in the usual install folders. */
  mongoshPath: string
}

export type ShellConfirmMode = 'off' | 'destructive' | 'writes'

export type ResultViewKind = 'table' | 'tree' | 'json'
/** shell = mongosh syntax (`ObjectId('…')`), relaxed / canonical = Extended JSON v2. */
export type JsonStyle = 'shell' | 'relaxed' | 'canonical'
export type EditorArea = 'query' | 'pipeline' | 'shell' | 'sql' | 'playground'

/** How the operating system writes dates (Settings → "Follow system"). */
export interface SystemDateFormat {
  /** BCP 47 locale of the regional format, e.g. 'bg-BG'. */
  locale: string
  /** Short date / long time patterns set in the OS (Windows regional settings), when available. */
  datePattern?: string
  timePattern?: string
}

/** Open tabs saved between launches (connections by saved config id). */
export type SavedTab =
  | {
      kind: 'query'
      configId: string
      db: string
      coll: string
      isView: boolean
      query: { query: string; projection: string; sort: string; skip: string; limit: string; collation?: string }
      view: 'table' | 'tree' | 'json' | 'explain' | 'code'
      pageSize: number
    }
  | { kind: 'playground'; configId: string; db: string; title: string; code: string; language: 'javascript' | 'typescript'; filePath?: string }
  | { kind: 'profiler'; configId: string; db: string }
  | { kind: 'tool'; tool: string; configId: string; db: string; coll?: string; title: string; icon: string; init?: unknown }

export interface SavedSession {
  savedAt: Date
  tabs: SavedTab[]
  /** Index of the active tab, -1 when none. */
  active: number
}

/** Query bar contents saved as the default for a connection, database or collection. */
export interface SavedQuery {
  query: string
  projection: string
  sort: string
  skip: string
  limit: string
  /** Collation text; missing (older saves) = keep the tab's collation. */
  collation?: string
}

export type DefaultQueryScope = 'collection' | 'database' | 'connection'

export interface DefaultQueryMatch {
  scope: DefaultQueryScope
  value: SavedQuery
}

export interface ConnectionImportPreview {
  format: string
  connections: ConnectionConfig[]
  warnings: string[]
  /** Shardwise export with encrypted passwords: ask for the passphrase and preview again. */
  needsPassphrase: boolean
}

export interface TestStep {
  name: string
  ok: boolean
  detail?: string
}

export interface TestResult {
  ok: boolean
  steps: TestStep[]
  serverVersion?: string
  error?: string
}

export interface ConnectResult {
  connId: string
  serverVersion: string
  topology: string
}

export interface DatabaseInfo {
  name: string
  sizeOnDisk?: number
}

export interface CollectionInfo {
  name: string
  type: 'collection' | 'view' | 'timeseries'
}

export interface FindRequest {
  filter: Doc
  projection?: Doc | null
  sort?: Doc | null
  skip: number
  limit: number
  /** Validated in the main process; null / missing = none. */
  collation?: Doc | null
}

export interface FindResult {
  docs: Doc[]
  ms: number
}

/** Which documents a write applies to. */
export type DocScope = { kind: 'ids'; ids: unknown[] } | { kind: 'filter'; filter: Doc; collation?: Doc | null } | { kind: 'all' }

export type FieldOp =
  | { kind: 'set'; path: string; value: unknown }
  | { kind: 'unset'; path: string }
  | { kind: 'rename'; path: string; newName: string }

export interface WriteResult {
  matched: number
  modified: number
}

/** Update Documents dialog: any filter and update (document, or pipeline array). */
export interface UpdateRequest {
  filter: Doc
  update: Doc | Doc[]
  /** All matches (updateMany) or only the first (updateOne). */
  multi: boolean
  upsert: boolean
  collation?: Doc | null
}

export interface UpdateResult extends WriteResult {
  upserted: number
}

// ---------------------------------------------------------------------------
// Profiling
// ---------------------------------------------------------------------------

export interface ProfilingStatus {
  /** 0 = off, 1 = slow operations only, 2 = all operations. */
  level: number
  slowms: number
  sampleRate: number
  filter?: Doc
}

export interface IndexInfo {
  name: string
  key: Doc
  unique?: boolean
  sparse?: boolean
  hidden?: boolean
  partialFilterExpression?: Doc
  expireAfterSeconds?: number
}

export interface ProfileQuery {
  /** Filter on system.profile documents. */
  filter: Doc
  limit: number
}

// ---------------------------------------------------------------------------
// JS / TS playground
// ---------------------------------------------------------------------------

export type PlaygroundLanguage = 'javascript' | 'typescript'

export interface PlaygroundRunRequest {
  runId: string
  connId: string
  db: string
  code: string
  language: PlaygroundLanguage
  /** 0 = no limit. */
  timeoutMS: number
}

export interface PlaygroundLog {
  level: 'log' | 'info' | 'warn' | 'error'
  text: string
  /** ms since the run started */
  at: number
}

export interface PlaygroundResult {
  runId: string
  ok: boolean
  /** Returned / last-expression value; documents keep their BSON types. */
  value?: unknown
  /** 'documents' when value is an array of documents (shown in the result views). */
  valueKind: 'documents' | 'document' | 'value' | 'undefined'
  logs: PlaygroundLog[]
  ms: number
  error?: string
  stack?: string
  cancelled?: boolean
}

// ---------------------------------------------------------------------------
// Phase 2: aggregation, indexes, shell, query history
// ---------------------------------------------------------------------------

export interface AggregateOptions {
  allowDiskUse?: boolean
  maxTimeMS?: number
  collation?: Doc | null
}

export interface AggregateResult {
  docs: Doc[]
  ms: number
}

export interface IndexDetail extends IndexInfo {
  /** Bytes, from collStats indexSizes. */
  size?: number
  /** $indexStats: operations since `since`. */
  ops?: number
  since?: Date
  /** e.g. 'regular', 'compound', 'text', '2dsphere', 'hashed', 'wildcard', 'ttl' */
  type: string
  /** Build in progress (from currentOp), 0-100 when known. */
  building?: number
}

export type QueryPayload =
  | { kind: 'find'; query: string; projection: string; sort: string; skip: string; limit: string; collation?: string }
  | { kind: 'aggregate'; pipeline: string }

export interface HistoryEntry {
  id: string
  at: Date
  configId: string
  connName: string
  db: string
  coll: string
  payload: QueryPayload
  ms?: number
  count?: number
}

export interface SavedQueryEntry {
  id: string
  name: string
  folder?: string
  configId?: string
  db: string
  coll: string
  payload: QueryPayload
  createdAt: Date
  updatedAt: Date
}

export interface HistoryFilter {
  configId?: string
  db?: string
  coll?: string
  text?: string
  kind?: QueryPayload['kind']
  limit?: number
}

// ---------------------------------------------------------------------------
// Phase 3: users & roles
// ---------------------------------------------------------------------------

export interface RoleRef {
  role: string
  db: string
}

export interface UserInfo {
  user: string
  db: string
  roles: RoleRef[]
  mechanisms?: string[]
  customData?: Doc
}

export interface Privilege {
  resource: Doc
  actions: string[]
}

export interface RoleInfo {
  role: string
  db: string
  isBuiltin: boolean
  roles: RoleRef[]
  privileges?: Privilege[]
  inheritedRoles?: RoleRef[]
}

// ---------------------------------------------------------------------------
// AI helper
// ---------------------------------------------------------------------------

export interface AiRequest {
  connId: string
  db: string
  coll: string
  prompt: string
  /** Send a few sample documents (values) to the model, not just field names and types. */
  includeSamples: boolean
  /** Current query bar texts, so the model can refine them. */
  current?: { query: string; projection: string; sort: string }
}

export interface AiSuggestion {
  kind: 'find' | 'aggregate'
  query: string
  projection: string
  sort: string
  limit: string
  pipeline: string
  explanation: string
}

export interface FileDialogOptions {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
  directory?: boolean
  multi?: boolean
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export type TransferFormat = 'json' | 'csv' | 'xlsx' | 'bson-folder' | 'bson-archive'

/** JSON export flavours. */
export type JsonFlavor = 'shell' | 'canonical' | 'relaxed' | 'legacyShell' | 'pure'

export const JSON_FLAVOR_LABELS: Record<JsonFlavor, string> = {
  shell: 'mongo shell syntax (ObjectId(…), ISODate(…))',
  canonical: 'mongoexport (canonical EJSON)',
  relaxed: 'mongoexport (relaxed EJSON)',
  legacyShell: 'Legacy mongo shell',
  pure: 'Pure JSON (no MongoDB types)'
}

export interface ExportRequest {
  connId: string
  db: string
  /** One or more collections. JSON/CSV/Excel write one file per collection when several are given. */
  collections: string[]
  format: TransferFormat
  /** File path for a single file, else a folder. */
  target: string
  /** Optional query restriction (single collection only). */
  query?: { filter: Doc; projection?: Doc | null; sort?: Doc | null; skip?: number; limit?: number; collation?: Doc | null }
  json?: { flavor: JsonFlavor; layout: 'lines' | 'array'; pretty: boolean }
  /** `bom`: start the file with a UTF-8 byte order mark so Excel on Windows reads it as UTF-8 (default off). */
  csv?: { fields: string[]; delimiter: string; header: boolean; bom?: boolean }
  xlsx?: { fields: string[] }
  bson?: { gzip: boolean }
}

export type CsvColumnType = 'auto' | 'string' | 'number' | 'bool' | 'date' | 'objectId' | 'skip'

/** Character encodings of imported text files (CSV / JSON); `auto` sniffs a BOM, then UTF-8, then a legacy code page. */
export type TextEncoding = 'auto' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251' | 'windows-1252' | 'iso-8859-5' | 'koi8-r'

export const TEXT_ENCODING_LABELS: Record<TextEncoding, string> = {
  auto: 'Auto-detect',
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1251': 'Windows-1251 (Cyrillic)',
  'windows-1252': 'Windows-1252 (Western)',
  'iso-8859-5': 'ISO-8859-5 (Cyrillic)',
  'koi8-r': 'KOI8-R (Cyrillic)'
}

export interface ImportRequest {
  connId: string
  db: string
  /** Target collection (JSON/CSV/Excel). For BSON it optionally renames a single collection. */
  collection: string
  format: TransferFormat
  source: string
  mode: 'insert' | 'upsert'
  dropFirst: boolean
  stopOnError: boolean
  /** Character encoding of a CSV / JSON source (default `auto`). */
  encoding?: TextEncoding
  csv?: { delimiter: string; columnTypes: Record<string, CsvColumnType> }
  xlsx?: { sheet?: string; columnTypes: Record<string, CsvColumnType> }
  bson?: { gzip: boolean; nsInclude?: string[] }
}

export interface FilePreview {
  /** Detected column headers for CSV/Excel. */
  columns: string[]
  /** First rows/documents for preview. */
  sample: Doc[]
  sheets?: string[]
  /** Collections found in a BSON dump folder / archive. */
  namespaces?: string[]
  /** CSV / JSON: the encoding the file was read with (resolved when `auto`). */
  encoding?: Exclude<TextEncoding, 'auto'>
  /** Why that encoding was chosen, when it is a guess worth checking (e.g. not valid UTF-8). */
  encodingNote?: string
}

export interface JobProgress {
  jobId: string
  title: string
  done: number
  total?: number
  message?: string
  state: 'running' | 'done' | 'error' | 'cancelled'
  error?: string
  log?: string[]
}

export interface ToolsStatus {
  found: boolean
  dir?: string
  version?: string
  source?: 'settings' | 'bundled' | 'path' | 'downloaded'
}

export interface Api extends CompareApi, MigrationApi, MaskingApi, AiApi, TasksApi, ServerApi, CopyApi, GridFsApi, SearchApi, ChangeHistoryApi {
  // settings
  getSettings(): AppSettings
  getSession(): SavedSession | null
  saveSession(s: SavedSession): void
  /** Whether saved passwords are protected by the OS keychain (false on Linux without a keyring). */
  secretStorageStatus(): { secure: boolean; backend: string }
  saveSettings(s: Partial<AppSettings>): AppSettings

  // default queries (most specific match wins: collection > database > connection)
  getDefaultQuery(configId: string, db: string, coll: string): DefaultQueryMatch | null
  listDefaultQueries(configId: string, db: string, coll: string): DefaultQueryScope[]
  setDefaultQuery(configId: string, scope: DefaultQueryScope, db: string, coll: string, value: SavedQuery | null): void

  // saved connections
  listConnections(): ConnectionConfig[]
  saveConnection(c: ConnectionConfig): ConnectionConfig
  deleteConnection(id: string): void
  reorderConnections(ids: string[]): void
  exportConnectionsToFile(ids: string[], path: string, o: { format: 'shardwise' | 'uri'; includePasswords: boolean; passphrase?: string }): number
  previewConnectionImport(path: string, passphrase?: string): ConnectionImportPreview
  /** Same, for connection strings / exports copied to the clipboard (read in main). */
  previewConnectionImportFromClipboard(passphrase?: string): ConnectionImportPreview
  importConnections(conns: ConnectionConfig[]): number
  parseUri(uri: string, base?: ConnectionConfig): ConnectionConfig
  buildUri(c: ConnectionConfig, withPassword: boolean): string
  testConnection(c: ConnectionConfig): TestResult

  // live connections
  /** `secrets`: what the user typed for a connection that asks for its password on every connect. */
  connect(id: string, secrets?: PromptedSecrets): ConnectResult
  disconnect(connId: string): void

  // browsing
  listDatabases(connId: string): DatabaseInfo[]
  listCollections(connId: string, db: string): CollectionInfo[]
  estimatedCount(connId: string, db: string, coll: string): number
  createCollection(connId: string, db: string, coll: string): void
  dropCollection(connId: string, db: string, coll: string): void
  renameCollection(connId: string, db: string, coll: string, newName: string): void
  dropDatabase(connId: string, db: string): void

  // querying
  find(connId: string, db: string, coll: string, req: FindRequest): FindResult
  count(connId: string, db: string, coll: string, filter: Doc, collation?: Doc | null): number
  sampleFields(connId: string, db: string, coll: string, size: number): string[]
  getDocument(connId: string, db: string, coll: string, id: unknown): Doc | null

  // profiling
  explain(connId: string, db: string, coll: string, req: FindRequest, verbosity: 'queryPlanner' | 'executionStats' | 'allPlansExecution'): Doc
  profilingStatus(connId: string, db: string): ProfilingStatus
  setProfiling(connId: string, db: string, level: number, slowms: number, sampleRate: number): ProfilingStatus
  readProfile(connId: string, db: string, q: ProfileQuery): Doc[]
  clearProfile(connId: string, db: string): void
  currentOps(connId: string, opts: { allUsers: boolean; idle: boolean }): Doc[]
  killOp(connId: string, opid: unknown): void
  listIndexes(connId: string, db: string, coll: string): IndexInfo[]
  createIndex(connId: string, db: string, coll: string, keys: Doc, options: Doc): string

  // playground
  playgroundRun(req: PlaygroundRunRequest): PlaygroundResult
  playgroundCancel(runId: string): void
  readTextFile(path: string): string
  writeTextFile(path: string, text: string): void

  // aggregation (phase 2)
  aggregate(connId: string, db: string, coll: string, pipeline: Doc[], opts: AggregateOptions): AggregateResult
  /**
   * Schema of a random sample, analysed in the main process: only the report reaches the window (a sample of
   * large documents is tens of MB, slow to send and decode).
   */
  analyzeSample(connId: string, db: string, coll: string, size: number, opts?: SchemaOptions): SchemaReport
  /** Newest GitHub release compared with this version (nothing is downloaded). */
  checkForUpdates(): UpdateInfo
  explainAggregate(connId: string, db: string, coll: string, pipeline: Doc[], opts: AggregateOptions, verbosity: 'queryPlanner' | 'executionStats' | 'allPlansExecution'): Doc
  createView(connId: string, db: string, name: string, viewOn: string, pipeline: Doc[]): void

  // index manager (phase 2)
  indexDetails(connId: string, db: string, coll: string): IndexDetail[]
  dropIndex(connId: string, db: string, coll: string, name: string): void
  setIndexHidden(connId: string, db: string, coll: string, name: string, hidden: boolean): void

  // shell sessions (phase 2) — evaluation output streams via 'shell:log', approvals via 'shell:confirm'
  shellOpen(connId: string, db: string): ShellOpenResult
  shellEval(sessionId: string, code: string, timeoutMS: number, opts?: ShellEvalOptions): PlaygroundResult
  shellInterrupt(sessionId: string): void
  shellClose(sessionId: string): void
  /** Answer to a 'shell:confirm' request. */
  shellConfirmReply(sessionId: string, requestId: string, approved: boolean): void

  // external mongosh
  /** Finds mongosh (`path` from Settings, else PATH and the usual install folders) and reads its version. */
  mongoshStatus(path: string): MongoshStatus
  /** Opens mongosh in a terminal window, connected to this connection (and database). */
  openInMongosh(connId: string, db?: string): MongoshLaunch

  // query history & saved queries (phase 2)
  addHistory(e: Omit<HistoryEntry, 'id' | 'at'>): void
  listHistory(f: HistoryFilter): HistoryEntry[]
  deleteHistory(ids: string[]): void
  clearHistory(f: HistoryFilter): number
  listSavedQueries(): SavedQueryEntry[]
  saveQuery(q: Omit<SavedQueryEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): SavedQueryEntry
  deleteSavedQuery(id: string): void

  // users & roles (phase 3)
  listUsers(connId: string, db: string): UserInfo[]
  listRoles(connId: string, db: string, showBuiltin: boolean): RoleInfo[]
  createUser(connId: string, db: string, user: string, password: string, roles: RoleRef[], customData?: Doc): void
  updateUser(connId: string, db: string, user: string, changes: { password?: string; roles?: RoleRef[]; customData?: Doc }): void
  dropUser(connId: string, db: string, user: string): void
  createRole(connId: string, db: string, role: string, privileges: Privilege[], roles: RoleRef[]): void
  updateRole(connId: string, db: string, role: string, privileges: Privilege[], roles: RoleRef[]): void
  dropRole(connId: string, db: string, role: string): void

  // editing
  insertDocuments(connId: string, db: string, coll: string, docs: Doc[]): number
  replaceDocument(connId: string, db: string, coll: string, id: unknown, doc: Doc): WriteResult
  updateField(connId: string, db: string, coll: string, scope: DocScope, op: FieldOp, opts?: WriteOptions): WriteResult
  deleteDocuments(connId: string, db: string, coll: string, scope: DocScope, opts?: WriteOptions): number
  updateDocuments(connId: string, db: string, coll: string, req: UpdateRequest, opts?: WriteOptions): UpdateResult

  // native dialogs / shell
  openFile(o: FileDialogOptions): string[] | null
  saveFile(o: FileDialogOptions): string | null
  copyText(text: string): void
  /** App version and where its third-party notices live. */
  appInfo(): { version: string; electron: string; node: string; notices: string }
  systemDateFormat(): SystemDateFormat
  openThirdPartyNotices(): void
  revealPath(path: string): void

  // import / export
  toolsStatus(): ToolsStatus
  downloadTools(): string
  previewImport(format: TransferFormat, source: string, opts?: { delimiter?: string; sheet?: string; encoding?: TextEncoding }): FilePreview
  startExport(req: ExportRequest): string
  startImport(req: ImportRequest): string
  cancelJob(jobId: string): void
}

export type ApiMethod = keyof Api

export type ApiResponse = { ok: true; value: string } | { ok: false; error: string }

/** Push events from main to renderer. */
export interface ApiEvents extends AiEvents, TasksEvents, SearchEvents {
  'job:progress': JobProgress
  'connection:lost': { connId: string; error: string }
  'playground:log': { runId: string; log: PlaygroundLog }
  'shell:log': { sessionId: string; log: PlaygroundLog }
  'shell:confirm': ShellConfirmRequest
}

export interface MongoshStatus {
  found: boolean
  path?: string
  version?: string
  /** settings = the configured path, path = found on PATH, common = a usual install folder. */
  source?: 'settings' | 'path' | 'common'
  /** Why the configured path or the version check failed. */
  error?: string
}

export interface MongoshLaunch {
  /** The terminal it was started in, e.g. "Windows Terminal". */
  terminal: string
  /** Things the user should know (e.g. the SSH port forward stays open while the connection is open). */
  notes: string[]
}
