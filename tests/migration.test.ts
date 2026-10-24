import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Binary, Decimal128, Double, Int32, Long, ObjectId } from 'bson'
import type { Doc, JobProgress } from '@shared/api'
import { parseUri } from '@shared/connection'
import { newSqlConnection } from '@shared/migrationApi'
import type { FromSqlRequest, FromSqlSource, SqlConnectionConfig, SqlDialect, ToSqlCollection, ToSqlRequest } from '@shared/migrationApi'
import { ConnectionManager } from '../src/main/mongo/manager'
import { Migrations } from '../src/main/sql/migrations'
import type { SecretCodec } from '../src/main/store'

const codec: SecretCodec = {
  encrypt: async (s) => Buffer.from(s).toString('base64'),
  decrypt: async (s) => Buffer.from(s, 'base64').toString()
}

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let connId: string
let m: Migrations
let dir: string
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()
const progress = new Map<string, () => void>()

function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  if (done) return Promise.resolve(done)
  return new Promise((r) => waiters.set(jobId, r))
}

const oid = (i: number): ObjectId => new ObjectId(i.toString(16).padStart(24, '0'))
const db = 'mig'

/** Documents with nested objects, arrays of scalars / documents and a few type mismatches. */
function orders(n: number, from = 1): Doc[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + from
    const d: Doc = {
      _id: oid(i),
      name: `order ${i}`,
      qty: new Int32(i),
      big: Long.fromString('9007199254740993'),
      price: Decimal128.fromString('12.50'),
      ok: i % 2 === 0,
      at: new Date(Date.UTC(2024, 0, 1, 0, 0, i % 60)),
      ratio: new Double(i + 0.5),
      address: { city: `c${i % 3}`, geo: { lat: new Double(i / 10) } },
      tags: i % 3 ? ['a', 'b'] : [],
      items: Array.from({ length: i % 4 }, (_, j) => ({ sku: `s${j}`, n: new Int32(j) })),
      bin: new Binary(Buffer.from([i % 256]))
    }
    return d
  })
}

async function seed(coll: string, docs: Doc[]): Promise<void> {
  await client.db(db).collection(coll).drop().catch(() => {})
  if (docs.length) await client.db(db).collection(coll).insertMany(docs as never)
}

async function saveConn(c: Partial<SqlConnectionConfig>): Promise<SqlConnectionConfig> {
  return m.saveConnection({ ...newSqlConnection(c.dialect ?? 'sqlite'), ...c })
}

async function infer(colls: string[]): Promise<ToSqlCollection[]> {
  return m.inferToSql(connId, db, colls, 1000)
}

async function toSql(req: Partial<ToSqlRequest> & Pick<ToSqlRequest, 'collections' | 'target'>): Promise<JobProgress> {
  const id = m.startToSql({ connId, db, mode: 'dropCreate', batchSize: 50, ...req })
  return wait(id)
}

async function fromSql(req: Partial<FromSqlRequest> & Pick<FromSqlRequest, 'sqlConnId' | 'sources'>): Promise<JobProgress> {
  const id = m.startFromSql({ connId, db, mode: 'insert', dropTarget: true, batchSize: 100, ...req })
  return wait(id)
}

const all = async (coll: string): Promise<Doc[]> =>
  (await client.db(db).collection(coll).find({}, { promoteValues: false, promoteLongs: false }).sort({ _id: 1 }).toArray()) as Doc[]

const count = (file: string, table: string): number => {
  const d = new DatabaseSync(file)
  try {
    return Number((d.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n)
  } finally {
    d.close()
  }
}

const rowsOf = (file: string, sql: string): Record<string, unknown>[] => {
  const d = new DatabaseSync(file)
  try {
    const st = d.prepare(sql)
    st.setReadBigInts(true)
    const big = (v: unknown): unknown => (typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v)) : v)
    return (st.all() as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, big(v)])))
  } finally {
    d.close()
  }
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  mgr = new ConnectionManager()
  connId = (await mgr.connect(parseUri(server.getUri()))).connId
  dir = mkdtempSync(join(tmpdir(), 'mg-migration-'))
  m = new Migrations(mgr, codec, dir, (p) => {
    if (p.state === 'running') {
      if (p.done > 0) progress.get(p.jobId)?.()
      return
    }
    finals.set(p.jobId, p)
    waiters.get(p.jobId)?.(p)
  })
})

