import type { Collation } from './collation'
import type { ConnProxyConfig } from './proxy'

/** Saved connection settings. Secrets are plain here; the main process encrypts them at rest. */
export interface ConnectionConfig {
  id: string
  name: string
  folder?: string
  color?: string
  /** srv = mongodb+srv://host, standalone = single host, replicaSet = host list, uri = raw URI */
  mode: 'srv' | 'standalone' | 'replicaSet' | 'uri'
  uri?: string
  srvHost?: string
  hosts: { host: string; port: number }[]
  replicaSet?: string
  directConnection?: boolean
  auth: AuthConfig
  tls: TlsConfig
  ssh: SshConfig
  options: ConnOptions
  /** Visible to MCP clients through the local MCP server. */
  exposeToMcp?: boolean
  /** Every write through Shardwise (UI, jobs, MCP, AI) is refused on this connection. */
  readOnly?: boolean
  /** Which databases the tree shows (users without the listDatabases privilege). */
  databases?: VisibleDatabases
  /** Per-connection values of app preferences; a missing field means "use the global preference". */
  overrides?: ConnOverrides
  /** Proxy for this connection (to the server, or to the SSH host with a tunnel); missing = Settings → Network & tools. */
  proxy?: ConnProxyConfig
  /** Shell script run at the start of every shell session of this connection (after the Settings one). */
  shellStartupScript?: string
}

export interface VisibleDatabases {
  /**
   * auto: what the server lists (falling back to the databases the user's roles grant access to), plus `names`.
   * manual: only `names`.
   */
  mode: 'auto' | 'manual'
  names?: string[]
}

export interface ConnOverrides {
  pageSize?: number
  /** 0 = no limit. */
  queryTimeoutMS?: number
  /** Record writes in Change History on this connection; missing = follow the global setting. */
  changeHistory?: boolean
  /** Collation new query tabs of this connection start with; null = none, missing = the preference. */
  defaultCollation?: Collation | null
}

export type AuthMechanism =
  | 'none'
  | 'DEFAULT'
  | 'SCRAM-SHA-1'
  | 'SCRAM-SHA-256'
  | 'MONGODB-X509'
  | 'PLAIN'
  | 'GSSAPI'
  | 'MONGODB-AWS'

export const AUTH_LABELS: Record<AuthMechanism, string> = {
  none: 'None',
  DEFAULT: 'Username / Password (negotiate)',
  'SCRAM-SHA-1': 'SCRAM-SHA-1',
  'SCRAM-SHA-256': 'SCRAM-SHA-256',
  'MONGODB-X509': 'X.509 certificate',
  PLAIN: 'LDAP (PLAIN)',
  GSSAPI: 'Kerberos (GSSAPI)',
  'MONGODB-AWS': 'AWS IAM'
}

export interface AuthConfig {
  mechanism: AuthMechanism
  username?: string
  password?: string
  /** Prompt for the password on every connect; it is never saved. */
  askPassword?: boolean
  authSource?: string
  gssapiServiceName?: string
  awsSessionToken?: string
}

export interface TlsConfig {
  enabled: boolean
  caFile?: string
  certKeyFile?: string
  certKeyPassword?: string
  allowInvalidCertificates?: boolean
  allowInvalidHostnames?: boolean
  /** Trust the operating system's certificate store in addition to the bundled Mozilla roots (and the CA file). */
  useSystemCA?: boolean
  /** TLS server name (SNI) and the name checked against the certificate, when it differs from the host. */
  servername?: string
}

export interface SshConfig {
  enabled: boolean
  host?: string
  port?: number
  username?: string
  method?: 'password' | 'key'
  password?: string
  keyFile?: string
  passphrase?: string
  /** Prompt for the SSH password (or key passphrase) on every connect; it is never saved. */
  askPassword?: boolean
}

export type Compressor = 'zstd' | 'snappy' | 'zlib'
export const COMPRESSORS: Compressor[] = ['zstd', 'snappy', 'zlib']

export type ReadConcernLevel = 'local' | 'available' | 'majority' | 'linearizable' | 'snapshot'
export const READ_CONCERN_LEVELS: ReadConcernLevel[] = ['local', 'available', 'majority', 'linearizable', 'snapshot']

