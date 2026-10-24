import { existsSync, readFileSync } from 'fs'
import http from 'http'
import https from 'https'
import net from 'net'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Server } from 'ssh2'
import Anthropic from '@anthropic-ai/sdk'
import { newConnectionConfig } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import { DEFAULT_PROXY_SETTINGS } from '@shared/proxy'
import type { ConnProxyConfig, ProxySettings } from '@shared/proxy'
import { ConnectionManager } from '../src/main/mongo/manager'
import { connectVia, forwardVia, ProxyError, proxyRouter } from '../src/main/net/proxy'
import type { Route } from '../src/main/net/proxy'
import { createProxyFetch } from '../src/main/net/fetch'
import { friendlyError } from '../src/main/ai/client'
import { ed25519HostKey } from './helpers/sshHostKey'

/**
 * Test proxies map every destination host to 127.0.0.1 (keeping the port), so connections can name hosts
 * like `mongo.test` that are not loopback (loopback is never proxied) and only exist behind the proxy.
 */

interface TestProxy {
  port: number
  /** Destinations requested, as host:port. */
  seen: string[]
  close(): void
}

const sockets = new Set<net.Socket>()
const track = (s: net.Socket): void => {
  sockets.add(s)
  s.on('close', () => sockets.delete(s))
}

function pipeTo(client: net.Socket, port: number, head?: Buffer, onOpen?: () => void): void {
  const up = net.connect(port, '127.0.0.1', () => {
    onOpen?.()
    if (head?.length) up.write(head)
    client.pipe(up).pipe(client)
  })
  track(up)
  up.on('error', () => client.destroy())
  client.on('error', () => up.destroy())
}

/** HTTP proxy: CONNECT tunnels (optionally with Basic auth) and absolute-URI requests answered by itself. */
async function httpProxy(auth?: { user: string; pass: string }): Promise<TestProxy> {
  const seen: string[] = []
  const expected = auth && `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`
  const server = http.createServer((req, res) => {
    // Plain HTTP through the proxy: absolute-form request line.
    seen.push(req.url ?? '')
    if (expected && req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ via: 'http-proxy', url: req.url }))
  })
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    track(client)
    const target = req.url ?? ''
    seen.push(target)
    if (expected && req.headers['proxy-authorization'] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n')
      return
    }
    if (target.startsWith('blocked.test')) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const port = Number(target.slice(target.lastIndexOf(':') + 1))
    pipeTo(client, port, head, () => client.write('HTTP/1.1 200 Connection established\r\n\r\n'))
  })
  server.on('connection', track)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() }
}

/** SOCKS5 proxy (no auth, or username / password). */
async function socksProxy(auth?: { user: string; pass: string }): Promise<TestProxy> {
  const seen: string[] = []
  const server = net.createServer((sock) => {
    track(sock)
    let buf = Buffer.alloc(0)
    let stage: 'hello' | 'auth' | 'request' = 'hello'
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (stage === 'hello') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return
        const methods = [...buf.subarray(2, 2 + buf[1])]
        buf = buf.subarray(2 + buf[1])
        const want = auth ? 2 : 0
        if (!methods.includes(want)) return void sock.end(Buffer.from([5, 0xff]))
        sock.write(Buffer.from([5, want]))
        stage = auth ? 'auth' : 'request'
      }
      if (stage === 'auth') {
        if (buf.length < 2) return
        const ulen = buf[1]
        if (buf.length < 3 + ulen || buf.length < 3 + ulen + buf[2 + ulen]) return
        const user = buf.subarray(2, 2 + ulen).toString()
        const pass = buf.subarray(3 + ulen, 3 + ulen + buf[2 + ulen]).toString()
        buf = buf.subarray(3 + ulen + buf[2 + ulen])
        if (user !== auth!.user || pass !== auth!.pass) return void sock.end(Buffer.from([1, 1]))
        sock.write(Buffer.from([1, 0]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buf.length < 5) return
        let host: string
        let off: number
        if (buf[3] === 3) {
          if (buf.length < 7 + buf[4]) return
          host = buf.subarray(5, 5 + buf[4]).toString()
          off = 5 + buf[4]
        } else if (buf[3] === 1) {
          if (buf.length < 10) return
          host = [...buf.subarray(4, 8)].join('.')
          off = 8
        } else return void sock.destroy()
        const port = buf.readUInt16BE(off)
        const rest = buf.subarray(off + 2)
        seen.push(`${host}:${port}`)
        sock.off('data', onData)
        if (host.startsWith('blocked.test')) return void sock.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))
        pipeTo(sock, port, rest, () => sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])))
      }
    }
    sock.on('data', onData)
    sock.on('error', () => sock.destroy())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() }
}

