import { describe, expect, it } from 'vitest'
import { Int32, Long, ObjectId } from 'bson'
import {
  buildProfileFilter,
  groupProfile,
  num,
  opLabel,
  profileQueryParts,
  profileWarnings,
  queryShapeText,
  shapeKey,
  shapeOf,
  shapeText
} from '@shared/profile'
import type { Doc } from '@shared/api'

const ts = (s: string): Date => new Date(`2026-10-21T10:${s}Z`)

// MongoDB 4.4 find with filter + sort (queryHash / planCacheKey)
const find44: Doc = {
  op: 'query',
  ns: 'shop.orders',
  command: {
    find: 'orders',
    filter: { status: 'paid', total: { $gt: 100 }, customer: new ObjectId('650000000000000000000001') },
    sort: { createdAt: -1 },
    projection: { _id: 0, total: 1 },
    skip: 10,
    limit: 20,
    $db: 'shop'
  },
  keysExamined: 0,
  docsExamined: 5000,
  hasSortStage: true,
  cursorExhausted: true,
  numYield: 39,
  nreturned: 20,
  queryHash: '7E4FCC5A',
  planCacheKey: 'A1B2C3D4',
  locks: {},
  responseLength: 2100,
  protocol: 'op_msg',
  millis: 48,
  planSummary: 'COLLSCAN',
  ts: ts('00:01'),
  client: '10.0.0.5',
  appName: 'shop-api',
  allUsers: [],
  user: ''
}

const find44b: Doc = {
  ...find44,
  command: { find: 'orders', filter: { status: 'new', total: { $gt: 5 }, customer: new ObjectId('650000000000000000000002') }, sort: { createdAt: -1 }, $db: 'shop' },
  millis: 12,
  docsExamined: 5000,
  nreturned: 3,
  hasSortStage: true,
  ts: ts('00:02')
}

// MongoDB 8.0 find: queryShapeHash + planCacheShapeHash
const find80: Doc = {
  op: 'query',
  ns: 'shop.users',
  command: { find: 'users', filter: { email: 'a@b.c' }, limit: 1, singleBatch: true, $db: 'shop' },
  keysExamined: 1,
  docsExamined: 1,
  nreturned: 1,
  queryShapeHash: 'F00DCAFEF00DCAFEF00DCAFEF00DCAFEF00DCAFEF00DCAFEF00DCAFEF00DCAFE',
  planCacheShapeHash: '3C5A8B1D',
  planCacheKey: '9AB0D3E1',
  millis: new Int32(3),
  planSummary: 'IXSCAN { email: 1 }',
  ts: ts('00:03')
}

