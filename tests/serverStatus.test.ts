import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import { Int32, Long } from 'bson'
import { MongoClient } from 'mongodb'
import * as status from '../src/main/server/status'
import type { ServerSample } from '@shared/serverApi'
import { appendPoint, approxDuration, bytesText, cacheUsage, compactNumber, counterRate, niceBytesMax, niceMax, statPoint, uptimeText, withLag } from '@shared/serverStats'

function sample(at: number, uptime: number, n: number, extra: Partial<ServerSample> = {}): ServerSample {
  return {
    at,
    uptime,
    host: 'h:27017',
    version: '8.0.0',
    process: 'mongod',
    connections: { current: 5, available: 100, totalCreated: 10 },
    opcounters: { insert: n, query: n * 2, update: n, delete: 0, getmore: 0, command: n * 10 },
    network: { bytesIn: n * 1000, bytesOut: n * 4000, numRequests: n },
    mem: { resident: 200, virtual: 1200 },
    ...extra
  }
}

describe('rate math', () => {
  it('computes per-second rates of counters', () => {
    expect(counterRate(100, 300, 2)).toBe(100)
    expect(counterRate(100, 100, 2)).toBe(0)
  })

  it('never returns negative rates: a counter reset is a gap', () => {
    expect(counterRate(500, 20, 2)).toBeNull()
    expect(counterRate(1, 2, 0)).toBeNull()
    expect(counterRate(undefined, 2, 1)).toBeNull()
  })

  it('builds chart points from two samples', () => {
    const a = sample(0, 100, 10)
    const b = sample(2000, 102, 30)
    const p = statPoint(a, b)
    expect(p.ops.insert).toBe(10)
    expect(p.ops.query).toBe(20)
    expect(p.ops.command).toBe(100)
    expect(p.ops.delete).toBe(0)
    expect(p.opsTotal).toBe(140)
    expect(p.netIn).toBe(10000)
    expect(p.netOut).toBe(40000)
    expect(p.connections).toBe(5)
    expect(p.cacheUsedPct).toBeNull()
    expect(statPoint(undefined, b).opsTotal).toBeNull()
  })

  it('treats a server restart as a gap, even if some counters grew', () => {
    const before = sample(0, 5000, 1000)
    const after = sample(2000, 3, 1)
    after.opcounters.command = 5000
    const p = statPoint(before, after)
    expect(p.ops.command).toBeNull()
    expect(p.opsTotal).toBeNull()
    expect(p.netIn).toBeNull()
    expect(Object.values(p.ops).every((v) => v === null || v >= 0)).toBe(true)
  })

  it('a single reset counter does not produce negative totals', () => {
    const a = sample(0, 100, 10)
    const b = sample(1000, 101, 20)
    b.opcounters.update = 0
    const p = statPoint(a, b)
    expect(p.ops.update).toBeNull()
    expect(p.opsTotal).toBeNull()
    expect(p.ops.insert).toBe(10)
  })

  it('computes cache usage and keeps a rolling window', () => {
    expect(cacheUsage(sample(0, 1, 1, { cache: { bytes: 25, max: 100, dirty: 5, readInto: 0, writtenFrom: 0 } }))).toEqual({ usedPct: 25, dirtyPct: 5 })
    expect(cacheUsage(sample(0, 1, 1, { cache: { bytes: 25, max: 0, dirty: 5, readInto: 0, writtenFrom: 0 } }))).toEqual({ usedPct: null, dirtyPct: null })
    let pts: { t: number }[] = []
    for (let t = 0; t <= 400_000; t += 2000) pts = appendPoint(pts, { t })
    expect(pts[0].t).toBe(100_000)
    expect(pts.at(-1)!.t).toBe(400_000)
    // A clock going backwards drops the newer points.
    pts = appendPoint(pts, { t: 300_000 })
    expect(pts.at(-1)!.t).toBe(300_000)
    expect(pts.every((p) => p.t <= 300_000)).toBe(true)
  })

  it('computes replica set lag against the primary', () => {
    const d = (s: number): Date => new Date(1_700_000_000_000 + s * 1000)
    const m = withLag([
      { name: 'a', stateStr: 'PRIMARY', optimeDate: d(100) },
      { name: 'b', stateStr: 'SECONDARY', optimeDate: d(88) },
      { name: 'c', stateStr: 'ARBITER', optimeDate: undefined },
      { name: 'd', stateStr: 'SECONDARY', optimeDate: d(105) }
    ])
    expect(m.map((x) => x.lagSec)).toEqual([0, 12, undefined, 0])
    const noPrimary = withLag([
      { name: 'b', stateStr: 'SECONDARY', optimeDate: d(90) },
      { name: 'c', stateStr: 'SECONDARY', optimeDate: d(100) }
    ])
    expect(noPrimary.map((x) => x.lagSec)).toEqual([10, 0])
  })

  it('formats values', () => {
    expect(approxDuration(37 * 3600 + 100)).toBe('~37 h')
    expect(approxDuration(5 * 86400)).toBe('~5 d')
    expect(approxDuration(600)).toBe('~10 min')
    expect(uptimeText(3 * 86400 + 4 * 3600 + 5)).toBe('3 d 4 h')
    expect(uptimeText(42)).toBe('42 s')
    expect(bytesText(1536)).toBe('1.5 KB')
    expect(bytesText(512)).toBe('512 B')
    expect(compactNumber(1234)).toBe('1.2k')
    expect(compactNumber(2.25)).toBe('2.3')
    expect(niceMax(0)).toBe(1)
    expect(niceMax(7)).toBe(8)
    expect(niceMax(130)).toBe(200)
    expect(niceMax(0.3)).toBe(0.4)
    expect(niceBytesMax(1.3 * 1024 * 1024)).toBe(2 * 1024 * 1024)
    expect(niceBytesMax(700)).toBe(800)
    expect(bytesText(1024 * 1024)).toBe('1 MB')
  })

  it('reads BSON numerics', () => {
    expect(status.num(new Int32(5))).toBe(5)
    expect(status.num(Long.fromNumber(123456789012))).toBe(123456789012)
    expect(status.num(undefined)).toBe(0)
    expect(status.num(7.5)).toBe(7.5)
  })
})

