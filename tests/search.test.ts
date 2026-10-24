import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Double, Int32, MongoClient, ObjectId } from 'mongodb'
import type { SearchCollectionResult, SearchEvent, SearchRequest } from '@shared/searchApi'
import { parseUri } from '@shared/connection'
import { ConnectionManager } from '../src/main/mongo/manager'
import { buildProbes, matchDoc, Searches } from '../src/main/search/search'

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let searches: Searches
let conn: string
const listeners = new Map<string, (e: SearchEvent) => void>()
const early: SearchEvent[] = []

const REF = new ObjectId('650a1f2b3c4d5e6f70819203')

interface Outcome {
  state: string
  error?: string
  results: Map<string, SearchCollectionResult>
  progress: number
}

function collect(id: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const out: Outcome = { state: '', results: new Map(), progress: 0 }
    const on = (e: SearchEvent): void => {
      if (e.kind === 'collection') out.results.set(e.result.coll, e.result)
      else if (e.kind === 'progress') out.progress++
      else {
        out.state = e.state
        out.error = e.error
        resolve(out)
      }
    }
    listeners.set(id, on)
    early.filter((e) => e.searchId === id).forEach(on)
  })
}

async function search(p: Partial<SearchRequest>): Promise<Outcome> {
  const id = searches.start({ connId: conn, db: 'find', text: '', type: 'auto', match: 'contains', caseSensitive: false, collections: null, maxPerCollection: 50, deep: false, ...p })
  const o = await collect(id)
  expect(o.state, o.error).toBe('done')
  return o
}

const paths = (o: Outcome, coll: string): string[] => [...new Set((o.results.get(coll)?.hits ?? []).flatMap((h) => h.matches.map((m) => m.path)))].sort()

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  mgr = new ConnectionManager()
  conn = (await mgr.connect(parseUri(server.getUri()))).connId
  searches = new Searches(mgr, (e) => {
    const l = listeners.get(e.searchId)
    if (l) l(e)
    else early.push(e)
  })
  const db = client.db('find')
  await db.collection('people').insertMany([
    { name: 'Alice Smith', age: new Int32(42), address: { city: 'Rome', zip: '00100' }, tags: ['vip', 'rome-fan'], friends: [{ name: 'Bob', ref: REF }] },
    { name: 'Carol Jones', age: new Int32(30), address: { city: 'Milan', zip: '20100' }, tags: [] },
    { name: 'Dan Romero', age: new Int32(55), address: { city: 'Turin' } }
  ])
  await db.collection('orders').insertMany([
    { _id: 1 as never, code: 'ORD-42', total: new Double(42), customer: REF },
    { _id: 2 as never, code: 'ORD-7', total: new Double(7.5), customer: new ObjectId() }
  ])
  await db.collection('many').insertMany(Array.from({ length: 120 }, (_, i) => ({ i, note: `needle ${i}` })))
  await db.collection('rare').insertMany(Array.from({ length: 2000 }, (_, i) => (i === 1234 ? { i, secret: 'hidden-treasure' } : { i, other: 'plain' })))
  await db.createCollection('people_view', { viewOn: 'people', pipeline: [] })
})

afterAll(async () => {
  searches?.cancelAll()
  await mgr?.closeAll()
  await client?.close()
  await server?.stop()
})

describe('probes', () => {
  it('parses typed values and rejects invalid ones', () => {
    expect(buildProbes({ text: '42', type: 'auto', match: 'contains', caseSensitive: false }).map((p) => p.kind)).toEqual(['string', 'number'])
    expect(buildProbes({ text: REF.toHexString(), type: 'auto', match: 'contains', caseSensitive: false }).map((p) => p.kind)).toEqual(['string', 'objectId'])
    expect(buildProbes({ text: `ObjectId("${REF.toHexString()}")`, type: 'auto', match: 'contains', caseSensitive: false }).map((p) => p.kind)).toEqual(['objectId'])
    expect(() => buildProbes({ text: 'abc', type: 'number', match: 'contains', caseSensitive: false })).toThrow(/not a number/)
    expect(() => buildProbes({ text: '123', type: 'objectId', match: 'contains', caseSensitive: false })).toThrow(/24 hex/)
    expect(() => buildProbes({ text: '(', type: 'regex', match: 'contains', caseSensitive: false })).toThrow(/Invalid regular/)
    expect(() => buildProbes({ text: '  ', type: 'auto', match: 'contains', caseSensitive: false })).toThrow(/Enter a value/)
  })

  it('reports concrete paths of matching leaves', () => {
    const probes = buildProbes({ text: 'bob', type: 'string', match: 'contains', caseSensitive: false })
    expect(matchDoc({ a: [{ n: 'x' }, { n: 'Bobby' }], b: { c: 'bob' } }, probes).map((m) => m.path)).toEqual(['a.1.n', 'b.c'])
    expect(matchDoc({ a: [{ n: 'x' }, { n: 'Bobby' }], b: { c: 'bob' } }, probes, 'a.n').map((m) => m.path)).toEqual(['a.1.n'])
  })
})

