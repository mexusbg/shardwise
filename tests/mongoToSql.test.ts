import { describe, expect, it } from 'vitest'
import { ObjectId } from 'bson'
import { mongoToSql, regexToLike, sqlIdent } from '@shared/mongoToSql'
import { sqlToMongo } from '@shared/sqlToMongo'
import type { SqlTranslation } from '@shared/sqlToMongo'

const sql = (q: Parameters<typeof mongoToSql>[0]): string => {
  const r = mongoToSql(q)
  if (r.sql === null) throw new Error(r.reason)
  return r.sql
}
const reason = (q: Parameters<typeof mongoToSql>[0]): string => {
  const r = mongoToSql(q)
  expect(r.sql).toBeNull()
  return r.reason!
}
const strip = (t: SqlTranslation): unknown => t

describe('mongoToSql: find', () => {
  it('writes SELECT * for an empty query', () => {
    expect(sql({ coll: 'users' })).toBe('SELECT *\nFROM users')
    expect(sql({ coll: 'users', filter: {}, projection: {}, sort: {}, skip: 0, limit: 0 })).toBe('SELECT *\nFROM users')
  })

  it('writes columns, conditions, sort and paging', () => {
    expect(sql({ coll: 'users', filter: { age: { $gt: 30 }, name: 'Ann' }, projection: { name: 1, age: 1, _id: 0 }, sort: { age: -1, name: 1 }, skip: 20, limit: 10 })).toBe(
      "SELECT name, age\nFROM users\nWHERE age > 30 AND name = 'Ann'\nORDER BY age DESC, name\nLIMIT 10 OFFSET 20"
    )
  })

  it('includes _id unless excluded and quotes awkward names', () => {
    expect(sql({ coll: 'my-coll', projection: { 'first-name': 1, 'a.b': 1, select: 1 } })).toBe('SELECT _id, `first-name`, a.b, `select`\nFROM `my-coll`')
    expect(sql({ coll: 'app.users', projection: { 'app.x': 1 } })).toBe('SELECT _id, app.x\nFROM app.users')
    expect(sql({ coll: 'users', projection: { 'users.x': 1, _id: 0 } })).toBe('SELECT users.users.x\nFROM users')
    expect(sqlIdent("we`ird")).toBe('`we``ird`')
  })

  it('maps operators', () => {
    const where = (filter: Record<string, unknown>): string => sql({ coll: 't', filter }).split('\n')[2]
    expect(where({ a: { $ne: 1 }, b: { $lte: 2, $gte: 1 }, c: { $in: ['x', 'y'] }, d: { $nin: [1] } })).toBe("WHERE a != 1 AND b BETWEEN 1 AND 2 AND c IN ('x', 'y') AND d NOT IN (1)")
    expect(where({ a: null, b: { $ne: null }, c: { $exists: true }, d: { $exists: false } })).toBe('WHERE a IS NULL AND b IS NOT NULL AND c IS NOT NULL AND d IS NULL')
    expect(where({ $or: [{ a: 1 }, { b: 2 }], c: 3 })).toBe('WHERE (a = 1 OR b = 2) AND c = 3')
    expect(where({ $nor: [{ a: 1 }] })).toBe('WHERE NOT (a = 1)')
    expect(where({ a: { $not: { $gt: 5 } } })).toBe('WHERE NOT (a > 5)')
    expect(where({ $expr: { $gt: ['$a', '$b'] } })).toBe('WHERE a > b')
    expect(where({ s: "it's" })).toBe("WHERE s = 'it''s'")
  })

  it('writes regular expressions as LIKE', () => {
    const where = (filter: Record<string, unknown>): string => sql({ coll: 't', filter }).split('\n')[2]
    expect(where({ name: /^Jo/ })).toBe("WHERE name LIKE 'Jo%'")
    expect(where({ name: /son$/i })).toBe("WHERE name ILIKE '%son'")
    expect(where({ name: { $regex: '^a.c$' } })).toBe("WHERE name LIKE 'a_c'")
    expect(where({ name: { $regex: 'x', $options: 'i' } })).toBe("WHERE name ILIKE '%x%'")
    expect(where({ name: { $not: /^x/ } })).toBe("WHERE name NOT LIKE 'x%'")
    expect(regexToLike('^100%$')).toBe('100\\%')
    expect(regexToLike('^a\\.b')).toBe('a.b%')
    expect(regexToLike('.*')).toBe('%')
    expect(regexToLike('^\\d+$')).toBeNull()
    expect(regexToLike('a|b')).toBeNull()
  })

  it('writes ObjectId and date literals', () => {
    const id = new ObjectId('650000000000000000000001')
    expect(sql({ coll: 't', filter: { _id: id, at: { $gte: new Date('2024-01-01T00:00:00Z') } } })).toBe(
      "SELECT *\nFROM t\nWHERE _id = ObjectId('650000000000000000000001') AND at >= ISODate('2024-01-01T00:00:00.000Z')"
    )
  })

  it('explains what cannot be represented', () => {
    expect(reason({ coll: 't', projection: { secret: 0 } })).toMatch(/Exclusion projections/)
    expect(reason({ coll: 't', filter: { tags: { $elemMatch: { a: 1 } } } })).toBe('$elemMatch has no SQL equivalent')
    expect(reason({ coll: 't', filter: { a: { b: 1 } } })).toMatch(/embedded document/)
    expect(reason({ coll: 't', filter: { name: /^(a|b)/ } })).toMatch(/cannot be written as LIKE/)
    expect(reason({ coll: 't', filter: { $text: { $search: 'x' } } })).toBe('$text has no SQL equivalent')
    expect(reason({ coll: 't', sort: { score: { $meta: 'textScore' } } })).toMatch(/Sorting by/)
  })
})

