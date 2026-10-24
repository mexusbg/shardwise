import { describe, expect, it } from 'vitest'
import { Binary, Decimal128, Double, Int32, Long, ObjectId, Timestamp } from 'bson'
import { getDialect, DIALECTS } from '../src/main/sql/dialects'
import {
  ConversionError,
  createTableSql,
  insertLiteralSql,
  insertSql,
  kindOfSqlType,
  parseSqlDate,
  rowsPerInsert,
  sanitizeName,
  setPath,
  toBson,
  toSqlValue,
  uniqueName
} from '../src/main/sql/dialects/common'
import { extractDoc, inferCollection, newExtractStats, planCollections } from '../src/main/sql/mongoToSql'
import { inferMissingTypes, keyQueries, rowToDoc } from '../src/main/sql/sqlToMongo'
import type { PlannedTable } from '@shared/migrationApi'

const pg = getDialect('postgres')
const my = getDialect('mysql')
const ms = getDialect('mssql')
const lite = getDialect('sqlite')

describe('identifiers', () => {
  it('quotes per dialect, escaping the quote character', () => {
    expect(pg.quote('a"b')).toBe('"a""b"')
    expect(my.quote('a`b')).toBe('`a``b`')
    expect(ms.quote('a]b')).toBe('[a]]b]')
    expect(lite.quote('order')).toBe('"order"')
  })
  it('qualifies with a schema only when given', () => {
    expect(pg.qualified('public', 't')).toBe('"public"."t"')
    expect(ms.qualified('dbo', 't')).toBe('[dbo].[t]')
    expect(my.qualified('', 't')).toBe('`t`')
  })
  it('sanitizes and deduplicates names within the identifier limit', () => {
    expect(sanitizeName('my.coll name')).toBe('my_coll_name')
    expect(sanitizeName('_id')).toBe('_id')
    const used = new Set<string>()
    expect(uniqueName('value', used, 63)).toBe('value')
    expect(uniqueName('Value', used, 63)).toBe('Value_2')
    expect(uniqueName('x'.repeat(70), used, 63)).toHaveLength(63)
    expect(uniqueName('x'.repeat(70), used, 63)).toBe(`${'x'.repeat(61)}_2`)
  })
  it('placeholders', () => {
    expect([pg.placeholder(3), my.placeholder(3), ms.placeholder(3), lite.placeholder(3)]).toEqual(['$3', '?', '@p3', '?'])
  })
})

describe('type mapping BSON → SQL', () => {
  const table: [string, string, string, string, string][] = [
    ['string', 'TEXT', 'TEXT', 'NVARCHAR(MAX)', 'TEXT'],
    ['int', 'INTEGER', 'INT', 'INT', 'INTEGER'],
    ['long', 'BIGINT', 'BIGINT', 'BIGINT', 'BIGINT'],
    ['double', 'DOUBLE PRECISION', 'DOUBLE', 'FLOAT', 'REAL'],
    ['decimal', 'NUMERIC(38,10)', 'DECIMAL(38,10)', 'DECIMAL(38,10)', 'NUMERIC'],
    ['bool', 'BOOLEAN', 'TINYINT(1)', 'BIT', 'BOOLEAN'],
    ['date', 'TIMESTAMP(3) WITH TIME ZONE', 'DATETIME(3)', 'DATETIME2(3)', 'DATETIME'],
    ['objectId', 'CHAR(24)', 'CHAR(24)', 'VARCHAR(24)', 'CHAR(24)'],
    ['binary', 'BYTEA', 'LONGBLOB', 'VARBINARY(MAX)', 'BLOB'],
    ['object', 'JSONB', 'JSON', 'NVARCHAR(MAX)', 'JSON'],
    ['array', 'JSONB', 'JSON', 'NVARCHAR(MAX)', 'JSON']
  ]
  it.each(table)('%s', (bson, p, m, s, l) => {
    expect(pg.typeFor(bson as never)).toBe(p)
    expect(my.typeFor(bson as never)).toBe(m)
    expect(ms.typeFor(bson as never)).toBe(s)
    expect(lite.typeFor(bson as never)).toBe(l)
  })
  it('uses indexable types for keys', () => {
    expect(my.typeFor('string', { key: true })).toBe('VARCHAR(255)')
    expect(ms.typeFor('string', { key: true })).toBe('NVARCHAR(450)')
    expect(ms.typeFor('binary', { key: true })).toBe('VARBINARY(900)')
    expect(pg.typeFor('string', { key: true })).toBe('TEXT')
    expect(my.typeFor('string', { maxLen: 20000 })).toBe('LONGTEXT')
  })
  it('reads the kind of declared SQL types', () => {
    const cases: [string, string][] = [
      ['integer', 'int'],
      ['INT', 'int'],
      ['smallint', 'int'],
      ['bigint', 'long'],
      ['BIGINT', 'long'],
      ['numeric(10,2)', 'decimal'],
      ['DECIMAL(38,10)', 'decimal'],
      ['double precision', 'double'],
      ['FLOAT', 'double'],
      ['real', 'double'],
      ['boolean', 'bool'],
      ['tinyint(1)', 'bool'],
      ['BIT', 'bool'],
      ['timestamp with time zone', 'date'],
      ['DATETIME2(3)', 'date'],
      ['datetime', 'date'],
      ['date', 'date'],
      ['bytea', 'binary'],
      ['LONGBLOB', 'binary'],
      ['varbinary(max)', 'binary'],
      ['jsonb', 'json'],
      ['uuid', 'uuid'],
      ['UNIQUEIDENTIFIER', 'uuid'],
      ['character(24)', 'objectId'],
      ['VARCHAR(24)', 'objectId'],
      ['text', 'string'],
      ['nvarchar(max)', 'string'],
      ['time', 'string']
    ]
    for (const [t, k] of cases) expect(kindOfSqlType(t), t).toBe(k)
  })
})

