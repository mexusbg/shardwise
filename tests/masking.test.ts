import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Decimal128, Double, EJSON, Int32, Long, ObjectId, UUID } from 'bson'
import type { Doc, JobProgress } from '@shared/api'
import type { MaskRule } from '@shared/maskingApi'
import { parseUri } from '@shared/connection'
import { ruleDefaults, suggestRule } from '@shared/masking'
import { ConnectionManager } from '../src/main/mongo/manager'
import { Masking } from '../src/main/masking/masking'
import { cloneDoc, hashHex, maskDoc, partialMask } from '../src/main/masking/engine'
import { fakeValue, seededRng } from '../src/main/masking/fake'

let serverA: MongoMemoryServer
let serverB: MongoMemoryServer
let a: MongoClient
let b: MongoClient
let mgr: ConnectionManager
let masking: Masking
let connA: string
let connB: string
let dir: string
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()

const canon = (v: unknown): string => EJSON.stringify(v as never, { relaxed: false })
const oid = (i: number): ObjectId => new ObjectId(i.toString(16).padStart(24, '0'))
const mask = (doc: Doc, rules: MaskRule[], salt = 's'): Doc => maskDoc(cloneDoc(doc), rules, salt)

function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  if (done) return Promise.resolve(done)
  return new Promise((r) => waiters.set(jobId, r))
}

beforeAll(async () => {
  serverA = await MongoMemoryServer.create()
  serverB = await MongoMemoryServer.create()
  a = await MongoClient.connect(serverA.getUri())
  b = await MongoClient.connect(serverB.getUri())
  mgr = new ConnectionManager()
  connA = (await mgr.connect(parseUri(serverA.getUri()))).connId
  connB = (await mgr.connect(parseUri(serverB.getUri()))).connId
  masking = new Masking(mgr, (p) => {
    if (p.state !== 'running') {
      finals.set(p.jobId, p)
      waiters.get(p.jobId)?.(p)
    }
  })
  dir = await fs.mkdtemp(join(tmpdir(), 'mg-mask-'))
})

