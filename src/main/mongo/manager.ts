import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import * as tls from 'tls'
import { MongoClient } from 'mongodb'
import type { MongoClientOptions } from 'mongodb'
import type { Socket } from 'net'
import { buildUri, parseUri, secretsToAsk } from '@shared/connection'
import { formatHostPort, stripBrackets } from '@shared/proxy'
import type { Compressor, ConnectionConfig, TlsConfig } from '@shared/connection'
import type { ConnectResult, TestResult, TestStep } from '@shared/api'
import { openSshTunnel } from './sshTunnel'
import type { Tunnel } from './sshTunnel'
import { readOnlyClient, ReadOnlyError } from './readOnly'
import { connectVia, describeRoute, openProxyBridge, ProxyError, proxyRouter } from '../net/proxy'
import type { ProxyBridge, Route } from '../net/proxy'

interface Live {
  client: MongoClient
  /** `client` behind the read-only guard; what every caller gets. */
  guarded: MongoClient
  tunnel?: Tunnel
  config: ConnectionConfig
}

export interface Opened {
  client: MongoClient
  tunnel?: Tunnel
}

const DEFAULT_SELECTION_TIMEOUT = 15000

/** Compressors whose optional driver module is missing would fail every compressed message: they are skipped. */
const COMPRESSOR_MODULES: Record<Compressor, string | null> = { zlib: null, snappy: 'snappy', zstd: '@mongodb-js/zstd' }

export function compressorAvailable(c: Compressor): boolean {
  const mod = COMPRESSOR_MODULES[c]
  if (!mod) return true
  try {
    require.resolve(mod)
    return true
  } catch {
    return false
  }
}

/** Bundled (Mozilla) roots, the operating system's store and the CA file, as PEM strings. */
export function trustedCertificates(t: TlsConfig): string[] {
  const get = (tls as { getCACertificates?: (type: 'default' | 'system') => string[] }).getCACertificates
  if (typeof get !== 'function') throw new Error('Trusting the system certificate store needs a newer Shardwise runtime; choose a CA file instead.')
  const certs = new Set([...get('default'), ...get('system')])
  if (t.caFile) certs.add(readFileSync(t.caFile, 'utf8'))
  return [...certs]
}

export function clientOptions(cfg: ConnectionConfig, tunnel?: Tunnel): MongoClientOptions {
  const o: MongoClientOptions = {
    appName: cfg.options.appName || 'Shardwise',
    serverSelectionTimeoutMS: cfg.options.serverSelectionTimeoutMS || DEFAULT_SELECTION_TIMEOUT
  }
  if (cfg.tls.enabled) {
    // The driver reads tlsCAFile only when `ca` is unset, so the system store and the file are combined here.
    if (cfg.tls.useSystemCA) o.ca = trustedCertificates(cfg.tls)
    else if (cfg.tls.caFile) o.tlsCAFile = cfg.tls.caFile
    if (cfg.tls.servername?.trim()) o.servername = cfg.tls.servername.trim()
    if (cfg.tls.certKeyFile) o.tlsCertificateKeyFile = cfg.tls.certKeyFile
    if (cfg.tls.certKeyPassword) o.tlsCertificateKeyFilePassword = cfg.tls.certKeyPassword
  }
  if (cfg.options.compressors?.length && cfg.mode !== 'uri') o.compressors = cfg.options.compressors.filter(compressorAvailable)
  if (cfg.auth.mechanism === 'MONGODB-AWS' && cfg.auth.awsSessionToken) {
    o.authMechanismProperties = { AWS_SESSION_TOKEN: cfg.auth.awsSessionToken }
  }
  if (tunnel) {
    o.proxyHost = tunnel.host
    o.proxyPort = tunnel.port
    o.proxyUsername = tunnel.username
    o.proxyPassword = tunnel.password
  }
  return o
}

/** Connections set to ask for a secret cannot be opened without it (MCP auto-connect, scheduled tasks). */
export function assertSecretsGiven(cfg: ConnectionConfig): void {
  const ask = secretsToAsk(cfg)
  let missing: string | null = null
  if (ask.password && cfg.auth.password === undefined) missing = 'its password'
  else if (ask.ssh === 'password' && cfg.ssh.password === undefined) missing = 'its SSH password'
  else if (ask.ssh === 'passphrase' && cfg.ssh.passphrase === undefined) missing = 'its SSH key passphrase'
  if (missing) throw new Error(`"${cfg.name}" asks for ${missing} on every connect; open it in Shardwise and enter it there first.`)
}

