import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { ObjectId } from 'bson'
import { GridFSBucket, MongoClient } from 'mongodb'
import { build } from 'rolldown'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildUri, clearAskedSecrets, effectiveSetting, newConnectionConfig, parseDbList, parseUri, secretsToAsk, withSecrets } from '@shared/connection'
import type { ConnectionConfig } from '@shared/connection'
import type { ApprovalRequest } from '@shared/mcpApi'
import { assertSecretsGiven, clientOptions, ConnectionManager } from '../src/main/mongo/manager'
import * as ops from '../src/main/mongo/ops'
import * as indexes from '../src/main/mongo/indexes'
import * as users from '../src/main/mongo/users'
import * as aggregation from '../src/main/mongo/aggregation'
import * as validation from '../src/main/server/validation'
import { assertJobWritable, isReadOnlyError, readOnlyClient, writeCommand, writeStage } from '../src/main/mongo/readOnly'
import { ChangeHistory } from '../src/main/changes/store'
import { Restorer } from '../src/main/changes/restore'
import { exportConnections, parseConnectionImport } from '../src/main/connectionTransfer'
import { execute } from '../src/main/playground/core'
import { Playground } from '../src/main/playground/runner'
import { McpBridge } from '../src/main/mcp/server'
import { TaskService } from '../src/main/tasks/service'

const cfg = (p: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ ...newConnectionConfig(), ...p })

// ---------------------------------------------------------------------------
// Driver options in connection strings
// ---------------------------------------------------------------------------

describe('driver options in connection strings', () => {
  const full = cfg({
    mode: 'replicaSet',
    hosts: [
      { host: 'a', port: 27017 },
      { host: 'b', port: 27018 }
    ],
    replicaSet: 'rs0',
    options: {
      readPreference: 'secondaryPreferred',
      readPreferenceTags: ['dc:east,rack:1', 'dc:east', ''],
      localThresholdMS: 30,
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 20,
      minPoolSize: 0,
      maxIdleTimeMS: 60000,
      retryWrites: false,
      retryReads: true,
      compressors: ['zstd', 'zlib'],
      writeConcern: { w: 'majority', wtimeoutMS: 2500, journal: true },
      readConcernLevel: 'majority'
    }
  })

  it('writes every option into the URI', () => {
    const uri = buildUri(full)
    expect(uri.startsWith('mongodb://a:27017,b:27018/?')).toBe(true)
    const q = new URLSearchParams(uri.split('?')[1])
    expect(q.getAll('readPreferenceTags')).toEqual(['dc:east,rack:1', 'dc:east', ''])
    expect(Object.fromEntries([...q].filter(([k]) => k !== 'readPreferenceTags'))).toEqual({
      replicaSet: 'rs0',
      readPreference: 'secondaryPreferred',
      serverSelectionTimeoutMS: '5000',
      localThresholdMS: '30',
      maxPoolSize: '20',
      minPoolSize: '0',
      maxIdleTimeMS: '60000',
      retryWrites: 'false',
      retryReads: 'true',
      compressors: 'zstd,zlib',
      w: 'majority',
      wtimeoutMS: '2500',
      journal: 'true',
      readConcernLevel: 'majority'
    })
  })

  it('round-trips through parseUri and buildUri', () => {
    const parsed = parseUri(buildUri(full))
    expect(parsed.options).toMatchObject(full.options)
    expect(parsed.options.extra).toBeUndefined()
    expect(buildUri(parsed)).toBe(buildUri(full))
  })

  it('parses common Atlas strings into structured options', () => {
    const c = parseUri('mongodb+srv://u@cluster0.x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0&socketTimeoutMS=9000')
    expect(c.options).toMatchObject({ retryWrites: true, writeConcern: { w: 'majority' }, appName: 'Cluster0', extra: 'socketTimeoutMS=9000' })
  })

  it('accepts numeric w and ignores unknown compressors and read concern levels', () => {
    const c = parseUri('mongodb://h/?w=2&compressors=lz4,zlib&readConcernLevel=weird&journal=false&maxPoolSize=-3')
    expect(c.options.writeConcern).toEqual({ w: '2', wtimeoutMS: undefined, journal: false })
    expect(c.options.compressors).toEqual(['zlib'])
    expect(c.options.readConcernLevel).toBeUndefined()
    expect(c.options.maxPoolSize).toBeUndefined()
  })

  it('leaves tag sets out with the primary read preference', () => {
    expect(buildUri(cfg({ options: { readPreferenceTags: ['dc:east'] } }))).toBe('mongodb://localhost:27017/')
  })

  it('lets an option in "Extra URI options" win over the structured field', () => {
    const uri = buildUri(cfg({ options: { maxPoolSize: 10, writeConcern: { w: '1' }, extra: 'maxPoolSize=50' } }))
    expect(uri).toBe('mongodb://localhost:27017/?w=1&maxPoolSize=50')
  })

  it('keeps settings that are not part of the URI when a string is parsed onto a connection', () => {
    const base = cfg({ readOnly: true, overrides: { pageSize: 20 }, databases: { mode: 'manual', names: ['a'] }, tls: { enabled: true, useSystemCA: true, servername: 'db.internal' } })
    const c = parseUri('mongodb://h/?tls=true', base)
    expect(c).toMatchObject({ readOnly: true, overrides: { pageSize: 20 }, databases: { mode: 'manual', names: ['a'] }, tls: { useSystemCA: true, servername: 'db.internal' } })
  })

  it('carries the new settings through a Shardwise export and the URI list export', () => {
    const c = { ...full, id: 'x', name: 'Full', readOnly: true, auth: { mechanism: 'DEFAULT' as const, username: 'u', askPassword: true, authSource: 'admin' } }
    const back = parseConnectionImport(exportConnections([c], { format: 'shardwise', includePasswords: false })).connections[0]
    expect(back).toMatchObject({ readOnly: true, options: full.options, auth: { askPassword: true } })
    const fromUri = parseConnectionImport(exportConnections([c], { format: 'uri', includePasswords: false })).connections[0]
    expect(fromUri.options).toMatchObject(full.options)
  })
})

