import type { AggregateOptions, AggregationCursor, Collection, Db, Document, FindCursor, FindOptions, IndexDescription, MongoClient } from 'mongodb'
import type { ShellOp } from '@shared/shellOptions'

/** Keep BSON number wrappers (Int32, Double, Long) intact like the query tabs do. */
export const RAW = { promoteValues: false, promoteLongs: false } as const

const INSPECT = Symbol.for('nodejs.util.inspect.custom')
/** Short text used when a shell object ends up in a result or a log line. */
export const REPR = Symbol('mgRepr')

type Verbosity = 'queryPlanner' | 'executionStats' | 'allPlansExecution'

/** Property names that must not turn into collections (await, JSON, test frameworks, React…). */
const HIDDEN = new Set(['then', 'catch', 'finally', 'toJSON', 'inspect', 'constructor', 'asymmetricMatch', 'nodeType', 'tagName', 'prototype', '__proto__'])

function namespaceProxy<T extends object>(target: T, child: (name: string) => unknown): T {
  return new Proxy(target, {
    get(t, p, r) {
      if (typeof p === 'symbol' || p in t) return Reflect.get(t, p, r)
      if (HIDDEN.has(p) || p.startsWith('$$') || p.startsWith('@@')) return undefined
      return child(p)
    }
  })
}

const isDoc = (v: unknown): v is Document => !!v && typeof v === 'object' && !Array.isArray(v)

function requireArg(v: unknown, method: string): void {
  if (v === undefined) throw new Error(`${method}() requires a filter; pass {} to match every document`)
}

/** mongosh-style cursor: chainable, and thenable so `await`/last-expression resolves to the documents. */
export class ShellCursor {
  constructor(
    public _cursor: FindCursor | AggregationCursor,
    private _count: () => Promise<number>,
    private _explain?: Verbosity,
    private _label = 'Cursor'
  ) {}

  private _find(method: string): FindCursor {
    if (!('hint' in this._cursor)) throw new Error(`cursor.${method}() is not supported on aggregation cursors`)
    return this._cursor as FindCursor
  }

  limit(n: number): this {
    this._cursor.limit(Number(n))
    return this
  }
  skip(n: number): this {
    this._cursor.skip(Number(n))
    return this
  }
  sort(spec: Document): this {
    if ('hint' in this._cursor) (this._cursor as FindCursor).sort(spec)
    else (this._cursor as AggregationCursor).sort(spec)
    return this
  }
  project(spec: Document): this {
    this._cursor.project(spec)
    return this
  }
  projection(spec: Document): this {
    return this.project(spec)
  }
  hint(h: string | Document): this {
    this._find('hint').hint(h)
    return this
  }
  maxTimeMS(ms: number): this {
    this._cursor.maxTimeMS(Number(ms))
    return this
  }
  batchSize(n: number): this {
    this._cursor.batchSize(Number(n))
    return this
  }
  comment(c: string): this {
    this._find('comment').comment(c)
    return this
  }
  collation(c: Document): this {
    this._find('collation').collation(c as never)
    return this
  }
  allowDiskUse(allow = true): this {
    this._find('allowDiskUse').allowDiskUse(allow)
    return this
  }
  min(spec: Document): this {
    this._find('min').min(spec)
    return this
  }
  max(spec: Document): this {
    this._find('max').max(spec)
    return this
  }
  returnKey(v = true): this {
    this._find('returnKey').returnKey(v)
    return this
  }
  showRecordId(v = true): this {
    this._find('showRecordId').showRecordId(v)
    return this
  }
  noCursorTimeout(): this {
    this._cursor.addCursorFlag('noCursorTimeout', true)
    return this
  }
  map(fn: (d: Document) => unknown): this {
    this._cursor = this._cursor.map(fn) as FindCursor
    return this
  }
  pretty(): this {
    return this
  }

  toArray(): Promise<unknown[]> {
    return this._explain ? this.explain(this._explain).then((e) => [e]) : this._cursor.toArray()
  }
  async forEach(fn: (d: Document) => unknown): Promise<void> {
    for await (const d of this._cursor) if ((await fn(d)) === false) break
  }
  next(): Promise<Document | null> {
    return this._cursor.next()
  }
  tryNext(): Promise<Document | null> {
    return this._cursor.tryNext()
  }
  hasNext(): Promise<boolean> {
    return this._cursor.hasNext()
  }
  isClosed(): boolean {
    return this._cursor.closed
  }
  close(): Promise<void> {
    return this._cursor.close()
  }
  count(): Promise<number> {
    return this._count()
  }
  async size(): Promise<number> {
    return (await this._cursor.toArray()).length
  }
  async itcount(): Promise<number> {
    let n = 0
    for await (const _ of this._cursor) n++
    return n
  }
  explain(verbosity: Verbosity = 'queryPlanner'): Promise<Document> {
    return this._cursor.explain(verbosity)
  }