afterAll(async () => {
  await m?.closeAll()
  await mgr?.closeAll()
  await client?.close()
  await server?.stop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('SQL connections', () => {
  it('saves connections with encrypted secrets and tests them', async () => {
    const c = await saveConn({ dialect: 'postgres', name: 'pg', host: 'db.local', user: 'u', password: 'secret', ssh: { enabled: true, host: 'b', password: 'sshpw' } })
    const raw = readFileSync(join(dir, 'sql-connections.json'), 'utf8')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('sshpw')
    expect(raw).toContain('enc:')
    const listed = (await m.conns.list()).find((x) => x.id === c.id)!
    expect(listed.password).toBe('secret')
    expect(listed.ssh.password).toBe('sshpw')
    await m.deleteConnection(c.id)
    expect((await m.conns.list()).some((x) => x.id === c.id)).toBe(false)

    const ok = await m.test({ ...newSqlConnection('sqlite'), file: join(dir, 'test.db') })
    expect(ok.ok).toBe(true)
    expect(ok.serverVersion).toMatch(/^SQLite 3\./)
    const bad = await m.test({ ...newSqlConnection('postgres'), host: '127.0.0.1', port: 1 })
    expect(bad.ok).toBe(false)
    expect(bad.error).toBeTruthy()
  })
})

describe('MongoDB → SQLite', () => {
  let file: string
  let sqlConnId: string

  beforeAll(async () => {
    const extra: Doc[] = [{ _id: oid(900), name: 12345, qty: 'many', address: 'not an object', tags: ['x', new Int32(5)], items: [{ sku: 'z' }, 'junk'] }]
    await seed('orders', [...orders(20), ...extra])
    file = join(dir, 'out.db')
    sqlConnId = (await saveConn({ dialect: 'sqlite', name: 'out', file })).id
  })

  it('previews DDL, rows and type warnings', async () => {
    const colls = await infer(['orders'])
    const p = await m.previewToSql({ connId, db, collections: colls, target: { kind: 'connection', sqlConnId }, mode: 'dropCreate', batchSize: 100 })
    expect(p.dialect).toBe('sqlite')
    expect(p.tables.map((t) => t.name)).toEqual(['orders', 'orders_tags', 'orders_items'])
    expect(p.ddl).toContain('DROP TABLE IF EXISTS "orders_items"')
    expect(p.ddl).toContain('CREATE TABLE "orders" (')
    expect(p.ddl).toContain('FOREIGN KEY ("orders_id") REFERENCES "orders" ("_id")')
    const root = p.rows.find((r) => r.table === 'orders')!
    expect(root.columns.slice(0, 4)).toEqual(['_id', 'name', 'qty', 'big'])
    expect(root.rows.length).toBe(10)
    expect(root.rows[0][0]).toBe('000000000000000000000001')
    expect(p.autoTypes.orders['address.city']).toBe('TEXT')
    expect(p.warnings.some((w) => w.startsWith('orders.qty: 1 value'))).toBe(true)
  })

  it('infers columns in a stable order (first appearance in _id order, not $sample order)', async () => {
    // Only the first document (by _id) lists `a` before `z`; with $sample order the columns came out shuffled.
    await seed('colorder', [{ _id: 1, a: 1, z: 1 }, ...Array.from({ length: 29 }, (_, i) => ({ _id: i + 2, z: 1, a: 1 }))])
    for (let i = 0; i < 5; i++) {
      const [c] = await infer(['colorder'])
      expect(c.fields.map((f) => f.name)).toEqual(['_id', 'a', 'z'])
    }
  })

  it('creates tables with child tables and converts mixed types', async () => {
    const f = await toSql({ collections: await infer(['orders']), target: { kind: 'connection', sqlConnId } })
    expect(f.state, f.error).toBe('done')
    expect(f.message).toMatch(/^21 documents/)
    expect(count(file, 'orders')).toBe(21)
    const tagRows = orders(20).reduce((n, d) => n + (d.tags as unknown[]).length, 0) + 2
    expect(count(file, 'orders_tags')).toBe(tagRows)
    const itemRows = orders(20).reduce((n, d) => n + (d.items as unknown[]).length, 0) + 1
    expect(count(file, 'orders_items')).toBe(itemRows)
    const [r] = rowsOf(file, `SELECT * FROM orders WHERE _id = '000000000000000000000002'`)
    expect(r).toMatchObject({ name: 'order 2', qty: 2, big: '9007199254740993', ok: 1, at: '2024-01-01T00:00:02.000Z', ratio: 2.5, address_city: 'c2', address_geo_lat: 0.2 })
    expect(Buffer.from(r.bin as Uint8Array)).toEqual(Buffer.from([2]))
    const [odd] = rowsOf(file, `SELECT * FROM orders WHERE _id = '${oid(900).toHexString()}'`)
    expect(odd).toMatchObject({ name: '12345', qty: null, address_city: null })
    expect(rowsOf(file, `SELECT value FROM orders_tags WHERE orders_id = '${oid(900).toHexString()}' ORDER BY idx`).map((x) => x.value)).toEqual(['x', '5'])
    expect(rowsOf(file, `SELECT orders_id, idx, sku, n FROM orders_items WHERE orders_id = '000000000000000000000003' ORDER BY idx`)).toEqual([
      { orders_id: '000000000000000000000003', idx: 0, sku: 's0', n: 0 },
      { orders_id: '000000000000000000000003', idx: 1, sku: 's1', n: 1 },
      { orders_id: '000000000000000000000003', idx: 2, sku: 's2', n: 2 }
    ])
    expect(f.log!.some((l) => /orders\.qty: 1 value\(s\) could not be converted/.test(l))).toBe(true)
    expect(f.log!.some((l) => /orders_items: 1 array element\(s\) skipped/.test(l))).toBe(true)
  })

  it('fails in create mode when tables exist, appends and truncates', async () => {
    const colls = await infer(['orders'])
    const fail = await toSql({ collections: colls, target: { kind: 'connection', sqlConnId }, mode: 'create' })
    expect(fail.state).toBe('error')
    expect(fail.error).toMatch(/already exists/)

    await client.db(db).collection('orders').insertMany(orders(5, 101) as never)
    const append = await toSql({
      collections: colls.map((c) => ({ ...c, filter: { _id: { $gte: oid(101), $lt: oid(200) } } })),
      target: { kind: 'connection', sqlConnId },
      mode: 'append'
    })
    expect(append.state, append.error).toBe('done')
    expect(count(file, 'orders')).toBe(26)

    const dup = await toSql({ collections: colls, target: { kind: 'connection', sqlConnId }, mode: 'append', batchSize: 10 })
    expect(dup.state).toBe('done')
    expect(dup.message).toMatch(/26 documents failed/)
    expect(dup.log!.some((l) => /UNIQUE constraint failed/.test(l))).toBe(true)

    const trunc = await toSql({ collections: colls, target: { kind: 'connection', sqlConnId }, mode: 'truncate' })
    expect(trunc.state, trunc.error).toBe('done')
    expect(count(file, 'orders')).toBe(26)
    expect(count(file, 'orders_items')).toBe(rowsOf(file, 'SELECT COUNT(*) AS n FROM orders_items')[0].n)
  })

  it('renames tables / columns, changes types, excludes fields and uses 1:1 / JSON modes', async () => {
    const [c] = await infer(['orders'])
    c.table = 'o'
    const f = (n: string): ToSqlCollection['fields'][number] => c.fields.find((x) => x.name === n)!
    f('name').column = 'title'
    f('qty').sqlType = 'TEXT'
    f('bin').include = false
    f('address').mode = 'table'
    f('items').mode = 'json'
    f('tags').include = false
    const r = await toSql({ collections: [c], target: { kind: 'connection', sqlConnId } })
    expect(r.state, r.error).toBe('done')
    const cols = rowsOf(file, `SELECT name FROM pragma_table_info('o')`).map((x) => x.name)
    expect(cols).toEqual(['_id', 'title', 'qty', 'big', 'price', 'ok', 'at', 'ratio', 'items'])
    expect(rowsOf(file, `SELECT name FROM pragma_table_info('o_address')`).map((x) => x.name)).toEqual(['o_id', 'city', 'geo_lat'])
    const [row] = rowsOf(file, `SELECT qty, items FROM o WHERE _id = '000000000000000000000002'`)
    expect(row).toEqual({ qty: '2', items: '[{"sku":"s0","n":0},{"sku":"s1","n":1}]' })
    expect(count(file, 'o_address')).toBe(25)
  })

  it('generates a .sql file that recreates the same tables', async () => {
    const colls = await infer(['orders'])
    const out = join(dir, 'export.sql')
    const r = await toSql({ collections: colls, target: { kind: 'file', path: out, dialect: 'sqlite' }, batchSize: 7 })
    expect(r.state, r.error).toBe('done')
    const script = readFileSync(out, 'utf8')
    expect(script).toMatch(/^-- Shardwise: mig → SQLite/)
    const fresh = join(dir, 'fresh.db')
    const d = new DatabaseSync(fresh)
    d.exec(script)
    d.close()
    const live = await toSql({ collections: colls, target: { kind: 'connection', sqlConnId } })
    expect(live.state).toBe('done')
    for (const t of ['orders', 'orders_tags', 'orders_items']) expect(count(fresh, t), t).toBe(count(file, t))
    expect(rowsOf(fresh, 'SELECT * FROM orders ORDER BY _id')).toEqual(rowsOf(file, 'SELECT * FROM orders ORDER BY _id'))

    for (const dialect of ['postgres', 'mysql', 'mssql'] as SqlDialect[]) {
      const p = join(dir, `export-${dialect}.sql`)
      const x = await toSql({ collections: colls, target: { kind: 'file', path: p, dialect }, batchSize: 10 })
      expect(x.state, x.error).toBe('done')
      const text = readFileSync(p, 'utf8')
      expect(text).toContain(dialect === 'mssql' ? 'CREATE TABLE [dbo].[orders]' : dialect === 'postgres' ? 'CREATE TABLE "public"."orders"' : 'CREATE TABLE `orders`')
      expect(text.match(/INSERT INTO/g)!.length).toBeGreaterThanOrEqual(7)
    }
  })

  it('cancels a long export', async () => {
    await seed('many', Array.from({ length: 20000 }, (_, i) => ({ _id: new Int32(i), v: `value ${i}`, n: new Int32(i), arr: [i, i + 1] })))
    const colls = await infer(['many'])
    const id = m.startToSql({ connId, db, collections: colls, target: { kind: 'connection', sqlConnId }, mode: 'dropCreate', batchSize: 100 })
    await new Promise<void>((r) => progress.set(id, r))
    m.cancel(id)
    const f = await wait(id)
    expect(f.state).toBe('cancelled')
    const n = count(file, 'many')
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(20000)
    expect(n % 100).toBe(0)
  })
})

describe('SQLite → MongoDB', () => {
  let file: string
  let sqlConnId: string

  beforeAll(async () => {
    file = join(dir, 'source.db')
    const d = new DatabaseSync(file)
    d.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created DATETIME, vip BOOLEAN, balance NUMERIC, meta JSON, ref CHAR(24), photo BLOB, big BIGINT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL, placed DATE);
      CREATE TABLE lines (order_id INTEGER, line INTEGER, sku TEXT, PRIMARY KEY (order_id, line), FOREIGN KEY (order_id) REFERENCES orders(id));
      INSERT INTO customers VALUES
        (1, 'Ann', '2024-01-02 03:04:05.678', 1, 12.5, '{"tier":"gold","since":{"$date":"2020-01-01T00:00:00Z"}}', '65a1b2c3d4e5f60718293a4b', X'0102', 9007199254740993),
        (2, 'Bob', '2024-02-03T04:05:06Z', 0, 0, NULL, 'not-an-object-id-at-all!', NULL, 1),
        (3, 'Cy', NULL, NULL, NULL, '[1,2]', NULL, NULL, NULL);
      INSERT INTO orders VALUES (10, 1, 9.99, '2024-03-01'), (11, 1, 20, '2024-03-02'), (12, 2, 5.5, '2024-03-03');
      INSERT INTO lines VALUES (10, 1, 'a'), (10, 2, 'b'), (12, 1, 'c');
    `)
    d.close()
    sqlConnId = (await saveConn({ dialect: 'sqlite', name: 'src', file })).id
  })

  it('browses schemas, tables, columns and keys', async () => {
    expect(await m.withSession(sqlConnId, (s) => s.listSchemas())).toEqual(['main'])
    expect((await m.withSession(sqlConnId, (s) => s.listTables('main'))).map((t) => t.name)).toEqual(['customers', 'lines', 'orders'])
    const det = await m.withSession(sqlConnId, (s) => s.describe('main', 'orders'))
    expect(det.primaryKey).toEqual(['id'])
    expect(det.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['id:INTEGER', 'customer_id:INTEGER', 'total:REAL', 'placed:DATE'])
    expect(det.foreignKeys).toEqual([expect.objectContaining({ table: 'orders', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] })])
    expect(det.referencedBy).toEqual([expect.objectContaining({ table: 'lines', columns: ['order_id'], refTable: 'orders', refColumns: ['id'] })])
    const lines = await m.withSession(sqlConnId, (s) => s.describe('main', 'lines'))
    expect(lines.primaryKey).toEqual(['order_id', 'line'])
  })

  it('imports tables with type conversions and embedded child rows', async () => {
    const src = await m.defaultSource(sqlConnId, { schema: 'main', table: 'customers' })
    expect(src.columns.find((c) => c.column === 'id')!.field).toBe('_id')
    const emb = src.embeds.find((e) => e.table === 'orders')!
    expect(emb).toMatchObject({ as: 'array', localColumns: ['id'], foreignColumns: ['customer_id'] })
    emb.include = true
    emb.field = 'orders'
    src.columns.find((c) => c.column === 'name')!.field = 'profile.name'
    src.columns.find((c) => c.column === 'balance')!.convert = 'double'

    const preview = await m.previewFromSql(sqlConnId, src)
    expect(preview.docs).toHaveLength(3)
    expect(preview.docs[0].profile).toEqual({ name: 'Ann' })

    const f = await fromSql({ sqlConnId, sources: [src] })
    expect(f.state, f.error).toBe('done')
    expect(f.message).toBe('3 rows read, 3 documents inserted')
    const docs = await all('customers')
    expect(docs[0]).toEqual({
      _id: new Int32(1),
      profile: { name: 'Ann' },
      created: new Date('2024-01-02T03:04:05.678Z'),
      vip: true,
      balance: new Double(12.5),
      meta: { tier: 'gold', since: new Date('2020-01-01T00:00:00Z') },
      ref: new ObjectId('65a1b2c3d4e5f60718293a4b'),
      photo: new Binary(Buffer.from([1, 2])),
      big: Long.fromString('9007199254740993'),
      orders: [
        { id: new Int32(10), total: new Double(9.99), placed: new Date('2024-03-01T00:00:00Z') },
        { id: new Int32(11), total: new Double(20), placed: new Date('2024-03-02T00:00:00Z') }
      ]
    })
    expect(docs[1]).toMatchObject({ _id: new Int32(2), vip: false, ref: 'not-an-object-id-at-all!', created: new Date('2024-02-03T04:05:06Z'), meta: null, big: Long.fromNumber(1) })
    expect((docs[1].orders as Doc[]).length).toBe(1)
    expect(docs[2]).toMatchObject({ _id: new Int32(3), meta: [new Int32(1), new Int32(2)], orders: [] })
  })

  it('embeds a referenced row as a sub-document and composite keys as _id objects', async () => {
    const orders = await m.defaultSource(sqlConnId, { schema: 'main', table: 'orders' })
    const cust = orders.embeds.find((e) => e.table === 'customers')!
    expect(cust.as).toBe('object')
    cust.include = true
    cust.field = 'customer'
    cust.columns = cust.columns.map((c) => ({ ...c, include: c.column === 'name' || c.column === 'id' }))
    const lines = orders.embeds.find((e) => e.table === 'lines')!
    lines.include = true
    const lineSrc = await m.defaultSource(sqlConnId, { schema: 'main', table: 'lines' })
    expect(lineSrc.columns.filter((c) => c.field.startsWith('_id.')).map((c) => c.field)).toEqual(['_id.order_id', '_id.line'])
    const f = await fromSql({ sqlConnId, sources: [orders, lineSrc], batchSize: 2 })
    expect(f.state, f.error).toBe('done')
    const docs = await all('orders')
    expect(docs).toHaveLength(3)
    expect(docs[0]).toMatchObject({ _id: new Int32(10), customer_id: new Int32(1), customer: { id: new Int32(1), name: 'Ann' } })
    expect((docs[0].lines as Doc[]).map((l) => l.sku)).toEqual(['a', 'b'])
    expect(docs[2]).toMatchObject({ customer: { name: 'Bob' } })
    const ls = await client.db(db).collection('lines').find({}, { promoteValues: false }).toArray()
    expect(ls.map((l) => l._id)).toEqual(expect.arrayContaining([{ order_id: new Int32(10), line: new Int32(1) }]))
  })

  it('upserts by _id and reports duplicate keys on insert', async () => {
    const src = await m.defaultSource(sqlConnId, { schema: 'main', table: 'customers' })
    expect((await fromSql({ sqlConnId, sources: [src] })).state).toBe('done')
    const d = new DatabaseSync(file)
    d.exec(`UPDATE customers SET name = 'Annie' WHERE id = 1; INSERT INTO customers (id, name) VALUES (4, 'Dee')`)
    d.close()
    const up = await fromSql({ sqlConnId, sources: [src], mode: 'upsert', dropTarget: false })
    expect(up.state, up.error).toBe('done')
    const docs = await all('customers')
    expect(docs.map((x) => x.name)).toEqual(['Annie', 'Bob', 'Cy', 'Dee'])
    const dup = await fromSql({ sqlConnId, sources: [src], mode: 'insert', dropTarget: false })
    expect(dup.state).toBe('done')
    expect(dup.message).toMatch(/0 documents inserted, 4 errors/)
    expect(dup.log!.some((l) => /E11000/.test(l))).toBe(true)
  })

  it('imports a custom query with new ObjectIds', async () => {
    const src = await m.defaultSource(sqlConnId, { query: `SELECT c.name, COUNT(o.id) AS n, SUM(o.total) AS spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id;` })
    expect(src.kind).toBe('query')
    expect(src.columns.map((c) => c.column)).toEqual(['name', 'n', 'spent'])
    src.collection = 'stats'
    const f = await fromSql({ sqlConnId, sources: [src] })
    expect(f.state, f.error).toBe('done')
    const docs = await client.db(db).collection('stats').find({}, { promoteValues: false }).toArray()
    expect(docs).toHaveLength(4)
    expect((docs[0]._id as { _bsontype?: string })._bsontype).toBe('ObjectId')
    expect(docs[0]).toMatchObject({ name: 'Annie', n: new Int32(2) })
    expect(docs[0].spent).toEqual(new Double(9.99 + 20))
    expect(docs[1].spent).toEqual(new Double(5.5))
  })

  it('cancels a long import', async () => {
    const big = join(dir, 'big.db')
    const d = new DatabaseSync(big)
    d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    d.exec(`WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 30000) INSERT INTO t SELECT i, 'v' || i FROM s`)
    d.close()
    const id2 = (await saveConn({ dialect: 'sqlite', name: 'big', file: big })).id
    const src = await m.defaultSource(id2, { schema: 'main', table: 't' })
    const id = m.startFromSql({ sqlConnId: id2, connId, db, sources: [src], mode: 'insert', dropTarget: true, batchSize: 100 })
    await new Promise<void>((r) => progress.set(id, r))
    m.cancel(id)
    const f = await wait(id)
    expect(f.state).toBe('cancelled')
    const n = await client.db(db).collection('t').countDocuments()
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(30000)
  })
})

// ---------------------------------------------------------------------------
// Docker-backed round trips (skipped when Docker is not running)
// ---------------------------------------------------------------------------

const docker = ((): boolean => {
  if (process.env.SHARDWISE_SKIP_DOCKER) return false
  try {
    return spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15000, encoding: 'utf8' }).status === 0
  } catch {
    return false
  }
})()

function dockerRun(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 600000 })
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function hostPort(container: string, port: number): number {
  const out = dockerRun(['port', container, String(port)])
  return Number(out.split('\n')[0].split(':').pop())
}

async function waitReady(cfg: SqlConnectionConfig, ms = 150000): Promise<void> {
  const until = Date.now() + ms
  let last = ''
  while (Date.now() < until) {
    const r = await m.test(cfg)
    if (r.ok) return
    last = r.error ?? ''
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error(`Database did not start: ${last}`)
}

async function roundTrip(cfg: SqlConnectionConfig): Promise<void> {
  const conn = await saveConn(cfg)
  await seed('rt', orders(30))
  const colls = await infer(['rt'])
  const out = await toSql({ collections: colls, target: { kind: 'connection', sqlConnId: conn.id }, batchSize: 7 })
  expect(out.state, out.error).toBe('done')
  const schema = await m.withSession(conn.id, async (s) => s.defaultSchema)
  const n = await m.withSession(conn.id, (s) => s.query(`SELECT COUNT(*) AS n FROM ${s.dialect.qualified(schema, 'rt_items')}`))
  expect(Number(n.rows[0].n)).toBe(orders(30).reduce((k, d) => k + (d.items as unknown[]).length, 0))

  // The generated script for this dialect runs on the real server.
  const script = join(dir, `rt-${cfg.dialect}.sql`)
  const gen = await toSql({ collections: colls, target: { kind: 'file', path: script, dialect: cfg.dialect, schema }, batchSize: 9 })
  expect(gen.state, gen.error).toBe('done')
  await m.withSession(conn.id, (s) => s.exec(readFileSync(script, 'utf8')))
  const viaFile = await m.withSession(conn.id, (s) => s.query(`SELECT name, ok FROM ${s.dialect.qualified(schema, 'rt')} WHERE ${s.dialect.quote('_id')} = '${oid(4).toHexString()}'`))
  expect(viaFile.rows[0].name).toBe('order 4')
  expect([true, 1]).toContain(viaFile.rows[0].ok)

  const again = await toSql({ collections: colls, target: { kind: 'connection', sqlConnId: conn.id }, mode: 'truncate' })
  expect(again.state, again.error).toBe('done')

  const src = await m.defaultSource(conn.id, { schema, table: 'rt' })
  const items = src.embeds.find((e) => e.table === 'rt_items')!
  items.include = true
  items.field = 'items'
  items.columns = items.columns.map((c) => ({ ...c, include: c.column === 'sku' || c.column === 'n' }))
  const back = await fromSql({ sqlConnId: conn.id, sources: [{ ...src, collection: 'rt_back' }], batchSize: 8 })
  expect(back.state, back.error).toBe('done')
  const docs = await all('rt_back')
  expect(docs).toHaveLength(30)
  const d = docs[2]
  expect(d._id).toEqual(oid(3))
  expect(d).toMatchObject({ name: 'order 3', qty: new Int32(3), ok: false, at: new Date(Date.UTC(2024, 0, 1, 0, 0, 3)), ratio: new Double(3.5), address_city: 'c0' })
  expect(String(d.big)).toBe('9007199254740993')
  expect(Number(String(d.price))).toBe(12.5)
  expect(d.bin).toEqual(new Binary(Buffer.from([3])))
  const its = (d.items as Doc[]).sort((a, b) => Number(String(a.n)) - Number(String(b.n)))
  expect(its).toEqual([
    { sku: 's0', n: new Int32(0) },
    { sku: 's1', n: new Int32(1) },
    { sku: 's2', n: new Int32(2) }
  ])
}

function dockerSuite(name: string, image: string, port: number, env: string[], cfg: (p: number) => Partial<SqlConnectionConfig>, setup?: (c: SqlConnectionConfig) => Promise<SqlConnectionConfig>): void {
  describe.skipIf(!docker)(`${name} (Docker)`, () => {
    let container = ''
    let config: SqlConnectionConfig
    beforeAll(async () => {
      container = dockerRun(['run', '--rm', '-d', '-p', `127.0.0.1:0:${port}`, ...env.flatMap((e) => ['-e', e]), image])
      config = { ...newSqlConnection(cfg(0).dialect), ...cfg(hostPort(container, port)) }
      await waitReady(config)
      if (setup) config = await setup(config)
    }, 600000)
    afterAll(() => {
      if (container) spawnSync('docker', ['rm', '-f', container], { timeout: 60000 })
    })
    it('round-trips MongoDB → SQL → MongoDB', () => roundTrip(config), 180000)
  })
}

dockerSuite('PostgreSQL', 'postgres:16-alpine', 5432, ['POSTGRES_PASSWORD=pw'], (p) => ({ dialect: 'postgres', host: '127.0.0.1', port: p, user: 'postgres', password: 'pw', database: 'postgres', name: 'pg' }))

dockerSuite('MySQL', 'mysql:8.4', 3306, ['MYSQL_ROOT_PASSWORD=pw', 'MYSQL_DATABASE=test'], (p) => ({ dialect: 'mysql', host: '127.0.0.1', port: p, user: 'root', password: 'pw', database: 'test', name: 'my' }))

dockerSuite(
  'SQL Server',
  'mcr.microsoft.com/mssql/server:2022-latest',
  1433,
  ['ACCEPT_EULA=Y', 'MSSQL_SA_PASSWORD=Str0ng!Passw0rd'],
  (p) => ({ dialect: 'mssql', host: '127.0.0.1', port: p, user: 'sa', password: 'Str0ng!Passw0rd', database: 'master', name: 'ms' }),
  async (c) => {
    const id = (await saveConn(c)).id
    await m.withSession(id, (s) => s.exec('CREATE DATABASE mgtest'))
    await m.deleteConnection(id)
    return { ...c, database: 'mgtest' }
  }
)
