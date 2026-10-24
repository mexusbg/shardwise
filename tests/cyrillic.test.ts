import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { GridFSBucket, MongoClient } from 'mongodb'
import { Int32, ObjectId } from 'bson'
import { parseFilter } from 'mongodb-query-parser'
import type { Doc, ExportRequest, ImportRequest, JobProgress } from '@shared/api'
import type { SearchEvent, SearchRequest } from '@shared/searchApi'
import type { SqlDialect, ToSqlRequest } from '@shared/migrationApi'
import { parseUri } from '@shared/connection'
import { shellText } from '@shared/bsonValue'
import { generateCode, modelName } from '@shared/codegen'
import { groupToFilter } from '@shared/vqb/filter'
import { newGroup, newRule } from '@shared/vqb/types'
import type { Group, Rule } from '@shared/vqb/types'
import { sqlToMongo } from '@shared/sqlToMongo'
import { ConnectionManager } from '../src/main/mongo/manager'
import { DEFAULT_SETTINGS } from '../src/main/store'
import { Transfers } from '../src/main/transfer/jobs'
import { decodeText, detectEncoding, isCyrillicLocale, resolveEncoding } from '../src/main/transfer/encoding'
import { parseDocText } from '../src/main/transfer/jsonFormat'
import { Searches } from '../src/main/search/search'
import { Migrations } from '../src/main/sql/migrations'
import { GridFs, safeFileName } from '../src/main/gridfs/gridfs'
import { partialMask } from '../src/main/masking/engine'
import type { SecretCodec } from '../src/main/store'

/*
 * Regression tests for non-ASCII (Bulgarian / Cyrillic) text through the whole data path: values, field names,
 * collection and file names, text file encodings, search, SQL migration, code generation and masking.
 */

/** Encode text in a single-byte code page (inverse of the TextDecoder table). */
function encode(text: string, label: string): Buffer {
  const dec = new TextDecoder(label)
  const map = new Map<string, number>()
  for (let b = 0; b < 256; b++) map.set(dec.decode(Uint8Array.of(b)), b)
  return Buffer.from([...text].map((c) => {
    const b = map.get(c)
    if (b === undefined) throw new Error(`${c} is not in ${label}`)
    return b
  }))
}
const utf16be = (s: string): Buffer => Buffer.from(s, 'utf16le').swap16()

const DB = 'бг_данни'
const COLL = 'клиенти'
const PEOPLE: Doc[] = [
  { _id: new Int32(1), име: 'Иван Петров', град: 'София', адрес: { улица: 'ул. „Шипка“ 12', пк: '1000' }, бележка: 'Ёж и щъркел' },
  { _id: new Int32(2), име: 'Мария Иванова', град: 'Пловдив', адрес: { улица: 'бул. България 5', пк: '4000' }, бележка: 'ЮЖЕН ВЯТЪР' },
  { _id: new Int32(3), име: 'Georgi Dimitrov', град: 'Варна', адрес: { улица: 'Ив. (Петров) [1]', пк: '9000' }, бележка: 'mixed Латиница' }
]

let server: MongoMemoryServer
let client: MongoClient
let mgr: ConnectionManager
let connId: string
let dir: string
let transfers: Transfers
let migrations: Migrations
let searches: Searches
const finals = new Map<string, JobProgress>()
const waiters = new Map<string, (p: JobProgress) => void>()
const searchListeners = new Map<string, (e: SearchEvent) => void>()
const earlySearch: SearchEvent[] = []

function wait(jobId: string): Promise<JobProgress> {
  const done = finals.get(jobId)
  if (done) return Promise.resolve(done)
  return new Promise((r) => waiters.set(jobId, r))
}
const onJob = (p: JobProgress): void => {
  if (p.state === 'running') return
  finals.set(p.jobId, p)
  waiters.get(p.jobId)?.(p)
}

const exportJob = (req: Partial<ExportRequest>): Promise<JobProgress> =>
  wait(transfers.startExport({ connId, db: DB, collections: [COLL], format: 'json', target: '', ...req } as ExportRequest))
