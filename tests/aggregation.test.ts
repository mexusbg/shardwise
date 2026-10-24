import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Double, Int32, ObjectId } from 'bson'
import { MongoClient } from 'mongodb'
import * as aggregation from '../src/main/mongo/aggregation'
import { parseExplain } from '@shared/explain'
import { MAX_RESULT_DOCS, pipelineDocs, previewPipeline, stagesFromText } from '@shared/pipeline'

let server: MongoMemoryServer
let client: MongoClient
const DB = 'agg'

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await client
    .db(DB)
    .collection('orders')
    .insertMany([
      { _id: new ObjectId('650000000000000000000001'), customer: 'ann', status: 'paid', qty: new Int32(2), price: new Double(10) },
      { _id: new ObjectId('650000000000000000000002'), customer: 'bob', status: 'paid', qty: new Int32(1), price: new Double(5.5) },
      { _id: new ObjectId('650000000000000000000003'), customer: 'ann', status: 'open', qty: new Int32(7), price: new Double(1) }
    ])
  await client
    .db(DB)
    .collection('many')
    .insertMany(Array.from({ length: MAX_RESULT_DOCS + 50 }, (_, i) => ({ i })))
})

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

describe('aggregation', () => {
  it('runs a pipeline and keeps raw numeric types', async () => {
    const r = await aggregation.aggregate(client, DB, 'orders', [{ $match: { status: 'paid' } }, { $sort: { customer: 1 } }], {})
    expect(r.docs.map((d) => d.customer)).toEqual(['ann', 'bob'])
    expect((r.docs[0].qty as Int32)._bsontype).toBe('Int32')
    expect((r.docs[0].price as Double)._bsontype).toBe('Double')
    expect(typeof r.ms).toBe('number')
  })

  it('runs pipelines built from editor text', async () => {
    const stages = stagesFromText(`[
      { $match: { status: 'paid' } },
      { $group: { _id: '$customer', n: { $sum: 1 } } },
      /* disabled */ { $limit: 0 },
      { $sort: { _id: 1 } }
    ]`)
    const r = await aggregation.aggregate(client, DB, 'orders', pipelineDocs(stages), {})
    expect(r.docs).toEqual([
      { _id: 'ann', n: new Int32(1) },
      { _id: 'bob', n: new Int32(1) }
    ])
    const prev = await aggregation.aggregate(client, DB, 'orders', previewPipeline(stages, 0, 2, 'output'), {})
    expect(prev.docs.length).toBeLessThanOrEqual(2)
  })

  it('caps full runs at MAX_RESULT_DOCS + 1 documents', async () => {
    const r = await aggregation.aggregate(client, DB, 'many', [{ $sort: { i: 1 } }], {})
    expect(r.docs).toHaveLength(MAX_RESULT_DOCS + 1)
    const small = await aggregation.aggregate(client, DB, 'many', [{ $limit: 5 }], {})
    expect(small.docs).toHaveLength(5)
  })

  it('passes allowDiskUse, maxTimeMS and collation to the driver', async () => {
    const coll = client.db(DB).collection('orders')
    const spy = vi.spyOn(Object.getPrototypeOf(coll), 'aggregate')
    try {
      const r = await aggregation.aggregate(client, DB, 'orders', [{ $match: { customer: 'ANN' } }], {
        allowDiskUse: true,
        maxTimeMS: 5000,
        collation: { locale: 'en', strength: 2 }
      })
      expect(r.docs).toHaveLength(2)
      const opts = spy.mock.calls.at(-1)![1] as Record<string, unknown>
      expect(opts).toMatchObject({ allowDiskUse: true, maxTimeMS: 5000, collation: { locale: 'en', strength: 2 }, promoteValues: false })
      await aggregation.aggregate(client, DB, 'orders', [], { maxTimeMS: 0, collation: {} })
      const o2 = spy.mock.calls.at(-1)![1] as Record<string, unknown>
      expect(o2.maxTimeMS).toBeUndefined()
      expect(o2.collation).toBeUndefined()
      expect(o2.allowDiskUse).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('fails when maxTimeMS is exceeded', async () => {
    await expect(
      aggregation.aggregate(client, DB, 'many', [{ $match: { $expr: { $function: { body: 'function() { const t = Date.now(); while (Date.now() - t < 50) {} return true }', args: [], lang: 'js' } } } }], {
        maxTimeMS: 20
      })
    ).rejects.toThrow(/time limit|MaxTimeMSExpired|exceeded|interrupted/i)
  })

  it('explains a pipeline with stages the explain model understands', async () => {
    const pipeline = [{ $match: { status: 'paid' } }, { $group: { _id: '$customer', n: { $sum: 1 } } }]
    const ex = await aggregation.explainAggregate(client, DB, 'orders', pipeline, {}, 'executionStats')
    const parsed = parseExplain(ex)
    const names: string[] = []
    const walk = (n: typeof parsed.root): void => {
      names.push(n.stage)
      n.children.forEach(walk)
    }
    walk(parsed.root)
    expect(names.join(' ')).toMatch(/COLLSCAN|scan|GROUP|\$group/i)
    expect(parsed.summary.hasStats).toBe(true)
    const qp = await aggregation.explainAggregate(client, DB, 'orders', pipeline, {}, 'queryPlanner')
    expect(qp).toBeTypeOf('object')
  })

  it('creates a view from a pipeline', async () => {
    await aggregation.createView(client, DB, 'paid_orders', 'orders', [{ $match: { status: 'paid' } }, { $project: { customer: 1 } }])
    const info = await client.db(DB).listCollections({ name: 'paid_orders' }).toArray()
    expect(info[0]).toMatchObject({ type: 'view', options: { viewOn: 'orders' } })
    const docs = await client.db(DB).collection('paid_orders').find().toArray()
    expect(docs.map((d) => d.customer).sort()).toEqual(['ann', 'bob'])
    await expect(aggregation.createView(client, DB, 'paid_orders', 'orders', [])).rejects.toThrow()
    await expect(aggregation.createView(client, DB, ' ', 'orders', [])).rejects.toThrow(/required/)
  })

  it('runs $out pipelines (no documents returned)', async () => {
    const r = await aggregation.aggregate(client, DB, 'orders', [{ $match: { status: 'open' } }, { $out: 'open_orders' }], {})
    expect(r.docs).toEqual([])
    expect(await client.db(DB).collection('open_orders').countDocuments()).toBe(1)
  })
})
