import { describe, expect, it } from 'vitest'
import { arrayFieldState } from '../src/shared/docPaths'

const docs = [
  { _id: 1, tags: ['a', 'b'], name: 'x', address: { phones: ['1'] }, mixed: 'one' },
  { _id: 2, tags: [], name: 'y', mixed: ['two'] }
]

describe('arrayFieldState (Slice in the Fields builder)', () => {
  it('is "array" for a field holding an array in the loaded documents', () => {
    expect(arrayFieldState(docs, 'tags')).toBe('array')
    expect(arrayFieldState(docs, 'address.phones')).toBe('array')
  })

  it('is "array" when at least one document holds an array there', () => {
    expect(arrayFieldState(docs, 'mixed')).toBe('array')
  })

  it('is "other" for scalars and sub-documents', () => {
    expect(arrayFieldState(docs, 'name')).toBe('other')
    expect(arrayFieldState(docs, 'address')).toBe('other')
  })

  it('is "unknown" when no loaded document has the field, or nothing is loaded', () => {
    expect(arrayFieldState(docs, 'missing')).toBe('unknown')
    expect(arrayFieldState([], 'tags')).toBe('unknown')
  })
})
