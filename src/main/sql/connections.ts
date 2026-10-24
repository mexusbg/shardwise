import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { SqlConnectionConfig } from '@shared/migrationApi'
import type { SecretCodec } from '../store'

/** Same marker as src/main/store.ts: values with it are encrypted with the OS keychain. */
const ENC = 'enc:'

interface SqlStoreFile {
  version: 1
  connections: SqlConnectionConfig[]
}

type Secret = (c: SqlConnectionConfig) => { get(): string | undefined; set(v: string): void }

const SECRETS: Secret[] = [
  (c) => ({ get: () => c.password, set: (v) => (c.password = v) }),
  (c) => ({ get: () => c.ssh?.password, set: (v) => (c.ssh.password = v) }),
  (c) => ({ get: () => c.ssh?.passphrase, set: (v) => (c.ssh.passphrase = v) })
]

/** Saved SQL connections in `sql-connections.json`; passwords encrypted like MongoDB connection passwords. */
export class SqlConnectionStore {
  private data: SqlStoreFile | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private file: string,
    private codec: SecretCodec
  ) {}

  static path(userData: string): string {
    return join(userData, 'sql-connections.json')
  }

  private async load(): Promise<SqlStoreFile> {
    if (this.data) return this.data
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<SqlStoreFile>
      this.data = { version: 1, connections: raw.connections ?? [] }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.data = { version: 1, connections: [] }
    }
    return this.data
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writing = this.writing.then(async () => {
      await fs.mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.file)
    })
    return this.writing
  }

  private async mapSecrets(c: SqlConnectionConfig, fn: (v: string) => Promise<string>): Promise<SqlConnectionConfig> {
    const out = structuredClone(c)
    out.ssh ??= { enabled: false }
    for (const s of SECRETS) {
      const acc = s(out)
      const v = acc.get()
      if (v) acc.set(await fn(v))
    }
    return out
  }

  private reveal(c: SqlConnectionConfig): Promise<SqlConnectionConfig> {
    return this.mapSecrets(c, async (v) => {
      if (!v.startsWith(ENC)) return v
      try {
        return await this.codec.decrypt(v.slice(ENC.length))
      } catch {
        return ''
      }
    })
  }

  async list(): Promise<SqlConnectionConfig[]> {
    return Promise.all((await this.load()).connections.map((c) => this.reveal(c)))
  }

  async get(id: string): Promise<SqlConnectionConfig> {
    const c = (await this.load()).connections.find((x) => x.id === id)
    if (!c) throw new Error('SQL connection not found')
    return this.reveal(c)
  }

  async save(c: SqlConnectionConfig): Promise<SqlConnectionConfig> {
    const d = await this.load()
    const saved: SqlConnectionConfig = { ...c, id: c.id || randomUUID(), name: c.name.trim() || defaultName(c) }
    const sealed = await this.mapSecrets(saved, async (v) => ENC + (await this.codec.encrypt(v)))
    const i = d.connections.findIndex((x) => x.id === saved.id)
    if (i >= 0) d.connections[i] = sealed
    else d.connections.push(sealed)
    await this.persist()
    return saved
  }

  async delete(id: string): Promise<void> {
    const d = await this.load()
    d.connections = d.connections.filter((c) => c.id !== id)
    await this.persist()
  }
}

export function defaultName(c: SqlConnectionConfig): string {
  if (c.dialect === 'sqlite') return c.file.split(/[\\/]/).pop() || 'SQLite'
  return `${c.database ? `${c.database}@` : ''}${c.host || 'localhost'}`
}
