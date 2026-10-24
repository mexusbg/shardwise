import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Int32, ObjectId } from 'bson'
import type { Doc, JobProgress } from '@shared/api'
import { parseUri } from '@shared/connection'
import { isHistoryCapError } from '@shared/changeHistoryApi'
import * as ops from '../src/main/mongo/ops'
import { ConnectionManager } from '../src/main/mongo/manager'
import { ChangeHistory } from '../src/main/changes/store'
import { Restorer } from '../src/main/changes/restore'
import { docIdText } from '../src/main/changes/recorder'
import { Comparisons } from '../src/main/compare/compare'
import { Masking } from '../src/main/masking/masking'
import { DocWriter } from '../src/main/transfer/importer'

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let connId: string
let dir: string
let h: ChangeHistory
let restorer: Restorer
const DB = 'hist'
const CFG = 'cfg-1'
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()

const oid = (i: number): ObjectId => new ObjectId(i.toString(16).padStart(24, '0'))
const coll = (name = 'items') => client.db(DB).collection(name)

function onJob(p: JobProgress): void {
  if (p.state === 'running') return
  finals.set(p.jobId, p)
  waiters.get(p.jobId)?.(p)
}
function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  return done ? Promise.resolve(done) : new Promise((r) => waiters.set(jobId, r))
}

async function seed(name = 'items', n = 3): Promise<void> {
  await coll(name).drop().catch(() => {})
  await coll(name).insertMany(Array.from({ length: n }, (_, i) => ({ _id: oid(i + 1), name: `n${i + 1}`, qty: new Int32(i + 1) })) as never)
}

const latest = (q: { coll?: string } = {}) => h.batches(CFG, { db: DB, ...q, limit: 1 })[0]
const recordsOf = (batchId: string) => h.records(CFG, batchId, { db: DB })

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  mgr = new ConnectionManager()
  connId = (await mgr.connect({ ...parseUri(server.getUri()), id: CFG, name: 'Local' })).connId
  dir = await fs.mkdtemp(join(tmpdir(), 'mg-changes-'))
  h = new ChangeHistory(dir, mgr)
  restorer = new Restorer(h)
})

afterAll(async () => {
  h?.close()
  await mgr?.closeAll()
  await client?.close()
  await server?.stop()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  h.saveSettings({ enabled: true, maxDocsPerOp: 10_000, maxSizeMB: 512, retentionDays: 30 })
  await seed()
})

