import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Int32, Long } from 'bson'
import type { Doc, JobProgress } from '@shared/api'
import type { CopyOptions, CopyRequest } from '@shared/copyApi'
import { parseUri } from '@shared/connection'
import { ConnectionManager } from '../src/main/mongo/manager'
import { Copies, creationOptions } from '../src/main/copy/copy'

let serverA: MongoMemoryServer
let serverB: MongoMemoryServer
let a: MongoClient
let b: MongoClient
let mgr: ConnectionManager
let copies: Copies
let connA: string
let connB: string
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()
const onRunning = new Map<string, (p: JobProgress) => void>()

function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  if (done) return Promise.resolve(done)
  return new Promise((r) => waiters.set(jobId, r))
}

const OPTS: CopyOptions = { documents: true, indexes: true, collectionOptions: true, views: true, conflict: 'abort', batchSize: 100 }

function req(p: Partial<CopyRequest> & { opts?: Partial<CopyOptions> }): CopyRequest {
  return {
    source: { connId: connA, db: 'shop' },
    target: { connId: connB, db: 'shop' },
    ...p,
    options: { ...OPTS, ...p.opts }
  }
}

async function copy(r: CopyRequest): Promise<JobProgress> {
  const id = await copies.start(r)
  const f = await wait(id)
  expect(f.state, f.error ?? f.message).toBe('done')
  return f
}

async function all(c: MongoClient, db: string, coll: string): Promise<Doc[]> {
  return (await c.db(db).collection(coll).find({}, { promoteValues: false, promoteLongs: false }).sort({ _id: 1 }).toArray()) as Doc[]
}

async function info(c: MongoClient, db: string, coll: string): Promise<Doc | undefined> {
  return (await c.db(db).listCollections({ name: coll }).toArray())[0] as Doc | undefined
}

const products = (): Doc[] =>
  Array.from({ length: 250 }, (_, i) => ({ _id: i + 1, sku: `p-${i + 1}`, qty: new Int32(i), big: Long.fromNumber(i * 1e10), tags: i % 2 ? ['odd'] : ['even'], nested: { n: i } }))

beforeAll(async () => {
  serverA = await MongoMemoryServer.create()
  serverB = await MongoMemoryServer.create()
  a = await MongoClient.connect(serverA.getUri())
  b = await MongoClient.connect(serverB.getUri())
  mgr = new ConnectionManager()
  connA = (await mgr.connect(parseUri(serverA.getUri()))).connId
  connB = (await mgr.connect(parseUri(serverB.getUri()))).connId
  copies = new Copies(mgr, (p) => {
    if (p.state === 'running') return onRunning.get(p.jobId)?.(p)
    finals.set(p.jobId, p)
    waiters.get(p.jobId)?.(p)
  })
  const shop = a.db('shop')
  await shop.createCollection('products', {
    validator: { $jsonSchema: { bsonType: 'object', required: ['sku'] } },
    validationLevel: 'moderate',
    collation: { locale: 'en', strength: 2 }
  })
  await shop.collection('products').insertMany(products() as never)
  await shop.collection('products').createIndexes([
    { key: { sku: 1 }, name: 'sku_unique', unique: true },
    { key: { qty: -1, sku: 1 }, name: 'qty_sku', partialFilterExpression: { qty: { $gt: 5 } } },
    { key: { sku: 'text' }, name: 'sku_text', collation: { locale: 'simple' } }
  ])
  await shop.createCollection('log', { capped: true, size: 65536, max: 100 })
  await shop.collection('log').insertMany(Array.from({ length: 10 }, (_, i) => ({ i })))
  await shop.createCollection('metrics', { timeseries: { timeField: 't', metaField: 'm', granularity: 'minutes' } })
  await shop.collection('metrics').insertMany(Array.from({ length: 20 }, (_, i) => ({ t: new Date(Date.UTC(2024, 0, 1, 0, i)), m: { host: 'a' }, v: i })))
  await shop.createCollection('cheap', { viewOn: 'products', pipeline: [{ $match: { qty: { $lt: 10 } } }] })
  await shop.createCollection('cheapest', { viewOn: 'cheap', pipeline: [{ $match: { qty: { $lt: 3 } } }] })
  await shop.createCollection('empty')
})

afterAll(async () => {
  copies?.cancelAll()
  await mgr?.closeAll()
  await a?.close()
  await b?.close()
  await serverA?.stop()
  await serverB?.stop()
})

describe('creationOptions', () => {
  it('keeps supported options and drops derived bucketing', () => {
    const o = creationOptions({
      validator: { a: 1 },
      capped: false,
      size: 10,
      timeseries: { timeField: 't', granularity: 'hours', bucketMaxSpanSeconds: 2592000 },
      clusteredIndex: { v: 2, key: { _id: 1 }, unique: true, name: '_id_' },
      storageEngine: {}
    })
    expect(o).toEqual({ validator: { a: 1 }, capped: false, timeseries: { timeField: 't', granularity: 'hours' }, clusteredIndex: { key: { _id: 1 }, unique: true, name: '_id_' } })
  })
})

