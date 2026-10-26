import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { MongoClient } from 'mongodb'
import { connectionHostLabel } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import type { ApprovalRequest, McpLogEntry } from '@shared/mcpApi'
import type { ConnectionManager } from '../mongo/manager'
import { registerTools } from './tools'
import type { Decision, ExposedConnection, ToolContext, WriteRequest } from './tools'

export interface McpStartOptions {
  /** 0 picks a free port. */
  port: number
  token: string
  allowWrites: boolean
  maxDocs: number
  autoConnect: boolean
  /** Deny write approvals after this long (default 60 s). */
  approvalTimeoutMs?: number
}

export interface McpBridgeStatus {
  running: boolean
  port?: number
  url?: string
  sessions: number
  clients: string[]
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  writeTools: RegisteredTool[]
  lastSeen: number
}

const MAX_SESSIONS = 32
const MAX_BODY = 8 * 1024 * 1024
/** Reported to MCP clients; kept equal to package.json by tests/mcp.test.ts. */
export const MCP_SERVER_VERSION = '0.2.6'

const INSTRUCTIONS =
  'Shardwise gives read access to the MongoDB connections its user chose to expose. Start with list_connections, then list_databases / list_collections, and call collection_schema before writing queries. find and aggregate results are capped; prefer projections, filters and $group over fetching many documents. Write tools exist only when the user allowed writes, and every write must be approved by the user in Shardwise.'

const hash = (s: string): Buffer => createHash('sha256').update(s).digest()

function jsonError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Local MCP server: Streamable HTTP at `http://127.0.0.1:<port>/mcp`, stateful sessions (one McpServer per
 * `Mcp-Session-Id`, so client names from `initialize` show in the activity log). Every request needs the
 * bearer token; Host / Origin must be loopback (DNS-rebinding protection).
 */
export class McpBridge {
  private http: Server | null = null
  private sessions = new Map<string, Session>()
  private opts: McpStartOptions | null = null
  private port = 0
  /** Connections the bridge opened itself (auto-connect), by config id. */
  private owned = new Map<string, Promise<string>>()

  constructor(
    private mgr: ConnectionManager,
    private getConfigs: () => Promise<ConnectionConfig[]>,
    private approveFn: (req: ApprovalRequest) => Promise<boolean>,
    private log: (e: McpLogEntry) => void,
    private recorder?: ToolContext['recorder']
  ) {}

  private seq = 0