  /** Up to `limit` documents and whether more are available (used for the playground result). */
  async _fetch(limit: number): Promise<{ value: unknown; more: boolean }> {
    if (this._explain) return { value: await this.explain(this._explain), more: false }
    const docs: unknown[] = []
    while (docs.length < limit) {
      const d = await this._cursor.next()
      if (d === null) return { value: docs, more: false }
      docs.push(d)
    }
    const more = await this._cursor.hasNext()
    await this._cursor.close().catch(() => {})
    return { value: docs, more }
  }

  then<A = unknown[], B = never>(onOk?: ((v: unknown[] | Document) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    const p: Promise<unknown[] | Document> = this._explain ? this.explain(this._explain) : this.toArray()
    return p.then(onOk, onErr)
  }
  catch<B = never>(onErr: (e: unknown) => B | PromiseLike<B>): Promise<unknown> {
    return this.then(undefined, onErr)
  }

  [Symbol.asyncIterator](): AsyncIterator<Document> {
    return this._cursor[Symbol.asyncIterator]()
  }
  get [REPR](): string {
    return this._label
  }
  [INSPECT](): string {
    return this._label
  }
  toString(): string {
    return this._label
  }
}

export interface ShellEnv {
  client: MongoClient
  getDb: (name: string) => ShellDb
  /** Called before every write / destructive call of the wrappers; throws to stop it (shell confirmations). */
  guard?: (op: ShellOp) => Promise<void>
}

export class ShellCollection {
  constructor(
    public _env: ShellEnv,
    public _dbName: string,
    public _name: string
  ) {}

  get _coll(): Collection {
    return this._env.client.db(this._dbName).collection(this._name)
  }

  getName(): string {
    return this._name
  }
  getFullName(): string {
    return `${this._dbName}.${this._name}`
  }
  getDB(): ShellDb {
    return this._env.getDb(this._dbName)
  }
  getCollection(sub: string): ShellCollection {
    return shellCollection(this._env, this._dbName, `${this._name}.${sub}`)
  }

  /** Lets the session approve (or refuse) a write before it runs. */
  async _check(method: string, args: unknown[]): Promise<void> {
    await this._env.guard?.({ target: 'collection', db: this._dbName, coll: this._name, method, args })
  }

  find(filter: Document = {}, projection?: Document, options: FindOptions = {}): ShellCursor {
    const opts: FindOptions = { ...RAW, ...(projection ? { projection } : {}), ...options }
    return new ShellCursor(this._coll.find(filter, opts), () => this._coll.countDocuments(filter), undefined, `Cursor(${this.getFullName()})`)
  }
  findOne(filter: Document = {}, projection?: Document, options: FindOptions = {}): Promise<Document | null> {
    return this._coll.findOne(filter, { ...RAW, ...(projection ? { projection } : {}), ...options })
  }
  aggregate(...args: unknown[]): ShellCursor {
    const [pipeline, options] = Array.isArray(args[0]) ? [args[0] as Document[], (args[1] ?? {}) as AggregateOptions] : [args.filter(isDoc), {}]
    return new ShellCursor(
      this._coll.aggregate(pipeline, { ...RAW, ...options }),
      async () => ((await this._coll.aggregate([...pipeline, { $count: 'n' }]).next())?.n as number) ?? 0,
      undefined,
      `AggregationCursor(${this.getFullName()})`
    )
  }
  countDocuments(filter: Document = {}, options: Document = {}): Promise<number> {
    return this._coll.countDocuments(filter, options)
  }
  count(filter: Document = {}, options: Document = {}): Promise<number> {
    return this._coll.countDocuments(filter, options)
  }
  estimatedDocumentCount(options: Document = {}): Promise<number> {
    return this._coll.estimatedDocumentCount(options)
  }
  distinct(key: string, filter: Document = {}, options: Document = {}): Promise<unknown[]> {
    return this._coll.distinct(key, filter, { ...RAW, ...options })
  }