describe('server status (standalone)', () => {
  let server: MongoMemoryServer
  let client: MongoClient

  beforeAll(async () => {
    server = await MongoMemoryServer.create()
    client = await MongoClient.connect(server.getUri())
    await client.db('shop').collection('orders').insertMany([{ a: 1 }, { a: 2 }, { a: 3 }])
    await client.db('shop').createCollection('orders_view', { viewOn: 'orders', pipeline: [] })
    await client.db('crm').collection('people').insertOne({ n: 'x' })
  })

  afterAll(async () => {
    await client?.close()
    await server?.stop()
  })

  it('samples serverStatus into a small payload', async () => {
    const r = await status.serverSample(client)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.value
    expect(s.version).toMatch(/^\d+\.\d+/)
    expect(s.uptime).toBeGreaterThanOrEqual(0)
    expect(s.connections.current).toBeGreaterThan(0)
    expect(s.opcounters.insert).toBeGreaterThanOrEqual(1)
    expect(s.network.bytesIn).toBeGreaterThan(0)
    expect(s.mem.resident).toBeGreaterThan(0)
    expect(s.cache?.max).toBeGreaterThan(0)
    expect(s.globalLock).toBeDefined()
    expect(s.document?.inserted).toBeGreaterThanOrEqual(3)
    expect(typeof s.queryExecutor?.scannedObjects).toBe('number')
    expect(JSON.stringify(s).length).toBeLessThan(3000)
  })

  it('rates between two live samples are non-negative', async () => {
    const a = await status.serverSample(client)
    await client.db('shop').collection('orders').find().toArray()
    await new Promise((r) => setTimeout(r, 50))
    const b = await status.serverSample(client)
    if (!a.ok || !b.ok) throw new Error('serverStatus failed')
    const p = statPoint(a.value, b.value)
    expect(p.ops.query).toBeGreaterThan(0)
    expect(Object.values(p.ops).every((v) => v != null && v >= 0)).toBe(true)
  })

  it('describes the server', async () => {
    const info = await status.serverInfo(client)
    expect(info.topology).toBe('standalone')
    expect(info.version).toMatch(/^\d+\./)
    expect(info.storageEngine).toBe('wiredTiger')
    expect(info.hostInfo.ok).toBe(true)
    if (info.hostInfo.ok) expect(info.hostInfo.value.cpuCores).toBeGreaterThan(0)
  })

  it('has no replication or sharding sections', async () => {
    expect(await status.replication(client)).toBeNull()
    expect(await status.sharding(client)).toBeNull()
  })

  it('lists database statistics', async () => {
    const r = await status.dbStats(client)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const shop = r.value.find((d) => d.name === 'shop')!
    expect(shop.views).toBe(1)
    expect(shop.objects).toBeGreaterThanOrEqual(3)
    expect(shop.collections).toBeGreaterThanOrEqual(1)
    expect(shop.storageSize).toBeGreaterThan(0)
    expect(r.value.some((d) => d.name === 'crm')).toBe(true)
  })

  it('classifies permission errors', async () => {
    const r = await status.section(async () => {
      throw Object.assign(new Error('not authorized on admin to execute command { serverStatus: 1 }'), { code: 13, codeName: 'Unauthorized' })
    })
    expect(r).toMatchObject({ ok: false, denied: true })
    expect(await status.section(async () => Promise.reject(new Error('boom')))).toMatchObject({ ok: false, denied: false, error: 'boom' })
  })
})