describe('capture through ops', () => {
  it('records updateField with before and after images', async () => {
    const rec = h.forConn(connId)
    await ops.updateField(client, DB, 'items', { kind: 'all' }, { kind: 'set', path: 'flag', value: true }, undefined, rec)
    const b = latest()
    expect(b).toMatchObject({ coll: 'items', source: 'bulk', count: 3, ops: { update: 3 }, label: '$set flag', connName: 'Local' })
    const rows = recordsOf(b.batchId)
    expect(rows).toHaveLength(3)
    const r = h.get(rows[0].id)!
    expect(r.before?.flag).toBeUndefined()
    expect(r.after?.flag).toBe(true)
    expect((r.before?.qty as Int32)._bsontype).toBe('Int32')
  })

  it('records a single-document edit as source edit and skips no-op updates', async () => {
    const rec = h.forConn(connId)
    await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [oid(1)] }, { kind: 'set', path: 'name', value: 'x' }, undefined, rec)
    expect(latest()).toMatchObject({ source: 'edit', count: 1 })
    const before = h.stats().count
    await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [oid(1)] }, { kind: 'set', path: 'name', value: 'x' }, undefined, rec)
    expect(h.stats().count).toBe(before)
  })

  it('records replaceDocument, deleteDocuments and insertDocuments', async () => {
    const rec = h.forConn(connId)
    await ops.replaceDocument(client, DB, 'items', oid(2), { _id: oid(2), name: 'replaced' }, rec)
    let b = latest()
    expect(b).toMatchObject({ ops: { replace: 1 }, source: 'edit' })
    const rr = h.get(recordsOf(b.batchId)[0].id)!
    expect(rr.before?.name).toBe('n2')
    expect(rr.after).toEqual({ _id: oid(2), name: 'replaced' })

    await ops.deleteDocuments(client, DB, 'items', { kind: 'filter', filter: { qty: { $gte: 3 } } }, undefined, rec)
    b = latest()
    expect(b).toMatchObject({ ops: { delete: 1 }, source: 'delete' })
    expect(h.get(recordsOf(b.batchId)[0].id)!.before?.name).toBe('n3')

    await ops.insertDocuments(client, DB, 'items', [{ name: 'new1' }, { _id: 77, name: 'new2' }], rec)
    b = latest()
    expect(b).toMatchObject({ ops: { insert: 2 }, count: 2 })
    const ins = recordsOf(b.batchId)
    expect(ins.every((r) => !r.hasBefore && r.hasAfter)).toBe(true)
    expect(ins.map((r) => docIdText(r.docId))).toContain(docIdText(77))
  })

  it('does not record when disabled', async () => {
    h.saveSettings({ enabled: false })
    const n = h.stats().count
    await ops.updateField(client, DB, 'items', { kind: 'all' }, { kind: 'set', path: 'z', value: 1 }, undefined, h.forConn(connId))
    expect(h.stats().count).toBe(n)
  })

  it('refuses writes over the per-operation cap unless allowed without history', async () => {
    h.saveSettings({ maxDocsPerOp: 2 })
    const rec = h.forConn(connId)
    const n = h.stats().count
    const err = await ops.updateField(client, DB, 'items', { kind: 'all' }, { kind: 'set', path: 'capped', value: 1 }, undefined, rec).catch((e) => e)
    expect(isHistoryCapError(err)).toBe(true)
    expect(await coll().countDocuments({ capped: 1 })).toBe(0)
    await expect(ops.deleteDocuments(client, DB, 'items', { kind: 'all' }, undefined, rec)).rejects.toThrow('HISTORY_CAP')
    const r = await ops.updateField(client, DB, 'items', { kind: 'all' }, { kind: 'set', path: 'capped', value: 1 }, { allowWithoutHistory: true }, rec)
    expect(r.modified).toBe(3)
    expect(h.stats().count).toBe(n)
    // Within the cap still records.
    await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [oid(1), oid(2)] }, { kind: 'unset', path: 'capped' }, undefined, rec)
    expect(h.stats().count).toBe(n + 2)
  })
})