describe('mongoToSql: pipelines', () => {
  it('writes $match/$sort/$skip/$limit/$project', () => {
    expect(sql({ coll: 'users', pipeline: [{ $match: { age: { $gt: 30 } } }, { $sort: { age: -1 } }, { $skip: 5 }, { $limit: 5 }, { $project: { n: '$name', age: 1, _id: 0 } }] })).toBe(
      'SELECT name AS n, age\nFROM users\nWHERE age > 30\nORDER BY age DESC\nLIMIT 5 OFFSET 5'
    )
  })

  it('writes $group with accumulators, HAVING and output names', () => {
    expect(
      sql({
        coll: 'orders',
        pipeline: [
          { $match: { status: 'paid' } },
          { $group: { _id: { city: '$city' }, n: { $sum: 1 }, total: { $sum: '$amount' }, avg: { $avg: '$amount' }, lo: { $min: '$amount' }, hi: { $max: '$amount' } } },
          { $match: { n: { $gt: 2 } } },
          { $sort: { total: -1 } },
          { $limit: 10 },
          { $project: { _id: 0, city: '$_id.city', n: 1, total: 1 } }
        ]
      })
    ).toBe("SELECT city, COUNT(*) AS n, SUM(amount) AS total\nFROM orders\nWHERE status = 'paid'\nGROUP BY city\nHAVING COUNT(*) > 2\nORDER BY SUM(amount) DESC\nLIMIT 10")
  })

  it('handles scalar and null group keys and $count', () => {
    expect(sql({ coll: 't', pipeline: [{ $group: { _id: '$kind', c: { $count: {} } } }] })).toBe('SELECT kind AS _id, COUNT(*) AS c\nFROM t\nGROUP BY kind')
    expect(sql({ coll: 't', pipeline: [{ $group: { _id: null, m: { $max: '$v' } } }] })).toBe('SELECT MAX(v) AS m\nFROM t')
    expect(sql({ coll: 't', pipeline: [{ $match: { a: 1 } }, { $count: 'total' }] })).toBe('SELECT COUNT(*) AS total\nFROM t\nWHERE a = 1')
  })

  it('explains unsupported stages and orders', () => {
    expect(reason({ coll: 't', pipeline: [{ $unwind: '$a' }] })).toBe('$unwind has no SQL equivalent')
    expect(reason({ coll: 't', pipeline: [{ $limit: 5 }, { $match: { a: 1 } }] })).toMatch(/\$match after/)
    expect(reason({ coll: 't', pipeline: [{ $limit: 5 }, { $skip: 1 }] })).toMatch(/\$skip after \$limit/)
    expect(reason({ coll: 't', pipeline: [{ $group: { _id: '$a', s: { $push: '$b' } } }] })).toMatch(/\$push/)
    expect(reason({ coll: 't', pipeline: [{ $group: { _id: '$a' } }, { $sort: { other: 1 } }] })).toMatch(/not an output of \$group/)
  })
})

describe('round trips', () => {
  const cases = [
    'SELECT *\nFROM users',
    "SELECT name, age\nFROM users\nWHERE age > 30 AND name LIKE 'A%'\nORDER BY age DESC\nLIMIT 10 OFFSET 5",
    "SELECT _id, status\nFROM orders\nWHERE (status = 'a' OR status IN ('b', 'c')) AND total BETWEEN 1 AND 5",
    'SELECT city, COUNT(*) AS n\nFROM orders\nGROUP BY city\nHAVING COUNT(*) > 2\nORDER BY COUNT(*) DESC\nLIMIT 3',
    'SELECT name AS n\nFROM users\nWHERE deleted IS NULL',
    'SELECT COUNT(*), SUM(amount)\nFROM orders'
  ]
  it.each(cases)('SQL → MongoDB → SQL → MongoDB is stable: %s', (text) => {
    const first = sqlToMongo(text)
    const back = mongoToSql(first.kind === 'find' ? first : { coll: first.coll, pipeline: first.pipeline })
    expect(back.reason).toBeUndefined()
    expect(strip(sqlToMongo(back.sql!))).toEqual(strip(first))
  })
})
