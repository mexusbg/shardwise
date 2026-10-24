import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Binary, BSONRegExp, Code, Decimal128, Double, EJSON, Int32, Long, MaxKey, MinKey, ObjectId, serialize, Timestamp, UUID } from 'bson'
import type { Doc, JsonFlavor } from '@shared/api'
import { DocSplitter, formatDoc, JsonLayout, parseDocText, parseShellDoc, splitDocs, toPure } from '../src/main/transfer/jsonFormat'
import { autoValue, convertCell, convertText, csvCell, OMIT, plainCell, rowToDoc, sheetName, xlsxCell } from '../src/main/transfer/tabular'
import { columnIndex, excelDate, isDateFormat } from '../src/main/transfer/xlsxRead'
import { compareVersions, parseOsRelease, pickToolsDownload, platformCandidates } from '../src/main/transfer/toolsDownload'
import type { ToolsFeed } from '../src/main/transfer/toolsDownload'
import { archiveNamespaces, dumpArgs, dumpFolderLayout, nsEscape, parseToolLine, parseToolVersion, restoreArgs, toolConfigYaml, viaLocalPort } from '../src/main/transfer/bsonTools'
import { buildUri, newConnectionConfig, parseUri } from '@shared/connection'

const canon = (v: unknown): string => EJSON.stringify(v as never, { relaxed: false })

/** A document with every interesting BSON type. */
function richDoc(): Doc {
  return {
    _id: new ObjectId('650000000000000000000001'),
    d: new Date('2024-01-02T03:04:05.678Z'),
    i: new Int32(42),
    negInt: new Int32(-7),
    l: Long.fromString('9007199254740993'),
    smallLong: Long.fromNumber(5),
    dbl: new Double(1),
    dbl2: new Double(2.5),
    tiny: new Double(1e-7),
    dec: Decimal128.fromString('1.50'),
    s: 'he said "hi"\n{not a brace}',
    nested: { a: { b: 'x', c: new Int32(1) }, arr: [] },
    arr: [new Int32(1), 'two', { three: new Double(3.5) }, [new Int32(4)]],
    empty: {},
    nul: null,
    bool: true,
    re: new BSONRegExp('^a.c/d{2}"$', 'i'),
    bin: new Binary(Buffer.from('hello'), 0),
    uuid: new UUID('0f8fad5b-d9cb-469f-a165-70867728950e').toBinary(),
    ts: new Timestamp({ t: 1700000000, i: 3 }),
    code: new Code('function () { return "}" }'),
    minK: new MinKey(),
    maxK: new MaxKey()
  }
}