describe('batched inserts', () => {
  it('respects parameter and row limits', () => {
    expect(rowsPerInsert(ms, 3)).toBe(666)
    expect(rowsPerInsert(ms, 10)).toBe(200)
    expect(rowsPerInsert(ms, 1)).toBe(1000)
    expect(rowsPerInsert(ms, 3000)).toBe(1)
    expect(rowsPerInsert(pg, 100)).toBe(655)
    expect(rowsPerInsert(pg, 2)).toBe(1000)
    expect(rowsPerInsert(lite, 2)).toBe(500)
    expect(rowsPerInsert(lite, 100)).toBe(327)
    for (const d of Object.values(DIALECTS)) for (const cols of [1, 7, 33, 250]) expect(rowsPerInsert(d, cols) * cols).toBeLessThanOrEqual(d.maxParams)
  })
  it('numbers placeholders across rows', () => {
    expect(insertSql(pg, '"t"', ['a', 'b'], 2)).toBe('INSERT INTO "t" ("a", "b") VALUES ($1, $2), ($3, $4)')
    expect(insertSql(ms, '[t]', ['a'], 3)).toBe('INSERT INTO [t] ([a]) VALUES (@p1), (@p2), (@p3)')
    expect(insertSql(my, '`t`', ['a', 'b'], 1)).toBe('INSERT INTO `t` (`a`, `b`) VALUES (?, ?)')
  })
  it('writes literal inserts', () => {
    const d = new Date('2024-05-06T07:08:09.123Z')
    const row = [`it's`, 5n, true, d, Buffer.from([1, 255]), '12.50', null]
    const kinds = ['string', 'long', 'bool', 'date', 'binary', 'decimal', 'string'] as const
    const cols = ['s', 'l', 'b', 'd', 'x', 'n', 'z']
    expect(insertLiteralSql(pg, '"t"', cols, [...kinds], [row as never])).toContain(`('it''s', 5, TRUE, '2024-05-06T07:08:09.123Z', '\\x01ff', 12.50, NULL)`)
    expect(insertLiteralSql(my, '`t`', cols, [...kinds], [row as never])).toContain(`('it''s', 5, 1, '2024-05-06 07:08:09.123', X'01ff', 12.50, NULL)`)
    expect(insertLiteralSql(ms, '[t]', cols, [...kinds], [row as never])).toContain(`(N'it''s', 5, 1, '2024-05-06T07:08:09.123', 0x01ff, 12.50, NULL)`)
    expect(insertLiteralSql(lite, '"t"', cols, [...kinds], [row as never])).toContain(`('it''s', 5, 1, '2024-05-06T07:08:09.123Z', X'01ff', 12.50, NULL)`)
    expect(my.literal('a\\b', 'string')).toBe(`'a\\\\b'`)
    expect(pg.literal('a\0b', 'string')).toBe(`'ab'`)
    expect(pg.literal(NaN, 'double')).toBe('NULL')
  })
})