  /** Starts listening, or applies new options in place when already listening on the same port. */
  async start(opts: McpStartOptions): Promise<McpBridgeStatus> {
    if (this.http && this.opts && (opts.port === this.opts.port || opts.port === 0 || opts.port === this.port)) {
      const writesChanged = opts.allowWrites !== this.opts.allowWrites
      if (this.opts.autoConnect && !opts.autoConnect) await this.releaseOwned()
      this.opts = { ...opts }
      if (writesChanged) for (const s of this.sessions.values()) this.applyWrites(s)
      return this.status()
    }
    await this.stop()
    const http = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e)
      http.once('error', onError)
      http.listen(opts.port, '127.0.0.1', () => {
        http.off('error', onError)
        resolve()
      })
    })
    http.on('error', () => {})
    this.http = http
    this.port = (http.address() as AddressInfo).port
    this.opts = { ...opts }
    return this.status()
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = null
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((s) => s.transport.close().catch(() => {})))
    if (http) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
    }
    await this.releaseOwned()
    this.port = 0
  }

  status(): McpBridgeStatus {
    if (!this.http) return { running: false, sessions: 0, clients: [] }
    const clients = [...this.sessions.values()].map((s) => clientLabel(s.server)).filter((c): c is string => !!c)
    return { running: true, port: this.port, url: `http://127.0.0.1:${this.port}/mcp`, sessions: this.sessions.size, clients: [...new Set(clients)] }
  }

  private async releaseOwned(): Promise<void> {
    const owned = [...this.owned.values()]
    this.owned.clear()
    await Promise.all(owned.map(async (p) => this.mgr.disconnect(await p.catch(() => '')).catch(() => {})))
  }

  private allowedHosts(): string[] {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
  }

  private allowedOrigins(): string[] {
    return [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]
  }

  private authorized(req: IncomingMessage): boolean {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')
    if (!m || !this.opts?.token) return false
    return timingSafeEqual(hash(m[1]), hash(this.opts.token))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return jsonError(res, 403, 'Forbidden')
      if (!this.allowedHosts().includes(req.headers.host ?? '')) return jsonError(res, 403, `Invalid Host header: ${req.headers.host ?? ''}`)
      const origin = req.headers.origin
      if (origin && !this.allowedOrigins().includes(origin)) return jsonError(res, 403, `Invalid Origin header: ${origin}`)
      const path = (req.url ?? '').split('?')[0]
      if (path !== '/mcp') return jsonError(res, 404, 'Not found; the MCP endpoint is /mcp')
      if (!this.authorized(req)) return jsonError(res, 401, 'Unauthorized: send the Shardwise MCP token as "Authorization: Bearer <token>"', { 'WWW-Authenticate': 'Bearer realm="Shardwise", error="invalid_token"' })

      const sid = req.headers['mcp-session-id']
      if (typeof sid === 'string' && sid) {
        const s = this.sessions.get(sid)
        if (!s) return jsonError(res, 404, 'Session not found')
        s.lastSeen = Date.now()
        return await s.transport.handleRequest(req, res)
      }
      if (req.method !== 'POST') return jsonError(res, 400, 'Missing Mcp-Session-Id header')
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch (e) {
        return jsonError(res, 400, `Invalid request body: ${(e as Error).message}`)
      }
      if (!isInitializeRequest(body)) return jsonError(res, 400, 'Missing Mcp-Session-Id header (send initialize first)')
      const s = this.newSession()
      await s.server.connect(s.transport)
      await s.transport.handleRequest(req, res, body)
    } catch (e) {
      jsonError(res, 500, (e as Error).message || 'Internal error')
    }
  }

  private newSession(): Session {
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]
      this.sessions.delete(oldest[0])
      void oldest[1].transport.close().catch(() => {})
    }
    const server = new McpServer({ name: 'shardwise', title: 'Shardwise', version: MCP_SERVER_VERSION }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts(),
      allowedOrigins: this.allowedOrigins(),
      onsessioninitialized: (id) => void this.sessions.set(id, session),
      onsessionclosed: (id) => void this.sessions.delete(id)
    })
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId)
    }
    const writeTools = registerTools(server, this.context(), () => clientLabel(server))
    const session: Session = { transport, server, writeTools, lastSeen: Date.now() }
    this.applyWrites(session)
    return session
  }

  private applyWrites(s: Session): void {
    const on = !!this.opts?.allowWrites
    for (const t of s.writeTools) if (t.enabled !== on) (on ? t.enable() : t.disable())
  }

  private context(): ToolContext {
    return {
      options: () => ({ maxDocs: this.opts?.maxDocs ?? 50, allowWrites: !!this.opts?.allowWrites }),
      exposed: () => this.exposed(),
      resolve: (c) => this.resolve(c),
      approve: (req, client) => this.approve(req, client),
      log: (e) => this.log({ ...e, id: ++this.seq, time: new Date() }),
      recorder: this.recorder
    }
  }

  private async exposed(): Promise<ExposedConnection[]> {
    const live = new Set(this.mgr.liveConnections().map((l) => l.configId))
    return (await this.getConfigs())
      .filter((c) => c.exposeToMcp)
      .map((c) => ({ id: c.id, name: c.name, host: connectionHostLabel(c), connected: live.has(c.id), ...(c.readOnly ? { readOnly: true } : {}) }))
  }

  private async resolve(name: string): Promise<{ client: MongoClient; config: ConnectionConfig }> {
    const configs = (await this.getConfigs()).filter((c) => c.exposeToMcp)
    let cfg = configs.find((c) => c.id === name)
    if (!cfg) {
      const byName = configs.filter((c) => c.name === name)
      const matches = byName.length ? byName : configs.filter((c) => c.name.toLowerCase() === name.toLowerCase())
      if (matches.length > 1) throw new Error(`Several exposed connections are named "${name}"; pass the id from list_connections instead.`)
      cfg = matches[0]
    }
    if (!cfg) throw new Error(`No exposed connection "${name}". Call list_connections to see the available connections.`)
    const live = this.mgr.liveConnections().find((l) => l.configId === cfg.id)
    if (live) return { client: this.mgr.get(live.connId), config: cfg }
    if (!this.opts?.autoConnect) throw new Error(`"${cfg.name}" is not connected in Shardwise. Ask the user to open it in the app (or to enable auto-connect in Settings → AI & automation → MCP server).`)
    let p = this.owned.get(cfg.id)
    if (!p) {
      const config = cfg
      p = this.mgr.connect(config).then((r) => r.connId)
      this.owned.set(cfg.id, p)
      p.catch(() => this.owned.delete(config.id))
    }
    const connId = await p
    return { client: this.mgr.get(connId), config: cfg }
  }

  private async approve(req: WriteRequest, client?: string): Promise<Decision> {
    const timeout = this.opts?.approvalTimeoutMs ?? 60_000
    const full: ApprovalRequest = { ...req, id: randomUUID(), client, expiresAt: Date.now() + timeout }
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeout)))
    try {
      const d = await Promise.race([this.approveFn(full).then((ok): Decision => (ok ? 'approved' : 'denied'), (): Decision => 'denied'), expired])
      // The server may have been stopped while the dialog was open.
      return this.http ? d : 'denied'
    } finally {
      clearTimeout(timer)
    }
  }
}

function clientLabel(server: McpServer): string | undefined {
  const v = server.server.getClientVersion()
  if (!v) return undefined
  return [v.title || v.name, v.version].filter(Boolean).join(' ')
}