export interface WriteConcernOptions {
  /** 'majority', a number of members as text ('1') or a custom tag set name. */
  w?: string
  wtimeoutMS?: number
  journal?: boolean
}

export interface ConnOptions {
  defaultDb?: string
  readPreference?: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest'
  /** Tag sets tried in order, each `key:value,key:value`; '' matches any member. Ignored with primary. */
  readPreferenceTags?: string[]
  appName?: string
  connectTimeoutMS?: number
  serverSelectionTimeoutMS?: number
  localThresholdMS?: number
  maxPoolSize?: number
  minPoolSize?: number
  maxIdleTimeMS?: number
  /** Missing = driver default (on). */
  retryWrites?: boolean
  retryReads?: boolean
  loadBalanced?: boolean
  /** Wire compression, in order of preference. */
  compressors?: Compressor[]
  writeConcern?: WriteConcernOptions
  readConcernLevel?: ReadConcernLevel
  /** Extra URI options, `a=b&c=d`. */
  extra?: string
}

/** Fields holding secrets; encrypted at rest and redacted in exports. */
export const SECRET_PATHS = [
  ['auth', 'password'],
  ['auth', 'awsSessionToken'],
  ['tls', 'certKeyPassword'],
  ['ssh', 'password'],
  ['ssh', 'passphrase'],
  ['proxy', 'password']
] as const

export function newConnectionConfig(): ConnectionConfig {
  return {
    id: '',
    name: 'New Connection',
    mode: 'standalone',
    hosts: [{ host: 'localhost', port: 27017 }],
    auth: { mechanism: 'none', authSource: 'admin' },
    tls: { enabled: false },
    ssh: { enabled: false, port: 22, method: 'password' },
    options: {}
  }
}

const enc = encodeURIComponent

/** `mongodb://user:secret@host` → `mongodb://user@host`. */
export function stripUriPassword(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)([^@/:]*):[^@/]*@/, '$1$2@')
}

export const uriHasPassword = (uri: string): boolean => stripUriPassword(uri) !== uri

function hostList(c: ConnectionConfig): string {
  if (c.mode === 'srv') return c.srvHost || 'localhost'
  const hosts = c.mode === 'standalone' ? c.hosts.slice(0, 1) : c.hosts
  return hosts.map((h) => `${h.host}:${h.port || 27017}`).join(',') || 'localhost:27017'
}

/**
 * Build a connection string. Passwords are only embedded when `withPassword` is set;
 * the app passes credentials through driver options instead.
 */
