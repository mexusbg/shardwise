import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  bypassMatches,
  chromiumProxyConfig,
  DEFAULT_PROXY_SETTINGS,
  isBypassed,
  isLoopback,
  normalizeProxySettings,
  parseBypassList,
  parsePacResult,
  pickPacEntry,
  proxySettingsProblems
} from '@shared/proxy'
import type { ProxySettings } from '@shared/proxy'
import { DEFAULT_SETTINGS, normalizeSettings } from '@shared/settings'
import { newConnectionConfig } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import { describeRoute, parseTarget, ProxyRouter, routeForConnection, routeForSettings } from '../src/main/net/proxy'
import { Store } from '../src/main/store'
import { exportConnections, parseConnectionImport, stripSecrets } from '../src/main/connectionTransfer'

const manual = (p: Partial<ProxySettings> = {}): ProxySettings => ({ ...DEFAULT_PROXY_SETTINGS, mode: 'manual', host: 'proxy.corp', port: 3128, ...p })

describe('bypass list', () => {
  const rules = parseBypassList('intranet.local, .corp.example\n*.svc.cluster ; db-*.prod 10.0.0.0/8 fd00::/8 192.168.1.5 [2001:db8::1] mongo.example:27018 <local>')

  it('splits on commas, semicolons, spaces and newlines', () => {
    expect(rules).toEqual(['intranet.local', '.corp.example', '*.svc.cluster', 'db-*.prod', '10.0.0.0/8', 'fd00::/8', '192.168.1.5', '[2001:db8::1]', 'mongo.example:27018', '<local>'])
  })

  it('matches exact host names (case-insensitive, trailing dot ignored)', () => {
    expect(bypassMatches('intranet.local', 27017, rules)).toBe(true)
    expect(bypassMatches('INTRANET.local.', 27017, rules)).toBe(true)
    expect(bypassMatches('a.intranet.local', 27017, rules)).toBe(false)
  })

  it('.domain matches the domain and its sub-domains; *.domain only sub-domains', () => {
    expect(bypassMatches('corp.example', 1, rules)).toBe(true)
    expect(bypassMatches('db.eu.corp.example', 1, rules)).toBe(true)
    expect(bypassMatches('notcorp.example', 1, rules)).toBe(false)
    expect(bypassMatches('svc.cluster', 1, rules)).toBe(false)
    expect(bypassMatches('mongo.ns.svc.cluster', 1, rules)).toBe(true)
  })

  it('supports wildcards inside names', () => {
    expect(bypassMatches('db-1.prod', 1, rules)).toBe(true)
    expect(bypassMatches('web-1.prod', 1, rules)).toBe(false)
  })

  it('matches IPv4 / IPv6 CIDR ranges and literals', () => {
    expect(bypassMatches('10.20.30.40', 1, rules)).toBe(true)
    expect(bypassMatches('11.0.0.1', 1, rules)).toBe(false)
    expect(bypassMatches('::ffff:10.1.2.3', 1, rules)).toBe(true)
    expect(bypassMatches('fd12:3456::1', 1, rules)).toBe(true)
    expect(bypassMatches('[fd12::1]', 1, rules)).toBe(true)
    expect(bypassMatches('fe80::1', 1, rules)).toBe(false)
    expect(bypassMatches('192.168.1.5', 1, rules)).toBe(true)
    expect(bypassMatches('192.168.1.6', 1, rules)).toBe(false)
    expect(bypassMatches('2001:db8:0:0:0:0:0:1', 1, rules)).toBe(true)
    // Host names are not resolved for CIDR rules.
    expect(bypassMatches('ten.example', 1, ['10.0.0.0/8'])).toBe(false)
  })

  it('limits host:port rules to that port', () => {
    expect(bypassMatches('mongo.example', 27018, rules)).toBe(true)
    expect(bypassMatches('mongo.example', 27017, rules)).toBe(false)
  })

  it('<local> matches names without a dot, * matches everything', () => {
    expect(bypassMatches('fileserver', 1, rules)).toBe(true)
    expect(bypassMatches('fileserver.lan', 1, rules)).toBe(false)
    expect(bypassMatches('anything.example', 1, ['*'])).toBe(true)
    expect(bypassMatches('anything.example', 1, [])).toBe(false)
  })

  it('always bypasses loopback', () => {
    for (const h of ['localhost', 'LOCALHOST', 'api.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
      expect(isLoopback(h), h).toBe(true)
      expect(isBypassed(h, 27017, ''), h).toBe(true)
    }
    for (const h of ['10.0.0.1', 'localhost.example.com', '::2', 'example.com']) expect(isLoopback(h), h).toBe(false)
  })
})

describe('PAC results', () => {
  it('parses proxies, SOCKS5 and DIRECT in order', () => {
    expect(parsePacResult('PROXY proxy.corp:3128; SOCKS5 10.0.0.1:1080; DIRECT')).toEqual([
      { kind: 'proxy', type: 'http', host: 'proxy.corp', port: 3128 },
      { kind: 'proxy', type: 'socks5', host: '10.0.0.1', port: 1080 },
      { kind: 'direct' }
    ])
    expect(parsePacResult('HTTP [2001:db8::5]:8080')).toEqual([{ kind: 'proxy', type: 'http', host: '2001:db8::5', port: 8080 }])
    expect(parsePacResult('PROXY proxy.corp')).toEqual([{ kind: 'proxy', type: 'http', host: 'proxy.corp', port: 80 }])
    expect(parsePacResult('  ')).toEqual([])
  })

  it('skips unsupported entries when picking', () => {
    expect(pickPacEntry(parsePacResult('HTTPS secure.corp:443; SOCKS old.corp:1080; PROXY p:8080'))).toEqual({ kind: 'proxy', type: 'http', host: 'p', port: 8080 })
    expect(pickPacEntry(parsePacResult('DIRECT'))).toEqual({ kind: 'direct' })
    expect(pickPacEntry(parsePacResult(''))).toEqual({ kind: 'direct' })
    expect(pickPacEntry(parsePacResult('SOCKS old.corp:1080'))).toBeNull()
    expect(parsePacResult('SOCKS old.corp:1080')[0]).toEqual({ kind: 'unsupported', text: 'SOCKS old.corp:1080' })
  })
})

describe('proxy settings', () => {
  it('normalizes stored values and drops secrets', () => {
    expect(normalizeProxySettings(undefined)).toEqual(DEFAULT_PROXY_SETTINGS)
    expect(normalizeProxySettings({ mode: 'bogus', type: 'ftp', port: 'x' })).toEqual(DEFAULT_PROXY_SETTINGS)
    expect(normalizeProxySettings({ mode: 'manual', type: 'socks5', host: ' [::1] ', port: '1081', username: ' u ', password: 'p', hasPassword: true, bypass: ' a \n b ' })).toEqual({
      mode: 'manual',
      type: 'socks5',
      host: '::1',
      port: 1081,
      username: 'u',
      bypass: 'a \n b'
    })
    // Out-of-range port → the type's default.
    expect(normalizeProxySettings({ type: 'socks5', port: 70000 }).port).toBe(1080)
  })

  it('is part of the app settings', () => {
    expect(DEFAULT_SETTINGS.proxy).toEqual(DEFAULT_PROXY_SETTINGS)
    expect(normalizeSettings({}).proxy).toEqual(DEFAULT_PROXY_SETTINGS)
    expect(normalizeSettings({ proxy: { mode: 'system', password: 'x' } }).proxy).toEqual({ ...DEFAULT_PROXY_SETTINGS, mode: 'system' })
  })

  it('reports incomplete manual settings', () => {
    expect(proxySettingsProblems(manual())).toEqual([])
    expect(proxySettingsProblems(manual({ host: '' }))).toEqual(['Enter the proxy host.'])
    expect(proxySettingsProblems(manual({ host: 'http://proxy' }))[0]).toMatch(/no scheme/)
    expect(proxySettingsProblems(manual({ port: 0 }))[0]).toMatch(/port/)
    expect(proxySettingsProblems({ ...DEFAULT_PROXY_SETTINGS, host: '' })).toEqual([])
  })

  it('maps to Chromium proxy rules', () => {
    expect(chromiumProxyConfig(DEFAULT_PROXY_SETTINGS)).toEqual({ mode: 'direct' })
    expect(chromiumProxyConfig({ ...DEFAULT_PROXY_SETTINGS, mode: 'system' })).toEqual({ mode: 'system' })
    expect(chromiumProxyConfig(manual({ bypass: '.corp, 10.0.0.0/8' }))).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http://proxy.corp:3128',
      proxyBypassRules: '<-loopback>;.corp;10.0.0.0/8'
    })
    expect(chromiumProxyConfig(manual({ type: 'socks5', host: 'fd00::1', port: 1080 })).proxyRules).toBe('socks5://[fd00::1]:1080')
  })

  it('parses test targets', () => {
    expect(parseTarget('api.anthropic.com:443')).toEqual({ host: 'api.anthropic.com', port: 443 })
    expect(parseTarget('[2001:db8::1]:27017')).toEqual({ host: '2001:db8::1', port: 27017 })
    expect(parseTarget('https://example.com/path')).toEqual({ host: 'example.com', port: 443 })
    expect(parseTarget('mongodb://db.example')).toEqual({ host: 'db.example', port: 27017 })
    expect(() => parseTarget('example.com')).toThrow(/host:port/)
    expect(() => parseTarget('')).toThrow(/Enter a host/)
  })
})

