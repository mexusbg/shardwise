import { describe, expect, it } from 'vitest'
import { exportScopes } from '../src/shared/exportScopes'
import type { ScopeInput } from '../src/shared/exportScopes'

const applied = { filter: { status: 'paid' }, projection: { number: 1, total: 1 }, sort: { createdAt: -1 }, skip: 0, limit: 0, collation: { locale: 'bg' } }
const docs = [{ _id: 'a', number: 1 }, { _id: 'b', number: 2 }, { _id: 'c', number: 3 }]
const input = (over: Partial<ScopeInput> = {}): ScopeInput => ({ applied, docs, selection: [], page: 0, pageSize: 50, count: 120, ...over })
const byId = (s: ReturnType<typeof exportScopes>, id: string) => s.find((x) => x.id === id)!

describe('export scopes of a collection tab', () => {
  it('offers the query result, this page, the selection and the whole collection, in that order', () => {
    expect(exportScopes(input()).map((s) => s.id)).toEqual(['query', 'page', 'selected', 'all'])
  })

  it('the query result keeps filter, projection, sort, skip, limit and collation', () => {
    const q = byId(exportScopes(input({ applied: { ...applied, skip: 5, limit: 40 } })), 'query')
    expect(q.query).toEqual({ filter: { status: 'paid' }, projection: { number: 1, total: 1 }, sort: { createdAt: -1 }, skip: 5, limit: 40, collation: { locale: 'bg' } })
    expect(q.count).toBe(120)
  })

  it('this page is exported by _id, with the projection and sort of the view', () => {
    const p = byId(exportScopes(input()), 'page')
    expect(p.query).toEqual({ filter: { _id: { $in: ['a', 'b', 'c'] } }, projection: { number: 1, total: 1 }, sort: { createdAt: -1 }, collation: { locale: 'bg' } })
    expect(p.count).toBe(3)
  })

  it('this page falls back to skip and limit when documents have no _id (projection without _id)', () => {
    const p = byId(exportScopes(input({ docs: [{ number: 1 }, { number: 2 }], page: 2, pageSize: 50, applied: { ...applied, skip: 10 } })), 'page')
    expect(p.query).toMatchObject({ filter: { status: 'paid' }, skip: 110, limit: 2 })
  })

  it('selected documents are exported by _id; one document uses a plain _id match', () => {
    expect(byId(exportScopes(input({ selection: [0, 2] })), 'selected').query?.filter).toEqual({ _id: { $in: ['a', 'c'] } })
    const one = byId(exportScopes(input({ selection: [1] })), 'selected')
    expect(one.query?.filter).toEqual({ _id: 'b' })
    expect(one.count).toBe(1)
  })

  it('the selection is unavailable, with a reason, when nothing is selected', () => {
    expect(byId(exportScopes(input()), 'selected').disabled).toMatch(/select/i)
  })

  it('the whole collection has no query', () => {
    expect(byId(exportScopes(input()), 'all').query).toBeUndefined()
  })

  it('before any query has run only the whole collection is offered', () => {
    expect(exportScopes(input({ applied: undefined, docs: [] })).map((s) => s.id)).toEqual(['all'])
  })
})