export function buildUri(c: ConnectionConfig, withPassword = false): string {
  if (c.mode === 'uri') return withPassword ? (c.uri ?? '') : stripUriPassword(c.uri ?? '')
  const scheme = c.mode === 'srv' ? 'mongodb+srv' : 'mongodb'
  const a = c.auth
  let cred = ''
  if (a.mechanism !== 'none' && a.username) {
    cred = enc(a.username)
    if (withPassword && a.password) cred += `:${enc(a.password)}`
    cred += '@'
  }
  const q = new URLSearchParams()
  if (c.mode === 'replicaSet' && c.replicaSet) q.set('replicaSet', c.replicaSet)
  if (c.directConnection) q.set('directConnection', 'true')
  if (a.mechanism !== 'none') {
    if (a.mechanism !== 'DEFAULT') q.set('authMechanism', a.mechanism)
    const defaultSource = a.mechanism === 'MONGODB-X509' || a.mechanism === 'GSSAPI' || a.mechanism === 'MONGODB-AWS' ? '$external' : ''
    const src = a.authSource || defaultSource
    if (src) q.set('authSource', src)
    if (a.mechanism === 'GSSAPI' && a.gssapiServiceName) q.set('authMechanismProperties', `SERVICE_NAME:${a.gssapiServiceName}`)
  }
  if (c.tls.enabled) {
    q.set('tls', 'true')
    if (c.tls.allowInvalidCertificates) q.set('tlsAllowInvalidCertificates', 'true')
    if (c.tls.allowInvalidHostnames) q.set('tlsAllowInvalidHostnames', 'true')
  } else if (c.mode === 'srv') {
    q.set('tls', 'false')
  }
  const o = c.options
  if (o.readPreference && o.readPreference !== 'primary') {
    q.set('readPreference', o.readPreference)
    for (const t of o.readPreferenceTags ?? []) q.append('readPreferenceTags', t.trim())
  }
  if (o.appName) q.set('appName', o.appName)
  if (o.connectTimeoutMS) q.set('connectTimeoutMS', String(o.connectTimeoutMS))
  if (o.serverSelectionTimeoutMS) q.set('serverSelectionTimeoutMS', String(o.serverSelectionTimeoutMS))
  appendDriverOptions(q, o)
  const extra = withoutStudio3t((o.extra ?? '').replace(/^[?&]/, ''))
  // An option repeated in "Extra URI options" wins over the structured field (the driver rejects duplicates).
  if (extra) {
    const overridden = new Set([...new URLSearchParams(extra).keys()].map((k) => k.toLowerCase()))
    for (const key of [...new Set(q.keys())]) if (overridden.has(key.toLowerCase())) q.delete(key)
  }
  let qs = q.toString()
  if (extra) qs = qs ? `${qs}&${extra}` : extra
  const db = o.defaultDb ? enc(o.defaultDb) : ''
  return `${scheme}://${cred}${hostList(c)}/${db}${qs ? `?${qs}` : ''}`
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Pool, retry, compression, read / write concern options. */
function appendDriverOptions(q: URLSearchParams, o: ConnOptions): void {
  if (isNum(o.localThresholdMS)) q.set('localThresholdMS', String(o.localThresholdMS))
  if (isNum(o.maxPoolSize)) q.set('maxPoolSize', String(o.maxPoolSize))
  if (isNum(o.minPoolSize)) q.set('minPoolSize', String(o.minPoolSize))
  if (isNum(o.maxIdleTimeMS)) q.set('maxIdleTimeMS', String(o.maxIdleTimeMS))
  if (o.retryWrites !== undefined) q.set('retryWrites', String(o.retryWrites))
  if (o.retryReads !== undefined) q.set('retryReads', String(o.retryReads))
  if (o.loadBalanced) q.set('loadBalanced', 'true')
  if (o.compressors?.length) q.set('compressors', o.compressors.join(','))
  const wc = o.writeConcern
  if (wc?.w) q.set('w', wc.w)
  if (isNum(wc?.wtimeoutMS)) q.set('wtimeoutMS', String(wc.wtimeoutMS))
  if (wc?.journal !== undefined) q.set('journal', String(wc.journal))
  if (o.readConcernLevel) q.set('readConcernLevel', o.readConcernLevel)
}

const KNOWN_PARAMS = new Set([
  'replicaset',
  'directconnection',
  'authmechanism',
  'authsource',
  'authmechanismproperties',
  'tls',
  'ssl',
  'tlsallowinvalidcertificates',
  'tlsallowinvalidhostnames',
  'tlsinsecure',
  'tlscafile',
  'tlscertificatekeyfile',
  'tlscertificatekeyfilepassword',
  'readpreference',
  'appname',
  'connecttimeoutms',
  'serverselectiontimeoutms',
  'readpreferencetags',
  'localthresholdms',
  'maxpoolsize',
  'minpoolsize',
  'maxidletimems',
  'retrywrites',
  'retryreads',
  'loadbalanced',
  'compressors',
  'w',
  'wtimeoutms',
  'journal',
  'readconcernlevel'
])

const truthy = (v: string | null): boolean => v === 'true' || v === '1'

/** true / false / undefined (missing or not a boolean). */
const boolParam = (v: string | null): boolean | undefined => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined)