describe('restore', () => {
  it('restores updates, deletes and inserts and records the restore', async () => {
    const rec = h.forConn(connId)
    await ops.updateField(client, DB, 'items', { kind: 'all' }, { kind: 'set', path: 'qty', value: 0 }, undefined, rec)
    const upd = latest().batchId
    await ops.deleteDocuments(client, DB, 'items', { kind: 'ids', ids: [oid(3)] }, undefined, rec)
    const del = latest().batchId
    await ops.insertDocuments(client, DB, 'items', [{ _id: 50, name: 'temp' }], rec)
    const ins = latest().batchId

    const plan = await restorer.plan(connId, { batchIds: [upd, del, ins] })
    expect(plan.actions).toEqual({ replace: 2, reinsert: 1, remove: 1 })
    expect(plan.conflicts).toEqual([])

    const res = await restorer.restore(connId, { batchIds: [upd, del, ins] }, false)
    expect(res.restored).toBe(4)
    expect(res.failed).toEqual([])
    const docs = await coll().find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()
    expect(docs.map((d) => d.name)).toEqual(['n1', 'n2', 'n3'])
    expect((docs[2].qty as Int32)._bsontype).toBe('Int32')

    // The restore is itself recorded and can be undone.
    expect(res.batchIds).toHaveLength(1)
    const rb = h.batches(CFG, { db: DB, source: 'restore' })[0]
    expect(rb.batchId).toBe(res.batchIds[0])
    expect(rb.ops).toEqual({ replace: 2, insert: 1, delete: 1 })
    const undo = await restorer.restore(connId, { batchIds: res.batchIds }, false)
    expect(undo.restored).toBe(4)
    expect(await coll().countDocuments({ qty: 0 })).toBe(2)
    expect(await coll().countDocuments({ _id: 50 } as never)).toBe(1)
    expect(await coll().countDocuments({ _id: oid(3) })).toBe(0)
  })

  it('collapses several records of one document to its oldest before image', async () => {
    const rec = h.forConn(connId)
    await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [oid(1)] }, { kind: 'set', path: 'name', value: 'v2' }, undefined, rec)
    const b1 = latest().batchId
    await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [oid(1)] }, { kind: 'set', path: 'name', value: 'v3' }, undefined, rec)
    const b2 = latest().batchId
    const plan = await restorer.plan(connId, { batchIds: [b1, b2] })
    expect(plan).toMatchObject({ records: 2, documents: 1, conflicts: [] })
    await restorer.restore(connId, { batchIds: [b1, b2] }, false)
    expect((await coll().findOne({ _id: oid(1) }))?.name).toBe('n1')
  })

  it('detects conflicts and requires force', async () => {
    const rec = h.forConn(connId)
    await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [oid(1)] }, { kind: 'set', path: 'name', value: 'mine' }, undefined, rec)
    const b = latest().batchId
    await coll().updateOne({ _id: oid(1) }, { $set: { name: 'someone else' } })
    const detail = await restorer.detail(connId, recordsOf(b)[0].id)
    expect(detail.conflict).toContain('Changed since')
    expect(detail.since.map((d) => d.path)).toEqual(['name'])
    expect(detail.changed.map((d) => d.path)).toEqual(['name'])
    expect(detail.current?.name).toBe('someone else')

    const plan = await restorer.plan(connId, { batchIds: [b] })
    expect(plan.conflicts).toHaveLength(1)
    const res = await restorer.restore(connId, { batchIds: [b] }, false)
    expect(res).toMatchObject({ restored: 0, conflicts: [{ reason: expect.stringContaining('Changed since') }] })
    expect((await coll().findOne({ _id: oid(1) }))?.name).toBe('someone else')
    const forced = await restorer.restore(connId, { batchIds: [b] }, true)
    expect(forced.restored).toBe(1)
    expect((await coll().findOne({ _id: oid(1) }))?.name).toBe('n1')

    // A deleted document that exists again conflicts too.
    await ops.deleteDocuments(client, DB, 'items', { kind: 'ids', ids: [oid(2)] }, undefined, rec)
    const d = latest().batchId
    await coll().insertOne({ _id: oid(2), name: 'back' })
    expect((await restorer.plan(connId, { batchIds: [d] })).conflicts[0].reason).toBe('The document exists again')

    // An updated document deleted afterwards (outside the history) conflicts as well.
    await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [oid(3)] }, { kind: 'set', path: 'name', value: 'gone soon' }, undefined, rec)
    const u = latest().batchId
    await coll().deleteOne({ _id: oid(3) })
    const p = await restorer.plan(connId, { batchIds: [u] })
    expect(p).toMatchObject({ actions: { reinsert: 1 }, conflicts: [{ reason: 'Deleted since this change' }] })
  })

  it('skips records already in the recorded state', async () => {
    const rec = h.forConn(connId)
    await ops.updateField(client, DB, 'items', { kind: 'ids', ids: [oid(1)] }, { kind: 'set', path: 'name', value: 'z' }, undefined, rec)
    const b = latest().batchId
    await coll().updateOne({ _id: oid(1) }, { $set: { name: 'n1' } })
    const plan = await restorer.plan(connId, { batchIds: [b] })
    expect(plan.skipped[0].reason).toBe('Already in the recorded state')
    expect(plan.documents).toBe(0)
  })
})

describe('queries and purge', () => {
  it('filters by op, source, collection and _id text, and purges', async () => {
    const rec = h.forConn(connId)
    await seed('other')
    await ops.deleteDocuments(client, DB, 'other', { kind: 'ids', ids: [oid(2)] }, undefined, rec)
    expect(h.batches(CFG, { db: DB, coll: 'other' }).every((b) => b.coll === 'other')).toBe(true)
    expect(h.batches(CFG, { db: DB, op: 'delete', coll: 'other' })[0].ops).toEqual({ delete: 1 })
    expect(h.batches(CFG, { db: DB, coll: 'other', text: '000000000000000000000002' })).toHaveLength(1)
    expect(h.batches(CFG, { db: DB, coll: 'other', text: 'nomatch' })).toHaveLength(0)
    expect(h.batches('another-config', { db: DB })).toHaveLength(0)
    const n = h.purge(CFG, { kind: 'scope', db: DB, coll: 'other' })
    expect(n).toBeGreaterThan(0)
    expect(h.batches(CFG, { db: DB, coll: 'other' })).toHaveLength(0)
  })
})

