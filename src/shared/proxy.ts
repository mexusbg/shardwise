/**
 * Proxy settings shared by main and renderer: types, defaults, validation, bypass matching and parsing of
 * the PAC-style answers Chromium gives for the system proxy ("PROXY h:p; SOCKS5 h:p; DIRECT").
 */

export type ProxyMode = 'none' | 'system' | 'manual'
export type ProxyType = 'http' | 'socks5'

export const PROXY_TYPE_LABELS: Record<ProxyType, string> = { http: 'HTTP (CONNECT)', socks5: 'SOCKS5' }
export const DEFAULT_PROXY_PORTS: Record<ProxyType, number> = { http: 8080, socks5: 1080 }

/** App-wide proxy (Settings → Network & tools). */
export interface ProxySettings {
  /** none = direct connections; system = the operating system's proxy settings (incl. PAC); manual = the server below. */
  mode: ProxyMode
  type: ProxyType
  host: string
  port: number
  /** Optional; with "system" it answers a system proxy that asks for credentials. */
  username: string
  /** Hosts that never use the proxy: one per line or comma separated. Loopback addresses are always bypassed. */
  bypass: string
  /** Filled in by the main process when reading: a proxy password is saved (encrypted). */
  hasPassword?: boolean
  /** Write-only: a new password to save; '' removes the saved one; missing keeps it. Never returned. */
  password?: string
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = { mode: 'none', type: 'http', host: '', port: DEFAULT_PROXY_PORTS.http, username: '', bypass: '' }

/** Per-connection choice (connection editor → Proxy). Missing = 'default'. */
export interface ConnProxyConfig {
  /** default = Settings → Network & tools; direct = never through a proxy; custom = the server below. */
  mode: 'default' | 'direct' | 'custom'
  type?: ProxyType
  host?: string
  port?: number
  username?: string
  password?: string
}

/** A concrete proxy server to go through. */
export interface ProxyEndpoint {
  type: ProxyType
  host: string
  port: number
  username?: string
  password?: string
}

/** Main → renderer result of Settings → Network & tools → Test. */
export interface ProxyTestResult {
  ok: boolean
  /** How the target was reached, e.g. "HTTP proxy proxy.corp:3128" or "direct (bypass list)". */
  route?: string
  /** Time until the tunnel to the target was open. */
  ms?: number
  error?: string
}

const validPort = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Complete, type-checked proxy settings (secrets and read-only flags are dropped). */
export function normalizeProxySettings(raw: unknown): ProxySettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ProxySettings, unknown>>
  const d = DEFAULT_PROXY_SETTINGS
  const type: ProxyType = r.type === 'socks5' || r.type === 'http' ? r.type : d.type
  const mode: ProxyMode = r.mode === 'system' || r.mode === 'manual' || r.mode === 'none' ? r.mode : d.mode
  return {
    mode,
    type,
    host: stripBrackets(text(r.host)),
    port: validPort(r.port, DEFAULT_PROXY_PORTS[type]),
    username: text(r.username),
    bypass: typeof r.bypass === 'string' ? r.bypass.trim() : ''
  }
}

/** Problems that make the settings unusable (shown in Settings); empty when fine. */
export function proxySettingsProblems(s: Pick<ProxySettings, 'mode' | 'host' | 'port'>): string[] {
  const out: string[] = []
  if (s.mode !== 'manual') return out
  if (!s.host.trim()) out.push('Enter the proxy host.')
  else if (/[\s/]/.test(s.host.trim())) out.push('The proxy host must be a host name or IP address (no scheme or path).')
  if (!(Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535)) out.push('The proxy port must be between 1 and 65535.')
  return out
}

// ---------------------------------------------------------------------------
// Hosts and addresses
// ---------------------------------------------------------------------------

export const stripBrackets = (h: string): string => h.replace(/^\[(.*)\]$/, '$1')

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4Bytes(h: string): number[] | null {
  const m = IPV4.exec(h)
  if (!m) return null
  const b = m.slice(1).map(Number)
  return b.every((x) => x <= 255) ? b : null
}