const importJob = (req: Partial<ImportRequest>): Promise<JobProgress> =>
  wait(transfers.startImport({ connId, db: DB, collection: 'x', format: 'json', source: '', mode: 'insert', dropFirst: true, stopOnError: false, ...req } as ImportRequest))
const docs = async (coll: string): Promise<Doc[]> => (await client.db(DB).collection(coll).find({}, { promoteValues: false }).sort({ _id: 1 }).toArray()) as Doc[]

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await client.db(DB).collection(COLL).insertMany(PEOPLE as never)
  dir = await fs.mkdtemp(join(tmpdir(), 'shardwise-кирилица-'))
  mgr = new ConnectionManager()
  connId = (await mgr.connect(parseUri(server.getUri()))).connId
  transfers = new Transfers(mgr, { getSettings: async () => DEFAULT_SETTINGS }, join(dir, 'userData'), onJob)
  const codec: SecretCodec = { encrypt: async (s) => s, decrypt: async (s) => s }
  migrations = new Migrations(mgr, codec, dir, onJob)
  searches = new Searches(mgr, (e) => {
    const l = searchListeners.get(e.searchId)
    if (l) l(e)
    else earlySearch.push(e)
  })
})

afterAll(async () => {
  transfers?.cancelAll()
  searches?.cancelAll()
  await migrations?.closeAll()
  await mgr?.closeAll()
  await client?.close()
  await server?.stop()
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------
// Encoding detection
// ---------------------------------------------------------------------------

describe('text encoding detection', () => {
  it('detects BOMs, UTF-8, UTF-16 and legacy Cyrillic / Western code pages', () => {
    expect(detectEncoding(Buffer.from('\uFEFFИван', 'utf8'), true, 'en-US')).toEqual({ encoding: 'utf-8' })
    expect(detectEncoding(Buffer.from('\uFEFFИван', 'utf16le'), true, 'en-US')).toEqual({ encoding: 'utf-16le' })
    expect(detectEncoding(utf16be('\uFEFFИван'), true, 'en-US')).toEqual({ encoding: 'utf-16be' })
    expect(detectEncoding(Buffer.from('name,city\nIvan,Sofia\n', 'utf16le'), true, 'en-US').encoding).toBe('utf-16le')
    expect(detectEncoding(Buffer.from('Иван,София', 'utf8'), true, 'en-US')).toEqual({ encoding: 'utf-8' })
    // A sample cut inside a two-byte Cyrillic letter is still UTF-8.
    const cut = Buffer.from('Иван', 'utf8').subarray(0, 3)
    expect(detectEncoding(cut, false, 'en-US').encoding).toBe('utf-8')
    // Excel "CSV" on Bulgarian Windows: windows-1251, even on a non-Cyrillic system locale.
    const cp1251 = encode('Име;Град\nИван Петров;София\n', 'windows-1251')
    const r = detectEncoding(cp1251, true, 'en-US')
    expect(r.encoding).toBe('windows-1251')
    expect(r.note).toMatch(/not valid UTF-8/)
    expect(detectEncoding(encode('Name;City\nJürgen Müller;Köln\n', 'windows-1252'), true, 'en-US').encoding).toBe('windows-1252')
    expect(detectEncoding(encode('Name;City\nJürgen Müller;Köln\n', 'windows-1252'), true, 'bg-BG').encoding).toBe('windows-1251')
  })

  it('knows Cyrillic locales', () => {
    expect(['bg-BG', 'bg', 'ru_RU', 'uk-UA', 'sr-Cyrl-RS', 'mk'].map(isCyrillicLocale)).toEqual([true, true, true, true, true, true])
    expect(['en-US', 'de', 'sr-Latn-RS', '', undefined].map(isCyrillicLocale)).toEqual([false, false, false, false, false])
  })

  it('honours an explicit encoding', async () => {
    const p = join(dir, 'koi8.txt')
    await fs.writeFile(p, encode('Привет', 'koi8-r'))
    expect(await resolveEncoding(p, 'koi8-r')).toEqual({ encoding: 'koi8-r' })
    expect(decodeText(encode('Привет', 'iso-8859-5'), true, 'bg').text).not.toBe('Привет')
  })
})

// ---------------------------------------------------------------------------
// CSV / JSON / Excel
// ---------------------------------------------------------------------------

describe('CSV with Cyrillic', () => {
  it('exports UTF-8 with a BOM for Excel and imports it back with Cyrillic field names', async () => {
    const target = join(dir, 'Експорт', `${COLL}.csv`)
    const ex = await exportJob({ format: 'csv', target, csv: { fields: [], delimiter: ',', header: true, bom: true } })
    expect(ex.state, ex.error).toBe('done')
    const bytes = readFileSync(target)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.toString('utf8').slice(1)
    expect(text.split('\n')[0]).toBe('_id,име,град,адрес.улица,адрес.пк,бележка')
    expect(text.split('\n')[1]).toBe('1,Иван Петров,София,ул. „Шипка“ 12,1000,Ёж и щъркел')

    const p = await transfers.preview('csv', target, { delimiter: ',' })
    expect(p.columns[0]).toBe('_id')
    expect(p.encoding).toBe('utf-8')
    expect(p.encodingNote).toBeUndefined()

    const im = await importJob({ format: 'csv', collection: 'csv_bom', source: target, csv: { delimiter: ',', columnTypes: { 'адрес.пк': 'string' } } })
    expect(im.state, im.error).toBe('done')
    const back = await docs('csv_bom')
    expect(Object.keys(back[0])).toEqual(['_id', 'име', 'град', 'адрес', 'бележка'])
    expect(back[0]).toMatchObject({ име: 'Иван Петров', адрес: { улица: 'ул. „Шипка“ 12', пк: '1000' }, бележка: 'Ёж и щъркел' })
  })

  it('writes no BOM unless asked and keeps Cyrillic collection names as file names', async () => {
    const folder = join(dir, 'много')
    await client.db(DB).collection('поръчки').insertOne({ _id: new Int32(1), продукт: 'хляб' } as never)
    const ex = await exportJob({ format: 'csv', target: folder, collections: [COLL, 'поръчки'], csv: { fields: [], delimiter: ';', header: true } })
    expect(ex.state, ex.error).toBe('done')
    expect((await fs.readdir(folder)).sort()).toEqual(['клиенти.csv', 'поръчки.csv'])
    expect(readFileSync(join(folder, 'поръчки.csv'), 'utf8')).toBe('_id;продукт\n1;хляб\n')
  })

  it('reads Excel CSV files saved in windows-1251', async () => {
    const src = join(dir, 'excel-1251.csv')
    await fs.writeFile(src, encode('Име;Град;Бележка\r\nИван Петров;София;"щъркел; ""ёж"""\r\nМария;Пловдив;ЮЖЕН\r\n', 'windows-1251'))
    const p = await transfers.preview('csv', src, { delimiter: ';' })
    expect(p.encoding).toBe('windows-1251')
    expect(p.encodingNote).toMatch(/windows-1251/)
    expect(p.columns).toEqual(['Име', 'Град', 'Бележка'])
    expect(p.sample[0]).toEqual({ Име: 'Иван Петров', Град: 'София', Бележка: 'щъркел; "ёж"' })

    const im = await importJob({ format: 'csv', collection: 'csv_1251', source: src, csv: { delimiter: ';', columnTypes: {} } })
    expect(im.state, im.error).toBe('done')
    expect(im.log?.some((l) => /windows-1251/.test(l))).toBe(true)
    expect((await docs('csv_1251')).map(({ _id, ...d }) => d)).toEqual([
      { Име: 'Иван Петров', Град: 'София', Бележка: 'щъркел; "ёж"' },
      { Име: 'Мария', Град: 'Пловдив', Бележка: 'ЮЖЕН' }
    ])

    // An explicit choice wins over detection.
    const wrong = await transfers.preview('csv', src, { delimiter: ';', encoding: 'utf-8' })
    expect(wrong.encoding).toBe('utf-8')
    expect(wrong.columns[0]).not.toBe('Име')
    const koi = await transfers.preview('csv', src, { delimiter: ';', encoding: 'windows-1251' })
    expect(koi.encodingNote).toBeUndefined()
    expect(koi.columns[0]).toBe('Име')
  })

  it('reads UTF-16 (Excel "Unicode text") CSV files', async () => {
    const src = join(dir, 'unicode.txt')
    await fs.writeFile(src, Buffer.from('\uFEFFИме\tГрад\r\nИван\tСофия\r\n', 'utf16le'))
    const p = await transfers.preview('csv', src, { delimiter: '\t' })
    expect(p.encoding).toBe('utf-16le')
    expect(p.sample).toEqual([{ Име: 'Иван', Град: 'София' }])
    const be = join(dir, 'unicode-be.txt')
    await fs.writeFile(be, utf16be('\uFEFFИме\tГрад\r\nИван\tСофия\r\n'))
    expect((await transfers.preview('csv', be, { delimiter: '\t' })).sample).toEqual([{ Име: 'Иван', Град: 'София' }])
  })
})

describe('JSON with Cyrillic', () => {
  it('imports UTF-8 with BOM, UTF-16 LE (Windows PowerShell) and windows-1251 files', async () => {
    const body = '{"_id": 1, "име": "Иван", "град": "София"}\n{"_id": 2, "име": "Ёлка"}\n'
    const files: [string, Buffer][] = [
      ['bom.json', Buffer.from(`\uFEFF${body}`, 'utf8')],
      ['ps.json', Buffer.from(`\uFEFF${body}`, 'utf16le')],
      ['ansi.json', encode(body, 'windows-1251')]
    ]
    for (const [name, data] of files) {
      const src = join(dir, name)
      await fs.writeFile(src, data)
      const im = await importJob({ collection: `json_${name}`, source: src })
      expect(im.state, `${name}: ${im.error}`).toBe('done')
      expect((await docs(`json_${name}`)).map((d) => d.име), name).toEqual(['Иван', 'Ёлка'])
    }
    expect((await transfers.preview('json', join(dir, 'ansi.json'))).encoding).toBe('windows-1251')
  })

  it('round-trips Cyrillic through every JSON flavour and parses unquoted Cyrillic keys', async () => {
    for (const flavor of ['shell', 'canonical', 'relaxed'] as const) {
      const target = join(dir, `${COLL}-${flavor}.json`)
      expect((await exportJob({ target, json: { flavor, layout: 'array', pretty: true } })).state).toBe('done')
      expect(readFileSync(target, 'utf8')).toContain('"име": "Иван Петров"')
      expect((await importJob({ collection: `json_rt_${flavor}`, source: target })).state).toBe('done')
      expect(await docs(`json_rt_${flavor}`)).toEqual(await docs(COLL))
    }
    expect(parseDocText("{ име: 'Иван', адрес: { град: 'София' }, _id: ObjectId('650000000000000000000001') }").doc).toEqual({
      име: 'Иван',
      адрес: { град: 'София' },
      _id: new ObjectId('650000000000000000000001')
    })
  })
})

describe('Excel with Cyrillic', () => {
  it('round-trips values, header names and the sheet name', async () => {
    const target = join(dir, `${COLL}.xlsx`)
    const ex = await exportJob({ format: 'xlsx', target, xlsx: { fields: [] } })
    expect(ex.state, ex.error).toBe('done')
    const p = await transfers.preview('xlsx', target)
    expect(p.sheets).toEqual([COLL])
    expect(p.columns).toEqual(['_id', 'име', 'град', 'адрес.улица', 'адрес.пк', 'бележка'])
    const im = await importJob({ format: 'xlsx', collection: 'xlsx_cyr', source: target, xlsx: { sheet: COLL, columnTypes: { 'адрес.пк': 'string' } } })
    expect(im.state, im.error).toBe('done')
    expect(await docs('xlsx_cyr')).toEqual(await docs(COLL))
  })
})

// ---------------------------------------------------------------------------
// Search and query building
// ---------------------------------------------------------------------------

function search(p: Partial<SearchRequest>): Promise<Map<string, string[]>> {
  const id = searches.start({ connId, db: DB, text: '', type: 'auto', match: 'contains', caseSensitive: false, collections: [COLL], maxPerCollection: 50, deep: false, ...p })
  return new Promise((resolve, reject) => {
    const out = new Map<string, string[]>()
    const on = (e: SearchEvent): void => {
      if (e.kind === 'collection') out.set(e.result.coll, e.result.hits.flatMap((h) => h.matches.map((m) => `${m.path}=${m.value}`)))
      else if (e.kind === 'done') (e.state === 'done' ? resolve(out) : reject(new Error(e.error)))
    }
    searchListeners.set(id, on)
    earlySearch.filter((e) => e.searchId === id).forEach(on)
  })
}

describe('search with Cyrillic', () => {
  it('matches case-insensitively on the server (sampled and deep modes)', async () => {
    for (const deep of [false, true]) {
      expect((await search({ text: 'иван', deep })).get(COLL)).toEqual(['име=Иван Петров', 'име=Мария Иванова'])
      expect((await search({ text: 'ЁЖ', deep })).get(COLL)).toEqual(['бележка=Ёж и щъркел'])
      expect((await search({ text: 'Иван', caseSensitive: true, deep })).get(COLL)).toEqual(['име=Иван Петров', 'име=Мария Иванова'])
      expect((await search({ text: 'иван', caseSensitive: true, deep })).get(COLL)).toBeUndefined()
      expect((await search({ text: 'иван петров', match: 'exact', deep })).get(COLL)).toEqual(['име=Иван Петров'])
      expect((await search({ text: 'софия', field: 'град', deep })).get(COLL)).toEqual(['град=София'])
      expect((await search({ text: 'ив. (петров) [1]', deep })).get(COLL)).toEqual(['адрес.улица=Ив. (Петров) [1]'])
      expect((await search({ text: '/^юж/i', deep })).get(COLL)).toEqual(['бележка=ЮЖЕН ВЯТЪР'])
    }
  })

  it('builds contains / starts with filters that match Cyrillic case-insensitively', async () => {
    const rule = (p: Partial<Rule>): Rule => ({ ...newRule(), valueType: 'string', ...p })
    const group = (...children: Rule[]): Group => ({ ...newGroup('and'), children })
    const run = async (f: Doc): Promise<number[]> =>
      (await client.db(DB).collection(COLL).find(f).sort({ _id: 1 }).toArray()).map((d) => Number(d._id))
    expect(await run(groupToFilter(group(rule({ field: 'име', op: 'contains', value: 'иван', caseInsensitive: true }))))).toEqual([1, 2])
    expect(await run(groupToFilter(group(rule({ field: 'име', op: 'contains', value: 'иван' }))))).toEqual([])
    expect(await run(groupToFilter(group(rule({ field: 'име', op: 'contains', value: 'Иванова' }))))).toEqual([2])
    expect(await run(groupToFilter(group(rule({ field: 'адрес.улица', op: 'startsWith', value: 'УЛ.', caseInsensitive: true }))))).toEqual([1])
    expect(await run(groupToFilter(group(rule({ field: 'бележка', op: 'endsWith', value: 'вятър', caseInsensitive: true }))))).toEqual([2])
    expect(await run(groupToFilter(group(rule({ field: 'адрес.улица', op: 'contains', value: '(петров) [1]', caseInsensitive: true }))))).toEqual([3])
    expect(await run(groupToFilter(group(rule({ field: 'град', op: 'notStartsWith', value: 'с', caseInsensitive: true }))))).toEqual([2, 3])
  })

  it('formats and parses query text with Cyrillic keys', async () => {
    const f = { име: 'Иван', 'адрес.град': { $regex: '^соф', $options: 'i' } }
    const text = shellText(f)
    expect(text).toContain("'име'")
    expect(parseFilter(text)).toEqual(f)
    expect(parseFilter("{ име: 'Иван' }")).toEqual({ име: 'Иван' })
    const sql = sqlToMongo("SELECT име, град FROM клиенти WHERE град = 'София' AND име LIKE 'Ив%' ORDER BY име")
    expect(sql).toMatchObject({ coll: 'клиенти', kind: 'find', filter: { град: 'София', име: { $regex: '^Ив' } }, sort: { име: 1 } })
  })
})

// ---------------------------------------------------------------------------
// SQL migration
// ---------------------------------------------------------------------------

describe('SQL migration with Cyrillic', () => {
  const toSql = async (req: Pick<ToSqlRequest, 'target'>, colls = [COLL, 'кодове']): Promise<JobProgress> => {
    const collections = await migrations.inferToSql(connId, DB, colls, 1000)
    return wait(migrations.startToSql({ connId, db: DB, mode: 'dropCreate', batchSize: 50, collections, ...req }))
  }

  beforeAll(async () => {
    // String _ids that differ only in case: a case-insensitive key collation would reject them as duplicates.
    await client.db(DB).collection('кодове').insertMany([{ _id: 'Абв', n: new Int32(1) }, { _id: 'абв', n: new Int32(2) }] as never)
  })

  it('writes scripts that keep Unicode text for every dialect', async () => {
    const script = async (dialect: SqlDialect): Promise<Buffer> => {
      const p = join(dir, `миграция-${dialect}.sql`)
      const r = await toSql({ target: { kind: 'file', path: p, dialect } })
      expect(r.state, r.error).toBe('done')
      return readFileSync(p)
    }
    const ms = await script('mssql')
    expect([...ms.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const msText = ms.toString('utf8')
    expect(msText).toContain('CREATE TABLE [dbo].[клиенти]')
    expect(msText).toMatch(/\[име\] NVARCHAR\(MAX\)/)
    expect(msText).toContain("N'Иван Петров'")
    expect(msText).not.toMatch(/[^N]'Иван/)

    const my = (await script('mysql')).toString('utf8')
    expect(my.charCodeAt(0)).not.toBe(0xfeff)
    expect(my).toContain('SET NAMES utf8mb4;')
    expect(my).toMatch(/CREATE TABLE `клиенти` \([\s\S]*\) DEFAULT CHARSET=utf8mb4;/)
    expect(my).toMatch(/`_id` VARCHAR\(255\) COLLATE utf8mb4_bin NOT NULL/)
    expect(my).toContain("'Иван Петров'")

    const pg = (await script('postgres')).toString('utf8')
    expect(pg).toContain("SET client_encoding = 'UTF8';")
    expect(pg).toContain('CREATE TABLE "public"."клиенти"')

    const lite = (await script('sqlite')).toString('utf8')
    expect(lite).not.toMatch(/SET /)
    const file = join(dir, 'от-скрипт.db')
    const d = new DatabaseSync(file)
    try {
      d.exec(lite)
      expect(d.prepare('SELECT "име", "град" FROM "клиенти" ORDER BY "_id"').all()).toEqual([
        { име: 'Иван Петров', град: 'София' },
        { име: 'Мария Иванова', град: 'Пловдив' },
        { име: 'Georgi Dimitrov', град: 'Варна' }
      ])
      expect(d.prepare('SELECT "_id" FROM "кодове" ORDER BY "n"').all().map((r) => r._id)).toEqual(['Абв', 'абв'])
    } finally {
      d.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Names, code generation, masking, GridFS
// ---------------------------------------------------------------------------

describe('code generation with Cyrillic', () => {
  const q = { kind: 'find' as const, db: DB, coll: COLL, filter: { име: 'Иван', 'адрес.град': 'София', бележка: 'ред 1\nред 2' }, sort: { име: 1 } }

  it('keeps Cyrillic in string literals and quotes non-ASCII keys', () => {
    const mongosh = generateCode(q, 'mongosh')
    expect(mongosh).toContain(`use('${DB}')`)
    expect(mongosh).toContain(`db.getCollection('${COLL}')`)
    expect(mongosh).toContain("'име': 'Иван'")
    expect(mongosh).toContain("'бележка': 'ред 1\\nред 2'")
    expect(generateCode(q, 'python')).toContain("{'име': 'Иван', 'адрес.град': 'София', 'бележка': 'ред 1\\nред 2'}")
    expect(generateCode(q, 'java')).toContain('new Document("име", "Иван")\n  .append("адрес.град", "София")\n  .append("бележка", "ред 1\\nред 2")')
    expect(generateCode(q, 'csharp')).toContain('{ "име", "Иван" }')
    expect(generateCode(q, 'go')).toContain('{Key: "име", Value: "Иван"}')
    // PHP / Ruby single quotes do not know \n: the line break is kept as is.
    expect(generateCode(q, 'php')).toContain("'бележка' => 'ред 1\nред 2'")
    expect(generateCode(q, 'ruby')).toContain("'бележка' => 'ред 1\nред 2'")
    expect(generateCode(q, 'mongoose')).toContain(`mongoose.model('Клиенти', new mongoose.Schema({}, { strict: false }), '${COLL}')`)
  })

  it('derives model names from any script', () => {
    expect(modelName('клиенти')).toBe('Клиенти')
    expect(modelName('order_items')).toBe('OrderItem')
    expect(modelName('стари-поръчки')).toBe('СтариПоръчки')
    expect(modelName('2024_log')).toBe('Model2024Log')
    expect(modelName('___')).toBe('Model')
  })
})

describe('masking Cyrillic text', () => {
  it('treats Cyrillic letters as letters and keeps separators', () => {
    expect(partialMask('Иван Петров', { partial: 'chars', keepStart: 1, keepEnd: 1, maskChar: '*' })).toBe('И*** *****в')
    expect(partialMask('ЕГН 8001011234', { partial: 'chars', keepStart: 0, keepEnd: 4, maskChar: '•' })).toBe('••• ••••••1234')
    expect(partialMask('иван.петров@поща.бг', { partial: 'email', keepStart: 2, maskChar: '*' })).toBe('ив***@поща.бг')
  })
})

describe('file names and GridFS', () => {
  it('keeps Cyrillic file names and limits their UTF-8 length', () => {
    expect(safeFileName('Отчет за продажбите 2024.pdf')).toBe('Отчет за продажбите 2024.pdf')
    expect(safeFileName('договори/2024: Иванов.docx')).toBe('договори_2024_ Иванов.docx')
    const long = safeFileName(`${'Дълго име на файл '.repeat(20)}.pdf`)
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(200)
    expect(long).toMatch(/^Дълго име на файл .*\.pdf$/)
    expect(long).not.toContain('\uFFFD')
  })

  it('previews windows-1251 and UTF-16 text files as text', async () => {
    const gfs = new GridFs({ get: () => client }, () => {})
    const bucket = new GridFSBucket(client.db(DB))
    const put = (name: string, data: Buffer): Promise<ObjectId> =>
      new Promise((resolve, reject) => {
        const up = bucket.openUploadStream(name)
        up.once('finish', () => resolve(up.id as ObjectId)).once('error', reject).end(data)
      })
    const ansi = await gfs.preview(connId, DB, 'fs', await put('бележки.txt', encode('Здравей, свят!\r\nЁж', 'windows-1251')))
    expect(ansi).toMatchObject({ kind: 'text', data: 'Здравей, свят!\r\nЁж' })
    const u16 = await gfs.preview(connId, DB, 'fs', await put('unicode.dat', Buffer.from('\uFEFFЗдравей', 'utf16le')))
    expect(u16).toMatchObject({ kind: 'text', data: 'Здравей' })
    const u8 = await gfs.preview(connId, DB, 'fs', await put('ok.txt', Buffer.from('Здравей', 'utf8')))
    expect(u8).toMatchObject({ kind: 'text', data: 'Здравей' })
  })
})