describe('retention and settings', () => {
  it('prunes by size and by age', async () => {
    const d2 = await fs.mkdtemp(join(tmpdir(), 'mg-changes-prune-'))
    let now = Date.UTC(2026, 0, 1)
    const h2 = new ChangeHistory(d2, mgr, () => now)
    try {
      h2.saveSettings({ maxSizeMB: 1, retentionDays: 30 })
      const owner = { configId: 'c', connName: 'c' }
      const big = 'x'.repeat(50_000)
      for (let i = 0; i < 40; i++) h2.begin(owner, 'db', 'c', 'edit')!.add([{ op: 'update', before: { _id: i, big } }])
      const s = h2.stats()
      expect(s.bytes).toBeLessThanOrEqual(1024 * 1024)
      // The running total kept without rescanning matches the table.
      expect(s.bytes).toBe(Number((h2.db.prepare('SELECT SUM(size) AS s FROM changes').get() as { s: number }).s))
      expect(s.count).toBeLessThan(40)
      expect(s.count).toBeGreaterThan(10)
      // The newest survive.
      expect(h2.batches('c', { db: 'db', limit: 1 })[0].count).toBe(1)
      expect(h2.select([], h2.batches('c', { db: 'db', limit: 1 }).map((b) => b.batchId))[0].docIdText).toBe(docIdText(39))

      now += 31 * 86_400_000
      h2.prune(now, true)
      expect(h2.stats().count).toBe(0)
    } finally {
      h2.close()
      await fs.rm(d2, { recursive: true, force: true })
    }
  })

  it('moves a damaged database aside instead of failing at startup', async () => {
    const d3 = await fs.mkdtemp(join(tmpdir(), 'mg-changes-bad-'))
    try {
      await fs.writeFile(ChangeHistory.dbPath(d3), 'not a sqlite database '.repeat(200))
      const h3 = new ChangeHistory(d3, mgr)
      try {
        h3.begin({ configId: 'c', connName: 'c' }, 'db', 'c', 'edit')!.add([{ op: 'update', before: { _id: 1 } }])
        expect(h3.stats().count).toBe(1)
        expect(h3.stats().lastError?.message).toMatch(/damaged/)
      } finally {
        h3.close()
      }
      expect((await fs.readdir(d3)).some((f) => f.startsWith('change-history.db.bad-'))).toBe(true)
    } finally {
      await fs.rm(d3, { recursive: true, force: true })
    }
  })

  it('persists settings', async () => {
    h.saveSettings({ retentionDays: 7, maxSizeMB: 64, maxDocsPerOp: 500 })
    const again = new ChangeHistory(dir, mgr)
    try {
      expect(again.settings()).toEqual({ enabled: true, retentionDays: 7, maxSizeMB: 64, maxDocsPerOp: 500 })
    } finally {
      again.close()
    }
    expect(JSON.parse(await fs.readFile(ChangeHistory.settingsPath(dir), 'utf8')).maxDocsPerOp).toBe(500)
  })
})

describe('other capture points', () => {
  it('records compare sync writes', async () => {
    await seed('src', 3)
    await seed('dst', 2)
    await coll('dst').updateOne({ _id: oid(1) }, { $set: { name: 'drift' } })
    await coll('dst').insertOne({ _id: oid(9), name: 'extra' })
    const cmp = new Comparisons(mgr, onJob, h)
    const side = (c: string) => ({ connId, db: DB, coll: c, filter: {} })
    const jobId = cmp.start({ source: side('src'), target: side('dst'), key: '_id', fields: { mode: 'all', paths: [] }, ignore: [], sample: 0 })
    expect((await wait(jobId)).state).toBe('done')
    const s = cmp.startSync({ compareJobId: jobId, direction: 'sourceToTarget', insertMissing: true, deleteExtra: true, overwrite: 'replace' })
    expect((await wait(s)).state).toBe('done')
    const b = latest({ coll: 'dst' })
    expect(b).toMatchObject({ source: 'sync', ops: { insert: 1, delete: 1, replace: 1 } })
    const res = await restorer.restore(connId, { batchIds: [b.batchId] }, false)
    expect(res.restored).toBe(3)
    const names = (await coll('dst').find({}).sort({ _id: 1 }).toArray()).map((d: Doc) => d.name)
    expect(names).toEqual(['drift', 'n2', 'extra'])
  })

  it('records documents replaced by an upsert import', async () => {
    const batch = h.forConn(connId)!.begin(DB, 'items', 'import', 'Import test.json')
    const w = new DocWriter(coll(), 'upsert', false, () => {}, batch)
    await w.add({ _id: oid(1), name: 'imported' })
    await w.add({ _id: oid(8), name: 'fresh' })
    await w.flush()
    const b = latest()
    expect(b).toMatchObject({ source: 'import', ops: { replace: 1, insert: 1 } })
    await restorer.restore(connId, { batchIds: [b.batchId] }, false)
    expect((await coll().findOne({ _id: oid(1) }))?.name).toBe('n1')
    expect(await coll().countDocuments({ _id: oid(8) })).toBe(0)
  })

  it('records reschema and in-place masking', async () => {
    const masking = new Masking(mgr, onJob, h)
    const id = masking.reschemaStart({ connId, db: DB, coll: 'items', filter: {}, ops: [{ kind: 'rename', from: 'name', to: 'title' }] }, { batchSize: 2 })
    expect((await wait(id)).state).toBe('done')
    const b = latest()
    expect(b).toMatchObject({ source: 'reschema', count: 3 })
    expect(h.get(recordsOf(b.batchId)[0].id)!.after?.title).toBeDefined()

    const m = masking.start({
      source: { connId, db: DB, coll: 'items', filter: {} },
      target: { kind: 'inPlace', confirm: 'items' },
      rules: [{ path: 'title', kind: 'redact' } as never],
      salt: 's'
    } as never)
    const f = await wait(m)
    expect(f.state, f.error).toBe('done')
    expect(latest()).toMatchObject({ source: 'mask', ops: { replace: 3 } })
  })
})

