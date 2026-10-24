import { describe, expect, it } from 'vitest'
import { Decimal128, Double, Int32, Long, ObjectId } from '@shared/bsonValue'
import { analyzeSchema, fieldQueryText, flattenFields, reportJson, toJsonSchema, validatorCommand } from '@shared/schema'
import type { FieldReport, SchemaReport } from '@shared/schema'

const field = (r: SchemaReport, path: string): FieldReport => {
  const f = flattenFields(r.fields).find((x) => x.path === path)
  if (!f) throw new Error(`no field ${path}`)
  return f
}

const docs = [
  { _id: new ObjectId('650000000000000000000001'), name: 'Ann', age: new Int32(30), addr: { city: 'Oslo', zip: '0150' }, tags: ['a', 'b'] },
  { _id: new ObjectId('660000000000000000000002'), name: 'Bob', age: new Int32(40), addr: { city: 'Rome' }, tags: ['a'] },
  { _id: new ObjectId('670000000000000000000003'), name: 'Cid', age: '50', addr: null, tags: [] },
  { _id: new ObjectId('680000000000000000000004'), name: 'Ann', age: new Double(20.5) }
]

describe('analyzeSchema', () => {
  const r = analyzeSchema(docs)

  it('lists top-level fields with _id first and presence', () => {
    expect(r.docCount).toBe(4)
    expect(r.fields.map((f) => f.name)).toEqual(['_id', 'name', 'age', 'addr', 'tags'])
    expect(field(r, 'name').presence).toBe(1)
    expect(field(r, 'tags').presence).toBe(0.75)
    expect(field(r, 'name').always).toBe(true)
    expect(field(r, 'tags').always).toBe(false)
  })

  it('analyses nested objects', () => {
    const addr = field(r, 'addr')
    expect(addr.nullable).toBe(true)
    expect(addr.types.map((t) => t.type)).toEqual(['object', 'null'])
    expect(addr.mixed).toBe(false)
    const city = field(r, 'addr.city')
    expect(city.depth).toBe(1)
    expect(city.parentCount).toBe(2)
    expect(city.always).toBe(true)
    expect(city.presence).toBe(0.5)
    const zip = field(r, 'addr.zip')
    expect(zip.always).toBe(false)
    expect(zip.queryPath).toBe('addr.zip')
  })

  it('analyses arrays of scalars and their elements', () => {
    const tags = field(r, 'tags')
    const arr = tags.types[0]
    expect(arr.type).toBe('array')
    expect(arr.array).toMatchObject({ min: 0, max: 2, avg: 1 })
    expect(arr.array?.elementTypes).toEqual([{ type: 'string', label: 'String', count: 3, pct: 1 }])
    const el = field(r, 'tags.[]')
    expect(el.isElement).toBe(true)
    expect(el.queryPath).toBe('tags')
    expect(el.count).toBe(3)
    expect(el.docCount).toBe(2)
    expect(el.topValues.map((v) => [v.value, v.count])).toEqual([
      ['a', 2],
      ['b', 1]
    ])
  })

  it('analyses arrays of documents', () => {
    const r2 = analyzeSchema([{ items: [{ sku: 'x', qty: 1 }, { sku: 'y' }] }, { items: [{ sku: 'z', qty: 3 }] }])
    const sku = field(r2, 'items.[].sku')
    expect(sku.queryPath).toBe('items.sku')
    expect(sku.count).toBe(3)
    expect(sku.docCount).toBe(2)
    expect(sku.presence).toBe(1)
    expect(sku.always).toBe(true)
    expect(field(r2, 'items.[].qty').always).toBe(false)
    expect(field(r2, 'items.[].qty').types[0].number).toEqual({ min: 1, max: 3, avg: 2 })
  })

  it('flags mixed types but not mixed numeric types alone', () => {
    const age = field(r, 'age')
    expect(age.mixed).toBe(true)
    expect(r.mixedCount).toBe(1)
    expect(age.types.map((t) => [t.type, t.count, t.pct])).toEqual([
      ['int', 2, 0.5],
      ['string', 1, 0.25],
      ['double', 1, 0.25]
    ])
    const nums = analyzeSchema([{ n: 1 }, { n: 1.5 }, { n: null }]).fields[0]
    expect(nums.mixed).toBe(false)
    expect(nums.numericMix).toBe(true)
    expect(nums.nullable).toBe(true)
  })

  it('computes number, string, date and ObjectId stats', () => {
    const r2 = analyzeSchema([
      { n: new Int32(5), l: Long.fromNumber(10), d: Decimal128.fromString('1.5'), s: 'ab', at: new Date('2024-01-01T00:00:00Z') },
      { n: new Int32(-3), l: Long.fromNumber(30), d: Decimal128.fromString('2.5'), s: 'abcd', at: new Date('2025-06-01T00:00:00Z') },
      { n: new Int32(7), s: '' }
    ])
    expect(field(r2, 'n').types[0].number).toEqual({ min: -3, max: 7, avg: 3 })
    expect(field(r2, 'l').types[0].number).toEqual({ min: 10, max: 30, avg: 20 })
    expect(field(r2, 'd').types[0].number).toEqual({ min: 1.5, max: 2.5, avg: 2 })
    expect(field(r2, 's').types[0].string).toEqual({ min: 0, max: 4, avg: 2 })
    const at = field(r2, 'at').types[0].date!
    expect(at.min.toISOString()).toBe('2024-01-01T00:00:00.000Z')
    expect(at.max.toISOString()).toBe('2025-06-01T00:00:00.000Z')
    const oid = field(r, '_id').types[0].objectId!
    expect(oid.min.getTime()).toBe(0x65000000 * 1000)
    expect(oid.max.getTime()).toBe(0x68000000 * 1000)
  })

  it('lists top values only for low-cardinality fields', () => {
    const name = field(r, 'name')
    expect(name.topValues[0]).toMatchObject({ value: 'Ann', count: 2, pct: 0.5 })
    expect(name.distinct).toBe(3)
    const many = analyzeSchema(Array.from({ length: 200 }, (_, i) => ({ s: `v${i % 60}`, k: `k${i % 5}` })))
    expect(field(many, 's').topValues).toEqual([])
    expect(field(many, 's').distinct).toBe(60)
    expect(field(many, 'k').topValues).toHaveLength(5)
    const capped = analyzeSchema(Array.from({ length: 50 }, (_, i) => ({ s: `v${i}` })), { distinctCap: 10 })
    expect(field(capped, 's').distinct).toBe(10)
    expect(field(capped, 's').distinctCapped).toBe(true)
  })

  it('keeps a few distinct sample values', () => {
    expect(field(r, 'name').samples).toEqual(['Ann', 'Bob', 'Cid'])
  })
})