describe('plan', () => {
  it('lists collections first and views in dependency order', async () => {
    const plan = await copies.plan(req({ target: { connId: connB, db: 'planned' } }))
    const names = plan.entries.map((e) => e.source)
    expect(names.slice(0, 4).sort()).toEqual(['empty', 'log', 'metrics', 'products'])
    expect(names.slice(4)).toEqual(['cheap', 'cheapest'])
    expect(names.indexOf('cheap')).toBeLessThan(names.indexOf('cheapest'))
    expect(names.indexOf('cheap')).toBeGreaterThan(names.indexOf('products'))
    expect(plan.entries.find((e) => e.source === 'products')).toMatchObject({ type: 'collection', exists: false, count: 250 })
    expect(plan.entries.find((e) => e.source === 'metrics')?.type).toBe('timeseries')
    expect(plan.targetDbExists).toBe(false)
    const missing = await copies.plan(req({ items: [{ source: 'nope', target: 'nope' }] }))
    expect(missing.missing).toEqual(['nope'])
  })
})

describe('copy across connections', () => {
  it('copies a collection with documents, types, indexes and options', async () => {
    const f = await copy(req({ items: [{ source: 'products', target: 'products' }], target: { connId: connB, db: 'one' } }))
    expect(f.done).toBe(250)
    expect(f.total).toBe(250)
    const src = await all(a, 'shop', 'products')
    const dst = await all(b, 'one', 'products')
    expect(dst).toEqual(src)
    expect((dst[3].qty as Int32)._bsontype).toBe('Int32')
    expect((dst[3].big as Long)._bsontype).toBe('Long')
    const idx = await b.db('one').collection('products').listIndexes().toArray()
    expect(idx.map((i) => i.name).sort()).toEqual(['_id_', 'qty_sku', 'sku_text', 'sku_unique'])
    expect(idx.find((i) => i.name === 'sku_unique')?.unique).toBe(true)
    expect(idx.find((i) => i.name === 'qty_sku')?.partialFilterExpression).toEqual({ qty: { $gt: 5 } })
    const opts = (await info(b, 'one', 'products'))?.options as Doc
    expect(opts.validator).toEqual({ $jsonSchema: { bsonType: 'object', required: ['sku'] } })
    expect(opts.validationLevel).toBe('moderate')
    expect((opts.collation as Doc).locale).toBe('en')
  })

  it('copies a whole database with capped, time-series, empty collections and views', async () => {
    const f = await copy(req({ target: { connId: connB, db: 'full' } }))
    expect(f.state).toBe('done')
    const names = (await b.db('full').listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'))
    expect(names.sort()).toEqual(['cheap', 'cheapest', 'empty', 'log', 'metrics', 'products'])
    const log = (await info(b, 'full', 'log'))?.options as Doc
    expect(log.capped).toBe(true)
    expect(log.max).toBe(100)
    expect((await info(b, 'full', 'metrics'))?.type).toBe('timeseries')
    expect(await b.db('full').collection('metrics').countDocuments()).toBe(20)
    const view = (await info(b, 'full', 'cheapest')) as Doc
    expect(view.type).toBe('view')
    expect((view.options as Doc).viewOn).toBe('cheap')
    expect(await b.db('full').collection('cheapest').countDocuments()).toBe(3)
    expect(await b.db('full').collection('empty').countDocuments()).toBe(0)
  })

  it('skips views and options when disabled', async () => {
    await copy(req({ target: { connId: connB, db: 'bare' }, opts: { views: false, collectionOptions: false, indexes: false } }))
    const list = await b.db('bare').listCollections().toArray()
    expect(list.some((c) => c.type === 'view')).toBe(false)
    expect((list.find((c) => c.name === 'products') as Doc).options).toEqual({})
    expect((await b.db('bare').collection('products').listIndexes().toArray()).length).toBe(1)
    expect(await b.db('bare').collection('metrics').countDocuments()).toBe(20)
  })

  it('applies a filter to a single collection', async () => {
    await copy(req({ items: [{ source: 'products', target: 'few', filter: { qty: { $lt: 7 } } }], target: { connId: connB, db: 'filtered' } }))
    expect(await b.db('filtered').collection('few').countDocuments()).toBe(7)
  })
})

describe('same connection', () => {
  it('copies into the same database under another name and maps view sources', async () => {
    await copy(
      req({
        target: { connId: connA, db: 'shop' },
        items: [
          { source: 'products', target: 'products_copy' },
          { source: 'cheap', target: 'cheap_copy' }
        ]
      })
    )
    expect(await a.db('shop').collection('products_copy').countDocuments()).toBe(250)
    expect(((await info(a, 'shop', 'cheap_copy'))?.options as Doc).viewOn).toBe('products_copy')
  })

  it('refuses to copy a collection onto itself', async () => {
    await expect(copies.start(req({ target: { connId: connA, db: 'shop' }, items: [{ source: 'products', target: 'products' }] }))).rejects.toThrow(/onto itself/)
  })

  it('refuses a same-database copy whose target is also copied from', async () => {
    // products → log would overwrite log before log → log_copy reads it.
    const items = [
      { source: 'products', target: 'log' },
      { source: 'log', target: 'log_copy' }
    ]
    await expect(copies.start(req({ target: { connId: connA, db: 'shop' }, items, opts: { conflict: 'merge' } }))).rejects.toThrow(/both copied and overwritten/)
    expect(await a.db('shop').collection('log_copy').countDocuments()).toBe(0)
  })

  it('never drops a collection to put a view in its place unless asked to drop', async () => {
    await b.db('vconf').dropDatabase()
    await b.db('vconf').collection('cheap').insertMany([{ _id: 1, keep: true }] as never)
    const f = await copy(req({ target: { connId: connB, db: 'vconf' }, items: [{ source: 'cheap', target: 'cheap' }], opts: { conflict: 'replace' } }))
    expect(f.message).toMatch(/1 failed/)
    expect(await b.db('vconf').collection('cheap').countDocuments()).toBe(1)
    expect((await info(b, 'vconf', 'cheap'))?.type).toBe('collection')
    await copy(req({ target: { connId: connB, db: 'vconf' }, items: [{ source: 'cheap', target: 'cheap' }], opts: { conflict: 'drop' } }))
    expect((await info(b, 'vconf', 'cheap'))?.type).toBe('view')
  })

  it('rejects invalid names', async () => {
    await expect(copies.start(req({ target: { connId: connB, db: 'x' }, items: [{ source: 'products', target: 'a$b' }] }))).rejects.toThrow(/\$/)
    await expect(copies.start(req({ target: { connId: connB, db: 'bad.db' } }))).rejects.toThrow(/Invalid database/)
  })
})

describe('conflict policies', () => {
  const seedTarget = async (): Promise<void> => {
    await b.db('conf').dropDatabase()
    await b
      .db('conf')
      .collection('products')
      .insertMany([
        { _id: 1, sku: 'changed', extra: true },
        { _id: 9999, sku: 'only-target' }
      ] as never)
  }
  const item = [{ source: 'products', target: 'products' }]

  it('abort refuses when the target exists', async () => {
    await seedTarget()
    await expect(copies.start(req({ target: { connId: connB, db: 'conf' }, items: item }))).rejects.toThrow(/Already in conf: products/)
  })

  it('drop replaces the target collection', async () => {
    await seedTarget()
    await copy(req({ target: { connId: connB, db: 'conf' }, items: item, opts: { conflict: 'drop' } }))
    const docs = await all(b, 'conf', 'products')
    expect(docs.length).toBe(250)
    expect(docs[0].sku).toBe('p-1')
    expect(((await info(b, 'conf', 'products'))?.options as Doc).validator).toBeDefined()
  })

  it('merge inserts new documents and skips duplicates', async () => {
    await seedTarget()
    const f = await copy(req({ target: { connId: connB, db: 'conf' }, items: item, opts: { conflict: 'merge', indexes: false } }))
    const docs = await all(b, 'conf', 'products')
    expect(docs.length).toBe(251)
    expect(docs.find((d) => Number(d._id) === 1)?.sku).toBe('changed')
    expect(f.message).toMatch(/1 duplicates skipped/)
  })

  it('replace overwrites documents with the same _id', async () => {
    await seedTarget()
    await copy(req({ target: { connId: connB, db: 'conf' }, items: item, opts: { conflict: 'replace', indexes: false } }))
    const docs = await all(b, 'conf', 'products')
    expect(docs.length).toBe(251)
    expect(docs.find((d) => Number(d._id) === 1)).toEqual((await all(a, 'shop', 'products'))[0])
    expect(docs.find((d) => Number(d._id) === 9999)?.sku).toBe('only-target')
  })
})

describe('cancel', () => {
  it('stops between batches', async () => {
    await a
      .db('big')
      .collection('rows')
      .insertMany(Array.from({ length: 20000 }, (_, i) => ({ _id: i, pad: 'x'.repeat(200) })) as never)
    const id = await copies.start({ source: { connId: connA, db: 'big' }, target: { connId: connB, db: 'big' }, options: { ...OPTS, batchSize: 50 } })
    onRunning.set(id, (p) => {
      if (p.done > 0) copies.cancel(id)
    })
    const f = await wait(id)
    expect(f.state).toBe('cancelled')
    const n = await b.db('big').collection('rows').countDocuments()
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(20000)
  })
})