let mongo: MongoMemoryServer
let mongoPort = 0
let httpOpen: TestProxy
let httpAuth: TestProxy
let socksOpen: TestProxy
let socksAuth: TestProxy

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  mongoPort = Number(new URL(mongo.getUri()).port)
  ;[httpOpen, httpAuth, socksOpen, socksAuth] = await Promise.all([
    httpProxy(),
    httpProxy({ user: 'alice', pass: 's3cret' }),
    socksProxy(),
    socksProxy({ user: 'bob', pass: 'hunter2' })
  ])
})

afterAll(async () => {
  for (const p of [httpOpen, httpAuth, socksOpen, socksAuth]) p?.close()
  for (const s of sockets) s.destroy()
  await mongo?.stop()
})

afterEach(() => proxyRouter.configure(null))

const viaProxy = (proxy: ConnProxyConfig | undefined, host = 'mongo.test'): ConnectionConfig => ({
  ...newConnectionConfig(),
  name: 'proxied',
  hosts: [{ host, port: mongoPort }],
  directConnection: true,
  options: { serverSelectionTimeoutMS: 8000 },
  proxy
})

const custom = (p: TestProxy, type: 'http' | 'socks5', user?: string, password?: string): ConnProxyConfig => ({
  mode: 'custom',
  type,
  host: '127.0.0.1',
  port: p.port,
  ...(user ? { username: user, password } : {})
})

async function roundTrip(cfg: ConnectionConfig): Promise<void> {
  const mgr = new ConnectionManager()
  const c = await mgr.connect(cfg)
  try {
    const coll = mgr.get(c.connId).db('proxytest').collection('items')
    const name = `n${Math.random()}`
    await coll.insertOne({ name })
    expect(await coll.findOne({ name })).toMatchObject({ name })
  } finally {
    await mgr.closeAll()
  }
}