const agg: Doc = {
  op: 'command',
  ns: 'shop.orders',
  command: {
    aggregate: 'orders',
    pipeline: [{ $match: { status: 'paid', 'items.sku': { $in: ['a', 'b'] } } }, { $group: { _id: '$customer', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
    cursor: {},
    $db: 'shop'
  },
  keysExamined: 900,
  docsExamined: 900,
  nreturned: 101,
  usedDisk: true,
  queryHash: 'AB12CD34',
  millis: 230,
  planSummary: 'IXSCAN { status: 1 }',
  ts: ts('00:04')
}

const update: Doc = {
  op: 'update',
  ns: 'shop.orders',
  command: { q: { _id: new ObjectId('650000000000000000000009') }, u: { $set: { status: 'shipped' } }, multi: false, upsert: false },
  keysExamined: 1,
  docsExamined: 1,
  nMatched: 1,
  nModified: 1,
  millis: 1,
  planSummary: 'IDHACK',
  ts: ts('00:05')
}

const remove: Doc = {
  op: 'remove',
  ns: 'shop.sessions',
  command: { q: { expires: { $lt: new Date('2026-01-01') } }, limit: 0 },
  docsExamined: 300,
  ndeleted: 300,
  millis: 40,
  planSummary: 'COLLSCAN',
  ts: ts('00:06')
}

const getMore: Doc = {
  op: 'getmore',
  ns: 'shop.orders',
  command: { getMore: Long.fromNumber(824375234123), collection: 'orders', $db: 'shop' },
  originatingCommand: { find: 'orders', filter: { status: 'paid' }, sort: { createdAt: 1 }, batchSize: 101, $db: 'shop' },
  docsExamined: 200,
  nreturned: 200,
  queryHash: '11223344',
  millis: 7,
  planSummary: 'IXSCAN { status: 1, createdAt: 1 }',
  ts: ts('00:07')
}

const insert: Doc = {
  op: 'insert',
  ns: 'shop.orders',
  command: { insert: 'orders', ordered: true, $db: 'shop' },
  ninserted: 1,
  millis: 2,
  ts: ts('00:08')
}

const count: Doc = {
  op: 'command',
  ns: 'shop.orders',
  command: { count: 'orders', query: { status: 'paid' }, $db: 'shop' },
  millis: 15,
  planSummary: 'COUNT_SCAN { status: 1 }',
  ts: ts('00:09')
}

describe('shapeOf / shapeText', () => {
  it('replaces values and keeps operators and field names in order', () => {
    const shape = shapeOf({ status: 'paid', total: { $gt: 100, $lt: 500 }, $or: [{ a: 1 }, { b: { $in: [1, 2, 3] } }], tags: ['x', 'y'], 'a.b': null })
    expect(shape).toEqual({ status: '?', total: { $gt: '?', $lt: '?' }, $or: [{ a: '?' }, { b: { $in: '?' } }], tags: '?', 'a.b': '?' })
    expect(shapeText(shape)).toBe("{ status: ?, total: { $gt: ?, $lt: ? }, $or: [ { a: ? }, { b: { $in: ? } } ], tags: ?, 'a.b': ? }")
  })

  it('treats BSON values and dates as leaves', () => {
    expect(shapeOf({ _id: new ObjectId(), at: new Date(), n: new Int32(4) })).toEqual({ _id: '?', at: '?', n: '?' })
    expect(shapeOf({ arr: { $elemMatch: { x: 1 } } })).toEqual({ arr: { $elemMatch: { x: '?' } } })
    expect(shapeText(shapeOf({}))).toBe('{}')
  })

  it('reads numbers from BSON wrappers', () => {
    expect(num(new Int32(5))).toBe(5)
    expect(num(Long.fromNumber(42))).toBe(42)
    expect(num(undefined)).toBeUndefined()
  })
})

describe('profileQueryParts', () => {
  it('extracts find filter, sort, projection, skip and limit', () => {
    expect(profileQueryParts(find44)).toEqual({
      kind: 'find',
      coll: 'orders',
      filter: { status: 'paid', total: { $gt: 100 }, customer: new ObjectId('650000000000000000000001') },
      sort: { createdAt: -1 },
      projection: { _id: 0, total: 1 },
      skip: 10,
      limit: 20
    })
  })

  it('uses the first $match of an aggregation', () => {
    const p = profileQueryParts(agg)
    expect(p?.kind).toBe('aggregate')
    expect(p?.coll).toBe('orders')
    expect(p?.filter).toEqual({ status: 'paid', 'items.sku': { $in: ['a', 'b'] } })
    expect(p?.sort).toBeNull()
    expect(profileQueryParts({ ...agg, command: { aggregate: 'orders', pipeline: [{ $group: { _id: 1 } }] } })).toBeNull()
    expect(profileQueryParts({ op: 'command', ns: 'admin.$cmd.aggregate', command: { aggregate: 1, pipeline: [{ $currentOp: {} }] } })).toBeNull()
  })

  it('reads q of per-statement update / remove entries', () => {
    expect(profileQueryParts(update)).toMatchObject({ kind: 'update', coll: 'orders', filter: { _id: new ObjectId('650000000000000000000009') } })
    expect(profileQueryParts(remove)).toMatchObject({ kind: 'delete', coll: 'sessions' })
  })

  it('reads update / delete commands', () => {
    expect(profileQueryParts({ op: 'command', ns: 'shop.orders', command: { update: 'orders', updates: [{ q: { a: 1 }, u: { $set: { b: 1 } } }] } })).toMatchObject({
      kind: 'update',
      coll: 'orders',
      filter: { a: 1 }
    })
    expect(profileQueryParts({ op: 'command', ns: 'shop.orders', command: { delete: 'orders', deletes: [{ q: { a: 2 }, limit: 1 }] } })).toMatchObject({
      kind: 'delete',
      filter: { a: 2 }
    })
  })

  it('follows originatingCommand of getMore', () => {
    expect(profileQueryParts(getMore)).toMatchObject({ kind: 'find', coll: 'orders', filter: { status: 'paid' }, sort: { createdAt: 1 }, limit: 0 })
  })

  it('handles count, distinct, findAndModify, explain and legacy entries', () => {
    expect(profileQueryParts(count)).toMatchObject({ kind: 'count', coll: 'orders', filter: { status: 'paid' } })
    expect(profileQueryParts({ op: 'command', ns: 'shop.orders', command: { distinct: 'orders', key: 'status', query: { total: { $gt: 1 } } } })).toMatchObject({
      kind: 'distinct',
      filter: { total: { $gt: 1 } }
    })
    expect(
      profileQueryParts({ op: 'command', ns: 'shop.jobs', command: { findAndModify: 'jobs', query: { state: 'new' }, sort: { prio: -1 }, update: { $set: { state: 'run' } } } })
    ).toMatchObject({ kind: 'findAndModify', coll: 'jobs', filter: { state: 'new' }, sort: { prio: -1 } })
    expect(profileQueryParts({ op: 'command', ns: 'shop.orders', command: { explain: { find: 'orders', filter: { x: 1 } }, verbosity: 'queryPlanner' } })).toMatchObject({
      kind: 'find',
      filter: { x: 1 }
    })
    expect(profileQueryParts({ op: 'query', ns: 'shop.orders', query: { find: 'orders', filter: { y: 2 } } })).toMatchObject({ coll: 'orders', filter: { y: 2 } })
    expect(profileQueryParts(insert)).toBeNull()
  })
})

describe('labels and shapes', () => {
  it('labels command entries by command name', () => {
    expect(opLabel(agg)).toBe('aggregate')
    expect(opLabel(count)).toBe('count')
    expect(opLabel(find44)).toBe('query')
    expect(opLabel({ op: 'command', command: { createIndexes: 'orders', indexes: [] } })).toBe('createIndexes')
  })

  it('describes query shapes', () => {
    expect(queryShapeText(find44)).toBe('{ status: ?, total: { $gt: ? }, customer: ? } sort { createdAt: -1 } proj { _id, total }')
    expect(queryShapeText(agg)).toBe("[ $match { status: ?, 'items.sku': { $in: ? } }, $group, $sort ]")
    expect(queryShapeText(getMore)).toBe('{ status: ? } sort { createdAt: 1 }')
    expect(queryShapeText(insert)).toBe('insert')
  })

  it('prefers queryShapeHash over planCacheShapeHash over queryHash', () => {
    expect(shapeKey(find80)).toBe(`shop.users|query|${find80.queryShapeHash}`)
    expect(shapeKey({ ...find80, queryShapeHash: undefined })).toBe('shop.users|query|3C5A8B1D')
    expect(shapeKey(find44)).toBe('shop.orders|query|7E4FCC5A')
    expect(shapeKey(insert)).toBe('shop.orders|insert|insert')
  })
})

describe('groupProfile', () => {
  const entries = [count, insert, getMore, remove, update, agg, find80, find44b, find44]
  const groups = groupProfile(entries)

  it('groups by shape with stats, sorted by total time', () => {
    expect(groups.length).toBe(8)
    expect(groups[0]).toMatchObject({ op: 'aggregate', count: 1, totalMs: 230 })
    const finds = groups.find((g) => g.hash === '7E4FCC5A')!
    expect(finds).toMatchObject({ ns: 'shop.orders', op: 'query', count: 2, totalMs: 60, avgMs: 30, maxMs: 48, avgDocsExamined: 5000, avgReturned: 11.5, plans: ['COLLSCAN'], hasCollscan: true })
    expect(finds.lastTs).toEqual(ts('00:02'))
    expect(finds.example).toBe('{ status: ?, total: { $gt: ? }, customer: ? } sort { createdAt: -1 }')
    expect(groups.find((g) => g.ns === 'shop.users')).toMatchObject({ count: 1, totalMs: 3, plans: ['IXSCAN { email: 1 }'], hasCollscan: false })
  })

  it('falls back to ns + op + filter shape without server hashes', () => {
    const a = { op: 'query', ns: 'x.c', command: { find: 'c', filter: { a: 1, b: 'x' } }, millis: 5 }
    const b = { op: 'query', ns: 'x.c', command: { find: 'c', filter: { a: 9, b: 'y' } }, millis: 7 }
    const c = { op: 'query', ns: 'x.c', command: { find: 'c', filter: { b: 'y', a: 9 } }, millis: 1 }
    const g = groupProfile([a, b, c])
    expect(g.map((x) => [x.count, x.totalMs])).toEqual([
      [2, 12],
      [1, 1]
    ])
  })
})

describe('profileWarnings', () => {
  it('flags collscan, in-memory sort, disk use and examined/returned ratio', () => {
    const w = profileWarnings(find44).map((x) => x.text)
    expect(w[0]).toMatch(/COLLSCAN/)
    expect(w[1]).toMatch(/In-memory sort/)
    expect(w[2]).toMatch(/ratio 250:1/)
    expect(profileWarnings(agg).map((x) => x.level)).toEqual(['danger'])
    expect(profileWarnings(find80)).toEqual([])
  })
})

describe('buildProfileFilter', () => {
  const now = new Date('2026-10-21T12:00:00Z')
  it('builds a server-side filter', () => {
    expect(buildProfileFilter({ db: 'shop', minMs: 100, op: 'update', ns: 'orders', nsExact: true, sinceMs: 3600_000, now })).toEqual({
      millis: { $gte: 100 },
      op: 'update',
      ns: 'shop.orders',
      ts: { $gte: new Date('2026-10-21T11:00:00Z') }
    })
  })
  it('maps aggregate to command.aggregate and excludes system.profile reads', () => {
    expect(buildProfileFilter({ db: 'shop', op: 'aggregate' })).toEqual({ op: 'command', 'command.aggregate': { $exists: true }, ns: { $ne: 'shop.system.profile' } })
    expect(buildProfileFilter({ db: 'shop', op: 'all', ns: 'ord.s' })).toEqual({ ns: { $regex: 'ord\\.s', $options: 'i' } })
  })
})
