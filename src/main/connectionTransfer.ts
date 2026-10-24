import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { buildUri, newConnectionConfig, parseUri, SECRET_PATHS, stripUriPassword } from '@shared/connection'
import type { AuthMechanism, ConnectionConfig } from '@shared/connection'
import type { ConnectionImportPreview } from '@shared/api'

/**
 * Connection import / export. Reads Shardwise exports, Studio 3T exports, MongoDB Compass exports,
 * Robo 3T configs and plain URI lists; writes Shardwise JSON (passwords optional, passphrase-encrypted)
 * or a URI list.
 */

const TYPE = 'Shardwise Connections'
/** Exports written before the rename. */
const LEGACY_TYPE = 'MongoGuru Connections'

interface Sealed {
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  data: string
}

interface ExportFile {
  type: typeof TYPE
  version: 1
  exportedAt: string
  /** Present when passwords were exported: the full connection list, encrypted with the passphrase. */
  encrypted?: Sealed
  /** Connections without secrets (always present so the file is readable without the passphrase). */
  connections: ConnectionConfig[]
}

const key = (passphrase: string, salt: Buffer): Buffer => scryptSync(passphrase, salt, 32)

function seal(plain: string, passphrase: string): Sealed {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(passphrase, salt), iv)
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return { kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function unseal(s: Sealed, passphrase: string): string {
  const d = createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(s.salt, 'base64')), Buffer.from(s.iv, 'base64'))
  d.setAuthTag(Buffer.from(s.tag, 'base64'))
  try {
    return Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8')
  } catch {
    throw new Error('Wrong passphrase')
  }
}

export function stripSecrets(c: ConnectionConfig): ConnectionConfig {
  const out = structuredClone(c)
  for (const [section, k] of SECRET_PATHS) {
    const obj = out[section] as unknown as Record<string, unknown> | undefined
    if (obj) delete obj[k]
  }
  if (out.uri) out.uri = stripUriPassword(out.uri)
  return out
}