/** 16 bytes of an IPv6 literal (with optional embedded IPv4), or null. */
function ipv6Bytes(h: string): number[] | null {
  let s = stripBrackets(h).toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null
  let tail: number[] = []
  const lastColon = s.lastIndexOf(':')
  const last = s.slice(lastColon + 1)
  if (last.includes('.')) {
    const v4 = ipv4Bytes(last)
    if (!v4) return null
    tail = v4
    s = s.slice(0, lastColon + 1) + '0:0'
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (x: string): number[] | null => {
    if (!x) return []
    const groups = x.split(':')
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      const n = parseInt(g, 16)
      out.push(n >> 8, n & 255)
    }
    return out
  }
  const head = part(halves[0])
  const rest = halves.length === 2 ? part(halves[1]) : []
  if (!head || !rest) return null
  let bytes: number[]
  if (halves.length === 2) {
    const fill = 16 - head.length - rest.length
    if (fill < 0) return null
    bytes = [...head, ...new Array(fill).fill(0), ...rest]
  } else bytes = head
  if (bytes.length !== 16) return null
  if (tail.length) bytes.splice(12, 4, ...tail)
  return bytes
}

/** Bytes of an IP literal (4 or 16), or null for host names. */
export function ipBytes(host: string): number[] | null {
  return ipv4Bytes(stripBrackets(host)) ?? ipv6Bytes(host)
}

/** localhost, *.localhost, 127.0.0.0/8, ::1 and IPv4-mapped loopback: never sent through a proxy. */
export function isLoopback(host: string): boolean {
  const h = stripBrackets(host.trim().toLowerCase()).replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const b = ipBytes(h)
  if (!b) return false
  if (b.length === 4) return b[0] === 127
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255
  return mapped && b[12] === 127
}

// ---------------------------------------------------------------------------
// Bypass list
// ---------------------------------------------------------------------------

/** Entries of a bypass list (newlines, commas, semicolons or spaces between them). */
export function parseBypassList(list: string): string[] {
  return list
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function inCidr(addr: number[], rule: string): boolean | null {
  const slash = rule.lastIndexOf('/')
  if (slash < 0) return null
  const net = ipBytes(rule.slice(0, slash))
  const bits = Number(rule.slice(slash + 1))
  if (!net || !Number.isInteger(bits) || bits < 0 || bits > net.length * 8) return null
  // An IPv4 rule also matches IPv4-mapped IPv6 addresses.
  let a = addr
  if (net.length === 4 && addr.length === 16 && addr.slice(0, 10).every((x) => x === 0) && addr[10] === 255 && addr[11] === 255) a = addr.slice(12)
  if (a.length !== net.length) return false
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3
    const mask = 0x80 >> (i & 7)
    if ((a[byte] & mask) !== (net[byte] & mask)) return false
  }
  return true
}

const globToRegExp = (g: string): RegExp => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

/** Rule `host:port` / `[v6]:port` → [host, port]; a bare IPv6 literal has no port. */
function splitRulePort(rule: string): [string, number | undefined] {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(rule)
  if (v6) return [v6[1], v6[2] ? Number(v6[2]) : undefined]
  const m = /^([^:]+):(\d+)$/.exec(rule)
  if (m) return [m[1], Number(m[2])]
  return [rule, undefined]
}

/**
 * Whether `host` (and `port`) matches a bypass rule:
 * - `*` everything; `<local>` plain names without a dot;
 * - `example.com` exactly that host; `.example.com` that domain and every sub-domain; `*.example.com` sub-domains only;
 *   `*` anywhere else is a wildcard (`db-*.corp`, `10.1.*`);
 * - IP literals and CIDR ranges (`10.0.0.0/8`, `fd00::/8`) match IP addresses (host names are not resolved for this);
 * - `rule:port` limits the rule to that port.
 */
export function bypassMatches(host: string, port: number | undefined, rules: string[]): boolean {
  const h = stripBrackets(host.trim().toLowerCase()).replace(/\.$/, '')
  if (!h) return false
  const addr = ipBytes(h)
  for (const raw of rules) {
    const r = raw.trim().toLowerCase()
    if (!r) continue
    if (r === '*') return true
    if (r === '<local>') {
      if (!h.includes('.') && !addr) return true
      continue
    }
    if (r.includes('/')) {
      if (addr && inCidr(addr, r)) return true
      continue
    }
    const [pattern, rulePort] = splitRulePort(r)
    if (rulePort !== undefined && rulePort !== port) continue
    const ruleAddr = ipBytes(pattern)
    if (ruleAddr) {
      if (addr && addr.length === ruleAddr.length && addr.every((x, i) => x === ruleAddr[i])) return true
      continue
    }
    if (pattern.startsWith('.')) {
      const domain = pattern.slice(1)
      if (h === domain || h.endsWith(pattern)) return true
      continue
    }
    if (pattern.includes('*')) {
      if (globToRegExp(pattern).test(h)) return true
      continue
    }
    if (h === pattern) return true
  }
  return false
}