describe('MongoDB through a proxy', () => {
  for (const [label, get, type, user, pass] of [
    ['HTTP CONNECT proxy', () => httpOpen, 'http', undefined, undefined],
    ['HTTP CONNECT proxy with Basic auth', () => httpAuth, 'http', 'alice', 's3cret'],
    ['SOCKS5 proxy', () => socksOpen, 'socks5', undefined, undefined],
    ['SOCKS5 proxy with user / password', () => socksAuth, 'socks5', 'bob', 'hunter2']
  ] as const) {
    it(`connects and queries through a ${label}`, async () => {
      const p = get()
      const before = p.seen.length
      const t = await new ConnectionManager().test(viaProxy(custom(p, type, user, pass)))
      expect(t.ok, t.error).toBe(true)
      expect(t.steps[0]).toMatchObject({ name: 'Proxy', ok: true })
      expect(t.steps[0].detail).toContain(`${type === 'http' ? 'HTTP' : 'SOCKS5'} proxy 127.0.0.1:${p.port} → mongo.test:${mongoPort}`)
      await roundTrip(viaProxy(custom(p, type, user, pass)))
      expect(p.seen.slice(before)).toContain(`mongo.test:${mongoPort}`)
    })
  }

  it('fails fast and clearly with a wrong HTTP proxy password', async () => {
    const t0 = Date.now()
    const t = await new ConnectionManager().test(viaProxy(custom(httpAuth, 'http', 'alice', 'wrong')))
    expect(t.ok).toBe(false)
    expect(t.steps[0]).toMatchObject({ name: 'Proxy', ok: false })
    expect(t.error).toBe(`The HTTP proxy 127.0.0.1:${httpAuth.port} rejected the user name or password (HTTP 407)`)
    expect(Date.now() - t0).toBeLessThan(5000)
    const noCreds = await new ConnectionManager().test(viaProxy(custom(httpAuth, 'http')))
    expect(noCreds.error).toMatch(/requires authentication \(HTTP 407\)/)
  })

  it('fails clearly with a wrong SOCKS5 password', async () => {
    const t = await new ConnectionManager().test(viaProxy(custom(socksAuth, 'socks5', 'bob', 'nope')))
    expect(t.ok).toBe(false)
    expect(t.error).toBe(`The SOCKS5 proxy 127.0.0.1:${socksAuth.port} rejected the user name or password`)
    await expect(new ConnectionManager().connect(viaProxy(custom(socksAuth, 'socks5')))).rejects.toThrow(/requires authentication/)
  })

  it('reports an unreachable proxy and a refused destination', async () => {
    const closed = net.createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()))
    const deadPort = (closed.address() as net.AddressInfo).port
    closed.close()
    const t = await new ConnectionManager().test(viaProxy({ mode: 'custom', type: 'http', host: '127.0.0.1', port: deadPort }))
    expect(t.error).toMatch(new RegExp(`^Could not reach the HTTP proxy 127\\.0\\.0\\.1:${deadPort}: .*ECONNREFUSED`))

    const blocked = await new ConnectionManager().test(viaProxy(custom(httpOpen, 'http'), 'blocked.test'))
    expect(blocked.error).toBe(`The HTTP proxy 127.0.0.1:${httpOpen.port} refused to open a tunnel to blocked.test:${mongoPort}: HTTP 403 Forbidden`)
    const blockedSocks = await new ConnectionManager().test(viaProxy(custom(socksOpen, 'socks5'), 'blocked.test'))
    expect(blockedSocks.error).toMatch(/could not connect to blocked\.test:\d+: not allowed by the proxy rules/)
  })

  it('uses Settings → Network & tools by default, with bypass rules and per-connection direct', async () => {
    const settings: ProxySettings = { ...DEFAULT_PROXY_SETTINGS, mode: 'manual', type: 'socks5', host: '127.0.0.1', port: socksAuth.port, username: 'bob', bypass: 'skip.test' }
    proxyRouter.configure({ settings: async () => settings, password: async () => 'hunter2' })
    const before = socksAuth.seen.length
    await roundTrip(viaProxy(undefined))
    expect(socksAuth.seen.slice(before)).toContain(`mongo.test:${mongoPort}`)

    // Loopback and "direct" connections never use the proxy.
    const n = socksAuth.seen.length
    await roundTrip(viaProxy(undefined, '127.0.0.1'))
    await roundTrip(viaProxy({ mode: 'direct' }, 'localhost'))
    expect(socksAuth.seen.length).toBe(n)
    // A bypassed host is dialled directly (and does not exist outside the proxy).
    const t = await new ConnectionManager().test({ ...viaProxy(undefined, 'skip.test'), options: { serverSelectionTimeoutMS: 1500 } })
    expect(t.ok).toBe(false)
    expect(t.steps.some((s) => s.name === 'Proxy')).toBe(false)
  })

  it('follows the system proxy (PAC answer) in system mode', async () => {
    proxyRouter.configure({
      settings: async () => ({ ...DEFAULT_PROXY_SETTINGS, mode: 'system' }),
      password: async () => undefined,
      resolveSystem: async () => `PROXY 127.0.0.1:${httpOpen.port}; DIRECT`
    })
    const t = await new ConnectionManager().test(viaProxy(undefined))
    expect(t.ok, t.error).toBe(true)
    expect(t.steps[0].detail).toContain(`HTTP proxy 127.0.0.1:${httpOpen.port} (system settings)`)
  })

  it('tests settings from Settings → Network & tools', async () => {
    proxyRouter.configure({ settings: async () => DEFAULT_PROXY_SETTINGS, password: async () => 'hunter2' })
    const s: ProxySettings = { ...DEFAULT_PROXY_SETTINGS, mode: 'manual', type: 'socks5', host: '127.0.0.1', port: socksAuth.port, username: 'bob' }
    const ok = await proxyRouter.test(s, `mongo.test:${mongoPort}`)
    expect(ok).toMatchObject({ ok: true, route: `SOCKS5 proxy 127.0.0.1:${socksAuth.port}` })
    expect(ok.ms).toBeGreaterThanOrEqual(0)
    const bad = await proxyRouter.test({ ...s, password: 'typed-but-wrong' }, `mongo.test:${mongoPort}`)
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/rejected the user name or password/) })
    const bypassed = await proxyRouter.test({ ...s, bypass: '127.0.0.0/8' }, `127.0.0.1:${mongoPort}`)
    expect(bypassed).toMatchObject({ ok: true, route: 'direct (local address)' })
  })

  it('forwards a local port through the proxy (SQL drivers, external tools)', async () => {
    const route: Route = { kind: 'proxy', proxy: { type: 'http', host: '127.0.0.1', port: httpAuth.port, username: 'alice', password: 's3cret' }, source: 'connection' }
    const fwd = await forwardVia(route, 'mongo.test', mongoPort)
    const client = new MongoClient(`mongodb://127.0.0.1:${fwd.port}/?directConnection=true`, { serverSelectionTimeoutMS: 5000 })
    try {
      expect((await client.db('admin').command({ ping: 1 })).ok).toBe(1)
    } finally {
      await client.close()
      fwd.close()
    }
  })

  it('reports proxy errors as ProxyError with a code', async () => {
    const route: Route = { kind: 'proxy', proxy: { type: 'socks5', host: '127.0.0.1', port: socksAuth.port, username: 'bob', password: 'x' }, source: 'connection' }
    const e = await connectVia(route, 'mongo.test', mongoPort).catch((err: unknown) => err)
    expect(e).toBeInstanceOf(ProxyError)
    expect((e as ProxyError).code).toBe('auth')
  })
})

