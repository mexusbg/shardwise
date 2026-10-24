import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Decimal128, Double, EJSON, Int32, Long, ObjectId } from 'bson'
import type { Doc, JobProgress } from '@shared/api'
import type { ReschemaOp, ReschemaRequest } from '@shared/maskingApi'
import { parseUri } from '@shared/connection'
import { compileOp, compileOps, failureExpr, mongoDateFormat, reschemaCommand, reschemaProblem, ReschemaError } from '@shared/reschema'
import { ConnectionManager } from '../src/main/mongo/manager'
import { Masking } from '../src/main/masking/masking'

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let masking: Masking
let connId: string
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()
const progress: JobProgress[] = []

const canon = (v: unknown): string => EJSON.stringify(v as never, { relaxed: false })
const oid = (i: number): ObjectId => new ObjectId(i.toString(16).padStart(24, '0'))

function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  if (done) return Promise.resolve(done)
  return new Promise((r) => waiters.set(jobId, r))
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  mgr = new ConnectionManager()
  connId = (await mgr.connect(parseUri(server.getUri()))).connId
  masking = new Masking(mgr, (p) => {
    progress.push(p)
    if (p.state !== 'running') {
      finals.set(p.jobId, p)
      waiters.get(p.jobId)?.(p)
    }
  })
})

afterAll(async () => {
  await mgr?.closeAll()
  await client?.close()
  await server?.stop()
})

async function seed(coll: string, docs: Doc[]): Promise<void> {
  const c = client.db('rs').collection(coll)
  await c.drop().catch(() => {})
  if (docs.length) await c.insertMany(docs as never)
}

async function all(coll: string): Promise<Doc[]> {
  return (await client.db('rs').collection(coll).find({}, { promoteValues: false, promoteLongs: false }).sort({ _id: 1 }).toArray()) as Doc[]
}

/** Run the pipeline as a real updateMany and return the documents. */
async function apply(coll: string, docs: Doc[], ops: ReschemaOp[]): Promise<Doc[]> {
  await seed(coll, docs)
  await client.db('rs').collection(coll).updateMany({}, compileOps(ops))
  return all(coll)
}

const req = (coll: string, ops: ReschemaOp[], filter: Doc = {}): ReschemaRequest => ({ connId, db: 'rs', coll, filter, ops })

