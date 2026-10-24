import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Int32 } from 'bson'
import * as validation from '../src/main/server/validation'
import * as aggregation from '../src/main/mongo/aggregation'
import { newStage, pipelineDocs, previewPipeline } from '@shared/pipeline'
import { pipelineKey, stagesFromDocs, viewPipelineError } from '@shared/viewEdit'

let server: MongoMemoryServer
let client: MongoClient
const DB = 'views'
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v))

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await client
    .db(DB)
    .collection<{ _id: number; name: string; age: number }>('people')
    .insertMany(Array.from({ length: 30 }, (_, i) => ({ _id: i, name: `p${i}`, age: i })))
  await client.db(DB).createCollection('other')
  await client.db(DB).createCollection('adults', { viewOn: 'people', pipeline: [{ $match: { age: { $gte: 18 } } }, { $sort: { age: -1 } }] })
})

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

describe('view editing', () => {
  it('loads a view definition into editor stages', async () => {
    const v = await validation.getView(client, DB, 'adults')
    expect(plain(v)).toEqual({ name: 'adults', viewOn: 'people', pipeline: [{ $match: { age: { $gte: 18 } } }, { $sort: { age: -1 } }] })
    const stages = stagesFromDocs(v.pipeline)
    expect(stages.map((s) => s.op)).toEqual(['$match', '$sort'])
    expect(plain(pipelineDocs(stages))).toEqual(plain(v.pipeline))
    expect(pipelineKey(stages)).toBe(pipelineKey(stagesFromDocs(v.pipeline)))
    await expect(validation.getView(client, DB, 'people')).rejects.toThrow(/not a view/)
    await expect(validation.getView(client, DB, 'nope')).rejects.toThrow(/does not exist/)
  })

  it('previews the edited pipeline against the source collection', async () => {
    const v = await validation.getView(client, DB, 'adults')
    const stages = [...stagesFromDocs(v.pipeline), newStage('$limit', '3')]
    const r = await aggregation.aggregate(client, DB, v.viewOn, previewPipeline(stages, 2, 20, 'output'), {})
    // Previews sample the first 20 source documents (ages 0-19).
    expect(r.docs.map((d) => Number(d.age))).toEqual([19, 18])
  })

  it('saves a view via collMod', async () => {
    const stages = stagesFromDocs([{ $match: { age: { $gte: new Int32(25) } } }, { $project: { name: 1 } }])
    await validation.updateView(client, DB, 'adults', 'people', pipelineDocs(stages))
    const v = await validation.getView(client, DB, 'adults')
    expect(v.pipeline).toHaveLength(2)
    const docs = await client.db(DB).collection('adults').find().toArray()
    expect(docs).toHaveLength(5)
    expect(Object.keys(docs[0]).sort()).toEqual(['_id', 'name'])
  })

  it('can point a view at another source and saves as a new view', async () => {
    await validation.updateView(client, DB, 'adults', 'other', [])
    expect((await validation.getView(client, DB, 'adults')).viewOn).toBe('other')
    await validation.updateView(client, DB, 'adults', 'people', [{ $match: { age: { $gte: 18 } } }])
    await aggregation.createView(client, DB, 'adults_copy', 'people', [{ $match: { age: { $lt: 5 } } }])
    expect(await client.db(DB).collection('adults_copy').countDocuments()).toBe(5)
  })

  it('rejects $out and $merge', async () => {
    await expect(validation.updateView(client, DB, 'adults', 'people', [{ $match: {} }, { $out: 'x' }])).rejects.toThrow(/\$out/)
    await expect(validation.updateView(client, DB, 'adults', 'people', [{ $merge: { into: 'x' } }])).rejects.toThrow(/\$merge/)
    await expect(validation.updateView(client, DB, 'people', 'other', [])).rejects.toThrow(/not a view/)
    expect(plain((await validation.getView(client, DB, 'adults')).pipeline)).toEqual([{ $match: { age: { $gte: 18 } } }])

    const stages = [newStage('$match', '{}'), newStage('$out', "'x'")]
    expect(viewPipelineError(stages)).toMatch(/\$out/)
    stages[1].enabled = false
    expect(viewPipelineError(stages)).toBeNull()
    expect(viewPipelineError([newStage('$merge', "{ into: 'x' }")])).toMatch(/\$merge/)
  })

  it('reports unparsable stages', () => {
    expect(pipelineKey([newStage('$match', '{ a: ')])).toBeNull()
    expect(() => stagesFromDocs([{ a: 1 }])).toThrow(/operator/)
  })
})