describe('JSON formatters', () => {
  it('shell flavour uses constructors and double-quoted keys', () => {
    const s = formatDoc(richDoc(), 'shell')
    expect(s.startsWith('{"_id": ObjectId("650000000000000000000001"), "d": ISODate("2024-01-02T03:04:05.678Z")')).toBe(true)
    expect(s).toContain('"i": NumberInt(42)')
    expect(s).toContain('"l": NumberLong("9007199254740993")')
    expect(s).toContain('"dec": NumberDecimal("1.50")')
    expect(s).toContain('"dbl": 1.0')
    expect(s).toContain('"dbl2": 2.5')
    expect(s).toContain('"re": /^a.c\\/d{2}"$/i')
    expect(s).toContain('"bin": BinData(0, "aGVsbG8=")')
    expect(s).toContain('"uuid": UUID("0f8fad5b-d9cb-469f-a165-70867728950e")')
    expect(s).toContain('"ts": Timestamp({ t: 1700000000, i: 3 })')
    expect(s).not.toContain('\n')
  })

  it('legacy shell flavour has spaces around colons', () => {
    const s = formatDoc({ _id: new ObjectId('650000000000000000000001'), n: Long.fromNumber(5), d: new Date(0) }, 'legacyShell')
    expect(s).toBe('{ "_id" : ObjectId("650000000000000000000001"), "n" : NumberLong(5), "d" : ISODate("1970-01-01T00:00:00.000Z") }')
    const pretty = formatDoc({ a: new Int32(1), b: [new Int32(2)] }, 'legacyShell', true)
    expect(pretty).toBe('{\n\t"a" : NumberInt(1),\n\t"b" : [\n\t\tNumberInt(2)\n\t]\n}')
  })

  it('canonical and relaxed flavours are EJSON', () => {
    const doc = richDoc()
    expect(formatDoc(doc, 'canonical')).toBe(EJSON.stringify(doc as never, { relaxed: false }))
    expect(formatDoc(doc, 'relaxed')).toBe(EJSON.stringify(doc as never, { relaxed: true }))
    expect(formatDoc({ a: new Int32(1) }, 'canonical', true)).toBe('{\n  "a": {\n    "$numberInt": "1"\n  }\n}')
  })

  it('pure flavour drops types', () => {
    const p = JSON.parse(formatDoc(richDoc(), 'pure')) as Doc
    expect(p._id).toBe('650000000000000000000001')
    expect(p.d).toBe('2024-01-02T03:04:05.678Z')
    expect(p.i).toBe(42)
    expect(p.l).toBe('9007199254740993')
    expect(p.smallLong).toBe(5)
    expect(p.dbl).toBe(1)
    expect(p.dec).toBe(1.5)
    expect(p.bin).toBe('aGVsbG8=')
    expect(p.uuid).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(p.re).toBe('/^a.c/d{2}"$/i')
    expect(p.nul).toBeNull()
    expect(p.nested).toEqual({ a: { b: 'x', c: 1 }, arr: [] })
    expect(toPure(new Double(NaN))).toBeNull()
  })

  it.each(['shell', 'legacyShell', 'canonical'] as JsonFlavor[])('%s round-trips every type (compact and pretty)', (flavor) => {
    for (const pretty of [false, true]) {
      const doc = richDoc()
      const text = formatDoc(doc, flavor, pretty)
      const back = parseDocText(text).doc
      expect(canon(back)).toBe(canon(doc))
    }
  })

  it('relaxed keeps ObjectId, Date, strings, Int32 and non-integral doubles', () => {
    const doc = { _id: new ObjectId(), d: new Date('2020-05-05T00:00:00Z'), i: new Int32(3), x: new Double(2.5), s: 'q' }
    const back = parseDocText(formatDoc(doc, 'relaxed')).doc
    expect(canon(back)).toBe(canon(doc))
  })

  it('JsonLayout writes arrays and lines', () => {
    for (const pretty of [false, true]) {
      const l = new JsonLayout('canonical', 'array', pretty)
      const text = l.start() + l.doc({ a: new Int32(1) }) + l.doc({ b: new Int32(2) }) + l.end()
      expect(JSON.parse(text)).toEqual([{ a: { $numberInt: '1' } }, { b: { $numberInt: '2' } }])
    }
    const empty = new JsonLayout('shell', 'array', false)
    expect(JSON.parse(empty.start() + empty.end())).toEqual([])
    const lines = new JsonLayout('shell', 'lines', false)
    expect(lines.start() + lines.doc({ a: 'x' }) + lines.doc({ b: 'y' }) + lines.end()).toBe('{"a": "x"}\n{"b": "y"}\n')
  })
})

