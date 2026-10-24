import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, HISTORY_CAP, QueryLibrary } from '../src/main/history'
import type { QueryPayload } from '@shared/api'

const dir = (): string => mkdtempSync(join(tmpdir(), 'mg-history-'))
const find = (query: string, extra: Partial<Extract<QueryPayload, { kind: 'find' }>> = {}): QueryPayload => ({
  kind: 'find',
  query,
  projection: '',
  sort: '',
  skip: '',
  limit: '',
  ...extra
})
const agg = (pipeline: string): QueryPayload => ({ kind: 'aggregate', pipeline })
const run = (payload: QueryPayload, o: { configId?: string; db?: string; coll?: string; ms?: number; count?: number } = {}) => ({
  configId: o.configId ?? 'c1',
  connName: o.configId === 'c2' ? 'Staging' : 'Local',
  db: o.db ?? 'shop',
  coll: o.coll ?? 'orders',
  payload,
  ms: o.ms,
  count: o.count
})

afterEach(() => {
  vi.useRealTimers()
})

describe('QueryLibrary history', () => {
  it('lists newest first with dates', () => {
    vi.useFakeTimers()
    const lib = new QueryLibrary(dir())
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
    lib.addHistory(run(find('{ a: 1 }')))
    vi.setSystemTime(new Date('2026-01-01T10:01:00Z'))
    lib.addHistory(run(find('{ b: 1 }')))
    const list = lib.listHistory({})
    expect(list.map((e) => (e.payload as { query: string }).query)).toEqual(['{ b: 1 }', '{ a: 1 }'])
    expect(list[0].at).toBeInstanceOf(Date)
    expect(list[0].at.toISOString()).toBe('2026-01-01T10:01:00.000Z')
    expect(list[0].id).not.toBe(list[1].id)
  })

  it('filters by connection, db, collection, kind, text and limit', () => {
    const lib = new QueryLibrary(dir())
    lib.addHistory(run(find('{ status: "open" }')))
    lib.addHistory(run(find('{ total: { $gt: 10 } }'), { coll: 'invoices' }))
    lib.addHistory(run(agg('[{ $match: { status: "paid" } }]')))
    lib.addHistory(run(find('{ name: "x" }'), { configId: 'c2', db: 'crm', coll: 'people' }))
    expect(lib.listHistory({ configId: 'c1' })).toHaveLength(3)
    expect(lib.listHistory({ db: 'crm' })).toHaveLength(1)
    expect(lib.listHistory({ configId: 'c1', db: 'shop', coll: 'orders' })).toHaveLength(2)
    expect(lib.listHistory({ kind: 'aggregate' }).map((e) => e.payload.kind)).toEqual(['aggregate'])
    expect(lib.listHistory({ kind: 'find' })).toHaveLength(3)
    expect(lib.listHistory({ text: 'STATUS' })).toHaveLength(2)
    expect(lib.listHistory({ text: 'staging' })).toHaveLength(1)
    expect(lib.listHistory({ text: 'shop.invoices' })).toHaveLength(1)
    expect(lib.listHistory({ limit: 2 })).toHaveLength(2)
    expect(lib.listHistory({ limit: 2 })[0].coll).toBe('people')
  })

  it('collapses consecutive identical runs into the newest', () => {
    vi.useFakeTimers()
    const lib = new QueryLibrary(dir())
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
    const first = lib.record(run(find('{ a: 1 }'), { ms: 5, count: 3 }))
    vi.setSystemTime(new Date('2026-01-01T10:05:00Z'))
    const again = lib.record(run(find('{ a: 1 } '), { ms: 9, count: 4 }))
    expect(again.id).toBe(first.id)
    const list = lib.listHistory({})
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ ms: 9, count: 4 })
    expect(list[0].at.toISOString()).toBe('2026-01-01T10:05:00.000Z')

    lib.addHistory(run(find('{ a: 1 }'), { coll: 'other' }))
    lib.addHistory(run(find('{ a: 1 }', { limit: '5' })))
    lib.addHistory(run(find('{ a: 1 }')))
    expect(lib.listHistory({})).toHaveLength(4)
  })

  it('caps the history', () => {
    const lib = new QueryLibrary(dir())
    for (let i = 0; i < HISTORY_CAP + 25; i++) lib.addHistory(run(find(`{ n: ${i} }`)))
    const list = lib.listHistory({})
    expect(list).toHaveLength(HISTORY_CAP)
    expect((list[0].payload as { query: string }).query).toBe(`{ n: ${HISTORY_CAP + 24} }`)
    expect((list[HISTORY_CAP - 1].payload as { query: string }).query).toBe('{ n: 25 }')
  })

  it('uses a configurable limit, clamped to 100–10000', () => {
    const lib = new QueryLibrary(dir(), 150)
    expect(lib.historyLimit).toBe(150)
    for (let i = 0; i < 160; i++) lib.addHistory(run(find(`{ n: ${i} }`)))
    expect(lib.listHistory({})).toHaveLength(150)
    expect(lib.setHistoryLimit(5)).toBe(50)
    expect(lib.historyLimit).toBe(100)
    expect(lib.setHistoryLimit(50000)).toBe(0)
    expect(lib.historyLimit).toBe(10000)
    expect(new QueryLibrary(dir(), Number.NaN).historyLimit).toBe(HISTORY_CAP)
  })

  it('prunes the oldest entries when the limit is lowered and persists that', () => {
    const d = dir()
    const lib = new QueryLibrary(d, 300)
    for (let i = 0; i < 250; i++) lib.addHistory(run(find(`{ n: ${i} }`)))
    expect(lib.setHistoryLimit(200)).toBe(50)
    const list = lib.listHistory({})
    expect(list).toHaveLength(200)
    expect((list[0].payload as { query: string }).query).toBe('{ n: 249 }')
    expect((list[199].payload as { query: string }).query).toBe('{ n: 50 }')
    lib.close()
    expect(new QueryLibrary(d, 300).listHistory({})).toHaveLength(200)
  })

  it('keeps entries beyond the default limit until a configured limit is known', () => {
    const d = dir()
    const big = new QueryLibrary(d, 2000)
    for (let i = 0; i < 1500; i++) big.addHistory(run(find(`{ n: ${i} }`)))
    big.close()
    // A library opened with the default limit reads the file before the settings arrive: nothing is lost.
    const lib = new QueryLibrary(d)
    expect(lib.listHistory({})).toHaveLength(1500)
    expect(lib.setHistoryLimit(2000)).toBe(0)
    expect(lib.listHistory({})).toHaveLength(1500)
    // Lowering the limit, or the next run, trims to the limit.
    expect(lib.setHistoryLimit(1200)).toBe(300)
    lib.addHistory(run(find('{ latest: 1 }')))
    expect(lib.listHistory({})).toHaveLength(1200)
    lib.close()
  })

  it('deletes by id and clears by filter', () => {
    const lib = new QueryLibrary(dir())
    const a = lib.record(run(find('{ a: 1 }')))
    lib.addHistory(run(find('{ b: 1 }')))
    lib.addHistory(run(agg('[]')))
    lib.addHistory(run(find('{ c: 1 }'), { configId: 'c2' }))
    lib.deleteHistory([a.id, 'missing'])
    expect(lib.listHistory({})).toHaveLength(3)
    expect(lib.clearHistory({ configId: 'c1', kind: 'find', limit: 1 })).toBe(1)
    expect(lib.listHistory({}).map((e) => e.payload.kind)).toEqual(['find', 'aggregate'])
    expect(lib.clearHistory({ db: 'nothing' })).toBe(0)
    expect(lib.clearHistory({})).toBe(2)
    expect(lib.listHistory({})).toEqual([])
  })

  it('debounces writes and persists across instances after flushSync', () => {
    const d = dir()
    const lib = new QueryLibrary(d)
    lib.addHistory(run(find('{ a: 1 }'), { ms: 3, count: 1 }))
    lib.addHistory(run(agg('[{ $limit: 1 }]')))
    expect(existsSync(join(d, 'history.json'))).toBe(false)
    lib.flushSync()
    const stored = JSON.parse(readFileSync(join(d, 'history.json'), 'utf8'))
    expect(typeof stored.items[0].at).toBe('string')
    const again = new QueryLibrary(d).listHistory({})
    expect(again).toHaveLength(2)
    expect(again[0].payload).toEqual(agg('[{ $limit: 1 }]'))
    expect(again[1]).toMatchObject({ ms: 3, count: 1, connName: 'Local' })
    expect(again[1].at).toBeInstanceOf(Date)
  })

  it('writes after the debounce delay and on the module-level flushSync', () => {
    vi.useFakeTimers()
    const d = dir()
    const lib = new QueryLibrary(d)
    lib.addHistory(run(find('{ a: 1 }')))
    vi.advanceTimersByTime(600)
    expect(new QueryLibrary(d).listHistory({})).toHaveLength(1)
    lib.addHistory(run(find('{ b: 1 }')))
    flushSync()
    expect(new QueryLibrary(d).listHistory({})).toHaveLength(2)
  })
})