describe('DDL', () => {
  const child: PlannedTable = {
    id: 'x',
    name: 'orders_items',
    coll: 'orders',
    path: 'items',
    kind: 'documents',
    columns: [
      { name: 'orders_id', type: 'CHAR(24)', nullable: false, key: true, source: '(parent)' },
      { name: 'idx', type: 'INTEGER', nullable: false, key: true, source: '(index)' },
      { name: 'sku', type: 'TEXT', nullable: true, key: false, source: 'items.sku' }
    ],
    primaryKey: ['orders_id', 'idx'],
    foreignKey: { columns: ['orders_id'], table: 'orders', refColumns: ['_id'] }
  }
  it('creates tables with primary and foreign keys', () => {
    expect(createTableSql(pg, 'public', child)).toBe(
      'CREATE TABLE "public"."orders_items" (\n  "orders_id" CHAR(24) NOT NULL,\n  "idx" INTEGER NOT NULL,\n  "sku" TEXT,\n  PRIMARY KEY ("orders_id", "idx"),\n  FOREIGN KEY ("orders_id") REFERENCES "public"."orders" ("_id")\n)'
    )
    expect(createTableSql(ms, 'dbo', child)).toContain('FOREIGN KEY ([orders_id]) REFERENCES [dbo].[orders] ([_id])')
  })
  it('creates when missing / drops / empties per dialect', () => {
    const c = createTableSql(lite, '', child)
    expect(lite.createIfMissing('"orders_items"', '', 'orders_items', c)).toMatch(/^CREATE TABLE IF NOT EXISTS "orders_items"/)
    expect(ms.createIfMissing('[dbo].[t]', 'dbo', 't', 'CREATE TABLE [dbo].[t] (x INT)')).toBe(`IF OBJECT_ID(N'[dbo].[t]', N'U') IS NULL\nCREATE TABLE [dbo].[t] (x INT)`)
    expect(pg.dropTable('"t"')).toBe('DROP TABLE IF EXISTS "t" CASCADE')
    expect(pg.emptyTables(['"a"', '"b"'])).toEqual(['TRUNCATE TABLE "a", "b"'])
    expect(my.emptyTables(['`a`', '`b`'])).toEqual(['DELETE FROM `a`', 'DELETE FROM `b`'])
    expect(ms.limit('SELECT 1 AS a', 5)).toBe('SELECT TOP (5) * FROM (SELECT 1 AS a) AS q')
  })
})

