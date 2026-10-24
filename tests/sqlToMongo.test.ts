import { describe, expect, it } from 'vitest'
import { ObjectId } from 'bson'
import { likeToRegex, splitSqlStatements, SqlError, sqlPosition, sqlStatementAt, sqlTables, sqlToMongo } from '@shared/sqlToMongo'
import type { SqlAggregate, SqlFind } from '@shared/sqlToMongo'

const find = (sql: string): SqlFind => {
  const r = sqlToMongo(sql)
  expect(r.kind).toBe('find')
  return r as SqlFind
}
const agg = (sql: string): SqlAggregate => {
  const r = sqlToMongo(sql)
  expect(r.kind).toBe('aggregate')
  return r as SqlAggregate
}
const where = (cond: string): unknown => find(`SELECT * FROM t WHERE ${cond}`).filter
const sqlError = (sql: string): SqlError => {
  try {
    sqlToMongo(sql)
  } catch (e) {
    expect(e).toBeInstanceOf(SqlError)
    return e as SqlError
  }
  throw new Error(`expected an error for: ${sql}`)
}

describe('sqlToMongo: SELECT … FROM', () => {
  it('translates SELECT * with LIMIT into a find', () => {
    expect(sqlToMongo('SELECT * FROM users LIMIT 50')).toEqual({ coll: 'users', kind: 'find', filter: {}, projection: null, sort: null, skip: 0, limit: 50 })
  })

  it('projects listed columns and hides _id unless selected', () => {
    expect(find('select name, address.city from users').projection).toEqual({ name: 1, 'address.city': 1, _id: 0 })
    expect(find('SELECT _id, name FROM users').projection).toEqual({ _id: 1, name: 1 })
  })

  it('accepts quoted identifiers for collections and fields', () => {
    const r = find('SELECT `first-name`, "last name" FROM `my.coll-1` ORDER BY "last name"')
    expect(r.coll).toBe('my.coll-1')
    expect(r.projection).toEqual({ 'first-name': 1, 'last name': 1, _id: 0 })
    expect(r.sort).toEqual({ 'last name': 1 })
    expect(find('SELECT * FROM [weird coll]').coll).toBe('weird coll')
  })

  it('accepts dotted collection names and strips table qualifiers', () => {
    const r = find('SELECT u.name FROM app.users u WHERE u.age > 3')
    expect(r.coll).toBe('app.users')
    expect(r.projection).toEqual({ name: 1, _id: 0 })
    expect(r.filter).toEqual({ age: { $gt: 3 } })
    expect(find('SELECT users.name FROM users').projection).toEqual({ name: 1, _id: 0 })
  })

  it('handles ORDER BY, LIMIT, OFFSET in their variants', () => {
    const r = find('SELECT * FROM t ORDER BY a DESC, b ASC, c LIMIT 10 OFFSET 20')
    expect(r.sort).toEqual({ a: -1, b: 1, c: 1 })
    expect([r.skip, r.limit]).toEqual([20, 10])
    expect(find('SELECT * FROM t LIMIT 5, 10')).toMatchObject({ skip: 5, limit: 10 })
    expect(find('SELECT * FROM t OFFSET 3 ROWS FETCH FIRST 4 ROWS ONLY')).toMatchObject({ skip: 3, limit: 4 })
    expect(find('SELECT TOP 7 * FROM t')).toMatchObject({ limit: 7 })
    expect(find('SELECT a, b FROM t ORDER BY 2 DESC').sort).toEqual({ b: -1 })
  })

  it('ignores comments and a trailing semicolon', () => {
    expect(find('-- all users\nSELECT * /* everything */ FROM users;').coll).toBe('users')
  })
})

