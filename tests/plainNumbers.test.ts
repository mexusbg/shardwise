import { describe, expect, it } from 'vitest'
import { Decimal128, Double, Int32, Long, ObjectId } from 'bson'
import { bsonTypeOf, parseShellValue, shellText } from '@shared/bsonValue'
import { docText } from '@shared/docText'
import { plainNumbers, restoreNumberTypes } from '@shared/plainNumbers'

const original = {
  _id: new ObjectId('65a1b2c3d4e5f60718293a4b'),
  __v: new Int32(0),
  var1: new Int32(102),
  var2: new Double(221.21),
  whole: new Double(5),
  big: Long.fromNumber(7),
  huge: Long.fromString('9223372036854775807'),
  price: Decimal128.fromString('19.99'),
  scaled: Decimal128.fromString('1.50'),
  nan: new Double(NaN),
  nested: { n: new Int32(1), list: [new Double(1.5), new Double(2)] },
  name: 'x'
}

/** Text in the editor, the user's edit applied, parsed and typed back as the editor's save does. */
const roundTrip = (edit: (t: string) => string = (t) => t): Record<string, unknown> =>
  restoreNumberTypes(parseShellValue(edit(docText(original, 'shell', 2, 'plain'))), original) as Record<string, unknown>

describe('plain numbers in document text', () => {
  it('shows numbers without their wrappers where the bare number is exact', () => {
    const t = docText(original, 'shell', 2, 'plain')
    expect(t).toContain('__v: 0')
    expect(t).toContain('var1: 102')
    expect(t).toContain('var2: 221.21')
    expect(t).toContain('whole: 5')
    expect(t).toContain('big: 7')
    expect(t).toContain('price: 19.99')
    expect(t).not.toContain('NumberInt')
    expect(t.match(/Double\(/g)).toHaveLength(1) // only the NaN
  })

  it('keeps the wrapper when a bare number would change the value', () => {
    const t = docText(original, 'shell', 2, 'plain')
    expect(t).toContain("NumberLong('9223372036854775807')")
    expect(t).toContain("NumberDecimal('1.50')")
    expect(t).toContain("nan: Double('NaN')")
  })

  it('typed mode is unchanged', () => {
    expect(docText(original, 'shell', 2, 'typed')).toBe(shellText(original, 2))
    expect(docText(original, 'shell', 2)).toContain("NumberInt('102')")
  })

  it('saves every field back with its original type when nothing changed', () => {
    const back = roundTrip()
    for (const k of Object.keys(original) as (keyof typeof original)[]) expect(bsonTypeOf(back[k]), k).toBe(bsonTypeOf(original[k]))
    const nested = back.nested as { n: unknown; list: unknown[] }
    expect(bsonTypeOf(nested.n)).toBe('int')
    expect(nested.list.map(bsonTypeOf)).toEqual(['double', 'double'])
    expect(String(back.huge)).toBe('9223372036854775807')
    expect(String(back.scaled)).toBe('1.50')
  })

  it('keeps the type of an edited number', () => {
    const back = roundTrip((t) => t.replace('var1: 102', 'var1: 103').replace('var2: 221.21', 'var2: 7').replace('price: 19.99', 'price: 20.5'))
    expect(back.var1).toEqual(new Int32(103))
    expect(back.var2).toEqual(new Double(7))
    expect(String(back.price)).toBe('20.5')
    expect(bsonTypeOf(back.price)).toBe('decimal')
  })

  it('widens an Int32 that no longer fits instead of losing the value', () => {
    expect(bsonTypeOf(roundTrip((t) => t.replace('var1: 102', 'var1: 3000000000')).var1)).toBe('long')
    expect(roundTrip((t) => t.replace('var1: 102', 'var1: 2.5')).var1).toEqual(new Double(2.5))
  })

  it('changes a type in either direction when it is written out', () => {
    const back = roundTrip((t) => t.replace('var1: 102', 'var1: Double(102)').replace('var2: 221.21', 'var2: NumberInt(221)').replace('price: 19.99', 'price: Double(19.99)'))
    expect(back.var1).toEqual(new Double(102))
    expect(back.var2).toEqual(new Int32(221))
    expect(back.price).toEqual(new Double(19.99))
    // An Int32 given a fraction becomes a Double without being told.
    expect(roundTrip((t) => t.replace('var1: 102', 'var1: 102.5')).var1).toEqual(new Double(102.5))
  })

  it('leaves an explicit type and numbers in new fields alone', () => {
    const back = roundTrip((t) => t.replace('var1: 102', "var1: NumberLong('102')").replace("name: 'x'", "name: 'x', added: 4"))
    expect(bsonTypeOf(back.var1)).toBe('long')
    expect(back.added).toBe(4)
  })

  it('gives elements added to an array the type the other numbers share', () => {
    const back = roundTrip((t) => t.replace(/list: \[\s*1\.5,\s*2\s*\]/, 'list: [1.5, 2, 3]'))
    expect((back.nested as { list: unknown[] }).list.map(bsonTypeOf)).toEqual(['double', 'double', 'double'])
  })

  it('handles non-document values', () => {
    expect(plainNumbers([new Int32(1), 'a'])).toEqual([1, 'a'])
    expect(plainNumbers(new Double(-0))).toEqual(new Double(-0))
    expect(restoreNumberTypes(5, new Long(5))).toEqual(Long.fromNumber(5))
  })
})