describe('BSON → SQL values', () => {
  const oid = new ObjectId('65a1b2c3d4e5f60718293a4b')
  it('keeps matching types', () => {
    expect(toSqlValue('x', 'string')).toEqual({ value: 'x', converted: false, lost: false })
    expect(toSqlValue(new Int32(5), 'int').value).toBe(5)
    expect(toSqlValue(Long.fromString('9007199254740993'), 'long').value).toBe(9007199254740993n)
    expect(toSqlValue(new Double(1.5), 'double').value).toBe(1.5)
    expect(toSqlValue(Decimal128.fromString('12.345'), 'decimal').value).toBe('12.345')
    expect(toSqlValue(oid, 'objectId').value).toBe('65a1b2c3d4e5f60718293a4b')
    expect(toSqlValue(new Binary(Buffer.from('hi')), 'binary').value).toEqual(Buffer.from('hi'))
    expect(toSqlValue(null, 'int')).toEqual({ value: null, converted: false, lost: false })
  })
  it('converts other types and reports what it could not convert', () => {
    expect(toSqlValue(new Double(3), 'int')).toEqual({ value: 3, converted: false, lost: false })
    expect(toSqlValue(new Double(3.7), 'int')).toEqual({ value: 3, converted: true, lost: false })
    expect(toSqlValue('42', 'int')).toEqual({ value: 42, converted: true, lost: false })
    expect(toSqlValue('abc', 'int')).toEqual({ value: null, converted: false, lost: true })
    expect(toSqlValue(Long.fromString('99999999999'), 'int').lost).toBe(true)
    expect(toSqlValue(new Int32(7), 'string')).toEqual({ value: '7', converted: true, lost: false })
    expect(toSqlValue(oid, 'string').value).toBe('65a1b2c3d4e5f60718293a4b')
    expect(toSqlValue('2024-01-02T03:04:05Z', 'date').value).toEqual(new Date('2024-01-02T03:04:05Z'))
    expect(toSqlValue(new Timestamp({ t: 1700000000, i: 1 }), 'date').value).toEqual(new Date(1700000000 * 1000))
    expect(toSqlValue('yes', 'bool').value).toBe(true)
    expect(toSqlValue(new Int32(0), 'bool').value).toBe(false)
    expect(toSqlValue({ a: 1, id: oid }, 'json').value).toBe('{"a":1,"id":{"$oid":"65a1b2c3d4e5f60718293a4b"}}')
    expect(toSqlValue({ a: 1 }, 'string').value).toBe('{"a":1}')
    expect(toSqlValue(new Date('2024-01-01T00:00:00Z'), 'string').value).toBe('2024-01-01T00:00:00.000Z')
    const uuid = new Binary(Buffer.from('0123456789abcdef0123456789abcdef', 'hex'), Binary.SUBTYPE_UUID)
    expect(toSqlValue(uuid, 'uuid').value).toBe('01234567-89ab-cdef-0123-456789abcdef')
    expect(toSqlValue(uuid, 'string').value).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })
})