afterAll(async () => {
  await mgr?.closeAll()
  await a?.close()
  await b?.close()
  await serverA?.stop()
  await serverB?.stop()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

async function seed(c: MongoClient, db: string, coll: string, docs: Doc[]): Promise<void> {
  await c.db(db).collection(coll).drop().catch(() => {})
  if (docs.length) await c.db(db).collection(coll).insertMany(docs as never)
}

async function all(c: MongoClient, db: string, coll: string): Promise<Doc[]> {
  return (await c.db(db).collection(coll).find({}, { promoteValues: false, promoteLongs: false }).sort({ _id: 1 }).toArray()) as Doc[]
}

const people = (n = 5): Doc[] =>
  Array.from({ length: n }, (_, i) => ({
    _id: oid(i + 1),
    name: `Person ${i}`,
    email: `person${i}@corp.io`,
    phone: '555-123-4567',
    age: new Int32(20 + i),
    born: new Date(Date.UTC(1990, 0, 1 + i)),
    address: { street: `${i} Real Road`, city: 'Realville' },
    orders: [{ card: '4111 1111 1111 1111', total: new Double(10.5) }],
    password: 'hunter2',
    group: i % 2 ? 'odd' : 'even'
  }))

describe('rules', () => {
  it('keeps, removes, redacts, nullifies and sets constants', () => {
    const d = mask({ a: 1, b: 2, c: 'x', d: 'y', e: 'z', f: [1] }, [
      { path: 'a', kind: 'keep' },
      { path: 'b', kind: 'remove' },
      { path: 'c', kind: 'redact', text: '[hidden]' },
      { path: 'd', kind: 'nullify' },
      { path: 'e', kind: 'constant', value: new Int32(7) },
      { path: 'f', kind: 'redact' }
    ])
    expect(d).toEqual({ a: 1, c: '[hidden]', d: null, e: new Int32(7), f: ['***'] })
  })

  it('partially masks in the usual formats', () => {
    expect(partialMask('john.doe@example.com', { partial: 'email', keepStart: 1 })).toBe('j***@example.com')
    expect(partialMask('555-123-4567', { partial: 'chars', keepEnd: 4, keepSeparators: true })).toBe('***-***-4567')
    expect(partialMask('4111 1111 1111 1234', { partial: 'chars', keepEnd: 4, keepSeparators: true })).toBe('**** **** **** 1234')
    expect(partialMask('4111-1111', { partial: 'chars', keepStart: 2, keepEnd: 2, maskChar: '#', keepSeparators: false })).toBe('41#####11')
    // Too short to reveal: masked entirely.
    expect(partialMask('1234', { partial: 'chars', keepEnd: 4 })).toBe('****')
    expect(mask({ n: new Long(5551234) }, [{ path: 'n', kind: 'partial', partial: 'chars', keepEnd: 2 }])).toEqual({ n: '*****34' })
  })

  it('hashes deterministically with SHA-256 and the salt', () => {
    const rule: MaskRule = { path: 'email', kind: 'hash' }
    const x = mask({ email: 'a@b.c' }, [rule], 'pepper')
    const y = mask({ email: 'a@b.c', other: 1 }, [rule], 'pepper')
    expect(x.email).toBe(y.email)
    expect(x.email).toMatch(/^[0-9a-f]{64}$/)
    expect(x.email).toBe(hashHex('pepper', 'a@b.c'))
    expect(mask({ email: 'a@b.c' }, [rule], 'other').email).not.toBe(x.email)
    expect(mask({ email: 'a@b.c' }, [{ ...rule, salt: 'pepper' }], 'other').email).toBe(x.email)
    // No salt: plain SHA-256 of the text.
    expect(hashHex('', 'abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('fakes consistently per original value', () => {
    const rules: MaskRule[] = [
      { path: 'name', kind: 'fake', fake: 'fullName', consistent: true },
      { path: 'email', kind: 'fake', fake: 'email', consistent: true }
    ]
    const x = mask({ name: 'Ann', email: 'ann@x.io' }, rules)
    const y = mask({ name: 'Ann', email: 'ann@x.io' }, rules)
    const z = mask({ name: 'Bob', email: 'bob@x.io' }, rules)
    expect(x).toEqual(y)
    expect(x.name).not.toBe('Ann')
    expect(x.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(x.email).toMatch(/^[a-z.]+\d{2}@example\.(com|org|net)$/)
    expect(z.email).not.toBe(x.email)
    // Another salt gives other fakes.
    expect(mask({ name: 'Ann', email: 'ann@x.io' }, rules, 'other')).not.toEqual(x)
  })

  it('generates every fake kind', () => {
    const rng = seededRng(new Uint8Array(16).fill(3))
    expect(fakeValue('firstName', rng)).toMatch(/^[A-Z][a-z]+$/)
    expect(fakeValue('lastName', rng)).toMatch(/^[A-Z][a-z]+$/)
    expect(fakeValue('phone', rng)).toMatch(/^\+1 \(\d{3}\) 555-\d{4}$/)
    expect(fakeValue('street', rng)).toMatch(/^\d+ [A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(fakeValue('city', rng)).toMatch(/^[A-Z]/)
    expect(fakeValue('company', rng)).toMatch(/^[A-Z]/)
    expect(fakeValue('lorem', rng, 'one two three four')).toMatch(/^[A-Z][a-z]+( [a-z]+){3}\.$/)
    expect(fakeValue('uuid', rng)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const u = mask({ u: new UUID() }, [{ path: 'u', kind: 'fake', fake: 'uuid', consistent: true }])
    expect((u.u as UUID).sub_type).toBe(4)
  })

  it('randomises numbers in range and keeps their type', () => {
    for (let i = 0; i < 50; i++) {
      const d = mask({ i: new Int32(5), x: new Double(1.25), l: Long.fromNumber(3), s: 'text' }, [
        { path: 'i', kind: 'number', min: 10, max: 20, decimals: 0 },
        { path: 'x', kind: 'number', min: 0, max: 1, decimals: 2 },
        { path: 'l', kind: 'number', min: 100, max: 200, decimals: 0 },
        { path: 's', kind: 'number', min: 0, max: 1 }
      ])
      expect(d.i).toBeInstanceOf(Int32)
      expect(Number(d.i)).toBeGreaterThanOrEqual(10)
      expect(Number(d.i)).toBeLessThanOrEqual(20)
      expect(d.x).toBeInstanceOf(Double)
      expect(Number(d.x)).toBeLessThanOrEqual(1)
      expect(String(Number(d.x))).toMatch(/^\d(\.\d{1,2})?$/)
      expect(d.l).toBeInstanceOf(Long)
      expect(d.s).toBe('text')
    }
  })

  it('adds noise within ±percent', () => {
    for (let i = 0; i < 50; i++) {
      const d = mask({ v: new Double(1000), dec: Decimal128.fromString('100') }, [
        { path: 'v', kind: 'noise', percent: 10 },
        { path: 'dec', kind: 'noise', percent: 5 }
      ])
      expect(Number(d.v)).toBeGreaterThanOrEqual(900)
      expect(Number(d.v)).toBeLessThanOrEqual(1100)
      expect(Number(String(d.dec))).toBeGreaterThanOrEqual(95)
      expect(Number(String(d.dec))).toBeLessThanOrEqual(105)
    }
  })

  it('shifts dates within ±days', () => {
    const base = new Date('2020-06-15T12:00:00Z')
    const seen = new Set<number>()
    for (let i = 0; i < 100; i++) {
      const d = mask({ at: base, s: '2020-06-15' }, [
        { path: 'at', kind: 'dateShift', days: 10 },
        { path: 's', kind: 'dateShift', days: 3 }
      ])
      const diff = ((d.at as Date).getTime() - base.getTime()) / 86_400_000
      expect(Number.isInteger(diff)).toBe(true)
      expect(Math.abs(diff)).toBeLessThanOrEqual(10)
      seen.add(diff)
      expect(d.s).toMatch(/^2020-06-1\d$/)
    }
    expect(seen.size).toBeGreaterThan(5)
    const rule: MaskRule = { path: 'at', kind: 'dateShift', days: 10, consistent: true }
    expect(mask({ at: base }, [rule])).toEqual(mask({ at: base }, [rule]))
  })

  it('masks nested paths and arrays of sub-documents', () => {
    const d = mask(people(1)[0], [
      { path: 'address.street', kind: 'fake', fake: 'street', consistent: true },
      { path: 'address.city', kind: 'redact', text: 'X' },
      { path: 'orders.card', kind: 'partial', partial: 'chars', keepEnd: 4, keepSeparators: true },
      { path: 'orders.0.total', kind: 'constant', value: new Int32(0) },
      { path: 'missing.path', kind: 'redact' }
    ])
    expect((d.address as Doc).city).toBe('X')
    expect((d.address as Doc).street).not.toBe('0 Real Road')
    expect(d.orders).toEqual([{ card: '**** **** **** 1111', total: new Int32(0) }])
    expect('missing' in d).toBe(false)
  })

  it('suggests rules from field names and types', () => {
    expect(suggestRule('email', 'string')).toMatchObject({ kind: 'fake', fake: 'email' })
    expect(suggestRule('user.first_name', 'string')).toMatchObject({ kind: 'fake', fake: 'firstName' })
    expect(suggestRule('phoneNumber', 'string')).toMatchObject({ kind: 'partial', keepEnd: 4 })
    expect(suggestRule('cardNumber', 'string')).toMatchObject({ kind: 'partial', keepEnd: 4 })
    expect(suggestRule('cards.number', 'string')).toMatchObject({ kind: 'partial', keepEnd: 4 })
    expect(suggestRule('cards.exp', 'string').kind).toBe('keep')
    expect(suggestRule('ssn', 'string')).toMatchObject({ kind: 'partial' })
    expect(suggestRule('password', 'string')).toMatchObject({ kind: 'redact' })
    expect(suggestRule('apiToken', 'string')).toMatchObject({ kind: 'redact' })
    expect(suggestRule('ip', 'string')).toMatchObject({ kind: 'hash' })
    expect(suggestRule('address.street', 'string')).toMatchObject({ kind: 'fake', fake: 'street' })
    expect(suggestRule('dob', 'date')).toMatchObject({ kind: 'dateShift' })
    expect(suggestRule('salary', 'int')).toMatchObject({ kind: 'noise' })
    expect(suggestRule('salary', 'string').kind).toBe('keep')
    expect(suggestRule('cancelled', 'bool').kind).toBe('keep')
    expect(suggestRule('_id', 'objectId').kind).toBe('keep')
    expect(ruleDefaults('x', 'partial')).toMatchObject({ keepEnd: 4, maskChar: '*' })
  })
})

describe('jobs', () => {
  const rules: MaskRule[] = [
    { path: 'name', kind: 'fake', fake: 'fullName', consistent: true },
    { path: 'email', kind: 'hash' },
    { path: 'password', kind: 'remove' },
    { path: 'address.city', kind: 'fake', fake: 'city', consistent: true }
  ]
  it('previews before / after', async () => {
    await seed(a, 'm', 'people', people(30))
    const pairs = await masking.preview({ connId: connA, db: 'm', coll: 'people', filter: { group: 'odd' } }, rules, 'salt', 20)
    expect(pairs).toHaveLength(15)
    expect(pairs[0].before.email).toBe('person1@corp.io')
    expect(pairs[0].after.email).toBe(hashHex('salt', 'person1@corp.io'))
    expect('password' in pairs[0].after).toBe(false)
    expect(pairs[0].before.password).toBe('hunter2')
  })

  it('copies masked documents into another connection', async () => {
    await seed(a, 'm', 'people', people(1200))
    await seed(b, 'copy', 'people', [{ _id: oid(9999), stale: true }])
    const id = masking.start({
      source: { connId: connA, db: 'm', coll: 'people', filter: {} },
      rules,
      salt: 'salt',
      target: { kind: 'collection', connId: connB, db: 'copy', coll: 'people', dropFirst: true }
    })
    const f = await wait(id)
    expect(f.state, f.error).toBe('done')
    expect(f.done).toBe(1200)
    const docs = await all(b, 'copy', 'people')
    expect(docs).toHaveLength(1200)
    expect(docs.some((d) => d.stale)).toBe(false)
    expect(docs[0].email).toBe(hashHex('salt', 'person0@corp.io'))
    expect('password' in docs[0]).toBe(false)
    expect(docs[0].age).toEqual(new Int32(20))
    // The source is untouched.
    expect((await all(a, 'm', 'people'))[0].email).toBe('person0@corp.io')
  })

  it('copies a filtered subset into the same database and reports duplicates', async () => {
    await seed(a, 'm', 'people', people(10))
    await seed(a, 'm', 'masked', [{ _id: oid(2) }])
    const id = masking.start({
      source: { connId: connA, db: 'm', coll: 'people', filter: { group: 'odd' } },
      rules,
      salt: 'salt',
      target: { kind: 'collection', connId: connA, db: 'm', coll: 'masked', dropFirst: false }
    })
    const f = await wait(id)
    expect(f.state, f.error).toBe('done')
    expect(f.message).toContain('4 masked documents')
    expect(f.message).toContain('1 failed')
    expect(await a.db('m').collection('masked').countDocuments()).toBe(5)
  })

  it('refuses the source as copy target and unconfirmed in-place runs', () => {
    const source = { connId: connA, db: 'm', coll: 'people', filter: {} }
    expect(() => masking.start({ source, rules, salt: '', target: { kind: 'collection', connId: connA, db: 'm', coll: 'people', dropFirst: false } })).toThrow(/in place/)
    expect(() => masking.start({ source, rules, salt: '', target: { kind: 'inPlace', confirm: 'wrong' } })).toThrow(/confirm/)
    expect(() => masking.start({ source, rules: [{ path: '_id', kind: 'hash' }], salt: '', target: { kind: 'inPlace', confirm: 'people' } })).toThrow(/_id/)
  })

  it('masks in place', async () => {
    await seed(a, 'm', 'people', people(700))
    const id = masking.start({
      source: { connId: connA, db: 'm', coll: 'people', filter: { group: 'even' } },
      rules,
      salt: 'salt',
      target: { kind: 'inPlace', confirm: 'people' }
    })
    const f = await wait(id)
    expect(f.state, f.error).toBe('done')
    expect(f.message).toContain('350 documents')
    const docs = await all(a, 'm', 'people')
    expect(docs[0].email).toBe(hashHex('salt', 'person0@corp.io'))
    expect('password' in docs[0]).toBe(false)
    expect(docs[1].email).toBe('person1@corp.io')
    expect(docs[1].password).toBe('hunter2')
  })

  it('exports masked relaxed EJSON lines', async () => {
    await seed(a, 'm', 'people', people(25))
    const path = join(dir, 'masked.json')
    const id = masking.start({ source: { connId: connA, db: 'm', coll: 'people', filter: {} }, rules, salt: 'salt', target: { kind: 'file', path } })
    const f = await wait(id)
    expect(f.state, f.error).toBe('done')
    const lines = (await fs.readFile(path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(25)
    const first = EJSON.parse(lines[0], { relaxed: true }) as Doc
    expect(first.email).toBe(hashHex('salt', 'person0@corp.io'))
    expect('password' in first).toBe(false)
    expect(lines[0]).toContain('"$oid"')
    expect(lines[0]).toContain('"$date"')
    expect(first.age).toBe(20)
  })

  it('cancels and removes a partial export', async () => {
    await seed(a, 'm', 'people', people(5000))
    const path = join(dir, 'cancelled.json')
    const id = masking.start({ source: { connId: connA, db: 'm', coll: 'people', filter: {} }, rules, salt: 'salt', target: { kind: 'file', path } })
    masking.cancel(id)
    const f = await wait(id)
    expect(f.state).toBe('cancelled')
    await expect(fs.access(path)).rejects.toThrow()
  })

  it('cancels a copy', async () => {
    await seed(a, 'm', 'people', people(5000))
    const id = masking.start({
      source: { connId: connA, db: 'm', coll: 'people', filter: {} },
      rules,
      salt: 'salt',
      target: { kind: 'collection', connId: connB, db: 'copy', coll: 'cancelled', dropFirst: true }
    })
    setTimeout(() => masking.cancel(id), 5)
    const f = await wait(id)
    expect(f.state).toBe('cancelled')
    expect(await b.db('copy').collection('cancelled').countDocuments()).toBeLessThan(5000)
  })

})