describe('search', () => {
  it('finds strings anywhere (contains, case-insensitive)', async () => {
    const o = await search({ text: 'smith' })
    expect([...o.results.keys()]).toEqual(['people'])
    expect(paths(o, 'people')).toEqual(['name'])
    expect(o.results.get('people')!.hits[0].matches[0].value).toBe('Alice Smith')
  })

  it('distinguishes exact and contains, and honours case', async () => {
    expect(paths(await search({ text: 'rome', match: 'exact' }), 'people')).toEqual(['address.city'])
    expect(paths(await search({ text: 'rome' }), 'people')).toEqual(['address.city', 'name', 'tags.1'])
    expect(paths(await search({ text: 'rome', caseSensitive: true }), 'people')).toEqual(['tags.1'])
    expect((await search({ text: 'rome', match: 'exact', caseSensitive: true })).results.size).toBe(0)
  })

  it('matches numbers of any numeric type and numeric text', async () => {
    const o = await search({ text: '42' })
    expect(paths(o, 'people')).toEqual(['age'])
    expect(paths(o, 'orders')).toEqual(['code', 'total'])
    const n = await search({ text: '42', type: 'number' })
    expect(paths(n, 'orders')).toEqual(['total'])
  })

  it('matches ObjectIds in nested arrays and plain fields', async () => {
    const o = await search({ text: REF.toHexString(), type: 'objectId' })
    expect(paths(o, 'people')).toEqual(['friends.0.ref'])
    expect(paths(o, 'orders')).toEqual(['customer'])
    expect(Number(o.results.get('orders')!.hits[0]._id)).toBe(1)
  })

  it('restricts to a field path', async () => {
    const o = await search({ text: 'i', field: 'address.city' })
    expect(paths(o, 'people')).toEqual(['address.city'])
    expect(o.results.get('people')!.hits).toHaveLength(2)
    expect(o.results.has('orders')).toBe(false)
  })

  it('supports regular expressions', async () => {
    const o = await search({ text: '/^ord-\\d+$/i' })
    expect(paths(o, 'orders')).toEqual(['code'])
    expect(o.results.get('orders')!.hits).toHaveLength(2)
    const r = await search({ text: '^ORD-4', type: 'regex', caseSensitive: true })
    expect(r.results.get('orders')!.hits).toHaveLength(1)
  })

  it('limits matches per collection', async () => {
    const o = await search({ text: 'needle', maxPerCollection: 50 })
    const r = o.results.get('many')!
    expect(r.hits).toHaveLength(50)
    expect(r.truncated).toBe(true)
    const all = await search({ text: 'needle', maxPerCollection: 500 })
    expect(all.results.get('many')!.hits).toHaveLength(120)
    expect(all.results.get('many')!.truncated).toBe(false)
  })

  it('searches only the selected collections and skips views by default', async () => {
    const o = await search({ text: 'a', collections: ['orders'] })
    expect([...o.results.keys()]).toEqual([])
    const p = await search({ text: 'alice' })
    expect(p.results.has('people_view')).toBe(false)
    const v = await search({ text: 'alice', collections: ['people_view'] })
    expect(paths(v, 'people_view')).toEqual(['name'])
  })

  it('deep scan finds values in rare fields', async () => {
    const o = await search({ text: 'treasure', deep: true, collections: ['rare'] })
    expect(paths(o, 'rare')).toEqual(['secret'])
    const f = await search({ text: 'treasure', deep: true, field: 'secret' })
    expect(paths(f, 'rare')).toEqual(['secret'])
  })

  it('tolerates missing collections and can be cancelled', async () => {
    const o = await search({ text: 'x', collections: ['people', 'missing_coll'] })
    expect(o.state).toBe('done')
    const id = searches.start({ connId: conn, db: 'find', text: 'plain', type: 'auto', match: 'contains', caseSensitive: false, collections: null, maxPerCollection: 5000, deep: true })
    searches.cancel(id)
    const c = await collect(id)
    expect(c.state).toBe('cancelled')
  })
})