describe('SQL → BSON values', () => {
  it('converts by declared type', () => {
    expect(toBson(5n, 'bigint', 'auto')).toEqual(Long.fromNumber(5))
    expect(toBson(5n, 'INTEGER', 'auto')).toEqual(new Int32(5))
    expect(toBson(9999999999n, 'INTEGER', 'auto')).toEqual(Long.fromNumber(9999999999))
    expect(toBson('123456789012345', 'bigint', 'auto')).toEqual(Long.fromString('123456789012345'))
    expect(toBson('12.50', 'numeric(10,2)', 'auto')).toEqual(Decimal128.fromString('12.50'))
    expect(toBson(1.5, 'double precision', 'auto')).toEqual(new Double(1.5))
    expect(toBson(1, 'tinyint(1)', 'auto')).toBe(true)
    expect(toBson(0n, 'BOOLEAN', 'auto')).toBe(false)
    expect(toBson('2024-01-02 03:04:05.678', 'datetime(3)', 'auto')).toEqual(new Date('2024-01-02T03:04:05.678Z'))
    expect(toBson('2024-01-02', 'date', 'auto')).toEqual(new Date('2024-01-02T00:00:00Z'))
    expect(toBson('65a1b2c3d4e5f60718293a4b', 'character(24)', 'auto')).toEqual(new ObjectId('65a1b2c3d4e5f60718293a4b'))
    expect(toBson('not-an-id-but-24-chars!!', 'character(24)', 'auto')).toBe('not-an-id-but-24-chars!!')
    expect(toBson('{"a":{"$oid":"65a1b2c3d4e5f60718293a4b"},"n":[1,2]}', 'JSON', 'auto')).toEqual({ a: new ObjectId('65a1b2c3d4e5f60718293a4b'), n: [1, 2] })
    expect(toBson({ x: 1 }, 'jsonb', 'auto')).toEqual({ x: 1 })
    expect(toBson(Buffer.from('hi'), 'bytea', 'auto')).toEqual(new Binary(Buffer.from('hi')))
    expect(toBson(new Date(5), undefined, 'auto')).toEqual(new Date(5))
    expect(toBson(null, 'int', 'auto')).toBeNull()
  })
  it('guesses without a declared type', () => {
    expect(toBson(7, undefined, 'auto')).toEqual(new Int32(7))
    expect(toBson(7.5, undefined, 'auto')).toEqual(new Double(7.5))
    expect(toBson(2 ** 40, undefined, 'auto')).toEqual(Long.fromNumber(2 ** 40))
    expect(toBson('x', undefined, 'auto')).toBe('x')
  })
  it('applies explicit conversions', () => {
    expect(toBson('42', 'text', 'int')).toEqual(new Int32(42))
    expect(toBson('42', 'text', 'long')).toEqual(Long.fromNumber(42))
    expect(toBson('4.2', 'text', 'double')).toEqual(new Double(4.2))
    expect(toBson(4.25, 'float', 'decimal')).toEqual(Decimal128.fromString('4.25'))
    expect(toBson('t', 'text', 'bool')).toBe(true)
    expect(toBson('2024-03-04T05:06:07+02:00', 'text', 'date')).toEqual(new Date('2024-03-04T03:06:07Z'))
    expect(toBson(12, 'int', 'string')).toBe('12')
    expect(toBson('0123456789abcdef0123456789abcdef', 'text', 'uuid')).toEqual(new Binary(Buffer.from('0123456789abcdef0123456789abcdef', 'hex'), Binary.SUBTYPE_UUID))
    expect(() => toBson('abc', 'text', 'int')).toThrow(ConversionError)
    expect(() => toBson('abc', 'text', 'objectId')).toThrow(ConversionError)
    expect(() => toBson('{bad', 'text', 'json')).toThrow(ConversionError)
  })
  it('parses SQL dates as UTC', () => {
    expect(parseSqlDate('2024-01-02 03:04:05')).toEqual(new Date('2024-01-02T03:04:05Z'))
    expect(parseSqlDate('2024-01-02 03:04:05.123456+02')).toEqual(new Date('2024-01-02T01:04:05.123Z'))
    expect(parseSqlDate('nope')).toBeUndefined()
  })
  it('builds nested documents from dotted fields', () => {
    const d: Record<string, unknown> = {}
    setPath(d, 'a.b', 1)
    setPath(d, 'a.c', 2)
    expect(d).toEqual({ a: { b: 1, c: 2 } })
    const doc = rowToDoc({ id: 1n, city: 'Rome', bad: 'x' }, [
      { column: 'id', field: '_id', include: true, convert: 'auto', type: 'integer' },
      { column: 'city', field: 'address.city', include: true, convert: 'auto' },
      { column: 'bad', field: 'n', include: true, convert: 'int' }
    ], () => {})
    expect(doc).toEqual({ _id: new Int32(1), address: { city: 'Rome' }, n: null })
  })
  it('treats untyped numeric columns with fractions as Double', () => {
    const cols = inferMissingTypes(
      [
        { column: 'a', field: 'a', include: true, convert: 'auto' },
        { column: 'b', field: 'b', include: true, convert: 'auto' },
        { column: 'c', field: 'c', include: true, convert: 'auto', type: 'integer' }
      ],
      [{ a: 2, b: 3, c: 1.5 }, { a: 2.5, b: 4, c: 1 }]
    )
    expect(cols.map((c) => c.type)).toEqual(['double precision', undefined, 'integer'])
    expect(toBson(2, cols[0].type, 'auto')).toEqual(new Double(2))
  })
  it('splits key lookups by the parameter limit', () => {
    const keys = Array.from({ length: 2500 }, (_, i) => [i, `k${i}`])
    const qs = keyQueries(ms, 'dbo', 'child', ['a', 'b'], keys)
    expect(qs).toHaveLength(3)
    expect(qs[0].params).toHaveLength(2000)
    expect(qs[0].sql).toMatch(/^SELECT \* FROM \[dbo\]\.\[child\] WHERE \(\[a\] = @p1 AND \[b\] = @p2\) OR/)
    const single = keyQueries(pg, 'public', 'c', ['id'], [[1], [2]])
    expect(single[0].sql).toBe('SELECT * FROM "public"."c" WHERE "id" IN ($1, $2)')
  })
})