/** Non-negative number or undefined. */
const numParam = (v: string | null): number | undefined => {
  if (v === null || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * Parse a connection string into structured settings. Unknown options are kept in `options.extra`.
 * Throws on malformed URIs.
 */
/** Studio 3T's own settings in its connection strings (`3t.connection.name`…): the driver rejects them. */
const isStudio3tKey = (k: string): boolean => k.toLowerCase().startsWith('3t.')

/** Extra URI options without Studio 3T settings (connections saved before they were dropped on paste). */
function withoutStudio3t(extra: string): string {
  if (!/(^|&)3t\./i.test(extra)) return extra
  return new URLSearchParams([...new URLSearchParams(extra)].filter(([k]) => !isStudio3tKey(k))).toString()
}

export function parseUri(uri: string, base: ConnectionConfig = newConnectionConfig()): ConnectionConfig {
  const m = /^(mongodb(?:\+srv)?):\/\/(?:([^@/]*)@)?([^/?]*)(?:\/([^?]*))?(?:\?(.*))?$/.exec(uri.trim())
  if (!m) throw new Error('Not a valid MongoDB connection string (expected mongodb:// or mongodb+srv://)')
  const [, scheme, userinfo, hostsPart, dbPart, query] = m
  const c: ConnectionConfig = structuredClone(base)
  c.uri = undefined
  const params = new URLSearchParams(query ?? '')
  const get = (k: string): string | null => {
    for (const [key, v] of params) if (key.toLowerCase() === k.toLowerCase()) return v
    return null
  }

  if (scheme === 'mongodb+srv') {
    c.mode = 'srv'
    c.srvHost = hostsPart
  } else {
    c.hosts = hostsPart.split(',').map((h) => {
      const ipv6 = /^\[(.+)\](?::(\d+))?$/.exec(h)
      if (ipv6) return { host: `[${ipv6[1]}]`, port: Number(ipv6[2] ?? 27017) }
      const [host, port] = h.split(':')
      return { host, port: Number(port ?? 27017) }
    })
    c.replicaSet = get('replicaSet') ?? undefined
    c.mode = c.hosts.length > 1 || c.replicaSet ? 'replicaSet' : 'standalone'
  }
  c.directConnection = truthy(get('directConnection')) || undefined

  const mech = get('authMechanism') as AuthMechanism | null
  let username: string | undefined
  let password: string | undefined
  if (userinfo) {
    const i = userinfo.indexOf(':')
    username = decodeURIComponent(i >= 0 ? userinfo.slice(0, i) : userinfo)
    password = i >= 0 ? decodeURIComponent(userinfo.slice(i + 1)) : undefined
  }
  c.auth = {
    mechanism: mech ?? (username ? 'DEFAULT' : 'none'),
    username,
    password: password ?? (username ? base.auth.password : undefined),
    authSource: get('authSource') ?? (username || mech ? (dbPart ? decodeURIComponent(dbPart) : 'admin') : base.auth.authSource)
  }
  const props = get('authMechanismProperties')
  const svc = props && /SERVICE_NAME:([^,]+)/.exec(props)
  if (svc) c.auth.gssapiServiceName = svc[1]

  const tlsParam = get('tls') ?? get('ssl')
  c.tls = {
    ...c.tls,
    enabled: tlsParam === null ? scheme === 'mongodb+srv' : truthy(tlsParam),
    allowInvalidCertificates: truthy(get('tlsAllowInvalidCertificates')) || truthy(get('tlsInsecure')) || undefined,
    allowInvalidHostnames: truthy(get('tlsAllowInvalidHostnames')) || truthy(get('tlsInsecure')) || undefined,
    caFile: get('tlsCAFile') ?? c.tls.caFile,
    certKeyFile: get('tlsCertificateKeyFile') ?? c.tls.certKeyFile
  }

  const rp = get('readPreference') as ConnOptions['readPreference'] | null
  // Not passed to the driver: Studio 3T settings, and srvServiceName when it is the default (or not SRV).
  const extra = [...params].filter(
    ([k, v]) => !KNOWN_PARAMS.has(k.toLowerCase()) && !isStudio3tKey(k) && !(k.toLowerCase() === 'srvservicename' && (scheme !== 'mongodb+srv' || v === 'mongodb'))
  )
  const name3t = get('3t.connection.name')
  if (name3t && base.name === newConnectionConfig().name) c.name = name3t
  const tags = [...params].filter(([k]) => k.toLowerCase() === 'readpreferencetags').map(([, v]) => v)
  const compressors = (get('compressors') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Compressor => (COMPRESSORS as string[]).includes(s))
  const level = get('readConcernLevel') as ReadConcernLevel | null
  const writeConcern: WriteConcernOptions = { w: get('w') || undefined, wtimeoutMS: numParam(get('wtimeoutMS')), journal: boolParam(get('journal')) }
  c.options = {
    ...c.options,
    defaultDb: dbPart ? decodeURIComponent(dbPart) : undefined,
    readPreference: rp ?? undefined,
    readPreferenceTags: tags.length ? tags : undefined,
    appName: get('appName') ?? undefined,
    connectTimeoutMS: get('connectTimeoutMS') ? Number(get('connectTimeoutMS')) : undefined,
    serverSelectionTimeoutMS: get('serverSelectionTimeoutMS') ? Number(get('serverSelectionTimeoutMS')) : undefined,
    localThresholdMS: numParam(get('localThresholdMS')),
    maxPoolSize: numParam(get('maxPoolSize')),
    minPoolSize: numParam(get('minPoolSize')),
    maxIdleTimeMS: numParam(get('maxIdleTimeMS')),
    retryWrites: boolParam(get('retryWrites')),
    retryReads: boolParam(get('retryReads')),
    loadBalanced: boolParam(get('loadBalanced')) || undefined,
    compressors: compressors.length ? compressors : undefined,
    writeConcern: Object.values(writeConcern).some((v) => v !== undefined) ? writeConcern : undefined,
    readConcernLevel: level && READ_CONCERN_LEVELS.includes(level) ? level : undefined,
    extra: extra.length ? new URLSearchParams(extra).toString() : undefined
  }
  return c
}

/** Secrets the user is asked for at connect time (nothing of it is saved). */
export interface PromptedSecrets {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
}

export const AUTH_WITH_PASSWORD: AuthMechanism[] = ['DEFAULT', 'SCRAM-SHA-1', 'SCRAM-SHA-256', 'PLAIN', 'GSSAPI']

/** Which secrets have to be asked for before connecting. */
export function secretsToAsk(c: ConnectionConfig): { password: boolean; ssh: 'password' | 'passphrase' | null } {
  const password = !!c.auth.askPassword && AUTH_WITH_PASSWORD.includes(c.auth.mechanism) && c.mode !== 'uri'
  const ssh = c.ssh.enabled && c.ssh.askPassword ? (c.ssh.method === 'key' ? 'passphrase' : 'password') : null
  return { password, ssh }
}

/** Drops secrets that are asked for at connect time, so they are never stored. */
export function clearAskedSecrets(c: ConnectionConfig): ConnectionConfig {
  const out: ConnectionConfig = { ...c, auth: { ...c.auth }, ssh: { ...c.ssh } }
  if (out.auth.askPassword) delete out.auth.password
  if (out.ssh.askPassword) {
    delete out.ssh.password
    delete out.ssh.passphrase
  }
  return out
}

/** The config with the prompted secrets filled in (for the live connection only). */
export function withSecrets(c: ConnectionConfig, s: PromptedSecrets | undefined): ConnectionConfig {
  if (!s) return c
  const out: ConnectionConfig = { ...c, auth: { ...c.auth }, ssh: { ...c.ssh } }
  if (s.password !== undefined) out.auth.password = s.password
  if (s.sshPassword !== undefined) out.ssh.password = s.sshPassword
  if (s.sshPassphrase !== undefined) out.ssh.passphrase = s.sshPassphrase
  return out
}

/** Effective per-connection value: the connection's override, else the global setting. */
export function effectiveSetting<K extends keyof ConnOverrides>(c: Pick<ConnectionConfig, 'overrides'> | undefined, key: K, global: NonNullable<ConnOverrides[K]>): NonNullable<ConnOverrides[K]> {
  const v = c?.overrides?.[key]
  return (v ?? global) as NonNullable<ConnOverrides[K]>
}

/** Database names from a manual list text (one per line or comma separated). */
export function parseDbList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))]
}

/** Short "host" label for the tree and tab titles. */
export function connectionHostLabel(c: ConnectionConfig): string {
  if (c.mode === 'uri') {
    const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]*)/.exec(c.uri ?? '')
    return m ? m[1] : 'URI'
  }
  return hostList(c)
}