describe('JSON import detection', () => {
  it('parses Studio 3T style shell text', () => {
    const text = `{
      "_id" : ObjectId("5f1a2b3c4d5e6f7a8b9c0d1e"),
      "n" : NumberInt(3), "l": NumberLong(12), "big": NumberLong("9223372036854775807"),
      "d" : ISODate("2020-01-01T00:00:00.000+0000"),
      'single': 'quoted', unquoted: true, "x": 1.0, "y": 7, "z": -Infinity,
      "r": /a\\/b/gi, "dec": NumberDecimal("0.1"), "dt": new Date(0), // comment
      "ts": Timestamp(5, 6), "ej": { "$oid": "5f1a2b3c4d5e6f7a8b9c0d1e" }, /* block */ "u": undefined,
    }`
    const d = parseShellDoc(text)
    expect((d._id as ObjectId).toHexString()).toBe('5f1a2b3c4d5e6f7a8b9c0d1e')
    expect((d.n as Int32)._bsontype).toBe('Int32')
    expect((d.l as Long)._bsontype).toBe('Long')
    expect((d.big as Long).toString()).toBe('9223372036854775807')
    expect((d.d as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z')
    expect(d.single).toBe('quoted')
    expect(d.unquoted).toBe(true)
    expect((d.x as Double)._bsontype).toBe('Double')
    expect((d.y as Int32)._bsontype).toBe('Int32')
    expect((d.z as Double).valueOf()).toBe(-Infinity)
    expect(d.r).toMatchObject({ pattern: 'a/b', options: 'i' })
    expect((d.dt as Date).getTime()).toBe(0)
    expect(d.ts).toMatchObject({ _bsontype: 'Timestamp' })
    expect((d.ej as ObjectId)._bsontype).toBe('ObjectId')
    expect('u' in d).toBe(true)
  })

  it('EJSON keeps Int32 / Long / Double for plain numbers', () => {
    const { doc, syntax } = parseDocText('{"a": 1, "b": 2.5, "c": 3000000000, "d": {"$date": "2020-01-01T00:00:00Z"}}')
    expect(syntax).toBe('ejson')
    expect((doc.a as Int32)._bsontype).toBe('Int32')
    expect((doc.b as Double)._bsontype).toBe('Double')
    expect((doc.c as Long)._bsontype).toBe('Long')
    expect(doc.d).toBeInstanceOf(Date)
  })

  it('reports shell syntax errors with a position', () => {
    expect(() => parseDocText('{"a": Foo(1)}')).toThrow(/Foo/)
    expect(() => parseDocText('{"a": ObjectId("zz")}')).toThrow(/ObjectId/)
  })
})

describe('DocSplitter', () => {
  const docs = [
    '{"a": "}{", "b": [1, {"c": "\\"]"}]}',
    "{ 'x': '{', r: /[}\\]]{2}\\//, y: { z: 1 } }",
    '{"_id" : ObjectId("650000000000000000000001"), "n" : 1 /* } */, "m": 2 // }\n}'
  ]

  it('splits lines, arrays, pretty and concatenated documents', () => {
    expect(splitDocs(docs.join('\n')).map((d) => d.text)).toEqual(docs)
    expect(splitDocs(`[\n${docs.join(',\n')}\n]`).map((d) => d.text)).toEqual(docs)
    expect(splitDocs(docs.join('')).map((d) => d.text)).toEqual(docs)
    expect(splitDocs('\uFEFF  [ ]  ')).toEqual([])
    const pretty = '{\n  "a": 1\n}\n{\n  "b": 2\n}\n'
    expect(splitDocs(pretty)).toEqual([
      { text: '{\n  "a": 1\n}', line: 1 },
      { text: '{\n  "b": 2\n}', line: 4 }
    ])
  })

  it('handles any chunk boundary', () => {
    const text = `[${docs.join(',')}]`
    for (const size of [1, 2, 3, 7, 13]) {
      const s = new DocSplitter()
      const out: string[] = []
      for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)).map((d) => d.text))
      s.end()
      expect(out).toEqual(docs)
    }
  })

  it('every split document parses', () => {
    for (const d of splitDocs(docs.join('\n'))) expect(() => parseDocText(d.text)).not.toThrow()
  })

  it('rejects broken input', () => {
    expect(() => splitDocs('{"a": 1')).toThrow(/end of file/)
    expect(() => splitDocs('[{"a": 1}')).toThrow(/\]/)
    expect(() => splitDocs('hello')).toThrow(/Unexpected/)
  })
})