describe('relational mapping', () => {
  const oid = (i: number): ObjectId => new ObjectId(i.toString(16).padStart(24, '0'))
  const docs = [
    { _id: oid(1), name: 'a', qty: new Int32(1), address: { city: 'Rome', geo: { lat: new Double(1.5) } }, tags: ['x', 'y'], items: [{ sku: 'p', n: new Int32(2) }] },
    { _id: oid(2), name: 'b', qty: 'many', address: { city: 'Paris' }, tags: [], items: [{ sku: 'q', n: new Int32(1), opts: ['red'] }, 'junk'] }
  ]
  it('infers fields, dominant types and mixed counts', () => {
    const c = inferCollection('orders', docs)
    expect(c.fields.map((f) => f.name)).toEqual(['_id', 'name', 'qty', 'address', 'tags', 'items'])
    const qty = c.fields.find((f) => f.name === 'qty')!
    expect([qty.bson, qty.mixed]).toEqual(['int', 1])
    const address = c.fields.find((f) => f.name === 'address')!
    expect([address.kind, address.mode]).toEqual(['object', 'flatten'])
    const tags = c.fields.find((f) => f.name === 'tags')!
    expect([tags.kind, tags.bson, tags.mode]).toEqual(['array', 'string', 'table'])
    const items = c.fields.find((f) => f.name === 'items')!
    expect([items.kind, items.bson, items.mixed]).toEqual(['array', 'object', 1])
    expect(items.fields!.map((f) => f.name)).toEqual(['sku', 'n', 'opts'])
  })
  it('plans flattened columns and child tables with keys', () => {
    const c = inferCollection('orders', docs)
    c.fields.find((f) => f.name === 'items')!.fields!.find((f) => f.name === 'opts')!.mode = 'table'
    const [plan] = planCollections([c], pg)
    expect(plan.tables.map((t) => t.name)).toEqual(['orders', 'orders_tags', 'orders_items', 'orders_items_opts'])
    const [root, tags, items, opts] = plan.tables
    expect(root.columns.map((x) => `${x.name} ${x.type}`)).toEqual(['_id CHAR(24)', 'name TEXT', 'qty INTEGER', 'address_city TEXT', 'address_geo_lat DOUBLE PRECISION'])
    expect(tags.columns.map((x) => x.name)).toEqual(['orders_id', 'idx', 'value'])
    expect(tags.foreignKey).toEqual({ columns: ['orders_id'], table: 'orders', refColumns: ['_id'] })
    expect(items.primaryKey).toEqual(['orders_id', 'idx'])
    expect(opts.columns.map((x) => x.name)).toEqual(['orders_id', 'orders_items_idx', 'idx', 'value'])
    expect(opts.foreignKey).toEqual({ columns: ['orders_id', 'orders_items_idx'], table: 'orders_items', refColumns: ['orders_id', 'idx'] })
    expect(plan.autoTypes['address.geo.lat']).toBe('DOUBLE PRECISION')

    const stats = newExtractStats()
    const rows: Record<string, unknown[][]> = {}
    for (const d of docs) extractDoc(d, plan.root, (t, r) => (rows[t.name] ??= []).push(r), stats)
    expect(rows.orders).toEqual([
      ['000000000000000000000001', 'a', 1, 'Rome', 1.5],
      ['000000000000000000000002', 'b', null, 'Paris', null]
    ])
    expect(rows.orders_tags).toEqual([
      ['000000000000000000000001', 0, 'x'],
      ['000000000000000000000001', 1, 'y']
    ])
    expect(rows.orders_items_opts).toEqual([['000000000000000000000002', 0, 0, 'red']])
    expect(stats.lost.get('orders.qty')).toBe(1)
    expect(stats.skipped.get('orders_items')).toBe(1)
  })
  it('honours JSON mode, 1:1 tables, renames, type overrides and exclusions', () => {
    const c = inferCollection('orders', docs)
    const f = (n: string): NonNullable<typeof c.fields>[number] => c.fields.find((x) => x.name === n)!
    f('address').mode = 'table'
    f('address').fields!.find((x) => x.name === 'geo')!.mode = 'json'
    f('tags').mode = 'json'
    f('items').include = false
    f('name').column = 'title'
    f('qty').sqlType = 'TEXT'
    c.table = 'o'
    const [plan] = planCollections([c], my)
    expect(plan.tables.map((t) => t.name)).toEqual(['o', 'o_address'])
    expect(plan.tables[0].columns.map((x) => `${x.name} ${x.type}`)).toEqual(['_id CHAR(24)', 'title TEXT', 'qty TEXT', 'tags JSON'])
    expect(plan.tables[1].columns.map((x) => `${x.name} ${x.type}`)).toEqual(['o_id CHAR(24)', 'city TEXT', 'geo JSON'])
    expect(plan.tables[1].primaryKey).toEqual(['o_id'])
    const rows: Record<string, unknown[][]> = {}
    for (const d of docs) extractDoc(d, plan.root, (t, r) => (rows[t.name] ??= []).push(r), newExtractStats())
    expect(rows.o[1]).toEqual(['000000000000000000000002', 'b', 'many', '[]'])
    expect(rows.o_address[0]).toEqual(['000000000000000000000001', 'Rome', '{"lat":1.5}'])
  })
})

