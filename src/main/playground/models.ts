import type { MongoClient } from 'mongodb'
import type { Connection, Mongoose, Schema } from 'mongoose'

/**
 * Mongoose bound to the playground's MongoClient. Models live per database (useDb) so `use('other')` switches
 * them too. Unknown capitalised identifiers become schemaless models on the matching collection.
 */
export class Models {
  private _base?: Connection
  private autoNames = new Set<string>()
  private collectionNames = new Map<string, string[]>()

  constructor(
    readonly m: Mongoose,
    private client: MongoClient,
    private currentDb: () => string
  ) {}

  /** Created on first use so scripts that never touch Mongoose don't pay for it. */
  get base(): Connection {
    return (this._base ??= this.m.createConnection().setClient(this.client))
  }

  conn(db = this.currentDb()): Connection {
    return this.base.useDb(db, { useCache: true })
  }

  /** Collection names used to resolve auto-models (fetched up front: model lookups are synchronous). */
  async preload(client: MongoClient, dbs: string[]): Promise<void> {
    await Promise.all(
      [...new Set(dbs)].map(async (db) => {
        try {
          const list = await client.db(db).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()
          this.collectionNames.set(db, list.map((c) => c.name))
        } catch {
          // Without the list the pluralised name is used.
        }
      })
    )
  }

  /** Collection for a model name: exact (case-insensitive) match, else Mongoose's pluralisation, preferring an existing collection. */
  resolveCollection(name: string, db = this.currentDb()): string {
    const existing = this.collectionNames.get(db) ?? []
    const find = (n: string): string | undefined => existing.find((c) => c.toLowerCase() === n.toLowerCase())
    const plural = this.m.pluralize()?.(name) ?? `${name.toLowerCase()}s`
    return find(name) ?? find(plural) ?? plural
  }

  auto(name: string): unknown {
    const db = this.currentDb()
    const c = this.conn(db)
    if (c.models[name]) return c.models[name]
    const collection = this.resolveCollection(name, db)
    const schema = new this.m.Schema({}, { strict: false, strictQuery: false, collection, versionKey: false, autoCreate: false, autoIndex: false })
    this.autoNames.add(`${db}\0${name}`)
    return c.model(name, schema, collection)
  }

  /** `model(name)` returns (or auto-creates) a model; `model(name, schema, collection?)` defines one, replacing an auto-model. */
  model(name: string, schema?: Schema | Record<string, unknown>, collection?: string, options?: Record<string, unknown>): unknown {
    if (!schema) return this.auto(name)
    const db = this.currentDb()
    const c = this.conn(db)
    const key = `${db}\0${name}`
    if (c.models[name] && this.autoNames.has(key)) {
      c.deleteModel(name)
      this.autoNames.delete(key)
    }
    return c.model(name, schema as Schema, collection, options)
  }

  /** The `mongoose` global: the real module, with model/connection routed to the playground connection. */
  facade(): Mongoose {
    return new Proxy(this.m, {
      get: (t, p, r) => {
        if (p === 'model') return this.model.bind(this)
        if (p === 'connection') return this.conn()
        if (p === 'models') return this.conn().models
        if (p === 'connections') return [this.base]
        return Reflect.get(t, p, r)
      }
    })
  }
}