// ---------------------------------------------------------------------------
// Secrets asked at connect time, per-connection settings
// ---------------------------------------------------------------------------

describe('ask for the password at connect time', () => {
  const c = cfg({
    name: 'Prod',
    auth: { mechanism: 'SCRAM-SHA-256', username: 'u', password: 'p', askPassword: true },
    ssh: { enabled: true, host: 'jump', method: 'key', keyFile: 'k', passphrase: 'pp', askPassword: true }
  })

  it('knows what to ask for', () => {
    expect(secretsToAsk(c)).toEqual({ password: true, ssh: 'passphrase' })
    expect(secretsToAsk({ ...c, ssh: { ...c.ssh, method: 'password' } }).ssh).toBe('password')
    expect(secretsToAsk({ ...c, auth: { ...c.auth, mechanism: 'MONGODB-X509' }, ssh: { ...c.ssh, enabled: false } })).toEqual({ password: false, ssh: null })
  })

  it('never stores the asked secrets and fills them in for the live connection only', () => {
    const stored = clearAskedSecrets(c)
    expect(stored.auth.password).toBeUndefined()
    expect(stored.ssh.passphrase).toBeUndefined()
    expect(c.auth.password).toBe('p')
    const live = withSecrets(stored, { password: 'typed', sshPassphrase: 'pp2' })
    expect(live.auth.password).toBe('typed')
    expect(live.ssh.passphrase).toBe('pp2')
    expect(buildUri(live, true)).toContain('u:typed@')
  })

  it('refuses to connect without the asked secrets (MCP auto-connect, scheduled tasks)', async () => {
    expect(() => assertSecretsGiven(clearAskedSecrets(c))).toThrow(/asks for its password/)
    await expect(new ConnectionManager().connect(clearAskedSecrets(c))).rejects.toThrow(/asks for its password/)
    expect(() => assertSecretsGiven(withSecrets(clearAskedSecrets(c), { password: '', sshPassphrase: '' }))).not.toThrow()
  })

  it('resolves per-connection overrides', () => {
    expect(effectiveSetting(cfg(), 'pageSize', 50)).toBe(50)
    expect(effectiveSetting(cfg({ overrides: { pageSize: 10 } }), 'pageSize', 50)).toBe(10)
    expect(effectiveSetting(cfg({ overrides: { queryTimeoutMS: 0 } }), 'queryTimeoutMS', 30000)).toBe(0)
    expect(parseDbList('a, b\n\n a \nc')).toEqual(['a', 'b', 'c'])
  })
})

