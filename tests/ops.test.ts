import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Double, Int32, ObjectId } from 'bson'
import { MongoClient } from 'mongodb'
import * as ops from '../src/main/mongo/ops'
import { ConnectionManager } from '../src/main/mongo/manager'
import { newConnectionConfig, parseUri } from '@shared/connection'

let server: MongoMemoryServer
let client: MongoClient
const DB = 'shop'

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await client
    .db(DB)
    .collection('items')
    .insertMany([
      { _id: new ObjectId('650000000000000000000001'), name: 'a', qty: new Int32(1), price: new Double(2.0), tags: ['x'] },
      { _id: new ObjectId('650000000000000000000002'), name: 'b', qty: new Int32(5), address: { city: 'Rome' } },
      { _id: new ObjectId('650000000000000000000003'), name: 'c', qty: new Int32(9) }
    ])
})

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

describe('mongo ops', () => {
  it('lists databases and collections', async () => {
    const dbs = await ops.listDatabases(client)
    expect(dbs.map((d) => d.name)).toContain(DB)
    const colls = await ops.listCollections(client, DB)
    expect(colls).toEqual([{ name: 'items', type: 'collection' }])
    expect(await ops.estimatedCount(client, DB, 'items')).toBe(3)
  })

  it('finds with filter, projection, sort, skip, limit and keeps raw types', async () => {
    const r = await ops.find(client, DB, 'items', { filter: { qty: { $gte: 5 } }, projection: { name: 1, qty: 1 }, sort: { qty: -1 }, skip: 0, limit: 10 })
    expect(r.docs.map((d) => d.name)).toEqual(['c', 'b'])
    expect((r.docs[0].qty as Int32)._bsontype).toBe('Int32')
    const all = await ops.find(client, DB, 'items', { filter: {}, skip: 1, limit: 1, sort: { name: 1 } })
    expect(all.docs.map((d) => d.name)).toEqual(['b'])
    const a = await ops.find(client, DB, 'items', { filter: { name: 'a' }, skip: 0, limit: 0 })
    expect((a.docs[0].price as Double)._bsontype).toBe('Double')
  })

  it('counts and samples fields', async () => {
    expect(await ops.count(client, DB, 'items', { qty: { $lt: 6 } })).toBe(2)
    const fields = await ops.sampleFields(client, DB, 'items', 10)
    expect(fields).toEqual(expect.arrayContaining(['_id', 'name', 'qty', 'address', 'address.city']))
  })

  it('updates, renames and unsets fields by scope', async () => {
    const id = new ObjectId('650000000000000000000002')
    let r = await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [id] }, { kind: 'set', path: 'address.city', value: 'Paris' })
    expect(r).toEqual({ matched: 1, modified: 1 })
    r = await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [id] }, { kind: 'rename', path: 'address.city', newName: 'town' })
    expect(r.modified).toBe(1)
    const doc = await ops.getDocument(client, DB, 'items', id)
    expect(doc?.address).toEqual({ town: 'Paris' })
    r = await ops.updateField(client, DB, 'items', { kind: 'all' }, { kind: 'set', path: 'flag', value: true })
    expect(r.modified).toBe(3)
    r = await ops.updateField(client, DB, 'items', { kind: 'filter', filter: { qty: { $gt: 4 } } }, { kind: 'unset', path: 'flag' })
    expect(r.modified).toBe(2)
    await expect(ops.updateField(client, DB, 'items', { kind: 'all' }, { kind: 'set', path: '_id', value: 1 })).rejects.toThrow('_id')
  })

  it('replaces, inserts and deletes documents', async () => {
    const id = new ObjectId('650000000000000000000003')
    await ops.replaceDocument(client, DB, 'items', id, { _id: id, name: 'c2', qty: new Int32(10) })
    expect((await ops.getDocument(client, DB, 'items', id))?.name).toBe('c2')
    await expect(ops.replaceDocument(client, DB, 'items', id, { _id: new ObjectId(), name: 'x' })).rejects.toThrow('_id')
    expect(await ops.insertDocuments(client, DB, 'items', [{ name: 'd' }, { name: 'e' }])).toBe(2)
    expect(await ops.deleteDocuments(client, DB, 'items', { kind: 'filter', filter: { name: { $in: ['d', 'e'] } } })).toBe(2)
  })

  it('creates, renames and drops collections', async () => {
    await ops.createCollection(client, DB, 'tmp')
    await ops.renameCollection(client, DB, 'tmp', 'tmp2')
    expect((await ops.listCollections(client, DB)).map((c) => c.name)).toContain('tmp2')
    await ops.dropCollection(client, DB, 'tmp2')
    expect((await ops.listCollections(client, DB)).map((c) => c.name)).not.toContain('tmp2')
  })
})

