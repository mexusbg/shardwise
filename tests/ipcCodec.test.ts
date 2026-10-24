import { describe, expect, it } from 'vitest'
import { Decimal128, Double, Int32, Long, ObjectId } from 'bson'
import { decodeIpc, encodeIpc } from '@shared/ipcCodec'

describe('ipc codec', () => {
  it('keeps plain numbers as numbers and BSON wrappers as wrappers', () => {
    const id = new ObjectId()
    const value = {
      count: 240,
      ratio: 1.5,
      nan: NaN,
      docs: [{ _id: id, n: new Int32(5), d: new Double(2), l: Long.fromNumber(7), dec: Decimal128.fromString('1.1'), at: new Date(0), q: 5 }],
      nested: { ports: [27017] }
    }
    const back = decodeIpc(encodeIpc(value)) as typeof value
    expect(back.count).toBe(240)
    expect(back.ratio).toBe(1.5)
    expect(Number.isNaN(back.nan)).toBe(true)
    expect(back.nested.ports[0]).toBe(27017)
    const d = back.docs[0]
    expect((d.n as Int32)._bsontype).toBe('Int32')
    expect((d.d as Double)._bsontype).toBe('Double')
    expect((d.l as Long)._bsontype).toBe('Long')
    expect((d.dec as Decimal128)._bsontype).toBe('Decimal128')
    expect(d._id.equals(id)).toBe(true)
    expect(d.at).toEqual(new Date(0))
    expect(d.q).toBe(5)
  })

  it('handles scalars and null', () => {
    expect(decodeIpc(encodeIpc(3))).toBe(3)
    expect(decodeIpc(encodeIpc(null))).toBe(null)
    expect(decodeIpc(encodeIpc(undefined))).toBe(null)
    expect(decodeIpc(encodeIpc('x'))).toBe('x')
  })
})

describe('ipc codec and query operators', () => {
  it('keeps operators next to $regex and other EJSON-like keys', () => {
    const filter = { name: { $regex: 'al', $options: 'i', $ne: 'alice' }, d: { $date: 'not-a-date-wrapper', $gt: 1 }, $or: [{ a: { $oid: 'x' } }] }
    expect(decodeIpc(encodeIpc(filter))).toEqual(filter)
  })
})

describe('undefined properties', () => {
  it('are omitted instead of becoming null', () => {
    const back = decodeIpc(encodeIpc({ a: 1, b: undefined, nested: { c: undefined, d: 2 } })) as Record<string, unknown>
    expect('b' in back).toBe(false)
    expect(back.nested).toEqual({ d: 2 })
  })
})

describe('__proto__ keys', () => {
  it('stay plain fields instead of replacing the prototype', () => {
    const doc = JSON.parse('{"a":1,"__proto__":{"x":1},"q":{"$gt":1,"__proto__":{"y":2}}}') as Record<string, unknown>
    const back = decodeIpc(encodeIpc(doc)) as Record<string, unknown>
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype)
    expect(Object.keys(back)).toEqual(['a', '__proto__', 'q'])
    expect(Object.getOwnPropertyDescriptor(back, '__proto__')?.value).toEqual({ x: 1 })
    const q = back.q as Record<string, unknown>
    expect(Object.getPrototypeOf(q)).toBe(Object.prototype)
    expect(Object.keys(q)).toEqual(['$gt', '__proto__'])
  })
})
