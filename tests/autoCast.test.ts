import { describe, expect, it } from 'vitest'
import { ObjectId } from 'bson'
import { autoCastFilter, hasCastCandidates } from '@shared/autoCast'
import { knownFieldType } from '@shared/vqb/tree'

const id1 = '650000000000000000000001'
const id2 = '650000000000000000000002'
const docs = [{ _id: new ObjectId(), customerId: new ObjectId(), code: 'abc', at: new Date(0), items: [{ sku: new ObjectId() }] }]
const typeOf = (p: string) => knownFieldType(docs, p)

describe('autoCastFilter', () => {
  it('casts hex strings for ObjectId fields, in equality and list operators', () => {
    const { filter, casts } = autoCastFilter({ _id: id1, customerId: { $in: [id1, id2] }, other: { $ne: id2 } }, typeOf)
    expect(casts).toBe(3)
    expect((filter._id as ObjectId).toHexString()).toBe(id1)
    expect(((filter.customerId as { $in: ObjectId[] }).$in[1] as ObjectId).toHexString()).toBe(id2)
    expect((filter.other as { $ne: unknown }).$ne).toBe(id2)
  })

  it('leaves string fields alone even when the value looks like an id', () => {
    const { filter, casts } = autoCastFilter({ code: id1 }, typeOf)
    expect(casts).toBe(0)
    expect(filter.code).toBe(id1)
  })

  it('casts ISO strings for date fields and recurses into logical operators and $elemMatch', () => {
    const { filter, casts } = autoCastFilter(
      { $or: [{ at: { $gte: '2024-01-01', $lt: '2024-02-01T00:00:00Z' } }, { items: { $elemMatch: { sku: id1 } } }] },
      typeOf
    )
    expect(casts).toBe(3)
    const or = filter.$or as Record<string, Record<string, unknown>>[]
    expect(or[0].at.$gte).toEqual(new Date('2024-01-01'))
    expect(((or[1].items.$elemMatch as Record<string, unknown>).sku as ObjectId).toHexString()).toBe(id1)
  })

  it('detects candidates', () => {
    expect(hasCastCandidates({ a: { $in: ['x', id1] } })).toBe(true)
    expect(hasCastCandidates({ a: 'hello', b: 5 })).toBe(false)
  })
})

describe('dates without timezone', () => {
  it('are UTC', () => {
    const { filter } = autoCastFilter({ at: { $gte: '2024-01-01T00:00' } }, typeOf)
    expect((filter.at as { $gte: Date }).$gte.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })
})
