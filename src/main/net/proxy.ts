import net from 'net'
import { SocksClient } from 'socks'
import {
  DEFAULT_PROXY_PORTS,
  describeEndpoint,
  formatHostPort,
  isBypassed,
  isLoopback,
  parsePacResult,
  pickPacEntry,
  proxySettingsProblems,
  stripBrackets
} from '@shared/proxy'
import type { ConnProxyConfig, ProxyEndpoint, ProxySettings, ProxyTestResult } from '@shared/proxy'
import { listenForward, listenSocks } from './socksServer'
import type { Tunnel, PortForward } from '../mongo/sshTunnel'

/**
 * Outbound proxy support for the main process. Everything that opens a TCP connection to a server the user
 * named (MongoDB, SSH, SQL, HTTPS) asks `proxyRouter.route()` how to reach it and dials with `connectVia()`.
 */

export type ProxyErrorCode = 'config' | 'unreachable' | 'timeout' | 'auth' | 'refused' | 'protocol'

/** A failure of the proxy hop, with a message meant for the user. */
export class ProxyError extends Error {
  constructor(
    public code: ProxyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ProxyError'
  }

  /** The proxy itself is unusable (as opposed to refusing one destination). */
  get fatal(): boolean {
    return this.code !== 'refused'
  }
}

export type Route = { kind: 'direct'; reason?: 'bypass' | 'loopback' } | { kind: 'proxy'; proxy: ProxyEndpoint; source: 'settings' | 'system' | 'connection' }

export const DIRECT: Route = { kind: 'direct' }

export function describeRoute(r: Route): string {
  if (r.kind === 'direct') return r.reason === 'bypass' ? 'direct (bypass list)' : r.reason === 'loopback' ? 'direct (local address)' : 'direct'
  return `${describeEndpoint(r.proxy)}${r.source === 'system' ? ' (system settings)' : ''}`
}

const DEFAULT_TIMEOUT = 15000

export interface DialOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** TCP connection to `host:port`; network errors are reported as-is (direct) or as "proxy unreachable". */
function dial(host: string, port: number, o: DialOptions, proxy?: ProxyEndpoint): Promise<net.Socket> {
  const what = proxy ? `the ${describeEndpoint(proxy)}` : formatHostPort(host, port)
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: stripBrackets(host), port })
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT
    const cleanup = (): void => {
      clearTimeout(timer)
      sock.off('error', onError)
      sock.off('connect', onConnect)
      o.signal?.removeEventListener('abort', onAbort)
    }
    const failWith = (e: Error): void => {
      cleanup()
      sock.destroy()
      reject(e)
    }
    const onError = (e: NodeJS.ErrnoException): void =>
      failWith(proxy ? new ProxyError('unreachable', `Could not reach ${what}: ${e.code === 'ENOTFOUND' ? 'host not found' : e.message}`) : e)
    const onConnect = (): void => {
      cleanup()
      resolve(sock)
    }
    const onAbort = (): void => failWith(o.signal?.reason instanceof Error ? o.signal.reason : new Error('Aborted'))
    const timer = setTimeout(() => failWith(proxy ? new ProxyError('timeout', `Could not reach ${what}: no answer within ${Math.round(timeoutMs / 1000)} s`) : new Error(`Connecting to ${what} timed out`)), timeoutMs)
    sock.once('error', onError)
    sock.once('connect', onConnect)
    if (o.signal?.aborted) onAbort()
    else o.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Open a connection to the proxy itself (plain HTTP requests are sent to an HTTP proxy, not tunnelled). */
export function dialProxy(proxy: ProxyEndpoint, o: DialOptions = {}): Promise<net.Socket> {
  return dial(proxy.host, proxy.port, o, proxy)
}

export const basicAuth = (p: ProxyEndpoint): string => `Basic ${Buffer.from(`${p.username ?? ''}:${p.password ?? ''}`).toString('base64')}`