describe('toJsonSchema', () => {
  const r = analyzeSchema(docs)

  it('builds nested properties, arrays and required fields', () => {
    const s = toJsonSchema(r) as Record<string, any>
    expect(s.bsonType).toBe('object')
    expect(s.required).toEqual(['_id', 'name', 'age'])
    expect(s.properties._id).toEqual({ bsonType: 'objectId' })
    expect(s.properties.age.bsonType).toEqual(['int', 'string', 'double'])
    expect(s.properties.addr).toEqual({
      bsonType: ['object', 'null'],
      required: ['city'],
      properties: { city: { bsonType: 'string' }, zip: { bsonType: 'string' } }
    })
    expect(s.properties.tags).toEqual({ bsonType: 'array', items: { bsonType: 'string' } })
  })

  it('describes arrays of documents and can omit required', () => {
    const r2 = analyzeSchema([{ items: [{ sku: 'x', qty: 1 }, { sku: 'y' }] }])
    expect(toJsonSchema(r2).properties).toEqual({
      items: {
        bsonType: 'array',
        items: { bsonType: 'object', required: ['sku'], properties: { sku: { bsonType: 'string' }, qty: { bsonType: 'int' } } }
      }
    })
    expect(JSON.stringify(toJsonSchema(r2, { required: 'none' }))).not.toContain('required')
  })

  it('renders a collMod validator command', () => {
    const cmd = validatorCommand('people', toJsonSchema(r))
    expect(cmd.startsWith('db.runCommand({')).toBe(true)
    expect(cmd).toContain("collMod: 'people'")
    expect(cmd).toContain('$jsonSchema')
    expect(cmd).toContain("validationLevel: 'moderate'")
  })
})