describe('tabular values', () => {
  it('maps values to CSV text', () => {
    expect(csvCell('x')).toBe('x')
    expect(csvCell(new ObjectId('650000000000000000000001'))).toBe('650000000000000000000001')
    expect(csvCell(new Date('2024-01-02T00:00:00Z'))).toBe('2024-01-02T00:00:00.000Z')
    expect(csvCell(new Int32(5))).toBe('5')
    expect(csvCell(new Double(2.5))).toBe('2.5')
    expect(csvCell(Long.fromString('9007199254740993'))).toBe('9007199254740993')
    expect(csvCell(Decimal128.fromString('1.10'))).toBe('1.10')
    expect(csvCell(true)).toBe('true')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell({ a: new Int32(1), d: new Date(0) })).toBe('{"a":1,"d":{"$date":"1970-01-01T00:00:00Z"}}')
    expect(csvCell([new Int32(1), 'x'])).toBe('[1,"x"]')
  })

  it('maps values to Excel cells', () => {
    const d = new Date('2024-01-02T00:00:00Z')
    expect(xlsxCell(d)).toBe(d)
    expect(xlsxCell(new Int32(5))).toBe(5)
    expect(xlsxCell(Long.fromString('9007199254740993'))).toBe('9007199254740993')
    expect(xlsxCell(Long.fromNumber(12))).toBe(12)
    expect(xlsxCell(Decimal128.fromString('1.5'))).toBe(1.5)
    expect(xlsxCell(new ObjectId('650000000000000000000001'))).toBe('650000000000000000000001')
    expect(xlsxCell('x'.repeat(40000))).toHaveLength(32767)
    expect(xlsxCell(null)).toBeNull()
  })

  it('auto-detects CSV values', () => {
    expect(autoValue('42')).toMatchObject({ _bsontype: 'Int32' })
    expect((autoValue('4.5') as Double)._bsontype).toBe('Double')
    expect((autoValue('3000000000') as Double)._bsontype).toBe('Double')
    expect(autoValue('007')).toBe('007')
    expect(autoValue('true')).toBe(true)
    expect(autoValue('2024-01-02T03:04:05Z')).toEqual(new Date('2024-01-02T03:04:05Z'))
    expect(autoValue('hello')).toBe('hello')
    expect(canon(autoValue('{"a":1}'))).toBe('{"a":{"$numberInt":"1"}}')
    expect(convertText('', 'auto')).toBe(OMIT)
    expect(convertText('', 'string')).toBe('')
    expect(convertText('x', 'skip')).toBe(OMIT)
    expect((convertText('650000000000000000000001', 'objectId') as ObjectId).toHexString()).toBe('650000000000000000000001')
    expect(convertText('12', 'string')).toBe('12')
    expect(convertText('yes', 'bool')).toBe(true)
    expect(() => convertText('abc', 'number')).toThrow(/not a number/)
    expect(convertText('1700000000000', 'date')).toEqual(new Date(1700000000000))
  })

  it('converts Excel cells honouring their type', () => {
    expect(plainCell({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab')
    expect(plainCell({ formula: 'A1+1', result: 3 })).toBe(3)
    expect((convertCell(3, 'auto') as Int32)._bsontype).toBe('Int32')
    expect(convertCell('007', 'auto')).toBe('007')
    expect(convertCell(1, 'bool')).toBe(true)
    expect(convertCell(new Date(5), 'string')).toBe(new Date(5).toISOString())
    expect(convertCell(null, 'auto')).toBe(OMIT)
  })

  it('builds nested documents from dot-path headers', () => {
    const doc = rowToDoc(['_id', 'a.b', 'a.c', '', 'skip'], ['1', 'x', '2', 'ignored', 'y'], (cell, h) => (h === 'skip' ? OMIT : autoValue(cell)))
    expect(canon(doc)).toBe('{"_id":{"$numberInt":"1"},"a":{"b":"x","c":{"$numberInt":"2"}}}')
    expect(() => rowToDoc(['n'], ['x'], (c) => convertText(c, 'number'))).toThrow(/column 'n'/)
  })

  it('reads Excel helpers', () => {
    expect(columnIndex('A1')).toBe(0)
    expect(columnIndex('Z9')).toBe(25)
    expect(columnIndex('AB12')).toBe(27)
    expect(isDateFormat('yyyy-mm-dd hh:mm:ss')).toBe(true)
    expect(isDateFormat('[$-409]d-mmm-yy;@')).toBe(true)
    expect(isDateFormat('0.00%')).toBe(false)
    expect(isDateFormat('"days"0')).toBe(false)
    expect(isDateFormat('General')).toBe(false)
    expect(excelDate(45293.5, false).toISOString()).toBe('2024-01-02T12:00:00.000Z')
    expect(excelDate(43831, true).toISOString()).toBe('2024-01-02T00:00:00.000Z')
  })

  it('makes legal sheet names', () => {
    expect(sheetName('a/b:c*d?e[f]g\\h')).toBe('a_b_c_d_e_f_g_h')
    expect(sheetName('x'.repeat(40))).toHaveLength(31)
  })
})

describe('tools download picker', () => {
  const feed: ToolsFeed = {
    versions: [
      {
        version: '100.9.0',
        downloads: [
          { name: 'windows', arch: 'x86_64', archive: { url: 'https://x/win-100.9.0.zip', sha256: 'a' } },
          { name: 'ubuntu2204', arch: 'x86_64', archive: { url: 'https://x/u2204-100.9.0.tgz' } }
        ]
      },
      {
        version: '100.10.0',
        downloads: [
          { name: 'windows', arch: 'x86_64', archive: { url: 'https://x/win-100.10.0.zip', sha256: 'b' } },
          { name: 'macos', arch: 'arm64', archive: { url: 'https://x/mac-arm-100.10.0.zip' } },
          { name: 'macos', arch: 'x86_64', archive: { url: 'https://x/mac-x64-100.10.0.zip' } },
          { name: 'ubuntu2404', arch: 'arm64', archive: { url: 'https://x/u2404-arm-100.10.0.tgz' } },
          { name: 'rhel93', arch: 'aarch64', archive: { url: 'https://x/rhel93-arm-100.10.0.tgz' } },
          { name: 'debian12', arch: 'x86_64', archive: { url: 'https://x/deb12-100.10.0.tgz' } }
        ]
      },
      { version: '100.11.0-rc1', downloads: [{ name: 'windows', arch: 'x86_64', archive: { url: 'https://x/rc.zip' } }] }
    ]
  }

  it('picks the newest stable build for the platform', () => {
    expect(pickToolsDownload(feed, 'win32', 'x64')).toMatchObject({ version: '100.10.0', url: 'https://x/win-100.10.0.zip', sha256: 'b' })
    expect(pickToolsDownload(feed, 'darwin', 'arm64')?.url).toBe('https://x/mac-arm-100.10.0.zip')
    expect(pickToolsDownload(feed, 'darwin', 'x64')?.url).toBe('https://x/mac-x64-100.10.0.zip')
    expect(pickToolsDownload(feed, 'linux', 'arm64', parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"'))?.url).toBe('https://x/u2404-arm-100.10.0.tgz')
    expect(pickToolsDownload(feed, 'linux', 'arm64', parseOsRelease('ID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.3"'))?.url).toBe('https://x/rhel93-arm-100.10.0.tgz')
    expect(pickToolsDownload(feed, 'linux', 'x64', parseOsRelease('ID=debian\nVERSION_ID="12"'))?.url).toBe('https://x/deb12-100.10.0.tgz')
    // Unknown distro: Ubuntu 22.04 build (older version, the only x86_64 match besides debian12 fallback order).
    expect(pickToolsDownload(feed, 'linux', 'x64', parseOsRelease('ID=arch'))?.name).toBe('debian12')
    expect(pickToolsDownload(feed, 'freebsd', 'x64')).toBeNull()
  })

  it('orders candidates and versions', () => {
    expect(platformCandidates('linux', { id: 'ubuntu', versionId: '22.04' })[0]).toBe('ubuntu2204')
    expect(platformCandidates('linux', { id: 'linuxmint', idLike: ['ubuntu', 'debian'], versionId: '21.2' })[0]).toBe('ubuntu2404')
    expect(compareVersions('100.10.0', '100.9.4')).toBeGreaterThan(0)
    expect(compareVersions('100.10.0-rc1', '100.10.0')).toBeLessThan(0)
  })
})

describe('mongodump / mongorestore helpers', () => {
  it('parses tool output lines', () => {
    expect(parseToolVersion('mongodump version: 100.19.1\ngit version: abc')).toBe('100.19.1')
    expect(parseToolLine('2026-10-21T18:40:10.228+0300\tdone dumping `shop.items` (3 documents)')).toEqual({
      kind: 'dumped',
      ns: 'shop.items',
      count: 3,
      text: 'done dumping `shop.items` (3 documents)'
    })
    expect(parseToolLine('2026-10-21T18:40:10.228+0300\t[####....]  shop.items  101/1000  (10.1%)')).toMatchObject({ kind: 'progress', ns: 'shop.items', done: 101, total: 1000 })
    expect(parseToolLine('2026-10-21T18:40:10.450+0300\tfinished restoring `shop3.renamed` (3 documents, 1 failure)')).toMatchObject({
      kind: 'restored',
      ns: 'shop3.renamed',
      count: 3,
      failures: 1
    })
    expect(parseToolLine('2026-10-21T18:40:10.450+0300\t4 document(s) restored successfully. 1 document(s) failed to restore.')).toMatchObject({
      kind: 'summary',
      restored: 4,
      failed: 1
    })
    expect(parseToolLine('2026-10-21T18:40:10.450+0300\t[##......]  shop.items  1.2KB/5.0KB  (24.0%)')).toMatchObject({ kind: 'bytes', percent: 24 })
    expect(parseToolLine('Failed: something broke')).toEqual({ kind: 'log', text: 'Failed: something broke' })
    // Namespaces may contain spaces.
    expect(parseToolLine('2026-10-21T18:40:10.228+0300\tdone dumping `ab.c d` (2 documents)')).toMatchObject({ kind: 'dumped', ns: 'ab.c d', count: 2 })
    expect(parseToolLine('2026-10-21T18:40:10.228+0300\tfinished restoring `ef.c d` (1 document, 0 failures)')).toMatchObject({ kind: 'restored', ns: 'ef.c d', count: 1 })
    expect(parseToolLine('2026-10-21T18:40:10.228+0300\t[####....]  ab.c d  101/1000  (10.1%)')).toMatchObject({ kind: 'progress', ns: 'ab.c d', done: 101 })
  })

  it('builds mongodump arguments', () => {
    const base = { db: 'shop', existing: ['items', 'orders', 'logs'], archive: false, gzip: false, target: '/out' }
    expect(dumpArgs({ ...base, collections: ['items'], all: false }, '/tmp/q.json')).toEqual(['--db=shop', '--collection=items', '--queryFile=/tmp/q.json', '--out=/out'])
    expect(dumpArgs({ ...base, collections: ['items', 'orders'], all: false, archive: true, gzip: true })).toEqual([
      '--db=shop',
      '--excludeCollection=logs',
      '--archive=/out',
      '--gzip'
    ])
    expect(dumpArgs({ ...base, collections: ['items', 'orders', 'logs'], all: true })).toEqual(['--db=shop', '--out=/out'])
  })

  it('builds mongorestore arguments', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mg-restore-'))
    await fs.mkdir(join(root, 'shop'))
    await fs.writeFile(join(root, 'shop', 'items.bson'), '')
    await fs.writeFile(join(root, 'shop', 'items.metadata.json'), '{}')
    await fs.writeFile(join(root, 'shop', 'orders.bson.gz'), '')
    expect(await dumpFolderLayout(root)).toEqual({ kind: 'root', namespaces: ['shop.items', 'shop.orders'] })
    expect(await dumpFolderLayout(join(root, 'shop'))).toEqual({ kind: 'db', db: 'shop', namespaces: ['shop.items', 'shop.orders'] })

    const common = { archive: false, gzip: false, drop: false, stopOnError: false }
    expect(await restoreArgs({ ...common, source: root, db: '' })).toEqual([root])
    expect(await restoreArgs({ ...common, source: join(root, 'shop'), db: 'shop2', drop: true })).toEqual([
      '--nsInclude=shop.*',
      '--nsFrom=$db$.$coll$',
      '--nsTo=shop2.$coll$',
      '--drop',
      root
    ])
    expect(await restoreArgs({ ...common, source: root, db: 'x', collection: 'renamed', nsInclude: ['shop.items'], stopOnError: true })).toEqual([
      '--nsInclude=shop.items',
      '--nsFrom=shop.items',
      '--nsTo=x.renamed',
      '--stopOnError',
      root
    ])
    expect(await restoreArgs({ ...common, archive: true, gzip: true, source: '/a.gz', db: '', namespaces: ['a.b'] })).toEqual(['--gzip', '--archive=/a.gz'])
    expect(nsEscape('we*ird$')).toBe('we\\*ird\\$')
    await fs.mkdir(join(root, 'ab'))
    await fs.writeFile(join(root, 'ab', 'c+d%2Fe.bson'), '')
    expect((await dumpFolderLayout(join(root, 'ab'))).namespaces).toEqual(['ab.c d/e'])
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reads namespaces from an archive prelude', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mg-archive-'))
    const magic = Buffer.alloc(4)
    magic.writeUInt32LE(0x8199e26d)
    const term = Buffer.alloc(4)
    term.writeInt32LE(-1)
    const file = join(dir, 'x.archive')
    await fs.writeFile(
      file,
      Buffer.concat([
        magic,
        serialize({ concurrent_collections: 4, version: '0.1', server_version: '8.0', tool_version: '100.19.1' }),
        serialize({ db: 'shop', collection: 'orders', metadata: '{}', size: 0, type: 'collection' }),
        serialize({ db: 'shop', collection: 'items', metadata: '{}', size: 0, type: 'collection' }),
        term,
        Buffer.from('garbage after the prelude')
      ])
    )
    expect(await archiveNamespaces(file)).toEqual(['shop.items', 'shop.orders'])
    await fs.writeFile(file, 'not an archive at all')
    await expect(archiveNamespaces(file)).rejects.toThrow(/archive/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('rewrites connections for an SSH port forward and writes YAML config', () => {
    const rs = parseUri('mongodb://u:p%40ss@a:27017,b:27018/?replicaSet=rs0&tls=true')
    const local = viaLocalPort(rs, 40000)
    expect(buildUri(local, true)).toBe('mongodb://u:p%40ss@127.0.0.1:40000/?directConnection=true&authSource=admin&tls=true&tlsAllowInvalidHostnames=true')
    const uriMode = { ...newConnectionConfig(), mode: 'uri' as const, uri: 'mongodb+srv://u:pw@cluster.example.net/db' }
    expect(buildUri(viaLocalPort(uriMode, 1234), true)).toContain('@127.0.0.1:1234/db?directConnection=true')
    expect(toolConfigYaml({ uri: 'mongodb://u:"p\\w@h/', password: undefined })).toBe('uri: "mongodb://u:\\"p\\\\w@h/"\n')
  })
})