/** Seed addresses of a connection (SRV: the SRV name with the default port); empty for an unparsable URI. */
export function seedHosts(cfg: ConnectionConfig): { host: string; port: number; srv?: boolean }[] {
  let c = cfg
  if (cfg.mode === 'uri') {
    try {
      c = parseUri(cfg.uri ?? '', cfg)
    } catch {
      return []
    }
  }
  if (c.mode === 'srv') return [{ host: c.srvHost || 'localhost', port: 27017, srv: true }]
  const hosts = c.mode === 'standalone' ? c.hosts.slice(0, 1) : c.hosts
  return hosts.map((h) => ({ host: stripBrackets(h.host), port: h.port || 27017 }))
}

/**
 * When a proxy applies to the connection's servers, a local SOCKS5 bridge for the driver (each member is routed
 * on its own: bypass rules, system settings). A direct test tunnel to the first proxied seed turns a bad proxy
 * into a clear error before the driver starts its server selection.
 */
async function openBridgeIfNeeded(cfg: ConnectionConfig, step: (s: TestStep) => void): Promise<ProxyBridge | undefined> {
  const route = (host: string, port: number): Promise<Route> => proxyRouter.route(host, port, cfg.proxy)
  const seeds = seedHosts(cfg)
  let first: { route: Route; host: string; port: number; srv?: boolean } | undefined
  try {
    for (const s of seeds) {
      const r = await route(s.host, s.port)
      if (r.kind === 'proxy') {
        first = { route: r, ...s }
        break
      }
    }
  } catch (e) {
    step({ name: 'Proxy', ok: false, detail: (e as Error).message })
    throw e
  }
  if (!first) return undefined
  const bridge = await openProxyBridge(route)
  try {
    if (!first.srv) (await connectVia(first.route, first.host, first.port)).destroy()
    const detail = first.srv ? `${describeRoute(first.route)} (SRV / TXT lookups for ${first.host} are made directly)` : `${describeRoute(first.route)} → ${formatHostPort(first.host, first.port)}`
    step({ name: 'Proxy', ok: true, detail })
  } catch (e) {
    step({ name: 'Proxy', ok: false, detail: (e as Error).message })
    // Another member of a replica set may still be reachable; a broken proxy never is.
    if (!(e instanceof ProxyError) || e.fatal || seeds.length === 1) {
      await bridge.close()
      throw e
    }
  }
  return bridge
}

/** A driver error with the proxy failure behind it, when there was one. */
function withProxyCause(e: unknown, bridge: ProxyBridge | undefined): Error {
  const err = e instanceof Error ? e : new Error(String(e))
  if (err instanceof ProxyError) return err
  const last = bridge?.lastError()
  return last ? new Error(`${err.message} — proxy: ${last.message}`) : err
}

/** Open a client (and SSH tunnel / proxy bridge when configured). Calls `step` as each stage completes. */
export async function openClient(cfg: ConnectionConfig, step: (s: TestStep) => void = () => {}): Promise<Opened> {
  assertSecretsGiven(cfg)
  // Fails early (e.g. an unreadable CA file) before a tunnel is opened.
  clientOptions(cfg)
  let tunnel: Tunnel | undefined
  let bridge: ProxyBridge | undefined
  if (cfg.ssh.enabled) {
    // The proxy carries the SSH connection; MongoDB traffic then runs inside SSH.
    let sock: Socket | undefined
    const sshHost = cfg.ssh.host ?? ''
    const sshPort = cfg.ssh.port || 22
    if (sshHost) {
      try {
        const r = await proxyRouter.route(sshHost, sshPort, cfg.proxy)
        if (r.kind === 'proxy') {
          sock = await connectVia(r, sshHost, sshPort)
          step({ name: 'Proxy', ok: true, detail: `${describeRoute(r)} → ${formatHostPort(sshHost, sshPort)}` })
        }
      } catch (e) {
        step({ name: 'Proxy', ok: false, detail: (e as Error).message })
        throw e
      }
    }
    try {
      tunnel = await openSshTunnel(cfg.ssh, sock)
      step({ name: 'SSH tunnel', ok: true, detail: `${cfg.ssh.username}@${cfg.ssh.host}:${cfg.ssh.port || 22}` })
    } catch (e) {
      sock?.destroy()
      step({ name: 'SSH tunnel', ok: false, detail: (e as Error).message })
      throw e
    }
  } else {
    bridge = await openBridgeIfNeeded(cfg, step)
    tunnel = bridge
  }
  const client = new MongoClient(buildUri(cfg, true), clientOptions(cfg, tunnel))
  try {
    // A proxy that rejects the credentials or cannot be reached ends the attempt at once.
    await (bridge ? Promise.race([client.connect(), bridge.failure]) : client.connect())
    step({ name: 'Connect', ok: true })
  } catch (e) {
    const err = withProxyCause(e, bridge)
    step({ name: 'Connect', ok: false, detail: err.message })
    await client.close().catch(() => {})
    await tunnel?.close()
    throw err
  }
  return { client, tunnel }
}

