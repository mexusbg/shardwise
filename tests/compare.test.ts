import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Binary, Decimal128, Double, EJSON, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp } from 'bson'
import type { Doc, JobProgress } from '@shared/api'
import type { CompareCategory, CompareRequest, CompareSummary, SyncRequest } from '@shared/compareApi'
import { parseUri } from '@shared/connection'
import { ConnectionManager } from '../src/main/mongo/manager'
import { Comparisons, ENTRY_CAP } from '../src/main/compare/compare'
import { compareBson, diffDocs, projectDoc, setUpdate } from '../src/main/compare/diff'

let serverA: MongoMemoryServer
let serverB: MongoMemoryServer
let a: MongoClient
let b: MongoClient
let mgr: ConnectionManager
let cmp: Comparisons
let connA: string
let connB: string
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()
const running = new Map<string, () => void>()

const canon = (v: unknown): string => EJSON.stringify(v as never, { relaxed: false })
const oid = (i: number): ObjectId => new ObjectId(i.toString(16).padStart(24, '0'))

function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  if (done) return Promise.resolve(done)
  return new Promise((r) => waiters.set(jobId, r))
}

function req(p: Partial<CompareRequest> & { sc?: string; tc?: string; tConn?: string; tDb?: string }): CompareRequest {
  return {
    source: { connId: connA, db: 'src', coll: p.sc ?? 'items', filter: {} },
    target: { connId: p.tConn ?? connA, db: p.tDb ?? 'dst', coll: p.tc ?? 'items', filter: {} },
    key: '_id',
    fields: { mode: 'all', paths: [] },
    ignore: [],
    sample: 0,
    ...p
  }
}

async function compare(r: CompareRequest): Promise<CompareSummary> {
  const id = cmp.start(r)
  const f = await wait(id)
  expect(f.state, f.error).toBe('done')
  return cmp.summary(id)
}

const keys = (jobId: string, cat: CompareCategory): string[] => cmp.result(jobId, cat, 0, 1000).entries.map((e) => canon(e.key))

async function sync(jobId: string, s: Partial<SyncRequest>): Promise<JobProgress> {
  const id = cmp.startSync({ compareJobId: jobId, direction: 'sourceToTarget', insertMissing: false, deleteExtra: false, overwrite: 'none', ...s })
  return wait(id)
}

async function all(c: MongoClient, db: string, coll: string): Promise<Doc[]> {
  return (await c.db(db).collection(coll).find({}, { promoteValues: false, promoteLongs: false }).sort({ _id: 1 }).toArray()) as Doc[]
}

async function seed(c: MongoClient, db: string, coll: string, docs: Doc[]): Promise<void> {
  await c.db(db).collection(coll).drop().catch(() => {})
  if (docs.length) await c.db(db).collection(coll).insertMany(docs as never)
}

const base = (): Doc[] => [
  { _id: oid(1), name: 'a', qty: new Int32(1), address: { city: 'Rome', zip: '001' }, tags: ['x', 'y'], updatedAt: new Date(1) },
  { _id: oid(2), name: 'b', qty: new Int32(2), address: { city: 'Paris' }, tags: ['x'], updatedAt: new Date(2) },
  { _id: oid(3), name: 'c', qty: new Int32(3), items: [{ sku: 'p', n: new Int32(1) }, { sku: 'q', n: new Int32(2) }], updatedAt: new Date(3) },
  { _id: oid(4), name: 'd', qty: new Int32(4), updatedAt: new Date(4) },
  { _id: oid(5), name: 'e', qty: new Int32(5), updatedAt: new Date(5) }
]

/** Target: 1 identical, 2 nested change, 3 array change, 4 missing, 5 only updatedAt differs, 6 extra. */
const changed = (): Doc[] => {
  const d = base()
  d[1] = { ...d[1], address: { city: 'Lyon', country: 'FR' } }
  d[2] = { ...d[2], items: [{ sku: 'p', n: new Int32(1) }, { sku: 'q', n: new Int32(7) }, { sku: 'r', n: new Int32(1) }] }
  d[4] = { ...d[4], updatedAt: new Date(99) }
  return [d[0], d[1], d[2], d[4], { _id: oid(6), name: 'f', qty: new Int32(6) }]
}