describe('client options', () => {
  it('trusts the system store together with the bundled roots and sets the TLS server name', () => {
    const o = clientOptions(cfg({ tls: { enabled: true, useSystemCA: true, servername: ' db.internal ' } }))
    expect(Array.isArray(o.ca) && o.ca.length).toBeGreaterThan(50)
    expect(o.tlsCAFile).toBeUndefined()
    expect(o.servername).toBe('db.internal')
    expect(clientOptions(cfg({ tls: { enabled: true, caFile: 'x.pem' } }))).toMatchObject({ tlsCAFile: 'x.pem' })
  })

  it('skips compressors whose optional module is missing', () => {
    const o = clientOptions(cfg({ options: { compressors: ['snappy', 'zlib'] } }))
    expect(o.compressors).toContain('zlib')
    expect(o.compressors).not.toContain('snappy')
  })
})

describe('write detection', () => {
  it('recognises write commands and pipelines', () => {
    expect(writeCommand({ insert: 'x', documents: [] })).toBe('insert')
    expect(writeCommand({ collMod: 'x' })).toBe('collMod')
    expect(writeCommand({ dropDatabase: 1 })).toBe('dropDatabase')
    expect(writeCommand({ profile: -1 })).toBeUndefined()
    expect(writeCommand({ profile: 2 })).toBe('profile')
    expect(writeCommand({ aggregate: 'x', pipeline: [{ $match: {} }, { $merge: 'y' }] })).toBe('aggregate with $merge')
    expect(writeCommand({ find: 'x' })).toBeUndefined()
    expect(writeCommand('dropAllUsersFromDatabase')).toBe('dropAllUsersFromDatabase')
    expect(writeStage([{ $match: {} }, { $out: 'y' }])).toBe('$out')
    expect(writeStage([{ $match: {} }])).toBeUndefined()
  })

  it('finds the connection a job writes into', () => {
    const config = (id: string) => ({ name: id, readOnly: id === 'ro' })
    expect(() => assertJobWritable({ kind: 'import', request: { connId: 'ro', db: 'd' } as never }, config)).toThrow(/"ro" is a read-only connection: importing into d/)
    expect(() => assertJobWritable({ kind: 'import', request: { connId: 'rw', db: 'd' } as never }, config)).not.toThrow()
    const mask = (target: unknown) => ({ kind: 'mask' as const, request: { source: { connId: 'ro', db: 'd', coll: 'c', filter: {} }, target } as never })
    expect(() => assertJobWritable(mask({ kind: 'file', path: 'x' }), config)).not.toThrow()
    expect(() => assertJobWritable(mask({ kind: 'inPlace', confirm: 'c' }), config)).toThrow(/masking documents in place/)
    expect(() => assertJobWritable(mask({ kind: 'collection', connId: 'rw', db: 'd', coll: 'x', dropFirst: false }), config)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Against a server
// ---------------------------------------------------------------------------

let server: MongoMemoryServer
let direct: MongoClient
const DB = 'shop'
const workerFile = resolve(__dirname, '../node_modules/.cache/shardwise-readonly-test/playgroundWorker.js')

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  direct = await MongoClient.connect(server.getUri())
  await direct.db(DB).collection('items').insertMany([{ _id: new ObjectId('650000000000000000000001'), name: 'a', qty: 1 }, { name: 'b', qty: 2 }])
  await direct.db(DB).collection('items').createIndex({ qty: 1 }, { name: 'qty_1' })
  await direct.db('reports').collection('daily').insertOne({ day: 1 })
  await build({
    input: resolve(__dirname, '../src/main/playground/worker.ts'),
    platform: 'node',
    resolve: { alias: { '@shared': resolve(__dirname, '../src/shared') } },
    external: (id) => !id.startsWith('.') && !id.startsWith('@shared') && !/^([a-zA-Z]:)?[\\/]/.test(id),
    logLevel: 'silent',
    output: { file: workerFile, format: 'cjs' }
  })
})

afterAll(async () => {
  await direct?.close()
  await server?.stop()
})

const live = (p: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ ...parseUri(server.getUri()), id: 'ro', name: 'Prod copy', ...p })

describe('read-only connections in the main process', () => {
  let mgr: ConnectionManager
  let connId: string

  beforeAll(async () => {
    mgr = new ConnectionManager()
    connId = (await mgr.connect(live({ readOnly: true }))).connId
  })
  afterAll(() => mgr?.closeAll())

  const refused = async (p: Promise<unknown>): Promise<string> => {
    const e = await p.then(
      () => null,
      (x: Error) => x
    )
    expect(e, 'the write was not refused').not.toBeNull()
    expect(isReadOnlyError(e)).toBe(true)
    return e!.message
  }

  it('still reads', async () => {
    const c = mgr.get(connId)
    expect((await ops.find(c, DB, 'items', { filter: {}, skip: 0, limit: 0 })).docs).toHaveLength(2)
    expect(await ops.count(c, DB, 'items', {})).toBe(2)
    expect((await ops.listDatabases(c, mgr.config(connId))).map((d) => d.name)).toContain(DB)
    expect((await aggregation.aggregate(c, DB, 'items', [{ $match: {} }])).docs).toHaveLength(2)
    expect(await ops.profilingStatus(c, DB)).toMatchObject({ level: 0 })
    expect((await indexes.indexDetails(c, DB, 'items')).map((i) => i.name)).toContain('qty_1')
  })

  it('refuses every editing path of the ops module', async () => {
    const c = mgr.get(connId)
    const id = new ObjectId('650000000000000000000001')
    expect(await refused(ops.insertDocuments(c, DB, 'items', [{ x: 1 }]))).toMatch(/^"Prod copy" is a read-only connection: insertMany on shop.items is not allowed/)
    await refused(ops.replaceDocument(c, DB, 'items', id, { name: 'z' }))
    await refused(ops.updateField(c, DB, 'items', { kind: 'all' }, { kind: 'set', path: 'q', value: 1 }))
    await refused(ops.deleteDocuments(c, DB, 'items', { kind: 'ids', ids: [id] }))
    await refused(ops.createCollection(c, DB, 'newColl'))
    await refused(ops.dropCollection(c, DB, 'items'))
    await refused(ops.renameCollection(c, DB, 'items', 'things'))
    await refused(ops.dropDatabase(c, DB))
    await refused(ops.createIndex(c, DB, 'items', { name: 1 }, {}))
    await refused(ops.setProfiling(c, DB, 2, 100, 1))
    await refused(ops.clearProfile(c, DB))
    await refused(ops.killOp(c, 12345))
    expect(await direct.db(DB).collection('items').countDocuments()).toBe(2)
    expect(await direct.db(DB).collection('items').findOne({ _id: id })).toMatchObject({ name: 'a' })
    expect((await direct.db(DB).listCollections().toArray()).map((x) => x.name).sort()).toEqual(['items'])
  })

  it('refuses index, user, view, validation and pipeline writes', async () => {
    const c = mgr.get(connId)
    await refused(indexes.dropIndex(c, DB, 'items', 'qty_1'))
    await refused(indexes.setIndexHidden(c, DB, 'items', 'qty_1', true))
    await refused(users.createUser(c, DB, 'bob', 'pw', []))
    await refused(users.dropRole(c, DB, 'r'))
    await refused(aggregation.createView(c, DB, 'v', 'items', []))
    await refused(aggregation.aggregate(c, DB, 'items', [{ $out: 'copy' }]))
    await refused(validation.setValidation(c, DB, 'items', { validator: { name: { $type: 'string' } }, level: 'strict', action: 'error' }))
    await refused(c.db(DB).command({ delete: 'items', deletes: [{ q: {}, limit: 0 }] }))
    await refused(c.db('admin').admin().command({ dropDatabase: 1 }))
    await refused(c.db(DB).collection('items').bulkWrite([{ insertOne: { document: { a: 1 } } }]))
    expect(() => c.db(DB).collection('items').initializeOrderedBulkOp()).toThrow(/read-only/)
    expect((await indexes.indexDetails(c, DB, 'items')).map((i) => i.name)).toContain('qty_1')
    expect(await direct.db(DB).collection('copy').countDocuments()).toBe(0)
  })

  it('refuses GridFS uploads made through the guarded database', async () => {
    const bucket = new GridFSBucket(mgr.get(connId).db(DB))
    const err = await new Promise<Error | null>((res) => bucket.openUploadStream('a.txt').on('error', res).on('finish', () => res(null)).end('hello'))
    expect(isReadOnlyError(err)).toBe(true)
    expect(await direct.db(DB).collection('fs.files').countDocuments()).toBe(0)
  })

  it('refuses job starters and Change History restores up front', async () => {
    expect(() => mgr.assertWritable(connId, 'pasting into shop')).toThrow(/read-only connection: pasting into shop/)
    const dir = mkdtempSync(join(tmpdir(), 'sw-ro-'))
    const h = new ChangeHistory(dir, mgr)
    try {
      await expect(new Restorer(h).restore(connId, { ids: [1] }, false)).rejects.toThrow(/read-only connection: restoring from Change History/)
    } finally {
      h.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies a switch of the read-only flag to clients already handed out', async () => {
    const c = mgr.get(connId)
    mgr.applySaved({ ...mgr.config(connId), readOnly: undefined })
    expect(mgr.isReadOnly(connId)).toBe(false)
    expect(await ops.insertDocuments(c, DB, 'scratch', [{ ok: 1 }])).toBe(1)
    mgr.applySaved({ ...mgr.config(connId), readOnly: true })
    await refused(ops.insertDocuments(c, DB, 'scratch', [{ ok: 2 }]))
    await direct.db(DB).collection('scratch').drop()
  })

  it('stops scheduled import tasks before they run', async () => {
    const tasks = new TaskService({
      userData: mkdtempSync(join(tmpdir(), 'sw-ro-tasks-')),
      connections: mgr,
      getConnection: async () => mgr.config(connId),
      runners: { transfers: { startImport: () => 'never' } } as never,
      watcher: { wait: () => new Promise(() => {}) } as never,
      emit: () => {}
    })
    const dispatch = (tasks as unknown as { dispatch: (j: unknown, a: unknown) => Promise<string> }).dispatch.bind(tasks)
    await expect(dispatch({ kind: 'import', request: { connId, db: DB, collection: 'x' } }, { log: [], run: { taskId: 't' } })).rejects.toThrow(/read-only connection: importing into shop/)
  })
})

describe('read-only connections in the shell and playground', () => {
  it('refuses shell helpers, raw driver writes and Mongoose writes in the playground core', async () => {
    const client = readOnlyClient(direct, () => 'Prod copy')
    const run = (code: string) => execute({ client, db: DB, code, language: 'javascript', onLog: () => {} })
    for (const code of [
      'db.items.insertOne({ x: 1 })',
      'db.items.updateMany({}, { $set: { x: 1 } })',
      'db.items.drop()',
      'db.createCollection("x")',
      'db.runCommand({ insert: "items", documents: [{ a: 1 }] })',
      'await client.db("shop").collection("items").deleteMany({})',
      'db.items.aggregate([{ $out: "copy" }])',
      'await Item.create({ name: "m" })',
      'await Item.updateMany({}, { $set: { q: 1 } })'
    ]) {
      const r = await run(code)
      expect(r.ok, code).toBe(false)
      expect(r.error, code).toMatch(/read-only connection/)
    }
    const read = await run('db.items.find({}).toArray()')
    expect(read.ok).toBe(true)
    expect(await direct.db(DB).collection('items').countDocuments()).toBe(2)
  })

  it('runs playground workers of a read-only connection with a guarded client', async () => {
    const mgr = new ConnectionManager()
    try {
      const connId = (await mgr.connect(live({ readOnly: true }))).connId
      const pg = new Playground(mgr, () => {}, workerFile)
      const w = await pg.run({ runId: 'r1', connId, db: DB, code: 'db.items.insertOne({ fromWorker: true })', language: 'javascript', timeoutMS: 0 })
      expect(w.ok).toBe(false)
      expect(w.error).toMatch(/read-only connection/)
      const r = await pg.run({ runId: 'r2', connId, db: DB, code: 'db.items.countDocuments({})', language: 'javascript', timeoutMS: 0 })
      expect(r.value).toBe(2)
    } finally {
      await mgr.closeAll()
    }
  })
})

describe('read-only connections over MCP', () => {
  it('refuses write tools before asking for approval and marks the connection', async () => {
    const mgr = new ConnectionManager()
    const config = { ...live({ readOnly: true }), id: 'mcp-ro', name: 'RO', exposeToMcp: true }
    await mgr.connect(config)
    const approvals: ApprovalRequest[] = []
    const bridge = new McpBridge(
      mgr,
      async () => [config],
      async (r) => {
        approvals.push(r)
        return true
      },
      () => {}
    )
    const st = await bridge.start({ token: 'tok-0123456789abcdef', allowWrites: true, maxDocs: 50, autoConnect: false, port: 0 })
    const client = new Client({ name: 't', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(st.url!), { requestInit: { headers: { Authorization: 'Bearer tok-0123456789abcdef' } } }))
      const list = (await client.callTool({ name: 'list_connections', arguments: {} })) as { content: { text: string }[] }
      expect(JSON.parse(list.content[0].text)[0]).toMatchObject({ name: 'RO', readOnly: true })
      for (const [name, args] of [
        ['insert_documents', { documents: [{ a: 1 }] }],
        ['update_documents', { filter: {}, update: { $set: { a: 1 } } }],
        ['delete_documents', { filter: {} }],
        ['create_index', { keys: { a: 1 } }],
        ['aggregate', { pipeline: [{ $out: 'x' }] }]
      ] as const) {
        const r = (await client.callTool({ name, arguments: { connection: 'RO', database: DB, collection: 'items', ...args } })) as { isError?: boolean; content: { text: string }[] }
        expect(r.isError, name).toBe(true)
        expect(r.content[0].text, name).toMatch(/"RO" is a read-only connection/)
      }
      expect(approvals).toHaveLength(0)
      expect(await direct.db(DB).collection('items').countDocuments()).toBe(2)
    } finally {
      await client.close().catch(() => {})
      await bridge.stop()
      await mgr.closeAll()
    }
  })
})

describe('visible databases', () => {
  it('derives databases from roles and privileges', () => {
    const status = {
      authInfo: {
        authenticatedUserRoles: [
          { role: 'readWrite', db: 'sales' },
          { role: 'read', db: 'reports' }
        ],
        authenticatedUserPrivileges: [
          { resource: { db: 'audit', collection: 'events' }, actions: ['find'] },
          { resource: { db: '', collection: '' }, actions: ['listCollections'] },
          { resource: { cluster: true }, actions: ['listDatabases'] },
          { resource: { db: '$external', collection: '' }, actions: ['find'] }
        ]
      }
    }
    expect(ops.rolesDatabases(status).sort()).toEqual(['audit', 'reports', 'sales'])
    expect(ops.rolesDatabases({})).toEqual([])
  })

  it('merges extra names without duplicates, keeping sizes of listed databases', () => {
    expect(ops.mergeDatabases([{ name: 'b', sizeOnDisk: 5 }, { name: 'a', sizeOnDisk: 1 }], ['c', 'a', ''])).toEqual([{ name: 'a', sizeOnDisk: 1 }, { name: 'b', sizeOnDisk: 5 }, { name: 'c' }])
  })

  it('adds the connection names in automatic mode and shows only them in manual mode', async () => {
    const auto = await ops.listDatabases(direct, live({ databases: { mode: 'auto', names: ['notYetCreated'] } }))
    expect(auto.map((d) => d.name)).toEqual(expect.arrayContaining([DB, 'reports', 'notYetCreated']))
    expect(auto.find((d) => d.name === DB)?.sizeOnDisk).toBeGreaterThan(0)
    const manual = await ops.listDatabases(direct, live({ databases: { mode: 'manual', names: ['reports', 'zeta'] } }))
    expect(manual).toEqual([{ name: 'reports' }, { name: 'zeta' }])
  })
})

describe('Change History per connection', () => {
  it('follows the connection override over the global switch', async () => {
    const mgr = new ConnectionManager()
    const dir = mkdtempSync(join(tmpdir(), 'sw-hist-'))
    const h = new ChangeHistory(dir, mgr)
    try {
      const on = (await mgr.connect(live({ id: 'on', overrides: { changeHistory: true } }))).connId
      const off = (await mgr.connect(live({ id: 'off', overrides: { changeHistory: false } }))).connId
      const dflt = (await mgr.connect(live({ id: 'dflt' }))).connId
      expect(h.forConn(off)!.begin(DB, 'items', 'edit')).toBeNull()
      expect(h.forConn(dflt)!.begin(DB, 'items', 'edit')).not.toBeNull()
      expect(h.forConfig({ id: 'off', name: 'x', overrides: { changeHistory: false } }).begin(DB, 'items', 'mcp')).toBeNull()
      h.saveSettings({ enabled: false })
      expect(h.forConn(dflt)!.begin(DB, 'items', 'edit')).toBeNull()
      expect(h.forConn(on)!.begin(DB, 'items', 'edit')).not.toBeNull()
      // Editing through ops records (or not) accordingly.
      await ops.insertDocuments(mgr.get(on), DB, 'hist', [{ a: 1 }], h.forConn(on))
      await ops.insertDocuments(mgr.get(dflt), DB, 'hist', [{ a: 2 }], h.forConn(dflt))
      expect(h.batches('on', { db: DB, coll: 'hist' })).toHaveLength(1)
      expect(h.batches('dflt', { db: DB, coll: 'hist' })).toHaveLength(0)
    } finally {
      h.close()
      await mgr.closeAll()
      await direct.db(DB).collection('hist').drop().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
