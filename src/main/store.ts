import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { SECRET_PATHS, uriHasPassword } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import type { AppSettings, DefaultQueryMatch, DefaultQueryScope, SavedQuery, SavedSession } from '@shared/api'
import { DEFAULT_SETTINGS, normalizeSettings } from '@shared/settings'

export { DEFAULT_SETTINGS }

export interface SecretCodec {
  encrypt(plain: string): Promise<string>
  decrypt(stored: string): Promise<string>
}

/** Prefix marking an encrypted value; values without it are legacy plain text. */
const ENC = 'enc:'
/** App secret holding the proxy password of Settings → Network & tools. */
export const PROXY_SECRET = 'proxyPassword'

interface StoreFile {
  version: 1
  connections: ConnectionConfig[]
  settings: AppSettings
  /** Keys: `configId`, `configId/db`, `configId/db/coll`. */
  defaultQueries: Record<string, SavedQuery>
  /** App-level secrets (e.g. the Anthropic API key), encrypted like connection passwords. */
  secrets?: Record<string, string>
  /** Tabs open when the app was last used. */
  session?: SavedSession
}

const SCOPES: DefaultQueryScope[] = ['collection', 'database', 'connection']

export function defaultQueryKey(configId: string, scope: DefaultQueryScope, db: string, coll: string): string {
  if (scope === 'connection') return configId
  if (scope === 'database') return `${configId}/${db}`
  return `${configId}/${db}/${coll}`
}

