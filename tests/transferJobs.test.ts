import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import ExcelJS from 'exceljs'
import { Binary, BSONRegExp, Decimal128, Double, EJSON, Int32, Long, ObjectId } from 'bson'
import type { Doc, ExportRequest, ImportRequest, JobProgress, JsonFlavor } from '@shared/api'
import { newConnectionConfig, parseUri } from '@shared/connection'
import { ConnectionManager } from '../src/main/mongo/manager'
import { DEFAULT_SETTINGS } from '../src/main/store'
import { Transfers } from '../src/main/transfer/jobs'
import { locateTools, toolConnection } from '../src/main/transfer/bsonTools'

/*
 * BSON tests need mongodump / mongorestore: put them on PATH or set MONGO_TOOLS_PATH to their folder.
 */
const TOOLS_PATH = process.env.MONGO_TOOLS_PATH ?? ''
const toolsFound = !!(await locateTools(TOOLS_PATH, join(tmpdir(), 'shardwise-no-tools')))
const BSON_SKIP_NOTE = toolsFound ? '' : ' (skipped: MongoDB Database Tools not found — set MONGO_TOOLS_PATH)'

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let transfers: Transfers
let connId: string
let dir: string
const DB = 'shop'
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()
const progressCount = new Map<string, number>()
/** Called on the first running update with documents done. */
const runningWaiters = new Map<string, () => void>()

const canon = (v: unknown): string => EJSON.stringify(v as never, { relaxed: false })
const oid = (i: number): ObjectId => new ObjectId(i.toString(16).padStart(24, '0'))

function item(i: number): Doc {
  return {
    _id: oid(i + 1),
    name: `item ${i}`,
    qty: new Int32(i),
    price: new Double(i + 0.5),
    big: Long.fromString('9007199254740993'),
    dec: Decimal128.fromString('1.5'),
    created: new Date(Date.UTC(2024, 0, 1 + i, 12)),
    address: { city: i % 2 ? 'Rome' : 'Paris', zip: `00${i}` },
    tags: ['a', `t${i}`],
    active: i % 2 === 0,
    nothing: null,
    re: new BSONRegExp('^it.m', 'i'),
    bin: new Binary(Buffer.from([1, 2, 3, i]), 0)
  }
}

function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  if (done) return Promise.resolve(done)
  return new Promise((r) => waiters.set(jobId, r))
}

async function allDocs(coll: string, db = DB): Promise<Doc[]> {
  return (await client.db(db).collection(coll).find({}, { promoteValues: false, promoteLongs: false, bsonRegExp: true }).sort({ _id: 1 }).toArray()) as Doc[]
}

async function exportJob(req: Partial<ExportRequest>): Promise<JobProgress> {
  const id = transfers.startExport({ connId, db: DB, collections: ['items'], format: 'json', target: '', ...req } as ExportRequest)
  return wait(id)
}

async function importJob(req: Partial<ImportRequest>): Promise<JobProgress> {
  const id = transfers.startImport({ connId, db: DB, collection: 'x', format: 'json', source: '', mode: 'insert', dropFirst: false, stopOnError: false, ...req } as ImportRequest)
  return wait(id)
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await client.db(DB).collection('items').insertMany(Array.from({ length: 50 }, (_, i) => item(i)))
  await client.db(DB).collection('orders').insertMany([{ _id: new Int32(1), total: new Double(9.99) }, { _id: new Int32(2), total: new Double(5) }] as Doc[] as never)
  await client.db(DB).collection('logs').insertMany([{ msg: 'x' }])
  await client
    .db(DB)
    .collection('big')
    .insertMany(Array.from({ length: 30000 }, (_, i) => ({ n: new Int32(i), pad: 'x'.repeat(100) })))
  dir = await fs.mkdtemp(join(tmpdir(), 'shardwise-transfer-'))
  mgr = new ConnectionManager()
  connId = (await mgr.connect(parseUri(server.getUri()))).connId
  transfers = new Transfers(mgr, { getSettings: async () => ({ ...DEFAULT_SETTINGS, toolsPath: TOOLS_PATH }) }, join(dir, 'userData'), (p) => {
    progressCount.set(p.jobId, (progressCount.get(p.jobId) ?? 0) + 1)
    if (p.state === 'running') {
      if (p.done > 0) runningWaiters.get(p.jobId)?.()
      return
    }
    finals.set(p.jobId, p)
    waiters.get(p.jobId)?.(p)
  })
})