beforeAll(async () => {
  serverA = await MongoMemoryServer.create()
  serverB = await MongoMemoryServer.create()
  a = await MongoClient.connect(serverA.getUri())
  b = await MongoClient.connect(serverB.getUri())
  mgr = new ConnectionManager()
  connA = (await mgr.connect(parseUri(serverA.getUri()))).connId
  connB = (await mgr.connect(parseUri(serverB.getUri()))).connId
  cmp = new Comparisons(mgr, (p) => {
    if (p.state === 'running') {
      if (p.done > 0) running.get(p.jobId)?.()
      return
    }
    finals.set(p.jobId, p)
    waiters.get(p.jobId)?.(p)
  })
  await seed(a, 'src', 'items', base())
  await seed(a, 'dst', 'items', changed())
  await seed(a, 'dst', 'same', base())
})

afterAll(async () => {
  cmp?.cancelAll()
  await mgr?.closeAll()
  await a?.close()
  await b?.close()
  await serverA?.stop()
  await serverB?.stop()
})

describe('compareBson', () => {
  it('follows the MongoDB sort order across types', () => {
    const sorted = [
      new MinKey(),
      null,
      new Double(-1.5),
      new Int32(1),
      Long.fromString('9007199254740993'),
      'B',
      'a',
      'é',
      { a: 1 },
      { a: 1, b: 1 },
      new Binary(Buffer.from([9])),
      new Binary(Buffer.from([1, 2])),
      oid(1),
      oid(2),
      false,
      true,
      new Date(0),
      new Date(5),
      new Timestamp({ t: 1, i: 1 }),
      new MaxKey()
    ]
    for (let i = 0; i < sorted.length - 1; i++) expect(compareBson(sorted[i], sorted[i + 1]), `${i}`).toBe(-1)
    expect(compareBson(new Int32(1), new Double(1))).toBe(0)
    expect(compareBson(Long.fromNumber(2), 2.5)).toBe(-1)
    expect(compareBson(Decimal128.fromString('3'), new Int32(2))).toBe(1)
    expect(compareBson(new Double(NaN), new Int32(-100))).toBe(-1)
  })
})

describe('diff helpers', () => {
  it('diffs nested objects and arrays and ignores field order', () => {
    const d = diffDocs({ a: { x: 1, y: 2 }, t: [1, 2, 3], s: 'k', z: 1 }, { t: [1, 5], a: { y: 2, x: 1, w: 3 }, s: 'k', n: null })
    const out = d.diffs.map((x) => `${x.kind}:${x.segs.join('.')}`).sort()
    expect(out).toEqual(['added:a.w', 'added:n', 'changed:t.1', 'removed:t.2', 'removed:z'])
    expect(diffDocs({ a: 1, b: 2 }, { b: 2, a: 1 }).total).toBe(0)
    expect(diffDocs({ a: new Int32(1) }, { a: new Double(1) }).total).toBe(1)
  })

  it('projects include / exclude / ignore paths', () => {
    const doc = { _id: 1, a: { b: 1, c: 2 }, l: [{ b: 1, c: 1 }, 5], u: 1 }
    expect(projectDoc(doc, { mode: 'include', paths: ['a.b', 'l.c'] }, [])).toEqual({ a: { b: 1 }, l: [{ c: 1 }] })
    expect(projectDoc(doc, { mode: 'exclude', paths: ['a.c'] }, ['u', 'l.b'])).toEqual({ _id: 1, a: { b: 1 }, l: [{ c: 1 }, 5] })
    expect(doc.a).toEqual({ b: 1, c: 2 })
  })

  it('builds $set / $unset updates, setting whole arrays', () => {
    const from = { _id: 1, a: { x: 1 }, t: [1, 2], gone: 1 }
    const to = { _id: 2, a: { x: 2, y: 1 }, t: [1, 3, 4], extra: true }
    const u = setUpdate(from, to, diffDocs(from, to).diffs)
    expect(u).toEqual({ $set: { 'a.x': 1, t: [1, 2], gone: 1 }, $unset: { 'a.y': '', extra: '' } })
    expect(setUpdate({ 'a.b': 1 }, {}, diffDocs({ 'a.b': 1 }, {}).diffs)).toBeNull()
  })
})