describe('SSH through a proxy', () => {
  let sshServer: Server
  let sshPort = 0
  beforeAll(async () => {
    const hostKey = ed25519HostKey()
    sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
      client
        .on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])))
        .on('ready', () => {
          client.on('tcpip', (accept, _reject, info) => {
            const stream = accept()
            const sock = net.connect(info.destPort, info.destIP)
            stream.pipe(sock).pipe(stream)
            sock.on('error', () => stream.destroy())
            stream.on('error', () => sock.destroy())
          })
        })
        .on('error', () => {})
    })
    await new Promise<void>((r) => sshServer.listen(0, '127.0.0.1', () => r()))
    sshPort = (sshServer.address() as net.AddressInfo).port
  })
  afterAll(() => sshServer?.close())

  for (const [label, get, type, user, pass] of [
    ['HTTP', () => httpAuth, 'http', 'alice', 's3cret'],
    ['SOCKS5', () => socksOpen, 'socks5', undefined, undefined]
  ] as const) {
    it(`opens the SSH connection through the ${label} proxy`, async () => {
      const p = get()
      const before = p.seen.length
      const cfg: ConnectionConfig = {
        ...viaProxy(custom(p, type, user, pass), 'localhost'),
        ssh: { enabled: true, host: 'ssh.test', port: sshPort, username: 'tester', method: 'password', password: 'secret' }
      }
      const t = await new ConnectionManager().test(cfg)
      expect(t.ok, t.error).toBe(true)
      expect(t.steps.map((s) => s.name).slice(0, 2)).toEqual(['Proxy', 'SSH tunnel'])
      expect(p.seen.slice(before)).toEqual([`ssh.test:${sshPort}`])
      await roundTrip(cfg)
    })
  }

  it('reports the proxy failure, not an SSH error', async () => {
    const cfg: ConnectionConfig = {
      ...viaProxy(custom(httpAuth, 'http', 'alice', 'bad'), 'localhost'),
      ssh: { enabled: true, host: 'ssh.test', port: sshPort, username: 'tester', method: 'password', password: 'secret' }
    }
    const t = await new ConnectionManager().test(cfg)
    expect(t.ok).toBe(false)
    expect(t.steps).toEqual([{ name: 'Proxy', ok: false, detail: expect.stringMatching(/rejected the user name or password/) }])
  })
})