async function serverInfo(client: MongoClient): Promise<{ version: string; topology: string }> {
  const admin = client.db('admin')
  const hello = await admin.command({ hello: 1 }).catch(() => admin.command({ isMaster: 1 }))
  let version = ''
  try {
    version = String((await admin.command({ buildInfo: 1 })).version ?? '')
  } catch {
    version = 'unknown'
  }
  const topology = hello.msg === 'isdbgrid' ? 'Sharded cluster' : hello.setName ? `Replica set ${hello.setName}` : 'Standalone'
  return { version, topology }
}

export class ConnectionManager {
  private live = new Map<string, Live>()

  constructor(private onLost: (connId: string, error: string) => void = () => {}) {}

  async connect(cfg: ConnectionConfig): Promise<ConnectResult> {
    const { client, tunnel } = await openClient(cfg)
    const connId = randomUUID()
    try {
      const info = await serverInfo(client)
      const live: Live = { client, tunnel, config: cfg, guarded: client }
      live.guarded = readOnlyClient(
        client,
        () => live.config.name,
        () => !!live.config.readOnly
      )
      this.live.set(connId, live)
      tunnel?.onClose((err) => {
        if (this.live.has(connId)) this.onLost(connId, err?.message ?? 'SSH tunnel closed')
      })
      return { connId, serverVersion: info.version, topology: info.topology }
    } catch (e) {
      await client.close().catch(() => {})
      await tunnel?.close()
      throw e
    }
  }

  async test(cfg: ConnectionConfig): Promise<TestResult> {
    const steps: TestStep[] = []
    const step = (s: TestStep): void => void steps.push(s)
    let opened: Opened | undefined
    try {
      opened = await openClient(cfg, step)
      await opened.client.db('admin').command({ ping: 1 })
      step({ name: 'Ping', ok: true })
      const info = await serverInfo(opened.client)
      step({ name: 'Server', ok: true, detail: `MongoDB ${info.version} — ${info.topology}` })
      try {
        const dbs = await opened.client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true })
        step({ name: 'List databases', ok: true, detail: `${dbs.databases.length} database(s)` })
      } catch (e) {
        step({ name: 'List databases', ok: false, detail: (e as Error).message })
      }
      return { ok: true, steps, serverVersion: info.version }
    } catch (e) {
      return { ok: false, steps, error: (e as Error).message }
    } finally {
      await opened?.client.close().catch(() => {})
      await opened?.tunnel?.close()
    }
  }

  /** The connection's client; on a read-only connection its write methods fail with ReadOnlyError. */
  get(connId: string): MongoClient {
    const l = this.live.get(connId)
    if (!l) throw new Error('Not connected (the connection was closed)')
    return l.guarded
  }

  config(connId: string): ConnectionConfig {
    const l = this.live.get(connId)
    if (!l) throw new Error('Not connected (the connection was closed)')
    return l.config
  }

  isReadOnly(connId: string): boolean {
    return !!this.live.get(connId)?.config.readOnly
  }

  /** Throws ReadOnlyError when the connection is read-only (job starters call it before doing anything). */
  assertWritable(connId: string, action?: string): void {
    const l = this.live.get(connId)
    if (!l) throw new Error('Not connected (the connection was closed)')
    if (l.config.readOnly) throw new ReadOnlyError(l.config.name, action)
  }

  /**
   * A saved connection changed: open connections of it pick up the settings that apply without reconnecting
   * (name, read-only, visible databases, overrides, MCP exposure). Server, credentials and TLS need a reconnect.
   */
  applySaved(cfg: ConnectionConfig): void {
    for (const l of this.live.values()) {
      if (l.config.id !== cfg.id) continue
      l.config = { ...l.config, name: cfg.name, color: cfg.color, readOnly: cfg.readOnly, databases: cfg.databases, overrides: cfg.overrides, exposeToMcp: cfg.exposeToMcp, shellStartupScript: cfg.shellStartupScript }
    }
  }

  /** Open connections and the saved config each belongs to. */
  liveConnections(): { connId: string; configId: string }[] {
    return [...this.live].map(([connId, l]) => ({ connId, configId: l.config.id }))
  }

  /** URI + tunnel info for external tools (mongodump / mongorestore). */
  tunnelFor(connId: string): Tunnel | undefined {
    return this.live.get(connId)?.tunnel
  }

  async disconnect(connId: string): Promise<void> {
    const l = this.live.get(connId)
    if (!l) return
    this.live.delete(connId)
    await l.client.close().catch(() => {})
    await l.tunnel?.close()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)))
  }
}