describe('compare', () => {
  it('reports identical collections', async () => {
    const s = await compare(req({ tc: 'same' }))
    expect(s).toMatchObject({ sourceCount: 5, targetCount: 5, identical: 5, different: 0, onlySource: 0, onlyTarget: 0, truncated: [] })
  })

  it('classifies missing, extra and different documents with nested and array diffs', async () => {
    const s = await compare(req({}))
    expect(s).toMatchObject({ sourceCount: 5, targetCount: 5, onlySource: 1, onlyTarget: 1, different: 3, identical: 1 })
    expect(keys(s.jobId, 'onlySource')).toEqual([canon(oid(4))])
    expect(keys(s.jobId, 'onlyTarget')).toEqual([canon(oid(6))])
    const diff = cmp.result(s.jobId, 'different', 0, 10).entries
    const d2 = diff.find((e) => canon(e.key) === canon(oid(2)))!.diffs!
    expect(d2.map((d) => `${d.kind}:${d.path}`).sort()).toEqual(['added:address.country', 'changed:address.city'])
    expect(d2.find((d) => d.path === 'address.city')).toMatchObject({ source: 'Paris', target: 'Lyon' })
    const d3 = diff.find((e) => canon(e.key) === canon(oid(3)))!.diffs!
    expect(d3.map((d) => `${d.kind}:${d.path}`).sort()).toEqual(['added:items.2', 'changed:items.1.n'])
    const docs = await cmp.docs(s.jobId, oid(2))
    expect(docs.source?.name).toBe('b')
    expect((docs.target?.address as Doc).city).toBe('Lyon')
  })

  it('ignores fields and compares field subsets', async () => {
    const s = await compare(req({ ignore: ['updatedAt'] }))
    expect(s).toMatchObject({ different: 2, identical: 2 })
    const only = await compare(req({ fields: { mode: 'include', paths: ['name', 'qty'] } }))
    expect(only).toMatchObject({ different: 0, identical: 4 })
    const ex = await compare(req({ fields: { mode: 'exclude', paths: ['address', 'items'] } }))
    expect(ex).toMatchObject({ different: 1, identical: 3 })
  })

  it('applies filters and sample mode', async () => {
    const f = await compare(req({ source: { connId: connA, db: 'src', coll: 'items', filter: { qty: { $lte: 2 } } }, target: { connId: connA, db: 'dst', coll: 'items', filter: { qty: { $lte: 2 } } } }))
    expect(f).toMatchObject({ sourceCount: 2, targetCount: 2, identical: 1, different: 1 })
    const s = await compare(req({ sample: 2 }))
    expect(s).toMatchObject({ sourceCount: 2, targetCount: 2, identical: 1, different: 1, onlyTarget: 0, sampled: true })
  })

  it('pairs documents by another unique key across connections', async () => {
    await seed(a, 'src', 'users', [
      { _id: oid(10), email: 'a@x', n: 1 },
      { _id: oid(11), email: 'b@x', n: 2 },
      { _id: oid(12), email: 'c@x', n: 3 }
    ])
    await seed(b, 'other', 'users', [
      { _id: oid(90), email: 'c@x', n: 3 },
      { _id: oid(91), email: 'b@x', n: 20 },
      { _id: oid(92), email: 'z@x', n: 9 }
    ])
    const s = await compare(req({ sc: 'users', tc: 'users', tConn: connB, tDb: 'other', key: 'email', ignore: ['_id'] }))
    expect(s).toMatchObject({ onlySource: 1, onlyTarget: 1, different: 1, identical: 1 })
    expect(keys(s.jobId, 'onlySource')).toEqual([canon('a@x')])
    expect(cmp.result(s.jobId, 'different', 0, 5).entries[0].diffs).toEqual([{ path: 'n', kind: 'changed', source: new Int32(2), target: new Int32(20) }])

    const p = await sync(s.jobId, { insertMissing: true, deleteExtra: true, overwrite: 'set' })
    expect(p.state, p.error).toBe('done')
    const docs = await all(b, 'other', 'users')
    expect(docs.map((d) => [d.email, Number(d.n)]).sort()).toEqual([['a@x', 1], ['b@x', 2], ['c@x', 3]])
    expect(canon(docs.find((d) => d.email === 'b@x')!._id)).toBe(canon(oid(91)))
    expect(cmp.summary(s.jobId).stale).toBe(true)
  })

  it('fails on a non-unique key', async () => {
    await seed(a, 'src', 'dups', [{ k: 1 }, { k: 1 }])
    await seed(a, 'dst', 'dups', [{ k: 1 }])
    const id = cmp.start(req({ sc: 'dups', tc: 'dups', key: 'k' }))
    const f = await wait(id)
    expect(f.state).toBe('error')
    expect(f.error).toMatch(/not unique in the source/)
  })

  it('caps stored entries but keeps exact counts', async () => {
    const n = ENTRY_CAP + 5
    await seed(a, 'src', 'many', Array.from({ length: n }, (_, i) => ({ _id: new Int32(i) })))
    await seed(a, 'dst', 'many', [])
    const s = await compare(req({ sc: 'many', tc: 'many' }))
    expect(s.onlySource).toBe(n)
    expect(s.truncated).toEqual(['onlySource'])
    expect(cmp.result(s.jobId, 'onlySource', 0, 10).stored).toBe(ENTRY_CAP)
  })

  it('cancels a running comparison', async () => {
    await seed(a, 'src', 'big', Array.from({ length: 30000 }, (_, i) => ({ _id: new Int32(i), pad: 'x'.repeat(200) })))
    await seed(a, 'dst', 'big', Array.from({ length: 30000 }, (_, i) => ({ _id: new Int32(i), pad: 'y'.repeat(200) })))
    const id = cmp.start(req({ sc: 'big', tc: 'big' }))
    await new Promise<void>((r) => running.set(id, r))
    cmp.cancel(id)
    const f = await wait(id)
    expect(f.state).toBe('cancelled')
    const s = cmp.summary(id)
    expect(s.state).toBe('cancelled')
    expect(s.sourceCount).toBeLessThan(30000)
  })
})