describe('QueryLibrary saved queries', () => {
  it('creates, updates and deletes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
    const lib = new QueryLibrary(dir())
    const q = lib.save({ name: ' Open orders ', folder: ' Reports ', configId: 'c1', db: 'shop', coll: 'orders', payload: find('{ status: "open" }') })
    expect(q).toMatchObject({ name: 'Open orders', folder: 'Reports' })
    lib.save({ name: 'Big', folder: '', db: 'shop', coll: 'orders', payload: agg('[]') })
    vi.setSystemTime(new Date('2026-01-01T11:00:00Z'))
    const u = lib.save({ id: q.id, name: 'Open orders v2', folder: 'Reports', configId: 'c1', db: 'shop', coll: 'orders', payload: find('{ status: "open" }', { limit: '10' }) })
    expect(u.id).toBe(q.id)
    expect(u.createdAt.toISOString()).toBe('2026-01-01T10:00:00.000Z')
    expect(u.updatedAt.toISOString()).toBe('2026-01-01T11:00:00.000Z')
    const list = lib.listSaved()
    expect(list.map((x) => x.name)).toEqual(['Big', 'Open orders v2'])
    expect(list[0].folder).toBeUndefined()
    expect(() => lib.save({ name: '  ', db: 'a', coll: 'b', payload: agg('[]') })).toThrow()
    lib.deleteSaved(q.id)
    expect(lib.listSaved().map((x) => x.name)).toEqual(['Big'])
  })

  it('persists immediately', () => {
    const d = dir()
    const lib = new QueryLibrary(d)
    const q = lib.save({ name: 'A', db: 'shop', coll: 'orders', payload: find('{}') })
    const back = new QueryLibrary(d).listSaved()
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ id: q.id, name: 'A', payload: find('{}') })
    expect(back[0].createdAt).toBeInstanceOf(Date)
  })
})