describe('ConnectionManager', () => {
  it('tests and connects with a parsed uri', async () => {
    const cfg = parseUri(server.getUri(), newConnectionConfig())
    const mgr = new ConnectionManager()
    const t = await mgr.test(cfg)
    expect(t.ok).toBe(true)
    expect(t.steps.map((s) => s.name)).toEqual(['Connect', 'Ping', 'Server', 'List databases'])
    const c = await mgr.connect(cfg)
    expect(c.topology).toBe('Standalone')
    expect(await ops.listDatabases(mgr.get(c.connId))).toBeTruthy()
    await mgr.disconnect(c.connId)
    expect(() => mgr.get(c.connId)).toThrow()
  })

  it('reports a failed connection', async () => {
    const cfg = { ...newConnectionConfig(), hosts: [{ host: '127.0.0.1', port: 1 }], options: { serverSelectionTimeoutMS: 500 } }
    const t = await new ConnectionManager().test(cfg)
    expect(t.ok).toBe(false)
    expect(t.steps[0]).toMatchObject({ name: 'Connect', ok: false })
  })
})

describe('profiling', () => {
  it('explains a query with execution stats', async () => {
    const r = await ops.explain(client, DB, 'items', { filter: { qty: { $gt: 1 } }, skip: 0, limit: 0 }, 'executionStats')
    const stats = r.executionStats as { totalDocsExamined: number; executionSuccess: boolean }
    expect(stats.executionSuccess).toBe(true)
    expect(stats.totalDocsExamined).toBeGreaterThan(0)
    expect(JSON.stringify(r.queryPlanner)).toContain('COLLSCAN')
  })

  it('sets the profiling level and reads system.profile', async () => {
    let s = await ops.setProfiling(client, DB, 2, 50, 1)
    expect(s).toMatchObject({ level: 2, slowms: 50, sampleRate: 1 })
    await client.db(DB).collection('items').find({ name: 'profiled' }).toArray()
    const entries = await ops.readProfile(client, DB, { filter: { op: 'query' }, limit: 50 })
    expect(entries.some((e) => JSON.stringify(e.command).includes('profiled'))).toBe(true)
    await ops.clearProfile(client, DB)
    expect((await ops.profilingStatus(client, DB)).level).toBe(2)
    s = await ops.setProfiling(client, DB, 0, 100, 1)
    expect(s.level).toBe(0)
  })

  it('lists current operations', async () => {
    const list = await ops.currentOps(client, { allUsers: true, idle: false })
    expect(Array.isArray(list)).toBe(true)
  })
})

describe('indexes', () => {
  it('creates and lists indexes', async () => {
    const name = await ops.createIndex(client, DB, 'items', { name: 1, qty: -1 }, { unique: false })
    expect(name).toBe('name_1_qty_-1')
    const list = await ops.listIndexes(client, DB, 'items')
    expect(list.map((i) => i.name)).toEqual(expect.arrayContaining(['_id_', 'name_1_qty_-1']))
    expect(await ops.listIndexes(client, DB, 'nope')).toEqual([])
  })
})