/** Ask an HTTP proxy for a CONNECT tunnel on an open socket. */
function httpConnect(sock: net.Socket, p: ProxyEndpoint, host: string, port: number, o: DialOptions): Promise<net.Socket> {
  const target = formatHostPort(host, port)
  const name = describeEndpoint(p)
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT
    const cleanup = (): void => {
      clearTimeout(timer)
      sock.off('data', onData)
      sock.off('error', onError)
      sock.off('close', onClose)
      o.signal?.removeEventListener('abort', onAbort)
    }
    const failWith = (e: Error): void => {
      cleanup()
      sock.destroy()
      reject(e)
    }
    const onError = (e: Error): void => failWith(new ProxyError('protocol', `The ${name} dropped the connection: ${e.message}`))
    const onClose = (): void => failWith(new ProxyError('protocol', `The ${name} closed the connection without answering the CONNECT request`))
    const onAbort = (): void => failWith(o.signal?.reason instanceof Error ? o.signal.reason : new Error('Aborted'))
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > 16384) failWith(new ProxyError('protocol', `The ${name} sent an invalid answer to CONNECT`))
        return
      }
      const head = buf.subarray(0, end).toString('latin1')
      const rest = buf.subarray(end + 4)
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})[ \t]*([^\r\n]*)/.exec(head)
      if (!m) return failWith(new ProxyError('protocol', `The ${name} is not an HTTP proxy (unexpected answer to CONNECT)`))
      const status = Number(m[1])
      const reason = m[2].trim()
      if (status >= 200 && status < 300) {
        cleanup()
        sock.pause()
        if (rest.length) sock.unshift(rest)
        return resolve(sock)
      }
      if (status === 407) {
        return failWith(
          new ProxyError(
            'auth',
            p.username
              ? `The ${name} rejected the user name or password (HTTP 407)`
              : `The ${name} requires authentication (HTTP 407); enter a user name and password`
          )
        )
      }
      failWith(new ProxyError('refused', `The ${name} refused to open a tunnel to ${target}: HTTP ${status}${reason ? ` ${reason}` : ''}`))
    }
    const timer = setTimeout(() => failWith(new ProxyError('timeout', `The ${name} did not answer the CONNECT request within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    sock.on('data', onData)
    sock.once('error', onError)
    sock.once('close', onClose)
    if (o.signal?.aborted) return onAbort()
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`]
    if (p.username) lines.push(`Proxy-Authorization: ${basicAuth(p)}`)
    sock.write(`${lines.join('\r\n')}\r\n\r\n`)
  })
}

const SOCKS_REPLIES: Record<string, string> = {
  Failure: 'general failure',
  NotAllowed: 'not allowed by the proxy rules',
  NetworkUnreachable: 'network unreachable',
  HostUnreachable: 'host unreachable',
  ConnectionRefused: 'connection refused',
  TTLExpired: 'TTL expired',
  CommandNotSupported: 'command not supported',
  AddressNotSupported: 'address type not supported'
}

/** SOCKS5 handshake on an open socket (the `socks` package). */
async function socksConnect(sock: net.Socket, p: ProxyEndpoint, host: string, port: number, o: DialOptions): Promise<net.Socket> {
  const name = describeEndpoint(p)
  const target = formatHostPort(host, port)
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: p.host, port: p.port, type: 5, userId: p.username || undefined, password: p.username ? (p.password ?? '') : undefined },
      command: 'connect',
      destination: { host: stripBrackets(host), port },
      existing_socket: sock,
      timeout: o.timeoutMs ?? DEFAULT_TIMEOUT
    })
    return socket as net.Socket
  } catch (e) {
    sock.destroy()
    const msg = (e as Error).message
    if (/Authentication failed/i.test(msg)) throw new ProxyError('auth', `The ${name} rejected the user name or password`)
    if (/no accepted authentication type/i.test(msg)) {
      throw new ProxyError('auth', p.username ? `The ${name} does not accept user name / password authentication` : `The ${name} requires authentication; enter a user name and password`)
    }
    const rejected = /rejected connection - (\w+)/.exec(msg)
    if (rejected) throw new ProxyError('refused', `The ${name} could not connect to ${target}: ${SOCKS_REPLIES[rejected[1]] ?? rejected[1]}`)
    if (/timed out/i.test(msg)) throw new ProxyError('timeout', `The ${name} did not complete the SOCKS5 handshake in time`)
    if (/Socket closed/i.test(msg)) throw new ProxyError('protocol', `The ${name} closed the connection during the SOCKS5 handshake (is it a SOCKS5 proxy?)`)
    throw new ProxyError('protocol', `SOCKS5 handshake with the ${name} failed: ${msg}`)
  }
}