describe('sync', () => {
  const fresh = async (): Promise<string> => {
    await seed(a, 'src', 'items', base())
    await seed(a, 'dst', 'items', changed())
    return (await compare(req({ ignore: ['updatedAt'] }))).jobId
  }

  it('dry run plans without writing', async () => {
    const id = await fresh()
    const before = canon(await all(a, 'dst', 'items'))
    const plan = await cmp.plan({ compareJobId: id, direction: 'sourceToTarget', insertMissing: true, deleteExtra: true, overwrite: 'set' })
    expect(plan).toMatchObject({ inserts: 1, deletes: 1, updates: 2, truncated: false })
    expect(plan.into).toMatchObject({ db: 'dst', coll: 'items' })
    const upd = plan.sample.filter((o) => o.op === 'update')
    expect(upd.find((o) => canon(o.key) === canon(oid(2)))?.update).toEqual({ $set: { 'address.city': 'Paris' }, $unset: { 'address.country': '' } })
    expect(upd.find((o) => canon(o.key) === canon(oid(3)))?.update).toEqual({ $set: { items: base()[2].items } })
    const rev = await cmp.plan({ compareJobId: id, direction: 'targetToSource', insertMissing: true, deleteExtra: false, overwrite: 'replace' })
    expect(rev).toMatchObject({ inserts: 1, deletes: 0, updates: 2 })
    expect(rev.into.db).toBe('src')
    expect(canon(await all(a, 'dst', 'items'))).toBe(before)
  })

  it('inserts missing documents only', async () => {
    const id = await fresh()
    expect((await sync(id, { insertMissing: true })).state).toBe('done')
    const docs = await all(a, 'dst', 'items')
    expect(docs.map((d) => d.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(canon(docs[3])).toBe(canon(base()[3]))
  })

  it('deletes extra documents only', async () => {
    const id = await fresh()
    expect((await sync(id, { deleteExtra: true })).state).toBe('done')
    expect((await all(a, 'dst', 'items')).map((d) => d.name)).toEqual(['a', 'b', 'c', 'e'])
  })

  it('overwrites different documents with $set, keeping ignored fields', async () => {
    const id = await fresh()
    expect((await sync(id, { overwrite: 'set' })).state).toBe('done')
    const docs = await all(a, 'dst', 'items')
    expect(docs[1].address).toEqual({ city: 'Paris' })
    expect(canon(docs[2].items)).toBe(canon(base()[2].items))
    expect(docs[3].updatedAt).toEqual(new Date(99))
    expect((await compare(req({ ignore: ['updatedAt'] })))).toMatchObject({ different: 0, identical: 4 })
  })

  it('replaces different documents in the reverse direction', async () => {
    const id = await fresh()
    const p = await sync(id, { direction: 'targetToSource', overwrite: 'replace' })
    expect(p.state).toBe('done')
    expect(p.message).toMatch(/2 overwritten/)
    const src = await all(a, 'src', 'items')
    expect(canon(src[1])).toBe(canon(changed()[1]))
    expect(canon(src[2])).toBe(canon(changed()[2]))
    expect(src.map((d) => d.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('refuses to sync without an action or before the comparison finished', async () => {
    const id = await fresh()
    expect(() => cmp.startSync({ compareJobId: id, direction: 'sourceToTarget', insertMissing: false, deleteExtra: false, overwrite: 'none' })).toThrow(/at least one/)
    expect(() => cmp.startSync({ compareJobId: 'nope', direction: 'sourceToTarget', insertMissing: true, deleteExtra: false, overwrite: 'none' })).toThrow(/no longer available/)
  })
})
