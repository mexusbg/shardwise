import { describe, expect, it } from 'vitest'
import { ObjectId } from 'bson'
import { idsFilter, updateProblem } from '@shared/updateDocuments'

describe('Update Documents dialog checks', () => {
  it('accepts update operators and pipelines of update stages', () => {
    expect(updateProblem({ $set: { a: 1 }, $inc: { n: 1 } }, false)).toBeNull()
    expect(updateProblem([{ $set: { a: 1 } }, { $unset: 'b' }], true)).toBeNull()
  })

  it('rejects a plain document, an empty update and wrong pipeline stages', () => {
    expect(updateProblem({ a: 1 }, false)).toMatch(/update operators/)
    expect(updateProblem({}, false)).toMatch(/empty/)
    expect(updateProblem({ $set: 1 }, true)).toMatch(/array/)
    expect(updateProblem([{ $match: {} }], true)).toMatch(/\$match/)
    expect(updateProblem([{ a: 1 }], false)).toMatch(/pipeline/)
  })

  it('builds the filter of the selected documents', () => {
    const a = new ObjectId()
    const b = new ObjectId()
    expect(idsFilter([a])).toEqual({ _id: a })
    expect(idsFilter([a, b])).toEqual({ _id: { $in: [a, b] } })
  })
})
