import { existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, ipcMain, Menu, Notification, shell } from 'electron'
import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { ApiEvents, ApiMethod, ApiResponse, JobProgress } from '@shared/api'
import { createApi } from './api'
import { ConnectionManager } from './mongo/manager'
import { Store } from './store'
import { secretCodec } from './secretStorage'
import { Transfers } from './transfer/jobs'
import { Playground } from './playground/runner'
import { ShellSessions } from './playground/shellSessions'
import { loadStartupScripts } from './playground/startup'
import { SHELL_STARTUP_TIMEOUT_MS } from '@shared/shellOptions'
import { Comparisons } from './compare/compare'
import { Migrations } from './sql/migrations'
import { Masking } from './masking/masking'
import { AiService, AiSettingsStore } from './ai'
import { McpService, mcpHandlers } from './mcp/service'
import { flushSync as flushHistory, QueryLibrary } from './history'
import { loadWindowState, trackWindowState } from './windowState'
import { migrateLegacyProfile } from './legacyProfile'
import { JobWatcher } from './tasks/jobWatcher'
import { TaskService } from './tasks/service'
import { Copies } from './copy/copy'
import { GridFs } from './gridfs/gridfs'
import { Searches } from './search/search'
import { ChangeHistory } from './changes/store'
import { appFetch } from './net/fetch'
import { applySessionProxy, installProxySupport, proxyHandlers } from './net/session'
import { setToolsFetch } from './transfer/toolsDownload'

// Lets tests and portable setups use an isolated profile; must run before anything reads userData.
if (process.env.SHARDWISE_USER_DATA) app.setPath('userData', process.env.SHARDWISE_USER_DATA)
// A second instance only focuses the first one (see 'second-instance'); quit before any service opens files.
if (!app.requestSingleInstanceLock()) process.exit(0)
if (!process.env.SHARDWISE_USER_DATA) {
  try {
    migrateLegacyProfile(app.getPath('appData'), app.getPath('userData'), Store.path(app.getPath('userData')))
  } catch (e) {
    console.error('Could not migrate the MongoGuru profile:', e)
  }
}

let mainWindow: BrowserWindow | null = null

function send<K extends keyof ApiEvents>(channel: K, payload: ApiEvents[K]): void {
  mainWindow?.webContents.send('event', channel, encodeIpc(payload))
}

// Windows shows this id in notifications (scheduled task results); must match electron-builder's appId.
if (process.platform === 'win32') app.setAppUserModelId('net.fidweb.shardwise')

/** Every job progress event also feeds the watcher that scheduled tasks wait on. */
const jobWatcher = new JobWatcher()
const emitJob = (p: JobProgress): void => {
  jobWatcher.feed(p)
  send('job:progress', p)
}

