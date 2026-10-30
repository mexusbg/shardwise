import { app, BrowserWindow, clipboard, dialog, shell } from 'electron'
import { join } from 'path'
import type { OpenDialogOptions } from 'electron'
import { buildUri, clearAskedSecrets, effectiveSetting, parseUri, withSecrets } from '@shared/connection'
import type { Api } from '@shared/api'
import { analyzeSchema } from '@shared/schema'
import { checkLatestRelease, repoFromPackage } from '@shared/updates'
import { appFetch } from './net/fetch'
import type { ConnectionConfig } from '@shared/connection'
import { ConnectionManager } from './mongo/manager'
import * as ops from './mongo/ops'
import { Store } from './store'
import { promises as fs, readFileSync } from 'fs'
import { secretStorageStatus } from './secretStorage'
import { systemDateFormat } from './systemDateFormat'
import { exportConnections, parseConnectionImport } from './connectionTransfer'
import { decodeText } from './transfer/encoding'
import { Transfers } from './transfer/jobs'
import type { Playground } from './playground/runner'
import type { ShellSessions } from './playground/shellSessions'
import type { QueryLibrary } from './history'
import * as aggregation from './mongo/aggregation'
import * as indexes from './mongo/indexes'
import * as users from './mongo/users'
import { compareHandlers } from './compare/compare'
import type { Comparisons } from './compare/compare'
import { migrationHandlers } from './sql/migrations'
import type { Migrations } from './sql/migrations'
import { maskingHandlers } from './masking/masking'
import type { Masking } from './masking/masking'
import { aiHandlers } from './ai'
import type { AiService } from './ai'
import { tasksHandlers } from './tasks/service'
import { serverHandlers } from './server/handlers'
import { changeHistoryHandlers } from './changes/handlers'
import type { ChangeHistory } from './changes/store'
import { copyHandlers } from './copy/copy'
import type { Copies } from './copy/copy'
import { gridFsHandlers } from './gridfs/gridfs'
import type { GridFs } from './gridfs/gridfs'
import { searchHandlers } from './search/search'
import type { Searches } from './search/search'
import type { TaskService } from './tasks/service'
import { assertJobWritable } from './mongo/readOnly'
import { MongoshLauncher } from './mongosh'

type Handlers = { [K in keyof Api]: (...args: Parameters<Api[K]>) => Promise<ReturnType<Api[K]>> | ReturnType<Api[K]> }

const noticesPath = (): string => (app.isPackaged ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.md') : join(app.getAppPath(), 'THIRD_PARTY_NOTICES.md'))

/** Implementation of every renderer-callable method. */
/** GitHub repository of the update check: `repository` in package.json (none until the repository is public). */
let repoCache: ReturnType<typeof repoFromPackage> | undefined
function updateRepo(): ReturnType<typeof repoFromPackage> {
  if (repoCache === undefined) {
    try {
      repoCache = repoFromPackage(JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).repository)
    } catch {
      repoCache = null
    }
  }
  return repoCache
}

