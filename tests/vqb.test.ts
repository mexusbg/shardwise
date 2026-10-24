import { describe, expect, it } from 'vitest'
import { Decimal128, Long, ObjectId } from 'bson'
import { parseFilter, toJSString } from 'mongodb-query-parser'
import { filterToGroup, groupToFilter } from '@shared/vqb/filter'
import { projectionToItems, itemsToProjection, sortToItems, itemsToSort } from '@shared/vqb/projectionSort'
import { newGroup, newRule } from '@shared/vqb/types'
import type { Group, Rule } from '@shared/vqb/types'

const rule = (p: Partial<Rule>): Rule => ({ ...newRule(), ...p })
const group = (op: Group['op'], children: Group['children'], extra: Partial<Group> = {}): Group => ({
  ...newGroup(op),
  children,
  ...extra
})
const js = (v: unknown) => toJSString(v as object, 0)

describe('groupToFilter', () => {
  it('empty root gives empty filter', () => {
    expect(groupToFilter(newGroup('and'))).toEqual({})
  })

  it('merges AND rules on distinct fields into one object', () => {
    const f = groupToFilter(
      group('and', [
        rule({ field: 'name', op: 'eq', valueType: 'string', value: 'Ann' }),
        rule({ field: 'age', op: 'gte', valueType: 'int', value: '18' })
      ])
    )
    expect(js(f)).toBe(js({ name: 'Ann', age: { $gte: 18 } }))
  })

  it('merges operator conditions on the same field', () => {
    const f = groupToFilter(
      group('and', [
        rule({ field: 'age', op: 'gt', valueType: 'int', value: '1' }),
        rule({ field: 'age', op: 'lt', valueType: 'int', value: '9' })
      ])
    )
    expect(js(f)).toBe(js({ age: { $gt: 1, $lt: 9 } }))
  })

  it('falls back to $and when conditions collide', () => {
    const f = groupToFilter(
      group('and', [
        rule({ field: 'a', op: 'eq', valueType: 'int', value: '1' }),
        rule({ field: 'a', op: 'eq', valueType: 'int', value: '2' })
      ])
    )
    expect(js(f)).toBe(js({ $and: [{ a: 1 }, { a: 2 }] }))
  })

  it('skips disabled rules and groups', () => {
    const f = groupToFilter(
      group('and', [
        rule({ field: 'a', op: 'eq', valueType: 'int', value: '1', enabled: false }),
        group('or', [rule({ field: 'b', op: 'exists' })], { enabled: false }),
        rule({ field: 'c', op: 'exists' })
      ])
    )
    expect(f).toEqual({ c: { $exists: true } })
  })

  it('builds $or / $nor groups', () => {
    const f = groupToFilter(
      group('or', [
        rule({ field: 'a', op: 'eq', valueType: 'string', value: 'x' }),
        group('nor', [rule({ field: 'b', op: 'isNull' })])
      ])
    )
    expect(f).toEqual({ $or: [{ a: 'x' }, { $nor: [{ b: null }] }] })
  })

  it('builds string match operators as regexes', () => {
    const mk = (op: Rule['op'], ci = false) =>
      groupToFilter(group('and', [rule({ field: 's', op, valueType: 'string', value: 'a.b', caseInsensitive: ci })]))
    expect(mk('contains')).toEqual({ s: { $regex: 'a\\.b' } })
    expect(mk('startsWith', true)).toEqual({ s: { $regex: '^a\\.b', $options: 'i' } })
    expect(mk('endsWith')).toEqual({ s: { $regex: 'a\\.b$' } })
    expect(mk('notContains', true)).toEqual({ s: { $not: { $regex: 'a\\.b', $options: 'i' } } })
  })

  it('builds ranges, lists, existence, null and type checks', () => {
    const one = (r: Partial<Rule>) => groupToFilter(group('and', [rule({ field: 'f', ...r })]))
    expect(js(one({ op: 'range_gte_lt', valueType: 'int', value: '1', value2: '5' }))).toBe(
      js({ f: { $gte: 1, $lt: 5 } })
    )
    expect(one({ op: 'in', valueType: 'string', value: 'a\nb' })).toEqual({ f: { $in: ['a', 'b'] } })
    expect(one({ op: 'notExists' })).toEqual({ f: { $exists: false } })
    expect(one({ op: 'notNull' })).toEqual({ f: { $ne: null } })
    expect(one({ op: 'type', value: 'string' })).toEqual({ f: { $type: 'string' } })
    expect(one({ op: 'notType', value: 'date' })).toEqual({ f: { $not: { $type: 'date' } } })
  })

  it('builds typed values', () => {
    const one = (valueType: Rule['valueType'], value: string) =>
      (groupToFilter(group('and', [rule({ field: 'f', op: 'eq', valueType, value })])) as { f: unknown }).f
    expect(one('objectId', '650000000000000000000000')).toEqual(new ObjectId('650000000000000000000000'))
    expect(one('long', '9007199254740993')).toEqual(Long.fromString('9007199254740993'))
    expect(one('decimal', '1.10')).toEqual(Decimal128.fromString('1.10'))
    expect(one('date', '2024-01-02T03:04:05.000Z')).toEqual(new Date('2024-01-02T03:04:05.000Z'))
    expect(one('bool', 'false')).toBe(false)
  })

  it('reports invalid values with the rule id', () => {
    const r = rule({ field: 'f', op: 'eq', valueType: 'objectId', value: 'nope' })
    expect(() => groupToFilter(group('and', [r]))).toThrowError(expect.objectContaining({ ruleId: r.id }))
  })

  it('builds $elemMatch and its negation', () => {
    const f = groupToFilter(
      group('and', [
        group('elemMatch', [rule({ field: 'qty', op: 'gt', valueType: 'int', value: '2' })], { field: 'items' }),
        group('notElemMatch', [rule({ field: 'sku', op: 'eq', valueType: 'string', value: 'x' })], { field: 'tags' })
      ])
    )
    expect(js(f)).toBe(
      js({ items: { $elemMatch: { qty: { $gt: 2 } } }, tags: { $not: { $elemMatch: { sku: 'x' } } } })
    )
  })

  it('builds $text search', () => {
    const f = groupToFilter(group('and', [rule({ op: 'text', value: 'coffee', textCaseSensitive: true })]))
    expect(f).toEqual({ $text: { $search: 'coffee', $caseSensitive: true } })
  })
})