describe('compile (pure)', () => {
  it('compiles each operation to update-pipeline stages', () => {
    expect(compileOp({ kind: 'remove', path: 'a.b' })).toEqual([{ $unset: 'a.b' }])
    const rename = compileOp({ kind: 'rename', from: 'a', to: 'b' })
    expect(rename).toHaveLength(2)
    expect(rename[0]).toEqual({ $set: { b: { $cond: [{ $eq: [{ $type: '$a' }, 'missing'] }, '$b', '$a'] } } })
    expect(rename[1]).toEqual({ $unset: 'a' })
    // Nested writes go through $setField under the top-level field.
    const nested = compileOp({ kind: 'rename', from: 'city', to: 'address.city' })
    expect(Object.keys(nested[0].$set as Doc)).toEqual(['address'])
    expect(JSON.stringify(nested[0])).toContain('$setField')
    // Overlapping paths use a temporary field.
    expect(compileOp({ kind: 'rename', from: 'a', to: 'a.b' })).toHaveLength(4)
    expect(compileOp({ kind: 'default', path: 'x', value: '$notAPath' })).toEqual([{ $set: { x: { $cond: [{ $eq: [{ $type: '$x' }, 'missing'] }, { $literal: '$notAPath' }, '$x'] } } }])
    expect(compileOp({ kind: 'default', path: 'x', value: 0, orNull: true })).toEqual([{ $set: { x: { $ifNull: ['$x', { $literal: 0 }] } } }])
    expect(JSON.stringify(compileOp({ kind: 'convert', path: 'n', to: 'int', onError: 'keep' }))).toContain('"$convert":{"input":"$n","to":"int","onError":"$n"}')
    expect(JSON.stringify(compileOp({ kind: 'convert', path: 'd', to: 'date', format: 'DD/MM/YYYY', onError: 'null' }))).toContain('"format":"%d/%m/%Y"')
    expect(JSON.stringify(compileOp({ kind: 'split', path: 's', separator: ',' }))).toContain('"$split":["$s",{"$literal":","}]')
    expect(JSON.stringify(compileOp({ kind: 'merge', paths: ['a', 'b'], separator: ' ', to: 'c' }))).toContain('$concat')
    expect(compileOp({ kind: 'merge', paths: ['a', 'b'], separator: ' ', to: 'a', removeSources: true }).at(-1)).toEqual({ $unset: 'b' })
    expect(Object.keys(compileOp({ kind: 'flatten', path: 'addr', prefix: 'addr_' })[0])).toEqual(['$replaceWith'])
    expect(Object.keys(compileOp({ kind: 'nest', prefix: 'addr_', to: 'addr' })[0])).toEqual(['$replaceWith'])
    expect(JSON.stringify(compileOp({ kind: 'extract', path: 'tags', index: -1, to: 'lastTag' }))).toContain('"$arrayElemAt":["$tags",-1]')
  })

  it('translates date formats', () => {
    expect(mongoDateFormat('DD/MM/YYYY')).toBe('%d/%m/%Y')
    expect(mongoDateFormat('YYYY-MM-DD HH:mm:ss.SSS')).toBe('%Y-%m-%d %H:%M:%S.%L')
    expect(mongoDateFormat('%Y%m%d')).toBe('%Y%m%d')
  })

  it('validates operations', () => {
    expect(() => compileOps([])).toThrow(ReschemaError)
    expect(() => compileOp({ kind: 'remove', path: '_id' })).toThrow(/_id/)
    expect(() => compileOp({ kind: 'rename', from: 'a', to: 'a' })).toThrow(/same/)
    expect(() => compileOp({ kind: 'rename', from: 'a..b', to: 'c' })).toThrow(/valid/)
    expect(() => compileOp({ kind: 'split', path: 'a', separator: '' })).toThrow(/separator/)
    expect(() => compileOp({ kind: 'nest', prefix: 'a_', to: 'x.y' })).toThrow(/plain field name/)
    expect(reschemaProblem([{ kind: 'remove', path: 'ok' }, { kind: 'remove', path: '' }])).toEqual({ op: 1, message: 'Remove: enter a field path' })
    expect(reschemaProblem([{ kind: 'remove', path: 'ok' }])).toBeNull()
    expect(failureExpr({ kind: 'convert', path: 'a', to: 'array', onError: 'keep' })).toBeNull()
    expect(failureExpr({ kind: 'convert', path: 'a', to: 'int', onError: 'keep' })).not.toBeNull()
  })

  it('renders the updateMany command', () => {
    const cmd = reschemaCommand('people', { active: true }, compileOps([{ kind: 'remove', path: 'tmp' }]))
    expect(cmd.startsWith('db.people.updateMany(')).toBe(true)
    expect(cmd).toContain("{ $unset: 'tmp' }")
    expect(cmd).toContain('{ active: true }')
    expect(reschemaCommand('my-coll', {}, [])).toContain("db.getCollection('my-coll')")
  })
})