afterAll(async () => {
  transfers?.cancelAll()
  await mgr?.closeAll()
  await client?.close()
  await server?.stop()
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('JSON export / import', () => {
  const cases: [JsonFlavor, 'lines' | 'array', boolean][] = [
    ['shell', 'lines', false],
    ['shell', 'array', true],
    ['canonical', 'lines', false],
    ['canonical', 'array', true],
    ['legacyShell', 'array', false],
    ['legacyShell', 'lines', true]
  ]

  it.each(cases)('%s / %s / pretty=%s round-trips all types', async (flavor, layout, pretty) => {
    const target = join(dir, `items-${flavor}-${layout}-${pretty}.json`)
    const ex = await exportJob({ target, json: { flavor, layout, pretty } })
    expect(ex.state).toBe('done')
    expect(ex.done).toBe(50)
    expect(ex.total).toBe(50)
    expect(ex.log?.[0]).toMatch(/Exported 50 documents from shop\.items/)
    const coll = `json_${flavor}_${layout}_${pretty}`
    const im = await importJob({ collection: coll, source: target })
    expect(im.state).toBe('done')
    expect(im.done).toBe(50)
    expect(canon(await allDocs(coll))).toBe(canon(await allDocs('items')))
  })

  it('relaxed and pure flavours import with their documented type loss', async () => {
    const relaxed = join(dir, 'relaxed.json')
    expect((await exportJob({ target: relaxed, json: { flavor: 'relaxed', layout: 'lines', pretty: false } })).state).toBe('done')
    expect((await importJob({ collection: 'json_relaxed', source: relaxed })).state).toBe('done')
    const r = (await allDocs('json_relaxed'))[3]
    expect((r._id as ObjectId).toHexString()).toBe(oid(4).toHexString())
    expect(r.created).toEqual(new Date(Date.UTC(2024, 0, 4, 12)))
    expect((r.qty as Int32)._bsontype).toBe('Int32')
    expect((r.price as Double)._bsontype).toBe('Double')

    const pure = join(dir, 'pure.json')
    expect((await exportJob({ target: pure, json: { flavor: 'pure', layout: 'array', pretty: true } })).state).toBe('done')
    expect((await importJob({ collection: 'json_pure', source: pure })).state).toBe('done')
    const p = (await allDocs('json_pure', DB)).find((d) => d.name === 'item 3')!
    expect(p._id).toBe(oid(4).toHexString())
    expect(p.created).toBe('2024-01-04T12:00:00.000Z')
    expect(p.big).toBe('9007199254740993')
  })

  it('exports a query-restricted result', async () => {
    const target = join(dir, 'query.json')
    const ex = await exportJob({
      target,
      json: { flavor: 'canonical', layout: 'lines', pretty: false },
      query: { filter: { qty: { $gte: 10 } }, projection: { name: 1, qty: 1 }, sort: { qty: -1 }, skip: 2, limit: 5 }
    })
    expect(ex.state).toBe('done')
    expect(ex.total).toBe(5)
    const lines = (await fs.readFile(target, 'utf8')).trim().split('\n').map((l) => EJSON.parse(l) as Doc)
    expect(lines.map((d) => d.qty)).toEqual([47, 46, 45, 44, 43])
    expect(Object.keys(lines[0]).sort()).toEqual(['_id', 'name', 'qty'])
  })

  it('exports several collections into a folder', async () => {
    const target = join(dir, 'multi')
    const ex = await exportJob({ target, collections: ['items', 'orders'], json: { flavor: 'shell', layout: 'lines', pretty: false } })
    expect(ex.state).toBe('done')
    expect(ex.done).toBe(52)
    expect((await fs.readdir(target)).sort()).toEqual(['items.json', 'orders.json'])
    expect((await fs.readFile(join(target, 'orders.json'), 'utf8')).trim()).toBe('{"_id": NumberInt(1), "total": 9.99}\n{"_id": NumberInt(2), "total": 5.0}')
  })

  it('upserts by _id and drops first', async () => {
    const src = join(dir, 'upsert.json')
    await fs.writeFile(
      src,
      [
        '{"_id": ObjectId("000000000000000000000001"), "name": "changed"}',
        '{"_id": ObjectId("0000000000000000000000ff"), "name": "new"}',
        '{"name": "no id"}'
      ].join('\n')
    )
    await client.db(DB).collection('ups').insertMany([item(0), item(1)])
    const up = await importJob({ collection: 'ups', source: src, mode: 'upsert' })
    expect(up.state).toBe('done')
    expect(up.message).toBe('Imported into shop.ups: 2 inserted, 1 replaced')
    const docs = await allDocs('ups')
    expect(docs).toHaveLength(4)
    expect(canon(docs[0])).toBe(canon({ _id: oid(1), name: 'changed' }))

    const dropped = await importJob({ collection: 'ups', source: src, mode: 'insert', dropFirst: true })
    expect(dropped.state).toBe('done')
    expect(dropped.log).toContain('Dropped shop.ups')
    expect(await client.db(DB).collection('ups').countDocuments()).toBe(3)
  })

  it('collects errors or stops on the first one', async () => {
    const src = join(dir, 'dupes.json')
    await fs.writeFile(src, '[{"_id": 1, "a": 1}, {"_id": 1, "a": 2}, {"_id": 2}, {"_id": Foo()}]')
    const go = await importJob({ collection: 'dupes', source: src })
    expect(go.state).toBe('done')
    expect(go.message).toMatch(/2 inserted, 2 failed/)
    expect(go.log?.some((l) => /E11000/.test(l))).toBe(true)
    expect(go.log?.some((l) => /Line 1: .*Foo/.test(l))).toBe(true)

    const stop = await importJob({ collection: 'dupes2', source: src, stopOnError: true })
    expect(stop.state).toBe('error')
    expect(stop.error).toMatch(/E11000/)
    expect(await client.db(DB).collection('dupes2').countDocuments()).toBe(1)
  })

  it('previews a JSON file', async () => {
    const p = await transfers.preview('json', join(dir, 'items-shell-array-true.json'))
    expect(p.sample).toHaveLength(20)
    expect(p.columns).toEqual(expect.arrayContaining(['_id', 'name', 'address', 'address.city']))
  })
})

describe('CSV export / import', () => {
  it('round-trips with discovered fields and column types', async () => {
    const target = join(dir, 'items.csv')
    const ex = await exportJob({ format: 'csv', target, csv: { fields: [], delimiter: ',', header: true } })
    expect(ex.state).toBe('done')
    const text = await fs.readFile(target, 'utf8')
    const [header, first] = text.split('\n')
    expect(header).toBe('_id,name,qty,price,big,dec,created,address.city,address.zip,tags,active,nothing,re,bin')
    expect(first).toMatch(/^000000000000000000000001,item 0,0,0\.5,9007199254740993,1\.5,2024-01-01T12:00:00\.000Z,Paris,000,"\[""a"",""t0""\]",true,,/)

    const p = await transfers.preview('csv', target, { delimiter: ',' })
    expect(p.columns[0]).toBe('_id')
    expect(p.sample).toHaveLength(20)

    const im = await importJob({
      collection: 'csv_items',
      format: 'csv',
      source: target,
      csv: { delimiter: ',', columnTypes: { _id: 'objectId', 'address.zip': 'string', big: 'skip' } }
    })
    expect(im.state).toBe('done')
    expect(im.done).toBe(50)
    const d = (await allDocs('csv_items'))[5]
    expect((d._id as ObjectId).toHexString()).toBe(oid(6).toHexString())
    expect(d.name).toBe('item 5')
    expect((d.qty as Int32)._bsontype).toBe('Int32')
    expect((d.price as Double).valueOf()).toBe(5.5)
    expect(d.created).toEqual(new Date(Date.UTC(2024, 0, 6, 12)))
    expect(d.address).toEqual({ city: 'Rome', zip: '005' })
    expect(d.tags).toEqual(['a', 't5'])
    expect(d.active).toBe(false)
    expect('nothing' in d).toBe(false)
    expect('big' in d).toBe(false)
    expect(canon(d.re)).toBe(canon(new BSONRegExp('^it.m', 'i')))
  })

  it('exports chosen fields with another delimiter and no header', async () => {
    const target = join(dir, 'fields.tsv')
    const ex = await exportJob({ format: 'csv', target, csv: { fields: ['name', 'address.city'], delimiter: '\t', header: false }, query: { filter: { qty: { $lt: 2 } } } })
    expect(ex.state).toBe('done')
    expect(await fs.readFile(target, 'utf8')).toBe('item 0\tParis\nitem 1\tRome\n')
  })
})

describe('Excel export / import', () => {
  it('round-trips with real dates and numbers', async () => {
    const target = join(dir, 'items.xlsx')
    const ex = await exportJob({ format: 'xlsx', target, xlsx: { fields: [] } })
    expect(ex.state).toBe('done')
    const p = await transfers.preview('xlsx', target)
    expect(p.sheets).toEqual(['items'])
    expect(p.columns).toEqual(['_id', 'name', 'qty', 'price', 'big', 'dec', 'created', 'address.city', 'address.zip', 'tags', 'active', 'nothing', 're', 'bin'])
    expect(p.sample).toHaveLength(20)

    const im = await importJob({ collection: 'xlsx_items', format: 'xlsx', source: target, xlsx: { columnTypes: { _id: 'objectId' } } })
    expect(im.state).toBe('done')
    expect(im.done).toBe(50)
    const d = (await allDocs('xlsx_items'))[7]
    expect((d._id as ObjectId).toHexString()).toBe(oid(8).toHexString())
    expect((d.qty as Int32)._bsontype).toBe('Int32')
    expect((d.qty as Int32).valueOf()).toBe(7)
    expect((d.price as Double).valueOf()).toBe(7.5)
    expect(d.big).toBe('9007199254740993')
    expect(d.created).toEqual(new Date(Date.UTC(2024, 0, 8, 12)))
    expect(d.address).toEqual({ city: 'Rome', zip: '007' })
    expect(d.tags).toEqual(['a', 't7'])
    expect(d.active).toBe(false)
  })

  it('reads a named sheet', async () => {
    const target = join(dir, 'orders.xlsx')
    expect((await exportJob({ format: 'xlsx', target, collections: ['orders'], xlsx: { fields: ['_id', 'total'] } })).state).toBe('done')
    const im = await importJob({ collection: 'xlsx_orders', format: 'xlsx', source: target, xlsx: { sheet: 'orders', columnTypes: {} } })
    expect(im.state).toBe('done')
    // Excel has a single number type: integral values come back as Int32.
    expect(canon(await allDocs('xlsx_orders'))).toBe(canon([{ _id: new Int32(1), total: new Double(9.99) }, { _id: new Int32(2), total: new Int32(5) }]))
    // A workbook with several sheets, written by the regular (non-streaming) writer like Excel would.
    const multi = join(dir, 'multi.xlsx')
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('first & foremost').addRows([['a'], [1]])
    const second = wb.addWorksheet('second')
    second.addRows([['name', 'when', 'n', 'flag'], ['x', new Date('2024-02-03T00:00:00Z'), 2.5, true], [], ['y', null, 3, false]])
    await wb.xlsx.writeFile(multi)
    const p = await transfers.preview('xlsx', multi, { sheet: 'second' })
    expect(p.sheets).toEqual(['first & foremost', 'second'])
    expect(p.columns).toEqual(['name', 'when', 'n', 'flag'])
    const im2 = await importJob({ collection: 'xlsx_multi', format: 'xlsx', source: multi, xlsx: { sheet: 'second', columnTypes: { n: 'number', flag: 'string' } } })
    expect(im2.state).toBe('done')
    const rows = (await allDocs('xlsx_multi')).map(({ _id, ...rest }) => rest)
    expect(canon(rows)).toBe(canon([
      { name: 'x', when: new Date('2024-02-03T00:00:00Z'), n: new Double(2.5), flag: 'true' },
      { name: 'y', n: new Int32(3), flag: 'false' }
    ]))

    const missing = await importJob({ collection: 'xlsx_none', format: 'xlsx', source: target, xlsx: { sheet: 'nope', columnTypes: {} } })
    expect(missing.state).toBe('error')
    expect(missing.error).toMatch(/nope/)
  })
})

describe('jobs', () => {
  it('throttles progress and can be cancelled', async () => {
    const id = transfers.startExport({ connId, db: DB, collections: ['big'], format: 'json', target: join(dir, 'big.json'), json: { flavor: 'shell', layout: 'lines', pretty: true } })
    await new Promise<void>((r) => runningWaiters.set(id, r))
    transfers.cancel(id)
    const p = await wait(id)
    expect(p.state).toBe('cancelled')
    expect(p.done).toBeLessThan(30000)
    await expect(fs.access(join(dir, 'big.json'))).rejects.toThrow()

    const full = await exportJob({ collections: ['big'], target: join(dir, 'big2.json'), json: { flavor: 'canonical', layout: 'lines', pretty: false } })
    expect(full.state).toBe('done')
    expect(full.done).toBe(30000)
    expect(progressCount.get(full.jobId)!).toBeLessThan(200)
  })

  it('reports errors for bad requests', async () => {
    expect(() => transfers.startExport({ connId, db: DB, collections: [], format: 'json', target: 'x' })).toThrow(/No collection/)
    expect(() => transfers.startImport({ connId: 'nope', db: DB, collection: 'x', format: 'json', source: 'x', mode: 'insert', dropFirst: false, stopOnError: false })).toThrow(/Not connected/)
    const p = await importJob({ collection: 'missing', source: join(dir, 'does-not-exist.json') })
    expect(p.state).toBe('error')
    expect(p.error).toMatch(/ENOENT|no such file/)
  })
})

describe('BSON via mongodump / mongorestore', () => {
  it.skipIf(!toolsFound)(`reports the tools${BSON_SKIP_NOTE}`, async () => {
    const s = await transfers.toolsStatus()
    expect(s.found).toBe(true)
    expect(s.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it.skipIf(!toolsFound)(`dumps a subset of collections to a folder and restores into another db${BSON_SKIP_NOTE}`, async () => {
    const target = join(dir, 'dump')
    const ex = await exportJob({ format: 'bson-folder', target, collections: ['items', 'orders'] })
    expect(ex.state).toBe('done')
    expect(ex.done).toBe(52)
    expect(ex.log).toEqual(expect.arrayContaining(['Dumped shop.items (50 documents)', 'Dumped shop.orders (2 documents)']))
    const p = await transfers.preview('bson-folder', target)
    expect(p.namespaces).toEqual(['shop.items', 'shop.orders'])
    const dbFolder = await transfers.preview('bson-folder', join(target, 'shop'))
    expect(dbFolder.namespaces).toEqual(['shop.items', 'shop.orders'])

    const im = await importJob({ db: 'restored', collection: '', format: 'bson-folder', source: join(target, 'shop'), dropFirst: true, bson: { gzip: false } })
    expect(im.state).toBe('done')
    expect(im.done).toBe(52)
    expect(canon(await allDocs('items', 'restored'))).toBe(canon(await allDocs('items')))
    expect((await client.db('restored').listCollections().toArray()).map((c) => c.name).sort()).toEqual(['items', 'orders'])
  })

  it.skipIf(!toolsFound)(`dumps a filtered collection to a gzip archive and restores it renamed${BSON_SKIP_NOTE}`, async () => {
    const target = join(dir, 'items.archive.gz')
    const ex = await exportJob({ format: 'bson-archive', target, bson: { gzip: true }, query: { filter: { qty: { $lt: 10 } } } })
    expect(ex.state).toBe('done')
    expect(ex.done).toBe(10)
    const p = await transfers.preview('bson-archive', target)
    expect(p.namespaces).toEqual(['shop.items'])
    const im = await importJob({ db: 'restored2', collection: 'renamed', format: 'bson-archive', source: target, bson: { gzip: true } })
    expect(im.state).toBe('done')
    expect(im.done).toBe(10)
    expect(await client.db('restored2').collection('renamed').countDocuments()).toBe(10)
  })

  it.skipIf(!toolsFound)(`fails cleanly on mongorestore errors${BSON_SKIP_NOTE}`, async () => {
    const im = await importJob({ db: 'x', collection: '', format: 'bson-archive', source: join(dir, 'items.json'), bson: { gzip: false } })
    expect(im.state).toBe('error')
  })

  it.skipIf(!toolsFound)(`leaves no temporary files behind when a tool job fails early${BSON_SKIP_NOTE}`, async () => {
    const cfg = { ...parseUri(server.getUri()), ssh: { ...newConnectionConfig().ssh, enabled: true, host: 'h', username: 'u' } }
    let finalP: (p: JobProgress) => void = () => {}
    const t = new Transfers(
      { get: () => client, config: () => cfg, tunnelFor: () => undefined },
      { getSettings: async () => ({ ...DEFAULT_SETTINGS, toolsPath: TOOLS_PATH }) },
      join(dir, 'userData'),
      (p) => p.state !== 'running' && finalP(p)
    )
    const temps = (t as unknown as { tempDirs: Set<string> }).tempDirs
    const added: string[] = []
    const add = temps.add.bind(temps)
    temps.add = (d: string) => (added.push(d), add(d))
    const done = new Promise<JobProgress>((r) => (finalP = r))
    t.startExport({ connId, db: DB, collections: ['items'], format: 'bson-archive', target: join(dir, 'never.archive'), query: { filter: { qty: 1 } } })
    const p = await done
    expect(p.state).toBe('error')
    expect(p.error).toMatch(/SSH tunnel of this connection is not open/)
    expect(added.length).toBe(1)
    expect(existsSync(added[0])).toBe(false)
    expect(temps.size).toBe(0)
  })

  it.skipIf(toolsFound)('BSON tests skipped: MongoDB Database Tools not found (set MONGO_TOOLS_PATH)', () => {})
})

describe('tool connection secrets', () => {
  it('writes the URI to a 0600 config file and refuses tools older than 100.3', async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), 'shardwise-conn-'))
    const cfg = { ...parseUri('mongodb://user:p%40ss@db.example:27017/'), tls: { ...newConnectionConfig().tls, enabled: true, caFile: '/ca.pem' } }
    const args = await toolConnection(cfg, { dir: tmp, toolVersion: '100.9.4' })
    expect(args).toEqual([`--config=${join(tmp, 'tools.yaml')}`, '--sslCAFile=/ca.pem'])
    expect(args.join(' ')).not.toMatch(/p%40ss|p@ss/)
    expect(await fs.readFile(join(tmp, 'tools.yaml'), 'utf8')).toMatch(/^uri: "mongodb:\/\/user:p%40ss@db\.example:27017/)
    await expect(toolConnection(cfg, { dir: tmp, toolVersion: '100.2.1' })).rejects.toThrow('MongoDB Database Tools 100.3 or newer is required')
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('cleanupSync removes temporary folders synchronously and cancels the jobs', async () => {
    const t = new Transfers(mgr, { getSettings: async () => DEFAULT_SETTINGS }, join(dir, 'userData'), () => {})
    const withTempDir = (t as unknown as { withTempDir<T>(fn: (d: string) => Promise<T>): Promise<T> }).withTempDir.bind(t)
    let tmp = ''
    let entered: () => void = () => {}
    const inside = new Promise<void>((r) => (entered = r))
    const pending = withTempDir(async (d) => {
      tmp = d
      await fs.writeFile(join(d, 'tools.yaml'), 'uri: secret')
      entered()
      await new Promise(() => {})
    })
    await inside
    expect(existsSync(join(tmp, 'tools.yaml'))).toBe(true)
    t.cleanupSync()
    expect(existsSync(tmp)).toBe(false)
    void pending
    // No new temporary folders after cleanup.
    await expect(withTempDir(async () => 1)).rejects.toThrow(/Cancelled/)
  })
})