describe('sqlToMongo: WHERE', () => {
  it('maps comparison operators', () => {
    expect(where("name = 'Ann'")).toEqual({ name: 'Ann' })
    expect(where('a != 1')).toEqual({ a: { $ne: 1 } })
    expect(where('a <> 1')).toEqual({ a: { $ne: 1 } })
    expect(where('a < 1')).toEqual({ a: { $lt: 1 } })
    expect(where('a <= 1.5')).toEqual({ a: { $lte: 1.5 } })
    expect(where('a > -2')).toEqual({ a: { $gt: -2 } })
    expect(where('a >= 1e3')).toEqual({ a: { $gte: 1000 } })
    expect(where('5 < a')).toEqual({ a: { $gt: 5 } })
  })

  it('merges AND on distinct and same fields', () => {
    expect(where('a > 1 AND a < 5 AND b = true')).toEqual({ a: { $gt: 1, $lt: 5 }, b: true })
    expect(where('a = 1 AND a = 2')).toEqual({ $and: [{ a: 1 }, { a: 2 }] })
  })

  it('maps OR, NOT and parentheses', () => {
    expect(where('a = 1 OR b = 2 OR c = 3')).toEqual({ $or: [{ a: 1 }, { b: 2 }, { c: 3 }] })
    expect(where('(a = 1 OR b = 2) AND c = 3')).toEqual({ $or: [{ a: 1 }, { b: 2 }], c: 3 })
    expect(where('NOT a = 1')).toEqual({ a: { $ne: 1 } })
    expect(where('NOT (a > 1)')).toEqual({ a: { $not: { $gt: 1 } } })
    expect(where('NOT (a = 1 OR b = 2)')).toEqual({ $nor: [{ a: 1 }, { b: 2 }] })
    expect(where('NOT (a = 1 AND b = 2)')).toEqual({ $nor: [{ a: 1, b: 2 }] })
  })

  it('maps IN, NOT IN and BETWEEN', () => {
    expect(where("status IN ('a', 'b')")).toEqual({ status: { $in: ['a', 'b'] } })
    expect(where('n NOT IN (1, 2)')).toEqual({ n: { $nin: [1, 2] } })
    expect(where('n BETWEEN 1 AND 10')).toEqual({ n: { $gte: 1, $lte: 10 } })
    expect(where('n NOT BETWEEN 1 AND 10')).toEqual({ $or: [{ n: { $lt: 1 } }, { n: { $gt: 10 } }] })
    expect(where('n BETWEEN 1 AND 10 AND m = 2')).toEqual({ n: { $gte: 1, $lte: 10 }, m: 2 })
  })

  it('maps LIKE / ILIKE to anchored regular expressions', () => {
    expect(where("name LIKE 'Jo%'")).toEqual({ name: { $regex: '^Jo' } })
    expect(where("name LIKE '%son'")).toEqual({ name: { $regex: 'son$' } })
    expect(where("name LIKE '%a.b%'")).toEqual({ name: { $regex: 'a\\.b' } })
    expect(where("name LIKE 'a_c'")).toEqual({ name: { $regex: '^a.c$' } })
    expect(where("name ILIKE 'ann%'")).toEqual({ name: { $regex: '^ann', $options: 'i' } })
    expect(where("name NOT LIKE 'x%'")).toEqual({ name: { $not: { $regex: '^x' } } })
    expect(where("code LIKE '50!%%' ESCAPE '!'")).toEqual({ code: { $regex: '^50%' } })
    expect(likeToRegex('100\\%')).toBe('^100%$')
    expect(likeToRegex('(a)+[b]?')).toBe('^\\(a\\)\\+\\[b\\]\\?$')
    expect(likeToRegex('%')).toBe('')
    expect(likeToRegex('%%')).toBe('')
    expect(likeToRegex('')).toBe('^$')
    expect(likeToRegex('a\\\\%')).toBe('^a\\\\')
  })

  it('maps IS NULL and IS NOT NULL', () => {
    expect(where('deleted IS NULL')).toEqual({ deleted: null })
    expect(where('deleted IS NOT NULL')).toEqual({ deleted: { $ne: null } })
    expect(where('active IS TRUE')).toEqual({ active: true })
  })

  it('parses literals: booleans, null, ObjectId, dates', () => {
    expect(where('a = true AND b = FALSE AND c = null')).toEqual({ a: true, b: false, c: null })
    const id = where("_id = ObjectId('650000000000000000000001')") as { _id: ObjectId }
    expect(id._id).toBeInstanceOf(ObjectId)
    expect(id._id.toHexString()).toBe('650000000000000000000001')
    const d = where("at >= ISODate('2024-01-02T03:04:05') AND at < DATE '2024-02-01' AND x > TIMESTAMP '2024-01-01 10:00:00'") as Record<string, Record<string, Date>>
    expect(d.at.$gte.toISOString()).toBe('2024-01-02T03:04:05.000Z')
    expect(d.at.$lt.toISOString()).toBe('2024-02-01T00:00:00.000Z')
    expect(d.x.$gt.toISOString()).toBe('2024-01-01T10:00:00.000Z')
    expect(where("s = 'it''s'")).toEqual({ s: "it's" })
  })

  it('treats a column named date as a column', () => {
    expect(where("date > DATE '2024-01-01'")).toEqual({ date: { $gt: new Date('2024-01-01T00:00:00Z') } })
  })

  it('uses $expr for field-to-field comparisons and expressions', () => {
    expect(where('a > b')).toEqual({ $expr: { $gt: ['$a', '$b'] } })
    expect(where('price * qty >= 100')).toEqual({ $expr: { $gte: [{ $multiply: ['$price', '$qty'] }, 100] } })
    expect(where("UPPER(name) = 'ANN' AND x = 1")).toEqual({ $expr: { $eq: [{ $toUpper: '$name' }, 'ANN'] }, x: 1 })
  })

  it('treats a bare column as a truthy test', () => {
    expect(where('active')).toEqual({ active: true })
  })
})