/**
 * Open a TCP connection to `host:port` along `route`. The socket is returned paused: the caller pipes it,
 * resumes it or wraps it in TLS right away.
 */
export async function connectVia(route: Route, host: string, port: number, o: DialOptions = {}): Promise<net.Socket> {
  if (route.kind === 'direct') {
    const s = await dial(host, port, o)
    s.pause()
    return s
  }
  const p = route.proxy
  const sock = await dialProxy(p, o)
  return p.type === 'socks5' ? socksConnect(sock, p, host, port, o) : httpConnect(sock, p, host, port, o)
}

// ---------------------------------------------------------------------------
// Which route a destination takes
// ---------------------------------------------------------------------------

export interface ProxyEnvironment {
  /** Settings → Network & tools (normalized). */
  settings(): Promise<ProxySettings>
  /** The saved proxy password. */
  password(): Promise<string | undefined>
  /** Electron `session.resolveProxy(url)`; without it "system" means direct. */
  resolveSystem?(url: string): Promise<string>
}

/** Route for a destination under app-level settings (with the given password). */
export async function routeForSettings(
  s: ProxySettings,
  password: string | undefined,
  host: string,
  port: number,
  resolveSystem?: (url: string) => Promise<string>
): Promise<Route> {
  if (s.mode === 'none') return DIRECT
  if (isLoopback(host)) return { kind: 'direct', reason: 'loopback' }
  if (isBypassed(host, port, s.bypass)) return { kind: 'direct', reason: 'bypass' }
  const creds = s.username ? { username: s.username, password: password ?? '' } : {}
  if (s.mode === 'manual') {
    const problems = proxySettingsProblems(s)
    if (problems.length) throw new ProxyError('config', `Proxy settings are incomplete (Settings → Network & tools): ${problems.join(' ')}`)
    return { kind: 'proxy', proxy: { type: s.type, host: s.host, port: s.port, ...creds }, source: 'settings' }
  }
  if (!resolveSystem) return DIRECT
  // Raw TCP has no scheme: ask for the proxy an HTTPS request to the same host would use (CONNECT-capable).
  const answer = await resolveSystem(`https://${host.includes(':') ? `[${stripBrackets(host)}]` : host}:${port}/`)
  const entry = pickPacEntry(parsePacResult(answer))
  if (!entry) throw new ProxyError('config', `The system proxy setting is not supported (${answer.trim()}); only HTTP and SOCKS5 proxies are`)
  if (entry.kind === 'direct') return DIRECT
  return { kind: 'proxy', proxy: { type: entry.type, host: entry.host, port: entry.port, ...creds }, source: 'system' }
}

/** Route for a connection's own proxy choice (`conn.mode !== 'default'`). */
export function routeForConnection(conn: ConnProxyConfig, host: string): Route {
  if (conn.mode === 'direct') return DIRECT
  if (isLoopback(host)) return { kind: 'direct', reason: 'loopback' }
  const type = conn.type ?? 'http'
  const port = conn.port || DEFAULT_PROXY_PORTS[type]
  const problems = proxySettingsProblems({ mode: 'manual', host: conn.host ?? '', port })
  if (problems.length) throw new ProxyError('config', `The connection's proxy settings are incomplete: ${problems.join(' ')}`)
  return {
    kind: 'proxy',
    proxy: { type, host: stripBrackets(conn.host!.trim()), port, ...(conn.username ? { username: conn.username, password: conn.password ?? '' } : {}) },
    source: 'connection'
  }
}

/** Decides per destination; app settings come from the environment set at startup (none in tests = direct). */
export class ProxyRouter {
  private env: ProxyEnvironment | null = null

  configure(env: ProxyEnvironment | null): void {
    this.env = env
  }

  async route(host: string, port: number, conn?: ConnProxyConfig): Promise<Route> {
    if (conn && conn.mode !== 'default') return routeForConnection(conn, host)
    if (!this.env) return DIRECT
    const s = await this.env.settings()
    if (s.mode === 'none') return DIRECT
    return routeForSettings(s, s.username ? await this.env.password() : undefined, host, port, this.env.resolveSystem?.bind(this.env))
  }

