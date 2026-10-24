import { describe, expect, it } from 'vitest'
import { Decimal128, Int32, Long, ObjectId } from 'bson'
import { CODE_LANGUAGES, generateCode } from '@shared/codegen'
import type { CodeQuery } from '@shared/codegen'

const id = new ObjectId('650000000000000000000001')
const find: CodeQuery = {
  kind: 'find',
  db: 'shop',
  coll: 'orders',
  filter: { status: 'paid', customerId: id, total: { $gte: new Decimal128('10.5') }, createdAt: { $lt: new Date('2024-02-01T00:00:00Z') }, qty: new Int32(2), big: Long.fromNumber(5), note: /urgent/i },
  projection: { status: 1, total: 1 },
  sort: { createdAt: -1 },
  skip: 10,
  limit: 20
}
const agg: CodeQuery = { kind: 'aggregate', db: 'shop', coll: 'orders', pipeline: [{ $match: { status: 'paid' } }, { $group: { _id: '$customerId', n: { $sum: 1 } } }] }

describe('generateCode', () => {
  it('produces code for every language and both query kinds', () => {
    for (const lang of CODE_LANGUAGES) {
      for (const q of [find, agg]) {
        const code = generateCode(q, lang)
        expect(code.length).toBeGreaterThan(40)
        expect(code).toContain('orders')
      }
    }
  })

  it('maps BSON types idiomatically', () => {
    expect(generateCode(find, 'mongosh')).toContain("ObjectId('650000000000000000000001')")
    expect(generateCode(find, 'mongosh')).toContain("ISODate('2024-02-01T00:00:00.000Z')")
    expect(generateCode(find, 'mongosh')).toContain('.sort({ createdAt: -1 })')
    expect(generateCode(find, 'node')).toContain("new ObjectId('650000000000000000000001')")
    expect(generateCode(find, 'node')).toContain("Decimal128.fromString('10.5')")
    expect(generateCode(find, 'python')).toContain("ObjectId('650000000000000000000001')")
    expect(generateCode(find, 'python')).toContain(".sort([('createdAt', -1)])")
    expect(generateCode(find, 'python')).toContain("Regex('urgent', 'i')")
    expect(generateCode(find, 'java')).toContain('new Document("status", "paid")')
    expect(generateCode(find, 'java')).toContain('5L')
    expect(generateCode(find, 'csharp')).toContain('{ "status", "paid" }')
    expect(generateCode(find, 'go')).toContain('{Key: "status", Value: "paid"}')
    expect(generateCode(find, 'go')).toContain('mustObjectID("650000000000000000000001")')
    expect(generateCode(find, 'php')).toContain("'status' => 'paid'")
    expect(generateCode(find, 'ruby')).toContain("BSON::ObjectId('650000000000000000000001')")
    expect(generateCode(agg, 'mongoose')).toContain("mongoose.model('Order'")
  })

  it('escapes quotes in strings and keys', () => {
    const q: CodeQuery = { kind: 'find', db: 'd', coll: 'c', filter: { "it's": 'say "hi"' } }
    expect(generateCode(q, 'mongosh')).toContain(`'it\\'s': 'say "hi"'`)
    expect(generateCode(q, 'java')).toContain('"say \\"hi\\""')
  })
})