describe('Update Documents dialog (updateDocuments)', () => {
  const batches = (): number => h.batches(CFG, { db: DB, limit: 1000 }).length

  it('updates every match with an update document and records each change', async () => {
    const rec = h.forConn(connId)
    const r = await ops.updateDocuments(client, DB, 'items', { filter: { qty: { $gte: 2 } }, update: { $set: { flag: true } }, multi: true, upsert: false }, undefined, rec)
    expect(r).toEqual({ matched: 2, modified: 2, upserted: 0 })
    expect(recordsOf(latest().batchId)).toHaveLength(2)
  })

  it('changes only the first match when Multi is off', async () => {
    const rec = h.forConn(connId)
    const r = await ops.updateDocuments(client, DB, 'items', { filter: {}, update: { $set: { flag: 1 } }, multi: false, upsert: false }, undefined, rec)
    expect([r.matched, r.modified]).toEqual([1, 1])
    expect(await coll().countDocuments({ flag: 1 })).toBe(1)
    expect(recordsOf(latest().batchId)).toHaveLength(1)
  })

  it('runs an aggregation pipeline update', async () => {
    await ops.updateDocuments(client, DB, 'items', { filter: { _id: oid(2) }, update: [{ $set: { double: { $multiply: ['$qty', 2] } } }], multi: true, upsert: false })
    expect((await coll().findOne({ _id: oid(2) } as never))?.double).toBe(4)
  })

  it('inserts with Upsert when nothing matches', async () => {
    const r = await ops.updateDocuments(client, DB, 'items', { filter: { name: 'new' }, update: { $set: { qty: 9 } }, multi: false, upsert: true })
    expect(r.upserted).toBe(1)
    expect(await coll().countDocuments({ name: 'new', qty: 9 })).toBe(1)
  })

  it('skips Change History when asked', async () => {
    const before = batches()
    await ops.updateDocuments(client, DB, 'items', { filter: {}, update: { $set: { x: 1 } }, multi: true, upsert: false }, { skipHistory: true }, h.forConn(connId))
    expect(batches()).toBe(before)
  })
})

describe('Delete Documents dialog (deleteDocuments)', () => {
  it('deletes the documents of an edited query and records them', async () => {
    const n = await ops.deleteDocuments(client, DB, 'items', { kind: 'filter', filter: { qty: { $lte: 2 } } }, undefined, h.forConn(connId))
    expect(n).toBe(2)
    expect(recordsOf(latest().batchId)).toHaveLength(2)
  })

  it('skips Change History when asked', async () => {
    const before = h.batches(CFG, { db: DB, limit: 1000 }).length
    expect(await ops.deleteDocuments(client, DB, 'items', { kind: 'all' }, { skipHistory: true }, h.forConn(connId))).toBe(3)
    expect(h.batches(CFG, { db: DB, limit: 1000 }).length).toBe(before)
  })
})