describe('HTTP(S) through a proxy', () => {
  let origin: http.Server
  let originPort = 0
  beforeAll(async () => {
    origin = http.createServer((req, res) => {
      if (req.url === '/redirect') return void res.writeHead(302, { location: '/final' }).end()
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url, method: req.method, body, host: req.headers.host })))
    })
    origin.on('connection', track)
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()))
    originPort = (origin.address() as net.AddressInfo).port
  })
  afterAll(() => origin?.close())

  const fixed =
    (route: Route) =>
    async (): Promise<Route> =>
      route

  it('tunnels requests through SOCKS5 and follows redirects', async () => {
    const f = createProxyFetch(fixed({ kind: 'proxy', proxy: { type: 'socks5', host: '127.0.0.1', port: socksAuth.port, username: 'bob', password: 'hunter2' }, source: 'settings' }))
    const res = await f(`http://web.test:${originPort}/redirect`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: '/final', method: 'GET', body: '', host: `web.test:${originPort}` })
    const post = await f(`http://web.test:${originPort}/echo`, { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } })
    expect(await post.json()).toMatchObject({ method: 'POST', body: '{"a":1}' })
  })

  it('sends plain HTTP to an HTTP proxy in absolute form, with credentials', async () => {
    const f = createProxyFetch(fixed({ kind: 'proxy', proxy: { type: 'http', host: '127.0.0.1', port: httpAuth.port, username: 'alice', password: 's3cret' }, source: 'settings' }))
    const res = await f('http://web.test/some/path?q=1')
    expect(await res.json()).toEqual({ via: 'http-proxy', url: 'http://web.test/some/path?q=1' })
    const wrong = createProxyFetch(fixed({ kind: 'proxy', proxy: { type: 'http', host: '127.0.0.1', port: httpAuth.port, username: 'alice', password: 'x' }, source: 'settings' }))
    expect((await wrong('http://web.test/')).status).toBe(407)
  })

  it('goes direct when the route says so', async () => {
    let used = false
    const f = createProxyFetch(fixed({ kind: 'direct' }), async (i, o) => {
      used = true
      return fetch(i, o)
    })
    expect((await f(`http://127.0.0.1:${originPort}/x`)).status).toBe(200)
    expect(used).toBe(true)
  })

  const certFile = join(process.cwd(), 'node_modules/ssh2/test/fixtures/https_cert.pem')
  it.skipIf(!existsSync(certFile))('verifies TLS end to end through an HTTP CONNECT tunnel', async () => {
    const cert = readFileSync(certFile, 'utf8')
    const key = readFileSync(join(process.cwd(), 'node_modules/ssh2/test/fixtures/https_key.pem'), 'utf8')
    const secure = https.createServer({ cert, key }, (req, res) => res.writeHead(200).end(`secure ${req.url}`))
    secure.on('connection', track)
    await new Promise<void>((r) => secure.listen(0, '127.0.0.1', () => r()))
    const port = (secure.address() as net.AddressInfo).port
    try {
      const route: Route = { kind: 'proxy', proxy: { type: 'http', host: '127.0.0.1', port: httpOpen.port }, source: 'settings' }
      const f = createProxyFetch(fixed(route), undefined, [cert])
      const res = await f(`https://localhost:${port}/hello`)
      expect(await res.text()).toBe('secure /hello')
      // Without trusting the certificate the request fails (no silent downgrade).
      await expect(createProxyFetch(fixed(route))(`https://localhost:${port}/`)).rejects.toThrow(/fetch failed/)
    } finally {
      secure.close()
    }
  })

  it('aborts a pending request', async () => {
    const hang = net.createServer((s) => track(s))
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()))
    const port = (hang.address() as net.AddressInfo).port
    try {
      const f = createProxyFetch(fixed({ kind: 'proxy', proxy: { type: 'socks5', host: '127.0.0.1', port: socksOpen.port }, source: 'settings' }))
      const ac = new AbortController()
      const p = f(`http://web.test:${port}/`, { signal: ac.signal })
      setTimeout(() => ac.abort(), 100)
      await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      hang.close()
    }
  })

  it('surfaces proxy failures in Anthropic SDK errors', async () => {
    const f = createProxyFetch(fixed({ kind: 'proxy', proxy: { type: 'http', host: '127.0.0.1', port: httpAuth.port, username: 'alice', password: 'bad' }, source: 'settings' }))
    const client = new Anthropic({ apiKey: 'test', fetch: f, maxRetries: 0 })
    const e = await client.messages.create({ model: 'claude-test', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }).catch((err: unknown) => err)
    expect(friendlyError(e).message).toMatch(/^Could not reach the Anthropic API through the proxy: The HTTP proxy .* rejected the user name or password/)
  })
})