describe('sqlToMongo: SELECT expressions and aliases', () => {
  it('switches to an aggregation with $project for aliases', () => {
    expect(agg('SELECT name AS n, age FROM users WHERE age > 30 ORDER BY age DESC LIMIT 5').pipeline).toEqual([
      { $match: { age: { $gt: 30 } } },
      { $sort: { age: -1 } },
      { $limit: 5 },
      { $project: { n: '$name', age: '$age', _id: 0 } }
    ])
  })

  it('translates scalar functions and arithmetic', () => {
    const p = agg("SELECT UPPER(name) AS u, LOWER(name), LENGTH(name) AS len, CONCAT(first, ' ', last) AS full, SUBSTRING(name, 2, 3) AS sub, a + b AS s, price * qty AS total FROM t").pipeline
    expect(p).toEqual([
      {
        $project: {
          u: { $toUpper: '$name' },
          'LOWER(name)': { $toLower: '$name' },
          len: { $strLenCP: '$name' },
          full: { $concat: ['$first', ' ', '$last'] },
          sub: { $substrCP: ['$name', 1, 3] },
          s: { $add: ['$a', '$b'] },
          total: { $multiply: ['$price', '$qty'] },
          _id: 0
        }
      }
    ])
  })

  it('sorts after $project when ordering by a computed alias', () => {
    expect(agg('SELECT name, price * qty AS total FROM t ORDER BY total DESC LIMIT 3').pipeline).toEqual([
      { $project: { name: '$name', total: { $multiply: ['$price', '$qty'] }, _id: 0 } },
      { $sort: { total: -1 } },
      { $limit: 3 }
    ])
  })

  it('escapes string literals that look like field paths', () => {
    expect(agg("SELECT CONCAT('$', price) AS p FROM t").pipeline[0]).toEqual({ $project: { p: { $concat: [{ $literal: '$' }, '$price'] }, _id: 0 } })
  })
})