  /** Settings → Network & tools → Test with unsaved settings (`password` missing = the saved one). */
  async test(s: ProxySettings, target: string): Promise<ProxyTestResult> {
    let dest: { host: string; port: number }
    try {
      dest = parseTarget(target)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    let route: Route | undefined
    const t0 = Date.now()
    try {
      const password = s.password !== undefined ? s.password : await this.env?.password()
      route = await routeForSettings(s, password, dest.host, dest.port, this.env?.resolveSystem?.bind(this.env))
      const sock = await connectVia(route, dest.host, dest.port)
      const ms = Date.now() - t0
      sock.destroy()
      return { ok: true, route: describeRoute(route), ms }
    } catch (e) {
      return { ok: false, route: route && describeRoute(route), error: (e as Error).message }
    }
  }
}

/** `host:port`, `[v6]:port` or a URL (default port by scheme). */
export function parseTarget(t: string): { host: string; port: number } {
  const s = t.trim()
  if (!s) throw new Error('Enter a host and port to test, e.g. api.anthropic.com:443')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL
    try {
      u = new URL(s.replace(/^mongodb(\+srv)?:/i, 'http:'))
    } catch {
      throw new Error(`Not a valid address: ${s}`)
    }
    const defaults: Record<string, number> = { 'https:': 443, 'http:': 80 }
    const port = Number(u.port) || (/^mongodb/i.test(s) ? 27017 : defaults[u.protocol])
    if (!port) throw new Error(`Add a port to ${s}`)
    return { host: stripBrackets(u.hostname), port }
  }
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:\s/]+):(\d+)$/.exec(s)
  if (!m) throw new Error('Enter the address as host:port, e.g. api.anthropic.com:443')
  const port = Number(m[2])
  if (port < 1 || port > 65535) throw new Error('The port must be between 1 and 65535')
  return { host: m[1], port }
}

/** The app-wide router (configured in src/main/index.ts). */
export const proxyRouter = new ProxyRouter()

// ---------------------------------------------------------------------------
// Local SOCKS5 bridge for the MongoDB driver
// ---------------------------------------------------------------------------

export interface ProxyBridge extends Tunnel {
  /** Rejects with the first proxy-level failure (bad credentials, proxy unreachable). Never resolves. */
  failure: Promise<never>
  /** The last error opening a tunnel through the proxy, if any. */
  lastError(): ProxyError | undefined
}

/**
 * A local SOCKS5 server (random credentials, loopback only) that opens each requested connection along
 * `resolve(host, port)`. The driver only speaks SOCKS5 to a proxy; this lets it use HTTP proxies, per-host
 * bypass rules and system (PAC) settings, and gives external tools a port forward.
 */
export async function openProxyBridge(resolve: (host: string, port: number) => Promise<Route>): Promise<ProxyBridge> {
  let last: ProxyError | undefined
  let rejectFailure: (e: Error) => void = () => {}
  const failure = new Promise<never>((_, reject) => (rejectFailure = reject))
  failure.catch(() => {})
  const closeCbs: ((err?: Error) => void)[] = []
  let closed = false

  const forward = async (host: string, port: number): Promise<NodeJS.ReadWriteStream> => {
    try {
      return await connectVia(await resolve(host, port), host, port)
    } catch (e) {
      if (e instanceof ProxyError) {
        last = e
        if (e.fatal) rejectFailure(e)
      }
      throw e
    }
  }

  const socks = await listenSocks(forward)
  const forwards = new Set<PortForward>()
  return {
    kind: 'proxy',
    host: socks.host,
    port: socks.port,
    username: socks.username,
    password: socks.password,
    failure,
    lastError: () => last,
    close: async () => {
      if (closed) return
      closed = true
      socks.close()
      for (const f of forwards) f.close()
      closeCbs.forEach((cb) => cb())
    },
    onClose: (cb) => void closeCbs.push(cb),
    forwardPort: async (host, port) => {
      if (closed) throw new Error('The proxy bridge is closed')
      const listener = await listenForward(() => forward(host, port))
      const fwd: PortForward = {
        port: listener.port,
        close: () => {
          forwards.delete(fwd)
          listener.close()
        }
      }
      forwards.add(fwd)
      return fwd
    }
  }
}

/** A loopback port forwarding to `host:port` along `route` (SQL drivers, which cannot take a socket). */
export function forwardVia(route: Route, host: string, port: number): Promise<PortForward> {
  return listenForward(() => connectVia(route, host, port))
}