describe('QueryLibrary corrupt files', () => {
  it('starts empty and keeps a backup', () => {
    const d = dir()
    writeFileSync(join(d, 'history.json'), '{ not json')
    writeFileSync(join(d, 'saved-queries.json'), '"just a string"')
    const lib = new QueryLibrary(d)
    expect(lib.listHistory({})).toEqual([])
    expect(lib.listSaved()).toEqual([])
    expect(readFileSync(join(d, 'history.json.bak'), 'utf8')).toBe('{ not json')
    expect(readFileSync(join(d, 'saved-queries.json.bak'), 'utf8')).toBe('"just a string"')
    lib.addHistory(run(find('{ a: 1 }')))
    lib.flushSync()
    expect(new QueryLibrary(d).listHistory({})).toHaveLength(1)
  })

  it('skips malformed entries', () => {
    const d = dir()
    writeFileSync(
      join(d, 'history.json'),
      JSON.stringify({ version: 1, items: [{ id: 'x', at: '2026-01-01T00:00:00Z', configId: 'c1', db: 'a', coll: 'b', payload: { kind: 'find', query: '{}' } }, { nope: true }, null] })
    )
    const list = new QueryLibrary(d).listHistory({})
    expect(list).toHaveLength(1)
    expect(list[0].payload).toEqual(find('{}'))
  })
})