describe('sqlToMongo: aggregates and GROUP BY', () => {
  it('groups by columns with COUNT/SUM/AVG/MIN/MAX', () => {
    expect(agg('SELECT city, COUNT(*), SUM(total) AS revenue, AVG(total) avg_total, MIN(total), MAX(total) FROM orders GROUP BY city').pipeline).toEqual([
      {
        $group: {
          _id: { city: '$city' },
          'COUNT(*)': { $sum: 1 },
          revenue: { $sum: '$total' },
          avg_total: { $avg: '$total' },
          'MIN(total)': { $min: '$total' },
          'MAX(total)': { $max: '$total' }
        }
      },
      { $project: { city: '$_id.city', 'COUNT(*)': '$COUNT(*)', revenue: '$revenue', avg_total: '$avg_total', 'MIN(total)': '$MIN(total)', 'MAX(total)': '$MAX(total)', _id: 0 } }
    ])
  })

  it('groups by several keys, filters with WHERE and HAVING, sorts and limits', () => {
    expect(agg('SELECT a, b, COUNT(*) AS n FROM t WHERE x = 1 GROUP BY a, b HAVING COUNT(*) > 2 ORDER BY n DESC LIMIT 10').pipeline).toEqual([
      { $match: { x: 1 } },
      { $group: { _id: { a: '$a', b: '$b' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 2 } } },
      { $sort: { n: -1 } },
      { $limit: 10 },
      { $project: { a: '$_id.a', b: '$_id.b', n: '$n', _id: 0 } }
    ])
  })

  it('supports HAVING on aliases and ORDER BY on group keys', () => {
    expect(agg('SELECT dept, SUM(salary) AS total FROM emp GROUP BY dept HAVING total >= 1000 ORDER BY dept').pipeline).toEqual([
      { $group: { _id: { dept: '$dept' }, total: { $sum: '$salary' } } },
      { $match: { total: { $gte: 1000 } } },
      { $sort: { '_id.dept': 1 } },
      { $project: { dept: '$_id.dept', total: '$total', _id: 0 } }
    ])
  })

  it('aggregates without GROUP BY into a single group', () => {
    expect(agg('SELECT COUNT(*) AS n FROM t WHERE a > 1').pipeline).toEqual([{ $match: { a: { $gt: 1 } } }, { $group: { _id: null, n: { $sum: 1 } } }, { $project: { n: '$n', _id: 0 } }])
  })

  it('translates COUNT(field) and COUNT(DISTINCT field)', () => {
    expect(agg('SELECT COUNT(email) AS e, COUNT(DISTINCT city) AS c FROM t').pipeline).toEqual([
      { $group: { _id: null, e: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$email', null] }, null] }, 0, 1] } }, c: { $addToSet: '$city' } } },
      { $set: { c: { $size: '$c' } } },
      { $project: { e: '$e', c: '$c', _id: 0 } }
    ])
  })

  it('translates SELECT DISTINCT into $group', () => {
    expect(agg('SELECT DISTINCT country, city FROM t ORDER BY country').pipeline).toEqual([
      { $group: { _id: { country: '$country', city: '$city' } } },
      { $sort: { '_id.country': 1 } },
      { $project: { country: '$_id.country', city: '$_id.city', _id: 0 } }
    ])
  })

  it('names dotted group keys safely and flattens the output column', () => {
    expect(agg('SELECT address.city, COUNT(*) AS n FROM t GROUP BY address.city').pipeline).toEqual([
      { $group: { _id: { address_city: '$address.city' }, n: { $sum: 1 } } },
      { $project: { city: '$_id.address_city', n: '$n', _id: 0 } }
    ])
  })

  it('supports expressions over aggregates and group keys by ordinal or expression', () => {
    expect(agg('SELECT YEAR(at) AS y, SUM(a) / COUNT(*) AS mean FROM t GROUP BY 1 ORDER BY mean DESC').pipeline).toEqual([
      { $group: { _id: { y: { $year: '$at' } }, 'SUM(a)': { $sum: '$a' }, 'COUNT(*)': { $sum: 1 } } },
      { $project: { y: '$_id.y', mean: { $divide: ['$SUM(a)', '$COUNT(*)'] }, _id: 0 } },
      { $sort: { mean: -1 } }
    ])
  })

  it('rejects columns that are neither grouped nor aggregated', () => {
    expect(sqlError('SELECT city, name, COUNT(*) FROM t GROUP BY city').message).toMatch(/'name' must be in GROUP BY/)
  })
})

describe('sqlToMongo: JOIN', () => {
  it('translates INNER JOIN into $lookup + $unwind', () => {
    expect(agg('SELECT o.total, c.name AS customer FROM orders o JOIN customers c ON o.customerId = c._id WHERE o.total > 10 AND c.vip = true').pipeline).toEqual([
      { $match: { total: { $gt: 10 } } },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $match: { 'c.vip': true } },
      { $project: { total: '$total', customer: '$c.name', _id: 0 } }
    ])
  })

  it('translates LEFT JOIN with preserveNullAndEmptyArrays and either ON order', () => {
    expect(agg('SELECT * FROM orders LEFT OUTER JOIN customers ON customers._id = orders.customerId').pipeline).toEqual([
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customers' } },
      { $unwind: { path: '$customers', preserveNullAndEmptyArrays: true } }
    ])
  })

  it('chains joins and keeps extra INNER JOIN conditions as $match', () => {
    expect(agg('SELECT a.x FROM a INNER JOIN b ON a.bid = b.id AND b.on = 1 JOIN c ON c.id = b.cid').pipeline).toEqual([
      { $lookup: { from: 'b', localField: 'bid', foreignField: 'id', as: 'b' } },
      { $unwind: '$b' },
      { $match: { 'b.on': 1 } },
      { $lookup: { from: 'c', localField: 'b.cid', foreignField: 'id', as: 'c' } },
      { $unwind: '$c' },
      { $project: { x: 1, _id: 0 } }
    ])
  })

  it('groups over joined documents', () => {
    expect(agg('SELECT c.country, SUM(o.total) AS revenue FROM orders o JOIN customers c ON o.cid = c._id GROUP BY c.country').pipeline).toEqual([
      { $lookup: { from: 'customers', localField: 'cid', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $group: { _id: { c_country: '$c.country' }, revenue: { $sum: '$total' } } },
      { $project: { country: '$_id.c_country', revenue: '$revenue', _id: 0 } }
    ])
  })

  it('rejects joins without a usable equality', () => {
    expect(sqlError('SELECT * FROM a JOIN b ON a.x > b.y').message).toMatch(/needs an equality/)
    expect(sqlError('SELECT * FROM a LEFT JOIN b ON a.x = b.y AND b.z = 1').message).toMatch(/single equality/)
    expect(sqlError('SELECT * FROM a RIGHT JOIN b ON a.x = b.y').message).toMatch(/RIGHT JOIN is not supported/)
    expect(sqlError('SELECT * FROM a, b').message).toMatch(/Comma-separated tables/)
  })
})

describe('sqlToMongo: errors', () => {
  it('reports positions', () => {
    const sql = 'SELECT *\nFROM t\nWHERE a = = 1'
    const e = sqlError(sql)
    expect(e.message).toBe("Expected an expression but found '='")
    expect(sqlPosition(sql, e.pos)).toEqual({ line: 3, col: 11 })
    expect(e.end).toBe(e.pos + 1)
  })

  it('rejects non-SELECT statements and unsupported syntax', () => {
    expect(sqlError('').message).toMatch(/Enter a SELECT/)
    expect(sqlError("DELETE FROM t WHERE a = 1").message).toMatch(/Only SELECT statements are supported/)
    expect(sqlError('WITH x AS (SELECT 1) SELECT * FROM x').message).toMatch(/WITH/)
    expect(sqlError('SELECT * FROM t WHERE a IN (SELECT b FROM u)').message).toMatch(/Subqueries are not supported/)
    expect(sqlError('SELECT * FROM (SELECT * FROM t)').message).toMatch(/Subqueries are not supported/)
    expect(sqlError('SELECT * FROM t UNION SELECT * FROM u').message).toMatch(/UNION is not supported/)
    expect(sqlError('SELECT CASE WHEN a THEN 1 END FROM t').message).toMatch(/CASE expressions are not supported/)
    expect(sqlError('SELECT FOO(a) FROM t').message).toBe('Unsupported function FOO()')
    expect(sqlError('SELECT ROW_NUMBER() OVER () FROM t').message).toMatch(/Window functions/)
    expect(sqlError('SELECT * FROM t ORDER BY a NULLS FIRST').message).toMatch(/NULLS FIRST/)
    expect(sqlError('SELECT * FROM t; SELECT * FROM u').message).toMatch(/one statement/)
  })

  it('rejects misplaced and incomplete clauses', () => {
    expect(sqlError('SELECT a').message).toMatch(/FROM clause is required/)
    expect(sqlError('SELECT * FROM t LIMIT 5 WHERE a = 1').message).toMatch(/WHERE is out of order/)
    expect(sqlError('SELECT * FROM t LIMIT x').message).toMatch(/LIMIT needs a whole number/)
    expect(sqlError("SELECT * FROM t WHERE a = 'oops").message).toBe('Unterminated string')
    expect(sqlError('SELECT * FROM t WHERE a = #').message).toMatch(/Unexpected character/)
  })

  it('rejects invalid aggregate usage', () => {
    expect(sqlError('SELECT * FROM t WHERE COUNT(*) > 1').message).toMatch(/not allowed in WHERE; use HAVING/)
    expect(sqlError('SELECT *, COUNT(*) FROM t').message).toMatch(/Combining \* with other columns/)
    expect(sqlError('SELECT * FROM t GROUP BY a').message).toMatch(/SELECT \* cannot be combined/)
    expect(sqlError('SELECT SUM(COUNT(*)) FROM t').message).toMatch(/Nested aggregate/)
    expect(sqlError('SELECT SUM(*) FROM t').message).toMatch(/only COUNT\(\*\)/)
    expect(sqlError('SELECT a FROM t HAVING a > 1').message).toMatch(/HAVING needs GROUP BY/)
  })

  it('validates literal constructors', () => {
    expect(sqlError("SELECT * FROM t WHERE _id = ObjectId('xyz')").message).toMatch(/24-character hex/)
    expect(sqlError("SELECT * FROM t WHERE d > DATE 'not a date'").message).toMatch(/Invalid date/)
    expect(sqlError("SELECT * FROM t WHERE a LIKE b").message).toMatch(/LIKE needs a string pattern/)
  })
})

describe('statements', () => {
  const script = "SELECT * FROM a WHERE s = 'x;y';\n-- c;\nSELECT * FROM b;\n\n"
  it('splits on semicolons outside strings and comments', () => {
    expect(splitSqlStatements(script).map((r) => script.slice(r.from, r.to).trim())).toEqual(["SELECT * FROM a WHERE s = 'x;y'", '-- c;\nSELECT * FROM b', ''])
  })

  it('picks the statement under the cursor', () => {
    expect(sqlStatementAt(script, 3).text).toContain('FROM a')
    expect(sqlStatementAt(script, script.indexOf(';\n') + 1).text).toContain('FROM a')
    expect(sqlStatementAt(script, script.indexOf('FROM b')).text).toContain('FROM b')
    const end = sqlStatementAt(script, script.length)
    expect(end.text).toContain('FROM b')
    expect(script.slice(end.offset, end.offset + end.text.length)).toBe(end.text)
  })
})

describe('sqlTables', () => {
  it('lists FROM and JOIN collections', () => {
    expect(sqlTables('SELECT * FROM a JOIN b ON a.x = b.y')).toEqual(['a', 'b'])
    expect(sqlTables('SELECT')).toEqual([])
  })
})