describe('server status (restricted user)', () => {
  let server: MongoMemoryServer
  let client: MongoClient

  beforeAll(async () => {
    server = await MongoMemoryServer.create({ auth: { enable: true, customRootName: 'root', customRootPwd: 'rootpw' } })
    const root = await MongoClient.connect(server.getUri(), { auth: { username: 'root', password: 'rootpw' }, authSource: 'admin' })
    await root.db('shop').collection('orders').insertOne({ a: 1 })
    await root.db('shop').command({ createUser: 'reader', pwd: 'pw', roles: [{ role: 'read', db: 'shop' }] })
    await root.close()
    client = await MongoClient.connect(server.getUri(), { auth: { username: 'reader', password: 'pw' }, authSource: 'shop' })
  })

  afterAll(async () => {
    await client?.close()
    await server?.stop()
  })

  it('degrades per section instead of failing', async () => {
    const s = await status.serverSample(client)
    expect(s).toMatchObject({ ok: false, denied: true })
    const info = await status.serverInfo(client)
    expect(info.version).toMatch(/^\d+\./)
    expect(info.hostInfo).toMatchObject({ ok: false, denied: true })
    const dbs = await status.dbStats(client)
    expect(dbs.ok).toBe(true)
    if (dbs.ok) expect(dbs.value.map((d) => d.name)).toEqual(['shop'])
  })
})

describe('server status (replica set)', () => {
  let rs: MongoMemoryReplSet
  let client: MongoClient

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 2, storageEngine: 'wiredTiger' } })
    client = await MongoClient.connect(rs.getUri())
    await client.db('app').collection('events').insertMany(Array.from({ length: 20 }, (_, i) => ({ i })))
  })

  afterAll(async () => {
    await client?.close()
    await rs?.stop()
  })

  it('reads members, lag and the oplog window', async () => {
    const info = await status.serverInfo(client)
    expect(info.topology).toBe('replicaSet')
    expect(info.setName).toBeTruthy()
    expect(info.isPrimary).toBe(true)

    const r = await status.replication(client)
    expect(r).not.toBeNull()
    expect(r!.status.ok).toBe(true)
    if (!r!.status.ok) return
    const members = r!.status.value.members
    expect(members).toHaveLength(2)
    expect(members.filter((m) => m.stateStr === 'PRIMARY')).toHaveLength(1)
    expect(members.find((m) => m.self)?.stateStr).toBe('PRIMARY')
    expect(r!.status.value.primary).toBe(members.find((m) => m.stateStr === 'PRIMARY')!.name)
    for (const m of members) {
      expect(m.health).toBe(1)
      if (m.optimeDate) expect(m.lagSec).toBeGreaterThanOrEqual(0)
    }

    expect(r!.oplog.ok).toBe(true)
    if (!r!.oplog.ok) return
    const o = r!.oplog.value
    expect(o.first).toBeInstanceOf(Date)
    expect(o.last!.getTime()).toBeGreaterThanOrEqual(o.first!.getTime())
    expect(o.windowSec).toBeGreaterThanOrEqual(0)
    expect(o.maxBytes).toBeGreaterThan(0)
    expect(o.count).toBeGreaterThan(0)
  })

  it('samples replication opcounters', async () => {
    const r = await status.serverSample(client)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.opcountersRepl).toBeDefined()
  })
})