/** True when a connection to `host:port` must not use the proxy (loopback or listed in `bypass`). */
export function isBypassed(host: string, port: number | undefined, bypass: string): boolean {
  return isLoopback(host) || bypassMatches(host, port, parseBypassList(bypass))
}

// ---------------------------------------------------------------------------
// PAC results (session.resolveProxy)
// ---------------------------------------------------------------------------

export type PacEntry = { kind: 'direct' } | { kind: 'proxy'; type: ProxyType; host: string; port: number } | { kind: 'unsupported'; text: string }

function hostPort(s: string, defaultPort: number): { host: string; port: number } | null {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort }
  const m = /^([^:\s]+)(?::(\d+))?$/.exec(s)
  if (!m) return null
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort }
}

/**
 * Parse a PAC-style proxy list, e.g. `PROXY proxy.corp:3128; SOCKS5 10.0.0.1:1080; DIRECT`. SOCKS (v4), HTTPS
 * and QUIC proxies are reported as unsupported.
 */
export function parsePacResult(result: string): PacEntry[] {
  const out: PacEntry[] = []
  for (const part of result.split(';')) {
    const t = part.trim()
    if (!t) continue
    const [word, ...rest] = t.split(/\s+/)
    const kind = word.toUpperCase()
    const target = rest.join('')
    if (kind === 'DIRECT') out.push({ kind: 'direct' })
    else if ((kind === 'PROXY' || kind === 'HTTP') && target) {
      const hp = hostPort(target, 80)
      out.push(hp ? { kind: 'proxy', type: 'http', ...hp } : { kind: 'unsupported', text: t })
    } else if (kind === 'SOCKS5' && target) {
      const hp = hostPort(target, 1080)
      out.push(hp ? { kind: 'proxy', type: 'socks5', ...hp } : { kind: 'unsupported', text: t })
    } else out.push({ kind: 'unsupported', text: t })
  }
  return out
}

/** First usable entry; an empty answer means direct. Null when every entry is unsupported. */
export function pickPacEntry(entries: PacEntry[]): Exclude<PacEntry, { kind: 'unsupported' }> | null {
  if (!entries.length) return { kind: 'direct' }
  for (const e of entries) if (e.kind !== 'unsupported') return e
  return null
}

// ---------------------------------------------------------------------------
// Chromium (Electron session) configuration
// ---------------------------------------------------------------------------

/** Settings → Electron `session.setProxy` config (used by requests Chromium makes itself). */
export function chromiumProxyConfig(s: ProxySettings): { mode: 'direct' | 'system' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string } {
  if (s.mode === 'system') return { mode: 'system' }
  if (s.mode !== 'manual' || !s.host) return { mode: 'direct' }
  const host = s.host.includes(':') ? `[${s.host}]` : s.host
  const scheme = s.type === 'socks5' ? 'socks5' : 'http'
  const rules = ['<-loopback>', ...parseBypassList(s.bypass)]
  return { mode: 'fixed_servers', proxyRules: `${scheme}://${host}:${s.port}`, proxyBypassRules: rules.join(';') }
}

/** "HTTP proxy proxy.corp:3128". */
export function describeEndpoint(p: Pick<ProxyEndpoint, 'type' | 'host' | 'port'>): string {
  const host = p.host.includes(':') ? `[${p.host}]` : p.host
  return `${p.type === 'socks5' ? 'SOCKS5' : 'HTTP'} proxy ${host}:${p.port}`
}

/** "host:port", bracketing IPv6 literals. */
export const formatHostPort = (host: string, port: number): string => `${host.includes(':') ? `[${stripBrackets(host)}]` : host}:${port}`