export function createApi(
  store: Store,
  mgr: ConnectionManager,
  transfers: Transfers,
  comparisons: Comparisons,
  migrations: Migrations,
  masking: Masking,
  playground: Playground,
  shells: ShellSessions,
  library: QueryLibrary,
  ai: AiService,
  tasks: TaskService,
  copies: Copies,
  gridfs: GridFs,
  searches: Searches,
  changes: ChangeHistory,
  win: () => BrowserWindow | null
): Handlers {
  /** Query time limit: the connection's override, else the preference. */
  const timeout = async (connId: string): Promise<number> => effectiveSetting(mgr.config(connId), 'queryTimeoutMS', (await store.getSettings()).queryTimeoutMS)
  const configOf = (connId: string): ConnectionConfig => mgr.config(connId)
  const masks = maskingHandlers(masking)
  const migrationsApi = migrationHandlers(migrations)
  const files = gridFsHandlers(gridfs)
  const writable = (connId: string, action: string): void => mgr.assertWritable(connId, action)
  const mongosh = new MongoshLauncher(mgr, async () => (await store.getSettings()).mongoshPath)

  return {
    getSettings: () => store.getSettings(),
    secretStorageStatus: () => secretStorageStatus(),
    saveSettings: async (s) => {
      const saved = await store.saveSettings(s)
      library.setHistoryLimit(saved.historyLimit)
      return saved
    },
    getSession: () => store.getSession(),
    saveSession: (s) => store.saveSession(s),

    getDefaultQuery: (configId, db, coll) => store.getDefaultQuery(configId, db, coll),
    listDefaultQueries: (configId, db, coll) => store.listDefaultQueries(configId, db, coll),
    setDefaultQuery: (configId, scope, db, coll, value) => store.setDefaultQuery(configId, scope, db, coll, value),

    listConnections: () => store.listConnections(),
    saveConnection: async (c) => {
      // Secrets asked for at connect time are never stored.
      const saved = await store.saveConnection(clearAskedSecrets(c))
      mgr.applySaved(saved)
      return saved
    },
    deleteConnection: (id) => store.deleteConnection(id),
    reorderConnections: (ids) => store.reorderConnections(ids),
    exportConnectionsToFile: async (ids, path, o) => {
      const all = await store.listConnections()
      const chosen = ids.length ? all.filter((c) => ids.includes(c.id)) : all
      await fs.writeFile(path, exportConnections(chosen, o), 'utf8')
      return chosen.length
    },
    // Exports can be UTF-8, UTF-16 or the ANSI code page (Studio 3T writes its date comment that way).
    previewConnectionImportFromClipboard: async (passphrase) => parseConnectionImport(await clipboard.readText(), passphrase),
    previewConnectionImport: async (path, passphrase) => parseConnectionImport(decodeText(await fs.readFile(path)).text, passphrase),
    importConnections: async (conns) => {
      for (const c of conns) await store.saveConnection(clearAskedSecrets({ ...c, id: '' }))
      return conns.length
    },
    parseUri: (uri, base) => parseUri(uri, base),
    buildUri: (c, withPassword) => buildUri(c, withPassword),
    testConnection: (c) => mgr.test(c),

    connect: async (id, secrets) => mgr.connect(withSecrets(await store.getConnection(id), secrets)),
    disconnect: (connId) => mgr.disconnect(connId),

    listDatabases: (connId) => ops.listDatabases(mgr.get(connId), mgr.config(connId)),
    listCollections: (connId, db) => ops.listCollections(mgr.get(connId), db),
    estimatedCount: (connId, db, coll) => ops.estimatedCount(mgr.get(connId), db, coll),
    createCollection: (connId, db, coll) => ops.createCollection(mgr.get(connId), db, coll),
    dropCollection: (connId, db, coll) => ops.dropCollection(mgr.get(connId), db, coll),
    renameCollection: (connId, db, coll, n) => ops.renameCollection(mgr.get(connId), db, coll, n),
    dropDatabase: (connId, db) => ops.dropDatabase(mgr.get(connId), db),

    find: async (connId, db, coll, req) => ops.find(mgr.get(connId), db, coll, req, await timeout(connId)),
    count: async (connId, db, coll, filter, collation) => ops.count(mgr.get(connId), db, coll, filter, await timeout(connId), collation),
    sampleFields: (connId, db, coll, size) => ops.sampleFields(mgr.get(connId), db, coll, size),
    getDocument: (connId, db, coll, id) => ops.getDocument(mgr.get(connId), db, coll, id),

    explain: (connId, db, coll, req, verbosity) => ops.explain(mgr.get(connId), db, coll, req, verbosity),
    profilingStatus: (connId, db) => ops.profilingStatus(mgr.get(connId), db),
    setProfiling: (connId, db, level, slowms, sampleRate) => ops.setProfiling(mgr.get(connId), db, level, slowms, sampleRate),
    readProfile: (connId, db, q) => ops.readProfile(mgr.get(connId), db, q),
    clearProfile: (connId, db) => ops.clearProfile(mgr.get(connId), db),
    currentOps: (connId, opts) => ops.currentOps(mgr.get(connId), opts),
    killOp: (connId, opid) => ops.killOp(mgr.get(connId), opid),
    listIndexes: (connId, db, coll) => ops.listIndexes(mgr.get(connId), db, coll),
    createIndex: (connId, db, coll, keys, options) => ops.createIndex(mgr.get(connId), db, coll, keys, options),

    aggregate: async (connId, db, coll, pipeline, opts) => aggregation.aggregate(mgr.get(connId), db, coll, pipeline, { maxTimeMS: (await timeout(connId)) || undefined, ...opts }),
    checkForUpdates: () => checkLatestRelease(updateRepo(), app.getVersion(), appFetch, { platform: process.platform, arch: process.arch, appImage: !!process.env['APPIMAGE'] }),
    analyzeSample: async (connId, db, coll, size, opts) => {
      const res = await aggregation.aggregate(mgr.get(connId), db, coll, [{ $sample: { size } }], { maxTimeMS: (await timeout(connId)) || undefined })
      return analyzeSchema(res.docs, opts)
    },
    explainAggregate: (connId, db, coll, pipeline, opts, verbosity) => aggregation.explainAggregate(mgr.get(connId), db, coll, pipeline, opts, verbosity),
    createView: (connId, db, name, viewOn, pipeline) => aggregation.createView(mgr.get(connId), db, name, viewOn, pipeline),

    indexDetails: (connId, db, coll) => indexes.indexDetails(mgr.get(connId), db, coll),
    dropIndex: (connId, db, coll, name) => indexes.dropIndex(mgr.get(connId), db, coll, name),
    setIndexHidden: (connId, db, coll, name, hidden) => indexes.setIndexHidden(mgr.get(connId), db, coll, name, hidden),


    listUsers: (connId, db) => users.listUsers(mgr.get(connId), db),
    listRoles: (connId, db, showBuiltin) => users.listRoles(mgr.get(connId), db, showBuiltin),
    createUser: (connId, db, user, password, roles, customData) => users.createUser(mgr.get(connId), db, user, password, roles, customData),
    updateUser: (connId, db, user, changes) => users.updateUser(mgr.get(connId), db, user, changes),
    dropUser: (connId, db, user) => users.dropUser(mgr.get(connId), db, user),
    createRole: (connId, db, role, privileges, roles) => users.createRole(mgr.get(connId), db, role, privileges, roles),
    updateRole: (connId, db, role, privileges, roles) => users.updateRole(mgr.get(connId), db, role, privileges, roles),
    dropRole: (connId, db, role) => users.dropRole(mgr.get(connId), db, role),

    shellOpen: async (connId, db) => {
      const sessionId = await shells.open(connId, db)
      return { sessionId, startup: shells.takeStartup(sessionId) }
    },
    shellEval: (sessionId, code, timeoutMS, opts) => shells.evaluate(sessionId, code, timeoutMS, opts),
    shellInterrupt: (sessionId) => shells.interrupt(sessionId),
    shellClose: (sessionId) => shells.close(sessionId),
    shellConfirmReply: (sessionId, requestId, approved) => shells.confirmReply(sessionId, requestId, approved),
    mongoshStatus: (path) => mongosh.status(path),
    openInMongosh: (connId, db) => mongosh.open(connId, db),

    addHistory: (e) => library.addHistory(e),
    listHistory: (f) => library.listHistory(f),
    deleteHistory: (ids) => library.deleteHistory(ids),
    clearHistory: (f) => library.clearHistory(f),
    listSavedQueries: () => library.listSaved(),
    saveQuery: (q) => library.save(q),
    deleteSavedQuery: (id) => library.deleteSaved(id),

    playgroundRun: (req) => playground.run(req),
    playgroundCancel: (runId) => playground.cancel(runId),
    readTextFile: (path) => fs.readFile(path, 'utf8'),
    writeTextFile: (path, text) => fs.writeFile(path, text, 'utf8'),

    insertDocuments: (connId, db, coll, docs) => ops.insertDocuments(mgr.get(connId), db, coll, docs, changes.forConn(connId)),
    replaceDocument: (connId, db, coll, id, doc) => ops.replaceDocument(mgr.get(connId), db, coll, id, doc, changes.forConn(connId)),
    updateField: (connId, db, coll, scope, op, opts) => ops.updateField(mgr.get(connId), db, coll, scope, op, opts, changes.forConn(connId)),
    updateDocuments: (connId, db, coll, req, opts) => ops.updateDocuments(mgr.get(connId), db, coll, req, opts, changes.forConn(connId)),
    deleteDocuments: (connId, db, coll, scope, opts) => ops.deleteDocuments(mgr.get(connId), db, coll, scope, opts, changes.forConn(connId)),

    openFile: async (o) => {
      const props: OpenDialogOptions['properties'] = [o.directory ? 'openDirectory' : 'openFile']
      if (o.multi) props.push('multiSelections')
      if (o.directory) props.push('createDirectory')
      const w = win()
      const opts: OpenDialogOptions = { title: o.title, defaultPath: o.defaultPath, filters: o.filters, properties: props }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : r.filePaths
    },
    saveFile: async (o) => {
      const w = win()
      const opts = { title: o.title, defaultPath: o.defaultPath, filters: o.filters }
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
      return r.canceled || !r.filePath ? null : r.filePath
    },
    copyText: (text) => clipboard.writeText(text),
    systemDateFormat: () => systemDateFormat(),
    appInfo: () => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, notices: noticesPath() }),
    openThirdPartyNotices: async () => {
      const err = await shell.openPath(noticesPath())
      if (err) throw new Error(err)
    },
    revealPath: (p) => shell.showItemInFolder(p),

    toolsStatus: () => transfers.toolsStatus(),
    downloadTools: () => transfers.downloadTools(),
    previewImport: (format, source, opts) => transfers.preview(format, source, opts),
    startExport: (req) => transfers.startExport(req),
    startImport: (req) => {
      // mongorestore talks to the server itself, so this check is what stops BSON imports.
      assertJobWritable({ kind: 'import', request: req }, configOf)
      return transfers.startImport(req)
    },
    cancelJob: (jobId) => {
      transfers.cancel(jobId)
      comparisons.cancel(jobId)
      migrations.cancel(jobId)
      masking.cancel(jobId)
      copies.cancel(jobId)
      gridfs.cancel(jobId)
    },
    ...serverHandlers(mgr),
    ...compareHandlers(comparisons),
    ...migrationsApi,
    migrationStartFromSql: (req) => {
      assertJobWritable({ kind: 'sqlImport', request: req }, configOf)
      return migrationsApi.migrationStartFromSql(req)
    },
    ...masks,
    maskingStart: (req) => {
      assertJobWritable({ kind: 'mask', request: req }, configOf)
      return masks.maskingStart(req)
    },
    reschemaStart: (req, o) => {
      assertJobWritable({ kind: 'reschema', request: req }, configOf)
      return masks.reschemaStart(req, o)
    },
    ...aiHandlers(ai),
    ...tasksHandlers(tasks),
    ...copyHandlers(copies),
    ...files,
    gridfsUpload: (connId, ...a) => {
      writable(connId, 'uploading GridFS files')
      return files.gridfsUpload(connId, ...a)
    },
    gridfsDelete: (connId, ...a) => {
      writable(connId, 'deleting GridFS files')
      return files.gridfsDelete(connId, ...a)
    },
    gridfsRename: (connId, ...a) => {
      writable(connId, 'renaming a GridFS file')
      return files.gridfsRename(connId, ...a)
    },
    gridfsSetMetadata: (connId, ...a) => {
      writable(connId, 'editing GridFS metadata')
      return files.gridfsSetMetadata(connId, ...a)
    },
    ...searchHandlers(searches),
    ...changeHistoryHandlers(changes)
  }
}