  async insertOne(doc: Document, options: Document = {}): Promise<unknown> {
    await this._check('insertOne', [doc, options])
    return this._coll.insertOne(doc, options)
  }
  async insertMany(docs: Document[], options: Document = {}): Promise<unknown> {
    await this._check('insertMany', [docs, options])
    return this._coll.insertMany(docs, options)
  }
  insert(docs: Document | Document[], options: Document = {}): Promise<unknown> {
    return Array.isArray(docs) ? this.insertMany(docs, options) : this.insertOne(docs, options)
  }
  async updateOne(filter: Document, update: Document | Document[], options: Document = {}): Promise<unknown> {
    requireArg(filter, 'updateOne')
    await this._check('updateOne', [filter, update, options])
    return this._coll.updateOne(filter, update, options)
  }
  async updateMany(filter: Document, update: Document | Document[], options: Document = {}): Promise<unknown> {
    requireArg(filter, 'updateMany')
    await this._check('updateMany', [filter, update, options])
    return this._coll.updateMany(filter, update, options)
  }
  async replaceOne(filter: Document, doc: Document, options: Document = {}): Promise<unknown> {
    requireArg(filter, 'replaceOne')
    await this._check('replaceOne', [filter, doc, options])
    return this._coll.replaceOne(filter, doc, options)
  }
  async deleteOne(filter: Document, options: Document = {}): Promise<unknown> {
    requireArg(filter, 'deleteOne')
    await this._check('deleteOne', [filter, options])
    return this._coll.deleteOne(filter, options)
  }
  async deleteMany(filter: Document, options: Document = {}): Promise<unknown> {
    requireArg(filter, 'deleteMany')
    await this._check('deleteMany', [filter, options])
    return this._coll.deleteMany(filter, options)
  }
  /** Legacy mongo shell remove(filter, justOne | { justOne }). */
  async remove(filter: Document, justOne: boolean | { justOne?: boolean } = false): Promise<unknown> {
    requireArg(filter, 'remove')
    await this._check('remove', [filter, justOne])
    const one = typeof justOne === 'object' ? !!justOne?.justOne : !!justOne
    return one ? this._coll.deleteOne(filter) : this._coll.deleteMany(filter)
  }
  async findOneAndUpdate(filter: Document, update: Document | Document[], options: Document = {}): Promise<unknown> {
    await this._check('findOneAndUpdate', [filter, update, options])
    return this._coll.findOneAndUpdate(filter, update, { ...RAW, ...options })
  }
  async findOneAndReplace(filter: Document, doc: Document, options: Document = {}): Promise<unknown> {
    await this._check('findOneAndReplace', [filter, doc, options])
    return this._coll.findOneAndReplace(filter, doc, { ...RAW, ...options })
  }
  async findOneAndDelete(filter: Document, options: Document = {}): Promise<unknown> {
    await this._check('findOneAndDelete', [filter, options])
    return this._coll.findOneAndDelete(filter, { ...RAW, ...options })
  }
  async bulkWrite(ops: Document[], options: Document = {}): Promise<unknown> {
    await this._check('bulkWrite', [ops, options])
    return this._coll.bulkWrite(ops as never, options)
  }

  async createIndex(keys: Document, options: Document = {}): Promise<string> {
    await this._check('createIndex', [keys, options])
    return this._coll.createIndex(keys, options)
  }
  async createIndexes(specs: Document[], options: Document = {}): Promise<string[]> {
    await this._check('createIndexes', [specs, options])
    const descs = specs.map((s) => (isDoc(s.key) ? s : { key: s, ...options })) as IndexDescription[]
    return this._coll.createIndexes(descs)
  }
  getIndexes(): Promise<Document[]> {
    return this._coll.listIndexes().toArray()
  }
  indexes(): Promise<Document[]> {
    return this.getIndexes()
  }
  async dropIndex(index: string | Document): Promise<unknown> {
    await this._check('dropIndex', [index])
    return typeof index === 'string' ? this._coll.dropIndex(index) : this._env.client.db(this._dbName).command({ dropIndexes: this._name, index })
  }
  async dropIndexes(indexes?: string | string[]): Promise<unknown> {
    await this._check('dropIndexes', indexes === undefined ? [] : [indexes])
    if (indexes === undefined || indexes === '*') return this._coll.dropIndexes()
    return this._env.client.db(this._dbName).command({ dropIndexes: this._name, index: indexes })
  }
  async drop(): Promise<boolean> {
    await this._check('drop', [])
    return this._coll.drop()
  }
  async renameCollection(newName: string, dropTarget = false): Promise<Document> {
    await this._check('renameCollection', [newName, dropTarget])
    await this._coll.rename(newName, { dropTarget })
    return { ok: 1 }
  }
  stats(scale?: number): Promise<Document> {
    return this._env.client.db(this._dbName).command({ collStats: this._name, ...(scale ? { scale } : {}) })
  }
  explain(verbosity: Verbosity = 'queryPlanner'): Document {
    const db = this._env.client.db(this._dbName)
    return {
      find: (filter: Document = {}, projection?: Document, options: FindOptions = {}): ShellCursor =>
        new ShellCursor(this._coll.find(filter, { ...RAW, ...(projection ? { projection } : {}), ...options }), () => this._coll.countDocuments(filter), verbosity, 'ExplainableCursor'),
      aggregate: (pipeline: Document[], options: AggregateOptions = {}) => this._coll.aggregate(pipeline, options).explain(verbosity),
      count: (query: Document = {}) => db.command({ explain: { count: this._name, query }, verbosity }),
      distinct: (key: string, query: Document = {}) => db.command({ explain: { distinct: this._name, key, query }, verbosity })
    }
  }