describe('map-like objects (keys that differ per document)', () => {
  const hex = (n: number): string => n.toString(16).padStart(24, '0')
  // perms: { <user id>: { read, write } } with new ids in every document; settings: the same 60 keys everywhere.
  const settings = Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`opt${k}`, k]))
  const docs = Array.from({ length: 200 }, (_, i) => ({
    _id: new ObjectId(hex(i + 1)),
    role: 'r',
    perms: Object.fromEntries(Array.from({ length: 5 }, (_, k) => [hex(i * 5 + k + 1000), { read: true, write: false }])),
    acl: [{ [hex(i + 5000)]: 1 }, { [hex(i + 9000)]: 2 }],
    settings
  }))

  it('keeps a map keyed by ids as one JSON column instead of a field per key', () => {
    const c = inferCollection('roles', docs)
    const perms = c.fields.find((f) => f.name === 'perms')!
    expect([perms.kind, perms.mode, perms.fields?.length ?? 0, perms.distinctKeys]).toEqual(['object', 'json', 0, 1000])
    const acl = c.fields.find((f) => f.name === 'acl')!
    expect([acl.kind, acl.bson, acl.mode, acl.fields?.length ?? 0, acl.distinctKeys]).toEqual(['array', 'object', 'json', 0, 400])
    const [plan] = planCollections([c], pg)
    expect(plan.root.columns.map((x) => x.name).filter((n) => !n.startsWith('settings_'))).toEqual(['_id', 'role', 'perms', 'acl'])
  })

  it('still flattens a wide object whose keys repeat in every document', () => {
    const settingsField = inferCollection('roles', docs).fields.find((f) => f.name === 'settings')!
    expect([settingsField.mode, settingsField.fields?.length, settingsField.distinctKeys]).toEqual(['flatten', 60, undefined])
  })
})

describe('documents whose top-level keys differ', () => {
  const hex = (n: number): string => n.toString(16).padStart(24, '0')
  const docs = Array.from({ length: 100 }, (_, i) => ({
    _id: new ObjectId(hex(i + 1)),
    role: `r${i}`,
    ...Object.fromEntries(Array.from({ length: 3 }, (_, k) => [`k_${hex(i * 3 + k)}`, new Int32(k)]))
  }))

  it('keeps the common keys as columns and stores the rest in one JSON column', () => {
    const c = inferCollection('wide', docs)
    expect(c.fields.map((f) => f.name)).toEqual(['_id', 'role', '*'])
    const rest = c.fields[2]
    expect([rest.rest, rest.mode, rest.distinctKeys, rest.column]).toEqual([true, 'json', 300, 'other_fields'])
    const [plan] = planCollections([c], pg)
    expect(plan.root.columns.map((x) => x.name)).toEqual(['_id', 'role', 'other_fields'])
    const rows: unknown[][] = []
    extractDoc(docs[1], plan.root, (_t, r) => rows.push(r), newExtractStats())
    expect(rows[0].slice(0, 2)).toEqual([hex(2), 'r1'])
    expect(JSON.parse(rows[0][2] as string)).toEqual({ [`k_${hex(3)}`]: 0, [`k_${hex(4)}`]: 1, [`k_${hex(5)}`]: 2 })
  })

  it('leaves excluded common keys out of the JSON column too', () => {
    const c = inferCollection('wide', docs)
    c.fields.find((f) => f.name === 'role')!.include = false
    const [plan] = planCollections([c], pg)
    const rows: unknown[][] = []
    extractDoc(docs[0], plan.root, (_t, r) => rows.push(r), newExtractStats())
    expect(plan.root.columns.map((x) => x.name)).toEqual(['_id', 'other_fields'])
    expect(Object.keys(JSON.parse(rows[0][1] as string))).toHaveLength(3)
  })
})