describe('routing', () => {
  it('follows the app settings', async () => {
    expect(await routeForSettings(DEFAULT_PROXY_SETTINGS, undefined, 'db.example', 27017)).toEqual({ kind: 'direct' })
    const r = await routeForSettings(manual({ username: 'u', bypass: '.internal' }), 'pw', 'db.example', 27017)
    expect(r).toEqual({ kind: 'proxy', proxy: { type: 'http', host: 'proxy.corp', port: 3128, username: 'u', password: 'pw' }, source: 'settings' })
    expect(describeRoute(r)).toBe('HTTP proxy proxy.corp:3128')
    expect(await routeForSettings(manual({ bypass: '.internal' }), undefined, 'db.internal', 27017)).toEqual({ kind: 'direct', reason: 'bypass' })
    expect(await routeForSettings(manual(), undefined, '127.0.0.1', 27017)).toEqual({ kind: 'direct', reason: 'loopback' })
    await expect(routeForSettings(manual({ host: '' }), undefined, 'db.example', 1)).rejects.toThrow(/Settings → Network & tools/)
  })

  it('resolves system settings through the PAC answer', async () => {
    const seen: string[] = []
    const resolve = async (url: string): Promise<string> => {
      seen.push(url)
      return url.includes('direct.example') ? 'DIRECT' : url.includes('old.example') ? 'SOCKS old:1080' : 'SOCKS5 gw.corp:1080; DIRECT'
    }
    const sys = { ...DEFAULT_PROXY_SETTINGS, mode: 'system' as const }
    expect(await routeForSettings(sys, undefined, 'db.example', 27017, resolve)).toEqual({ kind: 'proxy', proxy: { type: 'socks5', host: 'gw.corp', port: 1080 }, source: 'system' })
    expect(seen[0]).toBe('https://db.example:27017/')
    expect(await routeForSettings(sys, undefined, 'direct.example', 27017, resolve)).toEqual({ kind: 'direct' })
    await expect(routeForSettings(sys, undefined, 'old.example', 27017, resolve)).rejects.toThrow(/not supported/)
    // Without Electron (tests, scripts) "system" means direct.
    expect(await routeForSettings(sys, undefined, 'db.example', 27017)).toEqual({ kind: 'direct' })
  })

  it('lets a connection override the app settings', async () => {
    const router = new ProxyRouter()
    router.configure({ settings: async () => manual(), password: async () => undefined })
    expect((await router.route('db.example', 27017)).kind).toBe('proxy')
    expect(await router.route('db.example', 27017, { mode: 'direct' })).toEqual({ kind: 'direct' })
    expect(await router.route('db.example', 27017, { mode: 'custom', type: 'socks5', host: 'gw', username: 'a', password: 'b' })).toEqual({
      kind: 'proxy',
      proxy: { type: 'socks5', host: 'gw', port: 1080, username: 'a', password: 'b' },
      source: 'connection'
    })
    expect(() => routeForConnection({ mode: 'custom', host: '' }, 'db.example')).toThrow(/incomplete/)
    expect(await new ProxyRouter().route('db.example', 27017)).toEqual({ kind: 'direct' })
  })
})