  get [REPR](): string {
    return this.getFullName()
  }
  [INSPECT](): string {
    return this.getFullName()
  }
  toString(): string {
    return this.getFullName()
  }
}

export function shellCollection(env: ShellEnv, db: string, name: string): ShellCollection {
  const c: ShellCollection = namespaceProxy(new ShellCollection(env, db, name), (sub) => c.getCollection(sub))
  return c
}

export class ShellDb {
  constructor(
    public _env: ShellEnv,
    public _name: string
  ) {}

  get _db(): Db {
    return this._env.client.db(this._name)
  }

  getName(): string {
    return this._name
  }
  getSiblingDB(name: string): ShellDb {
    return this._env.getDb(name)
  }
  getMongo(): MongoClient {
    return this._env.client
  }
  getCollection(name: string): ShellCollection {
    return shellCollection(this._env, this._name, name)
  }

  /** Lets the session approve (or refuse) a write before it runs. */
  async _check(method: string, args: unknown[]): Promise<void> {
    await this._env.guard?.({ target: 'database', db: this._name, method, args })
  }
  async getCollectionNames(): Promise<string[]> {
    const list = await this._db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()
    return list.map((c) => c.name).sort()
  }
  getCollectionInfos(filter: Document = {}, options: Document = {}): Promise<Document[]> {
    return this._db.listCollections(filter, options).toArray()
  }
  async createCollection(name: string, options: Document = {}): Promise<Document> {
    await this._check('createCollection', [name, options])
    await this._db.createCollection(name, options)
    return { ok: 1 }
  }
  async createView(name: string, source: string, pipeline: Document[], options: Document = {}): Promise<Document> {
    await this._check('createView', [name, source, pipeline, options])
    await this._db.createCollection(name, { viewOn: source, pipeline, ...options })
    return { ok: 1 }
  }
  async runCommand(cmd: string | Document, options: Document = {}): Promise<Document> {
    await this._check('runCommand', [cmd, options])
    return this._db.command(typeof cmd === 'string' ? { [cmd]: 1 } : cmd, options)
  }
  async adminCommand(cmd: string | Document): Promise<Document> {
    await this._check('adminCommand', [cmd])
    return this._env.client.db('admin').command(typeof cmd === 'string' ? { [cmd]: 1 } : cmd)
  }
  aggregate(pipeline: Document[], options: AggregateOptions = {}): ShellCursor {
    return new ShellCursor(
      this._db.aggregate(pipeline, { ...RAW, ...options }),
      async () => ((await this._db.aggregate([...pipeline, { $count: 'n' }]).next())?.n as number) ?? 0,
      undefined,
      `AggregationCursor(${this._name})`
    )
  }
  stats(scale?: number): Promise<Document> {
    return this._db.command({ dbStats: 1, ...(scale ? { scale } : {}) })
  }
  serverStatus(): Promise<Document> {
    return this.adminCommand({ serverStatus: 1 })
  }
  hostInfo(): Promise<Document> {
    return this.adminCommand({ hostInfo: 1 })
  }
  hello(): Promise<Document> {
    return this.adminCommand({ hello: 1 })
  }
  async version(): Promise<string> {
    return String((await this.adminCommand({ buildInfo: 1 })).version)
  }
  currentOp(filter: Document = {}): Promise<Document> {
    return this.adminCommand({ currentOp: 1, ...filter })
  }
  killOp(op: unknown): Promise<Document> {
    return this.adminCommand({ killOp: 1, op })
  }
  getProfilingStatus(): Promise<Document> {
    return this._db.command({ profile: -1 })
  }
  async setProfilingLevel(level: number, slowms?: number): Promise<Document> {
    await this._check('setProfilingLevel', [level, slowms])
    return this._db.command({ profile: level, ...(slowms !== undefined ? { slowms } : {}) })
  }
  async dropDatabase(): Promise<boolean> {
    await this._check('dropDatabase', [])
    return this._db.dropDatabase()
  }

  get [REPR](): string {
    return this._name
  }
  [INSPECT](): string {
    return this._name
  }
  toString(): string {
    return this._name
  }
}

export function shellDb(env: ShellEnv, name: string): ShellDb {
  const d: ShellDb = namespaceProxy(new ShellDb(env, name), (coll) => d.getCollection(coll))
  return d
}

export const isDriverCursor = (v: unknown): v is FindCursor =>
  !!v && typeof v === 'object' && typeof (v as FindCursor).toArray === 'function' && typeof (v as FindCursor).hasNext === 'function' && typeof (v as FindCursor).next === 'function'