describe('filterToGroup', () => {
  const roundTrip = (text: string) => {
    const filter = parseFilter(text)
    const g = filterToGroup(filter)
    expect(g).not.toBeNull()
    return js(groupToFilter(g!))
  }

  it.each([
    '{}',
    "{name: 'Ann', age: {$gte: 18}}",
    "{_id: ObjectId('650000000000000000000000')}",
    "{d: {$gt: ISODate('2024-01-01T00:00:00.000Z'), $lte: ISODate('2024-02-01T00:00:00.000Z')}}",
    "{$or: [{a: 'x'}, {b: null}, {c: {$exists: false}, d: {$ne: null}}, {$and: [{e: 1}, {e: 2}]}]}",
    "{$nor: [{a: {$in: ['x', 'y']}}]}",
    "{s: {$regex: '^ab\\\\.c', $options: 'i'}}",
    "{s: {$not: {$regex: 'x$'}}}",
    "{t: {$type: 'string'}, u: {$not: {$type: 'date'}}}",
    "{items: {$elemMatch: {qty: {$gt: 2}}}}",
    "{tags: {$not: {$elemMatch: {sku: 'x'}}}}",
    "{$text: {$search: 'coffee', $language: 'en'}}",
    "{n: NumberLong('5'), dec: NumberDecimal('1.5')}",
    "{arr: {$all: [1, 2]}}"
  ])('round-trips %s', (text) => {
    expect(roundTrip(text)).toBe(js(parseFilter(text)))
  })

  it('classifies regex patterns into string operators', () => {
    const g = filterToGroup(parseFilter("{s: {$regex: '^ab', $options: 'i'}}"))!
    const r = g.children[0] as Rule
    expect(r.op).toBe('startsWith')
    expect(r.value).toBe('ab')
    expect(r.caseInsensitive).toBe(true)
  })

  it('keeps non-literal regexes as regex equality', () => {
    const g = filterToGroup(parseFilter('{s: /a.*b/i}'))!
    const r = g.children[0] as Rule
    expect(r.op).toBe('eq')
    expect(r.valueType).toBe('regex')
    expect(r.value).toBe('/a.*b/i')
  })

  it('returns null for unsupported constructs', () => {
    expect(filterToGroup(parseFilter('{$where: "1"}'))).toBeNull()
    expect(filterToGroup(parseFilter('{a: {$size: 2}}'))).toBeNull()
    expect(filterToGroup(parseFilter("{a: {$in: [1, 'x']}}"))).toBeNull()
  })

  it('uses $or as root operator when filter is a lone $or', () => {
    const g = filterToGroup(parseFilter("{$or: [{a: 1}, {b: 2}]}"))!
    expect(g.op).toBe('or')
    expect(g.children).toHaveLength(2)
  })
})

describe('projection and sort', () => {
  it('round-trips projection', () => {
    const p = { a: 1, b: 0, c: { $slice: 5 } }
    const items = projectionToItems(p)!
    expect(items.map((i) => i.mode)).toEqual(['include', 'exclude', 'slice'])
    expect(itemsToProjection(items)).toEqual(p)
  })

  it('round-trips sort', () => {
    const items = sortToItems({ a: 1, b: -1 })!
    expect(items.map((i) => i.dir)).toEqual([1, -1])
    expect(itemsToSort(items)).toEqual({ a: 1, b: -1 })
  })

  it('rejects unsupported projection', () => {
    expect(projectionToItems({ a: { $meta: 'textScore' } })).toBeNull()
  })

  it('returns null projection/sort when empty', () => {
    expect(itemsToProjection([])).toBeNull()
    expect(itemsToSort([])).toBeNull()
  })
})

describe('list values and ObjectId input', () => {
  it('accepts comma separated and ObjectId("…") wrapped values', () => {
    const f = groupToFilter(group('and', [rule({ field: '_id', op: 'in', valueType: 'objectId', value: "650000000000000000000001, ObjectId('650000000000000000000002')" })]))
    expect(js(f)).toBe(js({ _id: { $in: [new ObjectId('650000000000000000000001'), new ObjectId('650000000000000000000002')] } }))
  })
})

describe('builder never changes query meaning', () => {
  it('refuses lists with empty strings, empty $or branches and $eq regexes', () => {
    expect(filterToGroup(parseFilter("{a: {$in: ['x', '']}}"))).toBeNull()
    expect(filterToGroup(parseFilter('{$or: [{}, {a: 1}]}'))).toBeNull()
    expect(filterToGroup(parseFilter('{a: {$eq: /abc/}}'))).toBeNull()
    expect(filterToGroup(parseFilter('{a: /abc/}'))).not.toBeNull()
  })
})