/** Saved connections and settings in a JSON file; secrets encrypted with the OS keychain. */
export class Store {
  private data: StoreFile | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private file: string,
    private codec: SecretCodec
  ) {}

  static path(userData: string): string {
    return join(userData, 'shardwise.json')
  }

  private async load(): Promise<StoreFile> {
    if (this.data) return this.data
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<StoreFile>
      this.data = {
        version: 1,
        connections: raw.connections ?? [],
        settings: normalizeSettings(raw.settings),
        defaultQueries: raw.defaultQueries ?? {},
        secrets: raw.secrets,
        session: raw.session ? { ...raw.session, savedAt: new Date(raw.session.savedAt) } : undefined
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.data = { version: 1, connections: [], settings: normalizeSettings({}), defaultQueries: {} }
    }
    return this.data
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writing = this.writing.then(async () => {
      await fs.mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.file)
    })
    return this.writing
  }

  private async mapSecrets(c: ConnectionConfig, fn: (v: string) => Promise<string>): Promise<ConnectionConfig> {
    const out = structuredClone(c)
    for (const [section, key] of SECRET_PATHS) {
      const obj = out[section] as unknown as Record<string, string | undefined>
      if (obj && obj[key]) obj[key] = await fn(obj[key]!)
    }
    // Raw connection strings can carry a password too.
    if (out.uri && (out.uri.startsWith(ENC) || uriHasPassword(out.uri))) out.uri = await fn(out.uri)
    return out
  }

  async listConnections(): Promise<ConnectionConfig[]> {
    const d = await this.load()
    return Promise.all(d.connections.map((c) => this.reveal(c)))
  }

  async getConnection(id: string): Promise<ConnectionConfig> {
    const d = await this.load()
    const c = d.connections.find((x) => x.id === id)
    if (!c) throw new Error(`Connection ${id} not found`)
    return this.reveal(c)
  }

  private reveal(c: ConnectionConfig): Promise<ConnectionConfig> {
    return this.mapSecrets(c, async (v) => {
      if (!v.startsWith(ENC)) return v
      try {
        return await this.codec.decrypt(v.slice(ENC.length))
      } catch {
        // Keychain changed or unavailable: treat the secret as missing rather than failing the whole list.
        return ''
      }
    })
  }

  async saveConnection(c: ConnectionConfig): Promise<ConnectionConfig> {
    const d = await this.load()
    const saved: ConnectionConfig = { ...c, id: c.id || randomUUID() }
    const sealed = await this.mapSecrets(saved, async (v) => ENC + (await this.codec.encrypt(v)))
    const i = d.connections.findIndex((x) => x.id === saved.id)
    if (i >= 0) d.connections[i] = sealed
    else d.connections.push(sealed)
    await this.persist()
    return saved
  }

  async deleteConnection(id: string): Promise<void> {
    const d = await this.load()
    d.connections = d.connections.filter((c) => c.id !== id)
    for (const k of Object.keys(d.defaultQueries)) if (k === id || k.startsWith(`${id}/`)) delete d.defaultQueries[k]
    await this.persist()
  }

  async reorderConnections(ids: string[]): Promise<void> {
    const d = await this.load()
    const rank = new Map(ids.map((id, i) => [id, i]))
    d.connections.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
    await this.persist()
  }

  async getDefaultQuery(configId: string, db: string, coll: string): Promise<DefaultQueryMatch | null> {
    const d = await this.load()
    for (const scope of SCOPES) {
      const v = d.defaultQueries[defaultQueryKey(configId, scope, db, coll)]
      if (v) return { scope, value: v }
    }
    return null
  }

  async listDefaultQueries(configId: string, db: string, coll: string): Promise<DefaultQueryScope[]> {
    const d = await this.load()
    return SCOPES.filter((s) => d.defaultQueries[defaultQueryKey(configId, s, db, coll)])
  }

  async setDefaultQuery(configId: string, scope: DefaultQueryScope, db: string, coll: string, value: SavedQuery | null): Promise<void> {
    const d = await this.load()
    const key = defaultQueryKey(configId, scope, db, coll)
    if (value) d.defaultQueries[key] = value
    else delete d.defaultQueries[key]
    await this.persist()
  }

  async getSession(): Promise<SavedSession | null> {
    return (await this.load()).session ?? null
  }

  async saveSession(s: SavedSession): Promise<void> {
    const d = await this.load()
    d.session = s
    await this.persist()
  }

  async getSecret(name: string): Promise<string | undefined> {
    const v = (await this.load()).secrets?.[name]
    if (!v) return undefined
    try {
      return v.startsWith(ENC) ? await this.codec.decrypt(v.slice(ENC.length)) : v
    } catch {
      return undefined
    }
  }

  async setSecret(name: string, value: string | null): Promise<void> {
    const d = await this.load()
    d.secrets = { ...d.secrets }
    if (value) d.secrets[name] = ENC + (await this.codec.encrypt(value))
    else delete d.secrets[name]
    await this.persist()
  }

  /** Settings as the renderer sees them: `proxy.hasPassword` tells whether a proxy password is saved. */
  private view(d: StoreFile): AppSettings {
    const s = structuredClone(d.settings)
    s.proxy = { ...s.proxy, hasPassword: !!d.secrets?.[PROXY_SECRET] }
    return s
  }

  async getSettings(): Promise<AppSettings> {
    return this.view(await this.load())
  }

  /** `s.proxy.password` (write-only) replaces the saved proxy password ('' removes it); it is never stored in the settings. */
  async saveSettings(s: Partial<AppSettings>): Promise<AppSettings> {
    const d = await this.load()
    const password = s.proxy?.password
    if (password !== undefined) {
      d.secrets = { ...d.secrets }
      if (password) d.secrets[PROXY_SECRET] = ENC + (await this.codec.encrypt(password))
      else delete d.secrets[PROXY_SECRET]
    }
    d.settings = normalizeSettings({ ...d.settings, ...s })
    await this.persist()
    const out = this.view(d)
    for (const cb of this.settingsListeners) cb(out)
    return structuredClone(out)
  }

  /** The saved proxy password (Settings → Network & tools). */
  proxyPassword(): Promise<string | undefined> {
    return this.getSecret(PROXY_SECRET)
  }

  private settingsListeners: ((s: AppSettings) => void)[] = []

  /** Called after every settings save (e.g. to re-apply the proxy). */
  onSettingsSaved(cb: (s: AppSettings) => void): void {
    this.settingsListeners.push(cb)
  }
}
