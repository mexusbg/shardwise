import { describe, expect, it } from 'vitest'
import { adviseFromProfile, coveringIndex, createIndexCommand, suggestIndexes } from '@shared/indexAdvisor'

describe('suggestIndexes (ESR)', () => {
  it('orders equality, then sort, then range', () => {
    const [s] = suggestIndexes({ status: 'paid', total: { $gt: 100 }, customerId: 'x' }, { createdAt: -1 })
    expect(s.keys).toEqual([
      ['status', 1],
      ['customerId', 1],
      ['createdAt', -1],
      ['total', 1]
    ])
    expect(s.eqCount).toBe(2)
  })

  it('treats $in as equality without sort and as range with sort', () => {
    expect(suggestIndexes({ tag: { $in: ['a', 'b'] }, age: { $gte: 3 } }, null)[0].keys).toEqual([
      ['tag', 1],
      ['age', 1]
    ])
    expect(suggestIndexes({ tag: { $in: ['a', 'b'] } }, { name: 1 })[0].keys).toEqual([
      ['name', 1],
      ['tag', 1]
    ])
  })

  it('suggests one index per $or branch and handles $elemMatch', () => {
    const s = suggestIndexes({ shop: 1, $or: [{ email: 'a' }, { phone: 'b' }] }, null)
    expect(s.map((x) => x.keys)).toEqual([
      [
        ['shop', 1],
        ['email', 1]
      ],
      [
        ['shop', 1],
        ['phone', 1]
      ]
    ])
    expect(suggestIndexes({ items: { $elemMatch: { sku: 'x', qty: { $gt: 1 } } } }, null)[0].keys).toEqual([
      ['items.sku', 1],
      ['items.qty', 1]
    ])
  })

  it('skips queries that need no or cannot use a regular index', () => {
    expect(suggestIndexes({ _id: 'x' }, null)).toEqual([])
    expect(suggestIndexes({ $where: 'true' }, null)).toEqual([])
    expect(suggestIndexes({}, null)).toEqual([])
  })
})

describe('coveringIndex', () => {
  const existing = [
    { name: '_id_', key: { _id: 1 } },
    { name: 'status_1_customerId_1_createdAt_-1', key: { status: 1, customerId: 1, createdAt: -1 } }
  ]
  it('accepts equality fields in any order and reversed directions after them', () => {
    expect(coveringIndex([['customerId', 1], ['status', 1]], existing, 2)).toBe('status_1_customerId_1_createdAt_-1')
    expect(coveringIndex([['status', 1], ['customerId', 1], ['createdAt', 1]], existing, 2)).toBe('status_1_customerId_1_createdAt_-1')
    expect(coveringIndex([['createdAt', -1]], existing, 0)).toBeUndefined()
  })
})

describe('adviseFromProfile', () => {
  const entry = (filter: object, extra: object = {}) => ({
    op: 'query',
    ns: 'shop.orders',
    command: { find: 'orders', filter, sort: { createdAt: -1 }, $db: 'shop' },
    millis: 120,
    docsExamined: 5000,
    keysExamined: 0,
    nreturned: 10,
    planSummary: 'COLLSCAN',
    hasSortStage: true,
    ...extra
  })
  it('ranks slow collection scans and marks covered suggestions', () => {
    const advice = adviseFromProfile([entry({ status: 'paid' }), entry({ status: 'new' }), entry({ email: 'x' }, { millis: 5 })], {
      orders: [{ name: 'email_1_createdAt_-1', key: { email: 1, createdAt: -1 } }]
    })
    expect(advice).toHaveLength(2)
    expect(advice[0]).toMatchObject({ coll: 'orders', count: 2, totalMs: 240 })
    expect(advice[0].keys).toEqual([
      ['status', 1],
      ['createdAt', -1]
    ])
    expect(advice[0].reasons).toEqual(expect.arrayContaining(['Collection scan', 'Sorted in memory']))
    expect(advice[0].command).toBe('db.orders.createIndex({ status: 1, createdAt: -1 })')
    expect(advice[1].coveredBy).toBe('email_1_createdAt_-1')
  })
  it('ignores efficient queries', () => {
    expect(adviseFromProfile([entry({ status: 'x' }, { planSummary: 'IXSCAN { status: 1 }', hasSortStage: false, docsExamined: 10 })], {})).toEqual([])
  })
  it('quotes awkward names in commands', () => {
    expect(createIndexCommand('my-coll', [['a.b', 1]])).toBe("db.getCollection('my-coll').createIndex({ 'a.b': 1 })")
  })
})
