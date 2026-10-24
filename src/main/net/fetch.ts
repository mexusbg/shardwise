import http from 'http'
import tls from 'tls'
import { isIP } from 'net'
import { Readable } from 'stream'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { stripBrackets } from '@shared/proxy'
import { basicAuth, connectVia, dialProxy, proxyRouter } from './proxy'
import type { Route } from './proxy'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const NO_BODY = new Set([101, 204, 205, 304])
const MAX_REDIRECTS = 20

let caCache: string[] | undefined
/** Bundled roots plus the operating system's store (corporate proxies that inspect TLS install their root there). */
function trustedCa(): string[] | undefined {
  if (caCache) return caCache
  const get = (tls as { getCACertificates?: (type: 'default' | 'system') => string[] }).getCACertificates
  if (typeof get !== 'function') return undefined
  try {
    caCache = [...new Set([...get('default'), ...get('system')])]
  } catch {
    caCache = get('default')
  }
  return caCache
}

const urlOf = (input: string | URL | Request): URL => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const portOf = (u: URL): number => Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
const abortReason = (s: AbortSignal): Error => (s.reason instanceof Error ? s.reason : new DOMException('This operation was aborted', 'AbortError'))

/** One HTTP/1.1 exchange over a connection opened along `route` (no redirects). */
function requestOnce(url: URL, method: string, headers: Headers, body: Buffer | undefined, route: Route, signal: AbortSignal | undefined, ca: string[] | undefined): Promise<Response> {
  const secure = url.protocol === 'https:'
  if (!secure && url.protocol !== 'http:') return Promise.reject(new TypeError(`Unsupported URL scheme: ${url.protocol}`))
  const host = stripBrackets(url.hostname)
  const port = portOf(url)
  // Plain HTTP goes to an HTTP proxy as an absolute-URI request; everything else is tunnelled.
  const viaHttpProxy = !secure && route.kind === 'proxy' && route.proxy.type === 'http'
  const h: Record<string, string> = {}
  headers.forEach((v, k) => (h[k] = v))
  h.host = url.host
  // Bodies are passed on as they come; ask for them uncompressed.
  h['accept-encoding'] = 'identity'
  h.connection = 'close'
  if (body) h['content-length'] = String(body.length)
  else if (method !== 'GET' && method !== 'HEAD') h['content-length'] = '0'
  if (viaHttpProxy && route.proxy.username) h['proxy-authorization'] = basicAuth(route.proxy)

  const open = async (): Promise<NodeJS.ReadWriteStream> => {
    if (viaHttpProxy) {
      const s = await dialProxy(route.proxy, { signal })
      return s
    }
    const s = await connectVia(route, host, port, { signal })
    if (!secure) {
      s.resume()
      return s
    }
    const t = tls.connect({ socket: s, servername: isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'], ca: ca ?? trustedCa() })
    s.resume()
    return t
  }

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    let settled = false
    const req = http.request({
      method,
      host,
      port,
      path: viaHttpProxy ? url.href : `${url.pathname}${url.search}`,
      headers: h,
      createConnection: (_opts, cb) => {
        open().then(
          (s) => cb(null, s as unknown as import('stream').Duplex),
          (e: Error) => cb(e, undefined as unknown as import('stream').Duplex)
        )
        return undefined
      }
    })
    const onAbort = (): void => {
      const e = abortReason(signal!)
      req.destroy(e)
      if (!settled) {
        settled = true
        reject(e)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', (e) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(e.name === 'AbortError' ? e : new TypeError('fetch failed', { cause: e }))
    })
    req.on('response', (res) => {
      settled = true
      const status = res.statusCode ?? 0
      const out = new Headers()
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1])
      const empty = method === 'HEAD' || NO_BODY.has(status)
      if (empty) res.resume()
      res.on('close', () => signal?.removeEventListener('abort', onAbort))
      if (signal) signal.addEventListener('abort', () => res.destroy(abortReason(signal)), { once: true })
      const stream = empty ? null : (Readable.toWeb(res) as unknown as WebReadableStream<Uint8Array>)
      resolve(new Response(stream as unknown as ConstructorParameters<typeof Response>[0], { status, statusText: res.statusMessage ?? '', headers: out }))
    })
    req.end(body)
  })
}

/**
 * A `fetch` that reaches servers along `routeFor(host, port)`: direct requests go to `base` (Node's fetch);
 * proxied ones are sent over our own tunnel (HTTP CONNECT or SOCKS5, with credentials), following redirects.
 */
export function createProxyFetch(
  routeFor: (host: string, port: number) => Promise<Route>,
  base: FetchLike = (i, o) => fetch(i, o),
  /** Trusted roots for proxied HTTPS (default: bundled + system store). */
  ca?: string[]
): FetchLike {
  return async (input, init) => {
    let url = urlOf(input)
    let route = await routeFor(stripBrackets(url.hostname), portOf(url))
    if (route.kind === 'direct') return base(input, init)

    const req = new Request(input, init)
    let method = req.method.toUpperCase()
    const headers = new Headers(req.headers)
    let body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined
    const signal = init?.signal ?? req.signal
    const mode = init?.redirect ?? req.redirect ?? 'follow'
    for (let hops = 0; ; hops++) {
      const res = await requestOnce(url, method, headers, body, route, signal ?? undefined, ca)
      const location = res.headers.get('location')
      if (!REDIRECTS.has(res.status) || !location || mode === 'manual') return res
      await res.body?.cancel().catch(() => {})
      if (mode === 'error') throw new TypeError('fetch failed: redirect not allowed')
      if (hops >= MAX_REDIRECTS) throw new TypeError('fetch failed: too many redirects')
      const next = new URL(location, url)
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = method === 'HEAD' ? 'HEAD' : 'GET'
        body = undefined
        headers.delete('content-type')
      }
      if (next.origin !== url.origin) for (const k of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization']) headers.delete(k)
      url = next
      route = await routeFor(stripBrackets(url.hostname), portOf(url))
    }
  }
}

/** `fetch` for every HTTP(S) request of the main process (AI, tool downloads): follows Settings → Network & tools. */
export const appFetch: FetchLike = createProxyFetch((host, port) => proxyRouter.route(host, port))
