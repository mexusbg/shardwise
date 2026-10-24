import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import type { ConnectionConfig } from '@shared/connection'
import { DEFAULT_MCP_SETTINGS, MCP_MAX_DOCS_LIMIT } from '@shared/mcpApi'
import type { ApprovalRequest, McpApi, McpEvents, McpLogEntry, McpSettings, McpStatus } from '@shared/mcpApi'
import type { ConnectionManager } from '../mongo/manager'
import type { SecretCodec } from '../store'
import { McpBridge } from './server'
import type { ToolContext } from './tools'

interface McpFile extends McpSettings {
  /** Encrypted with the app's secret codec. */
  token?: string
}

const LOG_SIZE = 200

export const newToken = (): string => randomBytes(32).toString('base64url')

function clean(s: McpSettings): McpSettings {
  const port = Math.trunc(Number(s.port))
  const maxDocs = Math.trunc(Number(s.maxDocs))
  return {
    enabled: !!s.enabled,
    port: port >= 1 && port <= 65535 ? port : DEFAULT_MCP_SETTINGS.port,
    allowWrites: !!s.allowWrites,
    maxDocs: maxDocs >= 1 ? Math.min(maxDocs, MCP_MAX_DOCS_LIMIT) : DEFAULT_MCP_SETTINGS.maxDocs,
    autoConnect: !!s.autoConnect
  }
}

/** Settings (`<userData>/mcp.json`), token, approval queue and activity log around the MCP bridge. */
export class McpService {
  private settings: McpSettings = { ...DEFAULT_MCP_SETTINGS }
  private token = ''
  private error: string | undefined
  private entries: McpLogEntry[] = []
  private pending = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()
  private bridge: McpBridge
  private loaded: Promise<void> | null = null
  private file: string

  constructor(
    userData: string,
    private codec: SecretCodec,
    mgr: ConnectionManager,
    getConfigs: () => Promise<ConnectionConfig[]>,
    private emit: <K extends keyof McpEvents>(channel: K, payload: McpEvents[K]) => void,
    recorder?: ToolContext['recorder']
  ) {
    this.file = join(userData, 'mcp.json')
    this.bridge = new McpBridge(mgr, getConfigs, (r) => this.requestApproval(r), (e) => this.addLog(e), recorder)
  }

  /** Loads the settings and starts the server when enabled. Call once at startup. */
  init(): Promise<void> {
    this.loaded ??= this.load().then(() => this.apply())
    return this.loaded
  }

  private async load(): Promise<void> {
    let raw: Partial<McpFile> = {}
    try {
      raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<McpFile>
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('MCP settings unreadable, using defaults:', (e as Error).message)
    }
    this.settings = clean({ ...DEFAULT_MCP_SETTINGS, ...raw })
    if (raw.token) this.token = await this.codec.decrypt(raw.token).catch(() => '')
    if (!this.token) {
      this.token = newToken()
      // A failed save (locked keyring, read-only profile) must not leave the service unusable: the token is
      // saved again with the next settings change.
      await this.persist().catch((e) => console.warn('Could not save the MCP token:', (e as Error)?.message ?? e))
    }
  }

  private async persist(): Promise<void> {
    const data: McpFile = { ...this.settings, token: await this.codec.encrypt(this.token) }
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  private async apply(): Promise<void> {
    if (!this.settings.enabled) {
      this.denyPending()
      await this.bridge.stop()
      this.error = undefined
      return
    }
    try {
      await this.bridge.start({ ...this.settings, token: this.token })
      this.error = undefined
    } catch (e) {
      await this.bridge.stop().catch(() => {})
      const err = e as NodeJS.ErrnoException
      this.error = err.code === 'EADDRINUSE' ? `Port ${this.settings.port} is already in use` : err.message || String(e)
    }
  }

  async status(): Promise<McpStatus> {
    await this.init()
    const b = this.bridge.status()
    return { settings: { ...this.settings }, token: this.token, error: this.error, ...b }
  }

  async configure(patch: Partial<McpSettings>): Promise<McpStatus> {
    await this.init()
    this.settings = clean({ ...this.settings, ...patch })
    await this.persist()
    await this.apply()
    return this.status()
  }

  async regenerateToken(): Promise<McpStatus> {
    await this.init()
    this.token = newToken()
    await this.persist()
    await this.apply()
    return this.status()
  }

  log(): McpLogEntry[] {
    return [...this.entries].reverse()
  }

  clearLog(): void {
    this.entries = []
  }

  respond(id: string, approved: boolean): void {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve(approved)
  }

  async stop(): Promise<void> {
    this.denyPending()
    await this.bridge.stop()
  }

  private denyPending(): void {
    for (const id of [...this.pending.keys()]) this.respond(id, false)
  }

  private addLog(e: McpLogEntry): void {
    this.entries.push(e)
    if (this.entries.length > LOG_SIZE) this.entries.splice(0, this.entries.length - LOG_SIZE)
    this.emit('mcp:log', e)
  }

  private requestApproval(r: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.respond(r.id, false), Math.max(0, r.expiresAt - Date.now()) + 1000)
      this.pending.set(r.id, { resolve, timer })
      this.emit('mcp:approval', r)
    })
  }
}

type Handlers = { [K in keyof McpApi]: (...args: Parameters<McpApi[K]>) => Promise<ReturnType<McpApi[K]>> | ReturnType<McpApi[K]> }

export function mcpHandlers(s: McpService): Handlers {
  return {
    mcpStatus: () => s.status(),
    mcpConfigure: (settings) => s.configure(settings),
    mcpRegenerateToken: () => s.regenerateToken(),
    mcpLog: () => s.log(),
    mcpClearLog: () => s.clearLog(),
    mcpRespondApproval: (id, approved) => s.respond(id, approved)
  }
}