describe('execution', () => {
  it('renames and moves fields into and out of sub-documents', async () => {
    const docs = await apply(
      'rename',
      [
        { _id: 1, first: 'Ann', city: 'Rome', address: { zip: '001' }, meta: { score: 5 } },
        { _id: 2, first: 'Bob', address: 'unknown' },
        { _id: 3, other: true }
      ],
      [
        { kind: 'rename', from: 'first', to: 'firstName' },
        { kind: 'rename', from: 'city', to: 'address.city' },
        { kind: 'rename', from: 'meta.score', to: 'score' }
      ]
    )
    expect(docs[0]).toEqual({ _id: new Int32(1), address: { zip: '001', city: 'Rome' }, meta: {}, firstName: 'Ann', score: new Int32(5) })
    // A scalar parent is left alone; nothing is created where the source is missing.
    expect(docs[1]).toEqual({ _id: new Int32(2), address: 'unknown', firstName: 'Bob' })
    expect(docs[2]).toEqual({ _id: new Int32(3), other: true })
  })

  it('renames into its own sub-document and back', async () => {
    const docs = await apply('overlap', [{ _id: 1, a: 5 }, { _id: 2 }], [{ kind: 'rename', from: 'a', to: 'a.value' }])
    expect(docs).toEqual([{ _id: new Int32(1), a: { value: new Int32(5) } }, { _id: new Int32(2) }])
    const back = await apply('overlap', docs, [{ kind: 'rename', from: 'a.value', to: 'a' }])
    expect(back).toEqual([{ _id: new Int32(1), a: new Int32(5) }, { _id: new Int32(2) }])
  })

  it('removes fields and sets defaults', async () => {
    const docs = await apply(
      'defaults',
      [{ _id: 1, tmp: 1, status: 'active' }, { _id: 2, status: null }, { _id: 3, a: { tmp: 1 } }],
      [
        { kind: 'remove', path: 'tmp' },
        { kind: 'remove', path: 'a.tmp' },
        { kind: 'default', path: 'status', value: 'new' },
        { kind: 'default', path: 'opts.level', value: new Int32(1), orNull: true }
      ]
    )
    expect(docs[0]).toEqual({ _id: new Int32(1), status: 'active', opts: { level: new Int32(1) } })
    expect(docs[1]).toEqual({ _id: new Int32(2), status: null, opts: { level: new Int32(1) } })
    expect(docs[2]).toEqual({ _id: new Int32(3), a: {}, status: 'new', opts: { level: new Int32(1) } })
  })

  it('changes types', async () => {
    const id = oid(7)
    const docs = await apply(
      'convert',
      [
        { _id: 1, n: '42', d: '21/10/2026', iso: '2026-10-21T10:00:00Z', dec: 1.5, ref: id.toHexString(), flag: 'Yes', tags: 'x', arr: ['first', 'second'], s: new Int32(9) },
        { _id: 2, n: 'abc', d: 'nope', flag: 'maybe', arr: [], s: null }
      ],
      [
        { kind: 'convert', path: 'n', to: 'int', onError: 'keep' },
        { kind: 'convert', path: 'd', to: 'date', format: 'DD/MM/YYYY', onError: 'null' },
        { kind: 'convert', path: 'iso', to: 'date', onError: 'keep' },
        { kind: 'convert', path: 'dec', to: 'decimal', onError: 'keep' },
        { kind: 'convert', path: 'ref', to: 'objectId', onError: 'keep' },
        { kind: 'convert', path: 'flag', to: 'bool', onError: 'keep' },
        { kind: 'convert', path: 'tags', to: 'array', onError: 'keep' },
        { kind: 'convert', path: 'arr', to: 'first', onError: 'keep' },
        { kind: 'convert', path: 's', to: 'string', onError: 'keep' }
      ]
    )
    const [a, b] = docs
    expect(a.n).toEqual(new Int32(42))
    expect(a.d).toEqual(new Date('2026-10-21T00:00:00Z'))
    expect(a.iso).toEqual(new Date('2026-10-21T10:00:00Z'))
    expect((a.dec as Decimal128)._bsontype).toBe('Decimal128')
    expect(Number(String(a.dec))).toBe(1.5)
    expect(canon(a.ref)).toBe(canon(id))
    expect(a.flag).toBe(true)
    expect(a.tags).toEqual(['x'])
    expect(a.arr).toBe('first')
    expect(a.s).toBe('9')
    // Failures: kept or set to null; null and empty arrays stay sensible.
    expect(b.n).toBe('abc')
    expect(b.d).toBeNull()
    expect(b.flag).toBe('maybe')
    expect(b.arr).toBeNull()
    expect(b.s).toBeNull()
    expect('iso' in b).toBe(false)
  })

  it('converts numbers to Long and Double', async () => {
    const docs = await apply('numbers', [{ _id: 1, a: new Int32(3), b: '2.5' }], [
      { kind: 'convert', path: 'a', to: 'long', onError: 'keep' },
      { kind: 'convert', path: 'b', to: 'double', onError: 'keep' }
    ])
    expect(canon(docs[0].a)).toBe(canon(Long.fromNumber(3)))
    expect(canon(docs[0].b)).toBe(canon(new Double(2.5)))
  })

  it('splits and merges strings', async () => {
    const docs = await apply(
      'strings',
      [
        { _id: 1, tags: 'a, b,,c', first: 'Ann', last: 'Lee', age: new Int32(30) },
        { _id: 2, tags: ['already'], first: 'Bob' },
        { _id: 3 }
      ],
      [
        { kind: 'split', path: 'tags', separator: ',', trim: true, dropEmpty: true },
        { kind: 'merge', paths: ['first', 'last', 'age'], separator: ' ', to: 'label' },
        { kind: 'merge', paths: ['first', 'last'], separator: ' ', to: 'name', removeSources: true }
      ]
    )
    expect(docs[0]).toEqual({ _id: new Int32(1), tags: ['a', 'b', 'c'], age: new Int32(30), label: 'Ann Lee 30', name: 'Ann Lee' })
    expect(docs[1]).toEqual({ _id: new Int32(2), tags: ['already'], label: 'Bob', name: 'Bob' })
    expect(docs[2]).toEqual({ _id: new Int32(3) })
  })

  it('flattens and nests sub-documents', async () => {
    const flat = await apply(
      'flatten',
      [
        { _id: 1, address: { city: 'Rome', zip: '001' }, x: 1 },
        { _id: 2, address: 'n/a' },
        { _id: 3, meta: { info: { a: 1 }, keep: true } }
      ],
      [
        { kind: 'flatten', path: 'address', prefix: 'address_' },
        { kind: 'flatten', path: 'meta.info', prefix: 'info_' }
      ]
    )
    expect(flat[0]).toEqual({ _id: new Int32(1), x: new Int32(1), address_city: 'Rome', address_zip: '001' })
    expect(flat[1]).toEqual({ _id: new Int32(2), address: 'n/a' })
    expect(flat[2]).toEqual({ _id: new Int32(3), meta: { keep: true, info_a: new Int32(1) } })

    const nested = await apply('nest', [...flat, { _id: 4, address: { country: 'IT' }, address_city: 'Milan' }], [{ kind: 'nest', prefix: 'address_', to: 'address' }])
    expect(nested[0]).toEqual({ _id: new Int32(1), x: new Int32(1), address: { city: 'Rome', zip: '001' } })
    expect(nested[1]).toEqual({ _id: new Int32(2), address: 'n/a' })
    expect(nested[3]).toEqual({ _id: new Int32(4), address: { country: 'IT', city: 'Milan' } })

    const inner = await apply('nest2', [{ _id: 1, meta: { info_a: 1, info_b: 2, keep: true } }], [{ kind: 'nest', prefix: 'info_', to: 'info', parent: 'meta' }])
    expect(inner[0]).toEqual({ _id: new Int32(1), meta: { keep: true, info: { a: new Int32(1), b: new Int32(2) } } })
  })

  it('nest never captures _id', async () => {
    const docs = await apply('nestid', [{ _id: 1, _x: 1, _y: 2 }], [{ kind: 'nest', prefix: '_', to: 'under' }])
    expect(docs[0]).toEqual({ _id: new Int32(1), under: { x: new Int32(1), y: new Int32(2) } })
  })

  it('extracts array elements', async () => {
    const docs = await apply(
      'extract',
      [
        { _id: 1, tags: ['a', 'b', 'c'] },
        { _id: 2, tags: [] },
        { _id: 3, tags: 'x' }
      ],
      [
        { kind: 'extract', path: 'tags', index: -1, to: 'lastTag' },
        { kind: 'extract', path: 'tags', index: 0, to: 'firstTag', removeSource: true }
      ]
    )
    expect(docs[0]).toEqual({ _id: new Int32(1), lastTag: 'c', firstTag: 'a' })
    expect(docs[1]).toEqual({ _id: new Int32(2) })
    expect(docs[2]).toEqual({ _id: new Int32(3) })
  })
})