const store = new Store(Store.path(app.getPath('userData')), secretCodec)
const manager = new ConnectionManager((connId, error) => send('connection:lost', { connId, error }))
const changes = new ChangeHistory(app.getPath('userData'), manager)
/** Folder name used by scripts/fetch-tools.ts and electron-builder's `${os}-${arch}`. */
const toolsTarget = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}`
const bundledTools = app.isPackaged ? join(process.resourcesPath, 'tools') : join(app.getAppPath(), 'resources', 'tools', toolsTarget)
const transfers = new Transfers(manager, store, app.getPath('userData'), emitJob, bundledTools, changes)

/** Shell startup scripts of a connection (Settings → Shell & Playground, then the connection's own). */
const startupPlan = async (connId: string) => {
  const s = await store.getSettings()
  return { s, plan: await loadStartupScripts(s, manager.config(connId)) }
}
const playground = new Playground(manager, (runId, log) => send('playground:log', { runId, log }), undefined, async (connId) => {
  const { s, plan } = await startupPlan(connId)
  return s.playgroundRunStartup ? plan : null
})

const comparisons = new Comparisons(manager, emitJob, changes)
const migrations = new Migrations(manager, secretCodec, app.getPath('userData'), emitJob)
const masking = new Masking(manager, emitJob, changes)
const copies = new Copies(manager, emitJob)
const gridfs = new GridFs(manager, emitJob)
const searches = new Searches(manager, (e) => send('search:event', e))
const shells = new ShellSessions(manager, (sessionId, log) => send('shell:log', { sessionId, log }), undefined, {
  startup: async (connId) => {
    const { s, plan } = await startupPlan(connId)
    return { ...plan, timeoutMS: s.shellTimeoutMS || SHELL_STARTUP_TIMEOUT_MS }
  },
  onConfirm: (req) => {
    send('shell:confirm', req)
    mainWindow?.flashFrame(true)
  }
})
const library = new QueryLibrary(app.getPath('userData'))
void store.getSettings().then((s) => library.setHistoryLimit(s.historyLimit), () => {})
const ai = new AiService({
  secrets: store,
  mongo: (connId) => manager.get(connId),
  settingsFile: AiSettingsStore.path(app.getPath('userData')),
  emit: (e) => send('ai:stream', e),
  fetch: appFetch
})
const tasks = new TaskService({
  userData: app.getPath('userData'),
  connections: manager,
  getConnection: (id) => store.getConnection(id),
  runners: { transfers, comparisons, migrations, masking },
  watcher: jobWatcher,
  emit: (taskId) => send('tasks:changed', { taskId }),
  notify: (n) => {
    if (!Notification.isSupported()) return
    const note = new Notification({ title: n.title, body: n.body })
    note.on('click', () => {
      mainWindow?.show()
      mainWindow?.focus()
    })
    note.show()
  }
})
const mcp = new McpService(app.getPath('userData'), secretCodec, manager, () => store.listConnections(), (channel, payload) => {
  mainWindow?.webContents.send('event', channel, encodeIpc(payload))
  // Draw attention to a pending write approval.
  if (channel === 'mcp:approval') mainWindow?.flashFrame(true)
}, (cfg) => changes.forConfig(cfg))

function registerIpc(): void {
  const api = {
    ...createApi(store, manager, transfers, comparisons, migrations, masking, playground, shells, library, ai, tasks, copies, gridfs, searches, changes, () => mainWindow),
    ...mcpHandlers(mcp),
    ...proxyHandlers()
  } as unknown as Record<ApiMethod, (...args: unknown[]) => unknown>
  ipcMain.handle('api', async (_e, method: ApiMethod, payload: string): Promise<ApiResponse> => {
    try {
      const fn = api[method]
      if (!fn) throw new Error(`Unknown method ${method}`)
      const args = decodeIpc(payload) as unknown[]
      const value = await fn(...args)
      return { ok: true, value: encodeIpc(value) }
    } catch (e) {
      return { ok: false, error: (e as Error).message || String(e) }
    }
  })
}

/** App icon file: shipped next to the app when packaged (electron-builder extraResources), build/ in development. */
function appIcon(): string | undefined {
  const file = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(file) ? file : undefined
}

function createWindow(): void {
  const state = loadWindowState(app.getPath('userData'))
  mainWindow = new BrowserWindow({
    ...state.bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Shardwise',
    // Without it the window (and the taskbar when running from source, and Linux everywhere) shows Electron's icon.
    icon: appIcon(),
    backgroundColor: '#1e1f22',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (state.maximized) mainWindow.maximize()
  trackWindowState(mainWindow, app.getPath('userData'))
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})
app.whenReady().then(() => {
  // Proxy (Settings → Network & tools) before anything connects; re-applied on every settings save.
  installProxySupport(store)
  store.onSettingsSaved((s) => void applySessionProxy(s.proxy).catch((e) => console.error('Could not apply the proxy settings:', e)))
  setToolsFetch(appFetch)
  registerIpc()
  // safeStorage (MCP token) needs the app to be ready.
  mcp.init().catch((e) => console.error('Could not start the MCP server:', e))
  tasks.start().catch((e) => console.error('Could not start the task scheduler:', e))
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  void manager.closeAll()
  transfers.cleanupSync()
  playground.cancelAll()
  shells.closeAll()
  comparisons.cancelAll()
  void migrations.closeAll()
  masking.cancelAll()
  copies.cancelAll()
  gridfs.cancelAll()
  searches.cancelAll()
  ai.dispose()
  tasks.stop()
  void mcp.stop()
  flushHistory()
  changes.close()
})
app.on('will-quit', () => transfers.cleanupSync())