describe('proxy secrets', () => {
  const codec = {
    encrypt: async (s: string) => Buffer.from(s).toString('base64'),
    decrypt: async (s: string) => Buffer.from(s, 'base64').toString()
  }

  it('keeps the proxy password encrypted and out of the settings', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sw-proxy-')), 'shardwise.json')
    const store = new Store(file, codec)
    expect((await store.getSettings()).proxy.hasPassword).toBe(false)
    const saved = await store.saveSettings({ proxy: { ...manual({ username: 'alice' }), password: 'pr0xy-secret' } })
    expect(saved.proxy).toMatchObject({ mode: 'manual', username: 'alice', hasPassword: true })
    expect(saved.proxy.password).toBeUndefined()
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('pr0xy-secret')
    expect(JSON.parse(raw).settings.proxy).not.toHaveProperty('password')
    const reopened = new Store(file, codec)
    expect(await reopened.proxyPassword()).toBe('pr0xy-secret')
    // Saving without a password keeps it; '' removes it.
    await reopened.saveSettings({ pageSize: 20 })
    expect(await reopened.proxyPassword()).toBe('pr0xy-secret')
    expect((await reopened.saveSettings({ proxy: { ...manual(), password: '' } })).proxy.hasPassword).toBe(false)
    expect(await reopened.proxyPassword()).toBeUndefined()
  })

  it('encrypts a connection proxy password and handles it like other secrets in exports', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sw-proxy-')), 'shardwise.json')
    const store = new Store(file, codec)
    const c: ConnectionConfig = { ...newConnectionConfig(), name: 'Remote', proxy: { mode: 'custom', type: 'http', host: 'gw', port: 3128, username: 'bob', password: 'conn-secret' } }
    const saved = await store.saveConnection(c)
    expect(readFileSync(file, 'utf8')).not.toContain('conn-secret')
    expect((await new Store(file, codec).getConnection(saved.id)).proxy?.password).toBe('conn-secret')

    expect(stripSecrets(c).proxy).toEqual({ mode: 'custom', type: 'http', host: 'gw', port: 3128, username: 'bob' })
    // Connections without a proxy section are fine.
    expect(() => stripSecrets(newConnectionConfig())).not.toThrow()

    const plain = exportConnections([c], { format: 'shardwise', includePasswords: false })
    expect(plain).not.toContain('conn-secret')
    expect(parseConnectionImport(plain).connections[0].proxy).toMatchObject({ mode: 'custom', host: 'gw', username: 'bob' })
    const sealed = exportConnections([c], { format: 'shardwise', includePasswords: true, passphrase: 'pp' })
    expect(sealed).not.toContain('conn-secret')
    expect(parseConnectionImport(sealed, 'pp').connections[0].proxy?.password).toBe('conn-secret')
    // Never part of a connection string.
    expect(exportConnections([c], { format: 'uri', includePasswords: true })).not.toMatch(/gw|proxy/i)
  })
})