describe('helpers', () => {
  it('builds query filters for a field', () => {
    expect(fieldQueryText({ queryPath: 'addr.city' }, { kind: 'exists' })).toBe("{ 'addr.city': { $exists: true } }")
    expect(fieldQueryText({ queryPath: 'age' }, { kind: 'type', type: 'int' })).toBe("{ age: { $type: 'int' } }")
    expect(fieldQueryText({ queryPath: 'age' }, { kind: 'equals', value: new Int32(3) })).toBe('{ age: 3 }')
    expect(fieldQueryText({ queryPath: 'name' }, { kind: 'equals', value: "O'Neil" })).toBe("{ name: 'O\\'Neil' }")
  })

  it('serialises the report', () => {
    const json = JSON.parse(reportJson(analyzeSchema(docs)))
    expect(json.docCount).toBe(4)
    expect(json.fields[0].name).toBe('_id')
  })
})

describe('performance', () => {
  it('analyses 5000 documents in under a second', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({
      _id: new ObjectId(),
      name: `user${i}`,
      status: ['active', 'inactive', 'banned'][i % 3],
      score: new Double(i / 7),
      age: new Int32(i % 90),
      createdAt: new Date(1_700_000_000_000 + i * 1000),
      profile: { bio: 'x'.repeat(i % 200), langs: ['en', 'de'], social: { tw: `@u${i}`, gh: i % 2 ? `u${i}` : null } },
      orders: Array.from({ length: i % 5 }, (_, j) => ({ sku: `s${j}`, qty: new Int32(j), price: new Double(j * 1.5) }))
    }))
    const t = performance.now()
    const r = analyzeSchema(big)
    expect(performance.now() - t).toBeLessThan(1000)
    expect(field(r, 'status').topValues).toHaveLength(3)
    expect(field(r, 'orders.[].sku').count).toBeGreaterThan(5000)
  })
})

describe('map-like objects and large arrays', () => {
  const hex = (n: number): string => n.toString(16).padStart(24, '0')
  // perms: { <user id>: { read, write } } with new ids in every document; settings: the same 60 keys everywhere.
  const settings = Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`opt${k}`, new Int32(k)]))
  const docs = Array.from({ length: 200 }, (_, i) => ({
    _id: new ObjectId(hex(i + 1)),
    role: 'r',
    perms: Object.fromEntries(Array.from({ length: 5 }, (_, k) => [hex(i * 5 + k + 1000), { read: true, write: k % 2 === 0 }])),
    settings
  }))

  it('merges keys that are data into one "*" field', () => {
    const r = analyzeSchema(docs)
    const perms = field(r, 'perms')
    expect(perms.mapKeys).toBe(1000)
    expect(perms.children.map((c) => c.name)).toEqual(['*'])
    const star = field(r, 'perms.*')
    expect([star.dynamic, star.count, star.docCount]).toEqual([true, 1000, 200])
    const read = field(r, 'perms.*.read')
    expect([read.dynamic, read.count, read.types[0].type]).toEqual([true, 1000, 'bool'])
    expect(field(r, 'perms.*.write').topValues.map((v) => [v.value, v.count])).toEqual([[true, 600], [false, 400]])
    expect(r.fieldCount).toBeLessThan(80)
  })

  it('keeps wide objects whose keys repeat in every document', () => {
    const s = field(analyzeSchema(docs), 'settings')
    expect([s.mapKeys, s.children.length]).toEqual([undefined, 60])
  })

  it('keeps the frequent keys of a map-like object as real fields', () => {
    const mixed = docs.map((d, i) => ({ _id: d._id, ...Object.fromEntries([[`k_${hex(i)}`, 1], [`k_${hex(i + 500)}`, 2]]) }))
    const r = analyzeSchema(mixed)
    expect(r.fields.map((f) => f.name)).toEqual(['_id', '*'])
    expect(field(r, '*').count).toBe(400)
  })

  it('describes a map as additionalProperties in $jsonSchema', () => {
    const s = toJsonSchema(analyzeSchema(docs)) as { properties: Record<string, Record<string, unknown>> }
    expect(s.properties.perms).toEqual({
      bsonType: 'object',
      additionalProperties: { bsonType: 'object', required: ['read', 'write'], properties: { read: { bsonType: 'bool' }, write: { bsonType: 'bool' } } }
    })
  })

  it('reads at most 500 elements of each array, but reports the full lengths', () => {
    const big = Array.from({ length: 20 }, () => ({ items: Array.from({ length: 5000 }, (_, i) => ({ i: new Int32(i) })) }))
    const t = performance.now()
    const r = analyzeSchema(big)
    expect(performance.now() - t).toBeLessThan(1000)
    expect(field(r, 'items').types[0].array?.max).toBe(5000)
    expect(field(r, 'items.[]').count).toBe(20 * 500)
  })
})