describe('preview, dry run and apply', () => {
  const docs = (): Doc[] =>
    Array.from({ length: 30 }, (_, i) => ({ _id: i + 1, n: i % 10 === 0 ? `bad${i}` : String(i), group: i < 15 ? 'a' : 'b', keep: true }))

  it('previews the first documents before and after', async () => {
    await seed('flow', docs())
    const pairs = await masking.reschemaPreview(req('flow', [{ kind: 'convert', path: 'n', to: 'int', onError: 'keep' }, { kind: 'rename', from: 'group', to: 'g' }]), 20)
    expect(pairs).toHaveLength(20)
    expect(pairs[1].before).toEqual({ _id: new Int32(2), n: '1', group: 'a', keep: true })
    expect(pairs[1].after).toEqual({ _id: new Int32(2), n: new Int32(1), keep: true, g: 'a' })
    expect(pairs[0].after.n).toBe('bad0')
  })

  it('counts changes and conversion failures', async () => {
    await seed('flow', docs())
    const ops: ReschemaOp[] = [{ kind: 'convert', path: 'n', to: 'int', onError: 'keep' }]
    const dry = await masking.reschemaDryRun(req('flow', ops))
    expect(dry.matched).toBe(30)
    expect(dry.changed).toBe(27)
    expect(dry.failures).toHaveLength(1)
    expect(dry.failures[0]).toMatchObject({ op: 0, path: 'n', to: 'int', count: 3 })
    expect(dry.failures[0].sampleIds.map((v) => canon(v)).sort()).toEqual([1, 11, 21].map((v) => canon(new Int32(v))).sort())

    const filtered = await masking.reschemaDryRun(req('flow', ops, { group: 'b' }))
    expect(filtered.matched).toBe(15)
    expect(filtered.failures[0].count).toBe(1)

    // Type-only changes count as changes (Int32 → Double compares equal by value).
    await seed('typeonly', [{ _id: 1, v: new Int32(1) }, { _id: 2, v: new Double(2.5) }])
    const t = await masking.reschemaDryRun(req('typeonly', [{ kind: 'convert', path: 'v', to: 'double', onError: 'keep' }]))
    expect(t.changed).toBe(1)
    // A no-op operation changes nothing.
    const none = await masking.reschemaDryRun(req('flow', [{ kind: 'remove', path: 'absent' }]))
    expect(none.changed).toBe(0)
  })

  it('applies with one updateMany', async () => {
    await seed('flow', docs())
    const id = masking.reschemaStart(req('flow', [{ kind: 'convert', path: 'n', to: 'int', onError: 'null' }], { group: 'a' }), { batchSize: 0 })
    const f = await wait(id)
    expect(f.state, f.error).toBe('done')
    const after = await all('flow')
    expect(after[1].n).toEqual(new Int32(1))
    expect(after[0].n).toBeNull()
    expect(after[21].n).toBe('21')
  })

  it('applies in batches with progress', async () => {
    await seed('flow', docs())
    const before = progress.length
    const id = masking.reschemaStart(req('flow', [{ kind: 'rename', from: 'group', to: 'meta.group' }]), { batchSize: 7 })
    const f = await wait(id)
    expect(f.state, f.error).toBe('done')
    expect(f.done).toBe(30)
    expect(f.message).toContain('30 documents matched')
    expect(progress.slice(before).some((p) => p.jobId === id && p.state === 'running')).toBe(true)
    const after = await all('flow')
    expect(after.every((d) => !('group' in d) && (d.meta as Doc).group)).toBe(true)
  })

  it('cancels a batched apply', async () => {
    await seed('big', Array.from({ length: 3000 }, (_, i) => ({ _id: i, v: String(i) })))
    const id = masking.reschemaStart(req('big', [{ kind: 'convert', path: 'v', to: 'int', onError: 'keep' }]), { batchSize: 10 })
    masking.cancel(id)
    const f = await wait(id)
    expect(f.state).toBe('cancelled')
    const converted = await client.db('rs').collection('big').countDocuments({ v: { $type: 'int' } })
    expect(converted).toBeLessThan(3000)
  })
})
