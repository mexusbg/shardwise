import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import * as ops from '../src/main/mongo/ops'
import * as indexes from '../src/main/mongo/indexes'

let server: MongoMemoryServer
let client: MongoClient
const DB = 'ixdb'

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  const docs = Array.from({ length: 200 }, (_, i) => ({
    email: `u${i}@x.io`,
    age: i % 90,
    city: ['Rome', 'Paris', 'Oslo'][i % 3],
    createdAt: new Date(Date.UTC(2024, 0, 1 + (i % 28))),
    bio: `person number ${i} likes mongo`,
    loc: { type: 'Point', coordinates: [i % 180, i % 90] },
    attrs: { color: 'red', size: i }
  }))
  await client.db(DB).collection('people').insertMany(docs)
})

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

const byName = async (coll = 'people'): Promise<Record<string, Awaited<ReturnType<typeof indexes.indexDetails>>[number]>> =>
  Object.fromEntries((await indexes.indexDetails(client, DB, coll)).map((d) => [d.name, d]))

describe('index manager ops', () => {
  it('returns sizes, types and usage', async () => {
    await ops.createIndex(client, DB, 'people', { email: 1 }, { unique: true })
    await ops.createIndex(client, DB, 'people', { city: 1, age: -1 }, {})
    await ops.createIndex(client, DB, 'people', { bio: 'text' }, {})
    await ops.createIndex(client, DB, 'people', { loc: '2dsphere' }, {})
    await ops.createIndex(client, DB, 'people', { city: 'hashed' }, {})
    await ops.createIndex(client, DB, 'people', { 'attrs.$**': 1 }, {})
    const coll = client.db(DB).collection('people')
    for (let i = 0; i < 3; i++) await coll.findOne({ email: `u${i}@x.io` })
    await coll.find({ city: 'Rome', age: { $gt: 10 } }).sort({ age: -1 }).hint('city_1_age_-1').toArray()

    const ix = await byName()
    expect(Object.keys(ix).sort()).toEqual(['_id_', 'attrs.$**_1', 'bio_text', 'city_1_age_-1', 'city_hashed', 'email_1', 'loc_2dsphere'])
    expect(ix._id_.type).toBe('regular')
    expect(ix.email_1.type).toBe('regular')
    expect(ix.email_1.unique).toBe(true)
    expect(ix['city_1_age_-1'].type).toBe('compound')
    expect(ix.bio_text.type).toBe('text')
    expect(ix.loc_2dsphere.type).toBe('2dsphere')
    expect(ix.city_hashed.type).toBe('hashed')
    expect(ix['attrs.$**_1'].type).toBe('wildcard')
    for (const d of Object.values(ix)) {
      expect(d.size).toBeGreaterThan(0)
      expect(typeof d.ops).toBe('number')
      expect(d.since).toBeInstanceOf(Date)
      expect(d.building).toBeUndefined()
    }
    expect(ix.email_1.ops).toBeGreaterThanOrEqual(3)
    expect(ix['city_1_age_-1'].ops).toBeGreaterThanOrEqual(1)
    expect(ix.city_hashed.ops).toBe(0)
  })

  it('round-trips TTL (including 0), partial filter, collation and hidden options', async () => {
    await ops.createIndex(client, DB, 'events', { createdAt: 1 }, { expireAfterSeconds: 0, name: 'ttl0' })
    await ops.createIndex(client, DB, 'events', { at: 1 }, { expireAfterSeconds: 3600 })
    await ops.createIndex(client, DB, 'events', { kind: 1 }, {
      partialFilterExpression: { kind: { $exists: true } },
      collation: { locale: 'fr', strength: 2 },
      hidden: true
    })
    await ops.createIndex(client, DB, 'events', { title: 'text', body: 'text' }, { weights: { title: 5 }, default_language: 'italian' })
    const ix = await byName('events')
    expect(ix.ttl0.expireAfterSeconds).toBe(0)
    expect(ix.ttl0.type).toBe('ttl')
    expect(ix.at_1.expireAfterSeconds).toBe(3600)
    expect(ix.kind_1.partialFilterExpression).toEqual({ kind: { $exists: true } })
    expect(ix.kind_1.hidden).toBe(true)
    expect((ix.kind_1 as unknown as { collation: { locale: string; strength: number } }).collation).toMatchObject({ locale: 'fr', strength: 2 })
    const t = ix.title_text_body_text as unknown as { weights: Record<string, number>; default_language: string }
    expect(t.weights).toEqual({ title: 5, body: 1 })
    expect(t.default_language).toBe('italian')
  })

  it('hides and unhides an index', async () => {
    await indexes.setIndexHidden(client, DB, 'people', 'email_1', true)
    expect((await byName()).email_1.hidden).toBe(true)
    await indexes.setIndexHidden(client, DB, 'people', 'email_1', false)
    expect((await byName()).email_1.hidden).toBeFalsy()
    await expect(indexes.setIndexHidden(client, DB, 'people', '_id_', true)).rejects.toThrow(/_id/)
  })

  it('refuses to drop _id_ and drops other indexes', async () => {
    await expect(indexes.dropIndex(client, DB, 'people', '_id_')).rejects.toThrow(/_id index cannot be dropped/)
    await indexes.dropIndex(client, DB, 'people', 'city_hashed')
    const ix = await byName()
    expect(ix.city_hashed).toBeUndefined()
    expect(ix._id_).toBeDefined()
  })

  it('returns an empty list for a missing collection', async () => {
    expect(await indexes.indexDetails(client, DB, 'nope')).toEqual([])
  })
})