export function exportConnections(conns: ConnectionConfig[], o: { format: 'shardwise' | 'uri'; includePasswords: boolean; passphrase?: string }): string {
  if (o.format === 'uri') {
    return conns.map((c) => `# ${c.name}\n${buildUri(c, o.includePasswords)}`).join('\n\n') + '\n'
  }
  const file: ExportFile = { type: TYPE, version: 1, exportedAt: new Date().toISOString(), connections: conns.map(stripSecrets) }
  if (o.includePasswords) {
    if (!o.passphrase) throw new Error('A passphrase is required to export passwords')
    file.encrypted = seal(JSON.stringify(conns), o.passphrase)
  }
  return JSON.stringify(file, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined)
const num = (v: unknown, d: number): number => {
  const n = Number(typeof v === 'object' && v ? ((v as Json).$numberInt ?? (v as Json).$numberLong ?? NaN) : v)
  return Number.isFinite(n) && n > 0 ? n : d
}
const bool = (v: unknown): boolean => v === true || v === 'true'

/** Strip `//` and `#` comment lines (Studio 3T exports start with comment headers). */
const stripComments = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|#)/.test(l))
    .join('\n')

function withName(c: ConnectionConfig, name: string | undefined): ConnectionConfig {
  return { ...c, id: '', name: name || c.srvHost || c.hosts[0]?.host || 'Imported connection' }
}

function fromUri(uri: string, name?: string): ConnectionConfig {
  return withName(parseUri(uri, newConnectionConfig()), name)
}

function mechanismOf(v: unknown): AuthMechanism {
  const m = String(v ?? '').toUpperCase()
  if (m.includes('256')) return 'SCRAM-SHA-256'
  if (m.includes('SCRAM') || m.includes('SHA-1') || m === 'MONGODB-CR') return 'SCRAM-SHA-1'
  if (m.includes('X509') || m.includes('X.509')) return 'MONGODB-X509'
  if (m.includes('PLAIN') || m.includes('LDAP')) return 'PLAIN'
  if (m.includes('GSSAPI') || m.includes('KERBEROS')) return 'GSSAPI'
  if (m.includes('AWS')) return 'MONGODB-AWS'
  return 'DEFAULT'
}

function fromRobo(c: Json): ConnectionConfig {
  const base = newConnectionConfig()
  const rs = obj(c.replicaSet)
  const members = Array.isArray(rs.members) ? (rs.members as unknown[]).map(String) : []
  const isRs = bool(c.isReplicaSet) && members.length > 0
  const cred = (Array.isArray(c.credentials) ? (c.credentials as Json[]) : []).find((x) => bool(x.enabled)) ?? {}
  const ssh = obj(c.ssh)
  const ssl = obj(c.ssl)
  const out: ConnectionConfig = {
    ...base,
    mode: isRs ? 'replicaSet' : 'standalone',
    hosts: isRs
      ? members.map((m) => ({ host: m.split(':')[0], port: num(m.split(':')[1], 27017) }))
      : [{ host: str(c.serverHost) ?? 'localhost', port: num(c.serverPort, 27017) }],
    replicaSet: isRs ? str(rs.setName) : undefined,
    auth: str(cred.userName)
      ? { mechanism: mechanismOf(cred.mechanism), username: str(cred.userName), password: str(cred.userPassword), authSource: str(cred.databaseName) ?? 'admin' }
      : base.auth,
    tls: {
      enabled: bool(ssl.enabled),
      caFile: str(ssl.caFile),
      certKeyFile: str(ssl.pemKeyFile),
      certKeyPassword: str(ssl.pemPassPhrase),
      allowInvalidCertificates: bool(ssl.allowInvalidCertificates) || undefined,
      allowInvalidHostnames: bool(ssl.allowInvalidHostnames) || undefined
    },
    ssh: {
      enabled: bool(ssh.enabled),
      host: str(ssh.host),
      port: num(ssh.port, 22),
      username: str(ssh.userName),
      method: str(ssh.method) === 'publickey' || str(ssh.privateKeyFile) ? 'key' : 'password',
      password: str(ssh.userPassword),
      keyFile: str(ssh.privateKeyFile),
      passphrase: str(ssh.passphrase)
    },
    options: { defaultDb: str(c.defaultDatabase) }
  }
  return withName(out, str(c.connectionName))
}

function fromCompass(c: Json): ConnectionConfig | null {
  const opts = obj(c.connectionOptions)
  const uri = str(opts.connectionString)
  if (!uri) return null
  const fav = obj(c.favorite)
  const out = fromUri(uri, str(fav.name))
  const ssh = obj(opts.sshTunnel)
  if (str(ssh.host)) {
    out.ssh = {
      enabled: true,
      host: str(ssh.host),
      port: num(ssh.port, 22),
      username: str(ssh.username),
      method: str(ssh.identityKeyFile) ? 'key' : 'password',
      password: str(ssh.password),
      keyFile: str(ssh.identityKeyFile),
      passphrase: str(ssh.identityKeyPassphrase)
    }
  }
  return out
}

/**
 * Studio 3T exports are JSON with comment headers. Field names vary between versions, so look for the
 * common ones and fall back to an embedded connection string.
 */
function fromStudio3t(c: Json): ConnectionConfig | null {
  const name = str(c.name) ?? str(c.connectionName) ?? str(c.serverName)
  const uri = str(c.connectionString) ?? str(c.uri) ?? str(c.mongoUri) ?? str(obj(c.connectionOptions).connectionString)
  if (uri && /^mongodb(\+srv)?:\/\//.test(uri)) return fromUri(uri, name)
  const servers = (Array.isArray(c.serverList) ? c.serverList : Array.isArray(c.servers) ? c.servers : Array.isArray(c.hosts) ? c.hosts : []) as unknown[]
  const hosts = servers
    .map((s) => (typeof s === 'string' ? s : `${str(obj(s).host) ?? str(obj(s).hostName) ?? ''}:${num(obj(s).port, 27017)}`))
    .filter((h) => h && !h.startsWith(':'))
  const single = str(c.host) ?? str(c.hostName) ?? str(c.serverHost)
  if (!hosts.length && single) hosts.push(`${single}:${num(c.port ?? c.serverPort, 27017)}`)
  if (!hosts.length) return null
  const base = newConnectionConfig()
  const srv = bool(c.srv) || bool(c.isSrv) || /srv/i.test(str(c.connectionType) ?? '')
  const user = str(c.userName) ?? str(c.username) ?? str(obj(c.authentication).userName) ?? str(obj(c.credentials).userName)
  const out: ConnectionConfig = {
    ...base,
    mode: srv ? 'srv' : hosts.length > 1 ? 'replicaSet' : 'standalone',
    srvHost: srv ? hosts[0].split(':')[0] : undefined,
    hosts: hosts.map((h) => ({ host: h.split(':')[0], port: num(h.split(':')[1], 27017) })),
    replicaSet: str(c.replicaSetName) ?? str(c.replicaSet),
    auth: user
      ? { mechanism: mechanismOf(c.authMode ?? c.authMechanism ?? obj(c.authentication).mechanism), username: user, authSource: str(c.authDatabase) ?? str(c.authenticationDatabase) ?? 'admin' }
      : base.auth,
    tls: { enabled: bool(c.useSsl) || bool(c.ssl) || bool(c.tls) || srv },
    options: { defaultDb: str(c.defaultDatabase) ?? str(c.database) }
  }
  return withName(out, name)
}

const URI_LINE = /^mongodb(\+srv)?:\/\//i
const isComment = (l: string): boolean => l.startsWith('#') || l.startsWith('//')

/** Only connection strings, comments and blank lines. */
function isUriList(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.some((l) => URI_LINE.test(l)) && lines.every((l) => URI_LINE.test(l) || isComment(l))
}

/** Studio 3T's file header ("Connections Exported from Studio 3T …", "Exported on …") is not a connection name. */
const HEADER_COMMENT = /studio 3t|^exported on\b/i

/** Never echo a connection string (it may hold a password) in messages. */
const redact = (msg: string): string => msg.replace(/mongodb(\+srv)?:\/\/\S+/gi, '<connection string>')

/** Mechanisms that authenticate with a password. */
const PASSWORD_MECHANISMS = new Set<AuthMechanism>(['DEFAULT', 'SCRAM-SHA-1', 'SCRAM-SHA-256', 'PLAIN'])

interface Studio3tSettings {
  /** Lower-cased `3t.` option names (without the prefix) → values. */
  values: Map<string, string>
  /** Option names as written, for messages. */
  names: Map<string, string>
}

/** Split Studio 3T's `3t.*` options off a connection string; `srvServiceName=mongodb` is the default and dropped. */
function splitStudio3tOptions(uri: string): { uri: string; t3: Studio3tSettings } {
  const t3: Studio3tSettings = { values: new Map(), names: new Map() }
  const q = uri.indexOf('?')
  if (q < 0) return { uri, t3 }
  const keep = new URLSearchParams()
  for (const [k, v] of new URLSearchParams(uri.slice(q + 1))) {
    if (k.toLowerCase().startsWith('3t.')) {
      const key = k.slice(3).toLowerCase()
      t3.values.set(key, v)
      t3.names.set(key, k)
    } else if (!(k.toLowerCase() === 'srvservicename' && v.toLowerCase() === 'mongodb')) keep.append(k, v)
  }
  const rest = keep.toString()
  return { uri: uri.slice(0, q) + (rest ? `?${rest}` : ''), t3 }
}

const flag = (v: string | undefined): boolean | undefined => (v === undefined ? undefined : /^(true|1|yes)$/i.test(v))

/**
 * Studio 3T options we understand (names as found in real exports; Studio 3T does not document them). The rest are
 * listed by name only in a warning. Format 2 used `3t.` keys for timeouts and topology; format 3 uses driver options.
 */
const KNOWN_3T = new Set([
  'uriversion',
  'connection.name',
  'databases',
  'alwaysshowauthdb',
  'alwaysshowdbfromuserrole',
  'alwaysshowcollections',
  'ssltlsversion',
  'sslselfsignedcerts',
  'defaultcolor',
  'connectionmode',
  'proxytype',
  'ssh',
  'sshaddress',
  'sshport',
  'sshuser',
  'sshauthmode',
  'sshpassword',
  'sshpkpath',
  'sharded',
  'connecttimeout',
  'sockettimeout'
])

const hex2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

function applyStudio3t(c: ConnectionConfig, t3: Studio3tSettings): void {
  const v = t3.values
  // SSH tunnel (sshPassword is a secret like the database password: kept encrypted at rest).
  if (flag(v.get('ssh')) && v.get('sshaddress')) {
    const keyAuth = /key/i.test(v.get('sshauthmode') ?? '') || !!v.get('sshpkpath')
    c.ssh = {
      ...c.ssh,
      enabled: true,
      host: v.get('sshaddress'),
      port: Number(v.get('sshport')) || 22,
      username: v.get('sshuser') || undefined,
      method: keyAuth ? 'key' : 'password',
      password: keyAuth ? undefined : v.get('sshpassword') || undefined,
      keyFile: keyAuth ? v.get('sshpkpath') || undefined : undefined
    }
  }
  if (flag(v.get('sslselfsignedcerts'))) c.tls = { ...c.tls, enabled: true, allowInvalidCertificates: true }
  if (/^direct$/i.test(v.get('connectionmode') ?? '')) c.directConnection = true
  const rgb = (v.get('defaultcolor') ?? '').split(',').map((s) => Number(s.trim()))
  if (rgb.length === 3 && rgb.every((n) => Number.isFinite(n))) c.color = `#${rgb.map(hex2).join('')}`
  // Format 2 timeouts (milliseconds); format 3 writes connectTimeoutMS / socketTimeoutMS instead.
  const connectTimeout = Number(v.get('connecttimeout'))
  if (connectTimeout > 0 && !c.options.connectTimeoutMS) c.options = { ...c.options, connectTimeoutMS: connectTimeout }
  const socketTimeout = Number(v.get('sockettimeout'))
  if (socketTimeout > 0 && !/socketTimeoutMS=/i.test(c.options.extra ?? '')) {
    c.options = { ...c.options, extra: [c.options.extra, `socketTimeoutMS=${socketTimeout}`].filter(Boolean).join('&') }
  }
  // Databases to show: the listed ones, plus the auth database and the databases granted by roles when asked.
  const listed = (v.get('databases') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const showAuthDb = flag(v.get('alwaysshowauthdb'))
  const showRoleDbs = flag(v.get('alwaysshowdbfromuserrole'))
  if (listed.length || showAuthDb !== undefined || showRoleDbs !== undefined) {
    const names = [...listed]
    const authDb = c.auth.mechanism !== 'none' ? c.auth.authSource : undefined
    if (showAuthDb && authDb && !names.includes(authDb)) names.push(authDb)
    // Ours: "auto" lists what the server allows plus role databases; "manual" shows exactly the list.
    c.databases = { mode: showRoleDbs === false && names.length ? 'manual' : 'auto', names: names.length ? names : undefined }
  }
  const tlsVersion = v.get('ssltlsversion')
  if (tlsVersion && !/^(none|off|false)$/i.test(tlsVersion)) c.tls = { ...c.tls, enabled: true }
}

/** Legacy driver options some exports carry (removed from current drivers) → our TLS fields. */
function applyLegacyTls(c: ConnectionConfig): void {
  const extra = new URLSearchParams(c.options.extra ?? '')
  let changed = false
  for (const [k, val] of [...extra]) {
    const key = k.toLowerCase()
    if (key === 'sslinvalidhostnameallowed' || key === 'sslallowinvalidhostnames') c.tls = { ...c.tls, allowInvalidHostnames: flag(val) || undefined }
    else if (key === 'sslallowinvalidcertificates') c.tls = { ...c.tls, allowInvalidCertificates: flag(val) || undefined }
    else continue
    extra.delete(k)
    changed = true
  }
  if (changed) c.options = { ...c.options, extra: extra.toString() || undefined }
}

/** One connection string of a URI list or Studio 3T URI export. */
function fromListedUri(line: string, commentName: string | undefined): { conn: ConnectionConfig; t3: Studio3tSettings } {
  const { uri, t3 } = splitStudio3tOptions(line)
  const conn = fromUri(uri, t3.values.get('connection.name')?.trim() || commentName)
  applyStudio3t(conn, t3)
  applyLegacyTls(conn)
  return { conn, t3 }
}

function parseUriList(text: string): ConnectionImportPreview {
  const warnings: string[] = []
  const connections: ConnectionConfig[] = []
  const unknown = new Set<string>()
  const noPassword: string[] = []
  let studio3t = /studio 3t/i.test(text)
  let newestVersion = 0
  let pendingName: string | undefined
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim()
    if (!l) return
    if (isComment(l)) {
      const name = l.replace(/^(\/\/|#)\s*/, '').trim()
      if (name && !HEADER_COMMENT.test(name)) pendingName = name
      return
    }
    try {
      const { conn, t3 } = fromListedUri(l, pendingName)
      if (t3.values.size) studio3t = true
      newestVersion = Math.max(newestVersion, Number(t3.values.get('uriversion')) || 0)
      for (const [key, name] of t3.names) if (!KNOWN_3T.has(key)) unknown.add(name)
      // Exports made without passwords: ask at connect time instead of failing to authenticate.
      if (conn.auth.username && !conn.auth.password && PASSWORD_MECHANISMS.has(conn.auth.mechanism)) {
        conn.auth = { ...conn.auth, askPassword: true }
        noPassword.push(conn.name)
      }
      connections.push(conn)
    } catch (e) {
      warnings.push(`Line ${i + 1}: skipped a connection string that could not be read (${redact((e as Error).message)})`)
    }
    pendingName = undefined
  })
  if (noPassword.length) {
    warnings.push(`${noPassword.length} connection${noPassword.length === 1 ? ' has' : 's have'} no saved password and will ask for it when connecting: ${noPassword.join(', ')}`)
  }
  if (unknown.size) warnings.push(`Studio 3T settings not imported: ${[...unknown].sort().join(', ')}`)
  if (newestVersion > 3) warnings.push(`Made by a newer Studio 3T (URI format ${newestVersion}); check the imported settings.`)
  return { format: studio3t ? 'Studio 3T URI export' : 'URI list', connections, warnings, needsPassphrase: false }
}

function looksLikeConnectionList(v: unknown): Json[] | null {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object') as Json[]
  const o = obj(v)
  for (const k of ['connections', 'connectionList', 'items', 'mongoConnections']) if (Array.isArray(o[k])) return o[k] as Json[]
  return null
}

/** Parse an import file. `passphrase` is needed only for Shardwise exports that include passwords. */
export function parseConnectionImport(text: string, passphrase?: string): ConnectionImportPreview {
  const warnings: string[] = []
  const trimmed = text.trim()

  // URI lists: plain ones and Studio 3T's "Export connections → URI" files (comment headers, a "// name" line
  // before each connection, Studio 3T settings as `3t.*` query options). Any of these parts may be missing.
  if (isUriList(trimmed)) return parseUriList(trimmed)

  let json: unknown
  try {
    json = JSON.parse(stripComments(text))
  } catch {
    throw new Error('Unrecognised file: expected a JSON export (Shardwise, Studio 3T, Compass, Robo 3T) or a list of mongodb:// URIs')
  }
  const root = obj(json)

  if (root.type === TYPE || root.type === LEGACY_TYPE) {
    const file = root as unknown as ExportFile
    if (file.encrypted) {
      if (!passphrase) {
        return { format: 'Shardwise', connections: file.connections.map((c) => ({ ...c, id: '' })), warnings: ['Passwords are encrypted; enter the passphrase to import them.'], needsPassphrase: true }
      }
      const conns = JSON.parse(unseal(file.encrypted, passphrase)) as ConnectionConfig[]
      return { format: 'Shardwise (with passwords)', connections: conns.map((c) => ({ ...c, id: '' })), warnings, needsPassphrase: false }
    }
    return { format: 'Shardwise', connections: file.connections.map((c) => ({ ...c, id: '' })), warnings, needsPassphrase: false }
  }

  if (root.type === 'Compass Connections' || (Array.isArray(root.connections) && (root.connections as Json[]).some((c) => obj(c).connectionOptions))) {
    const list = (root.connections as Json[]) ?? []
    const connections = list.map(fromCompass).filter((c): c is ConnectionConfig => !!c)
    if (list.some((c) => obj(c).connectionSecrets)) warnings.push('Compass passwords were exported encrypted; re-enter them after import.')
    return { format: 'MongoDB Compass', connections, warnings, needsPassphrase: false }
  }

  const list = looksLikeConnectionList(json)
  if (!list) throw new Error('No connections found in the file')
  if (list.some((c) => 'serverHost' in c || 'connectionName' in c)) {
    return { format: 'Robo 3T', connections: list.map(fromRobo), warnings, needsPassphrase: false }
  }
  const connections: ConnectionConfig[] = []
  for (const c of list) {
    const parsed = fromStudio3t(c)
    if (parsed) connections.push(parsed)
    else warnings.push(`Skipped an entry without host information${str(c.name) ? ` (${str(c.name)})` : ''}`)
  }
  if (connections.length) warnings.push('Studio 3T keeps passwords in its own key store; enter them again after import.')
  return { format: /Studio 3T/i.test(text.slice(0, 200)) ? 'Studio 3T' : 'JSON', connections, warnings, needsPassphrase: false }
}
