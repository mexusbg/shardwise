import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { EJSON } from 'bson'
import type { Doc, JobProgress } from '@shared/api'
import {
  collationLabel,
  effectiveCollation,
  formatCollation,
  isCaseInsensitive,
  parseCollationText,
  toCollation,
  tryCollationText,
  validateCollation
} from '@shared/collation'
import { generateCode, CODE_LANGUAGES } from '@shared/codegen'
import type { CodeQuery } from '@shared/codegen'
import { DEFAULT_SETTINGS, normalizeSettings } from '@shared/settings'
import { newConnectionConfig, parseUri } from '@shared/connection'
import * as ops from '../src/main/mongo/ops'
import { ConnectionManager } from '../src/main/mongo/manager'
import { Transfers } from '../src/main/transfer/jobs'
import { exportConnections, parseConnectionImport } from '../src/main/connectionTransfer'
import { payloadKey, QueryLibrary } from '../src/main/history'
import { Store } from '../src/main/store'

const NAMES = ['ябълка', 'Ана', 'ана', 'Ёж', 'Борис', 'ѝ']
const BG = { locale: 'bg' }
const BG2 = { locale: 'bg', strength: 2 }
const DB = 'coll_test'

let server: MongoMemoryServer
let client: MongoClient
let dir: string

const names = (docs: Doc[]): string[] => docs.map((d) => d.name as string)

async function reset(coll: string): Promise<void> {
  const c = client.db(DB).collection(coll)
  await c.deleteMany({})
  await c.insertMany(NAMES.map((name, i) => ({ _id: i + 1, name })) as never)
}

beforeAll(async () => {
  server = await MongoMemoryServer.create()
  client = await MongoClient.connect(server.getUri())
  await reset('words')
  dir = await fs.mkdtemp(join(tmpdir(), 'shardwise-collation-'))
})

afterAll(async () => {
  await client?.close()
  await server?.stop()
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('collation documents', () => {
  it('parses shell text, validates and formats in canonical order', () => {
    expect(parseCollationText('')).toBeNull()
    expect(parseCollationText('  ')).toBeNull()
    expect(parseCollationText('{}')).toBeNull()
    expect(parseCollationText("{ strength: 2, locale: 'bg' }")).toEqual(BG2)
    expect(formatCollation(parseCollationText('{strength:2,locale:"bg",numericOrdering:true}'))).toBe("{ locale: 'bg', strength: 2, numericOrdering: true }")
    expect(formatCollation(null)).toBe('')
    expect(parseCollationText(formatCollation({ locale: 'ru', caseFirst: 'upper', alternate: 'shifted', backwards: true }))).toEqual({ locale: 'ru', caseFirst: 'upper', alternate: 'shifted', backwards: true })
  })

  it('rejects documents without a locale or with bad values', () => {
    expect(() => parseCollationText('{ strength: 2 }')).toThrow(/locale/)
    expect(() => parseCollationText("{ locale: '' }")).toThrow(/locale/)
    expect(() => parseCollationText("{ locale: 'bg', strength: 7 }")).toThrow(/strength/)
    expect(() => parseCollationText("{ locale: 'bg', strength: 1.5 }")).toThrow(/strength/)
    expect(() => parseCollationText("{ locale: 'bg', caseFirst: 'title' }")).toThrow(/caseFirst/)
    expect(() => parseCollationText("{ locale: 'bg', numericOrdering: 'yes' }")).toThrow(/numericOrdering/)
    expect(() => parseCollationText("{ locale: 'bg', colour: 1 }")).toThrow(/Unknown collation field "colour"/)
    expect(() => parseCollationText("'bg'")).toThrow(/object/)
    expect(() => parseCollationText('{ locale: ')).toThrow()
    expect(() => validateCollation([])).toThrow(/object/)
    expect(tryCollationText('{ strength: 2 }')).toBeNull()
    expect(toCollation(undefined)).toBeUndefined()
    expect(toCollation({})).toBeUndefined()
  })

  it('labels chips and knows when matching ignores case', () => {
    expect(collationLabel(BG2)).toBe('bg · 2')
    expect(collationLabel({ locale: 'ru', numericOrdering: true })).toBe('ru · 1-2-10')
    expect(isCaseInsensitive(BG2)).toBe(true)
    expect(isCaseInsensitive({ locale: 'bg', strength: 1 })).toBe(true)
    expect(isCaseInsensitive(BG)).toBe(false)
    expect(isCaseInsensitive({ locale: 'bg', strength: 2, caseLevel: true })).toBe(false)
    expect(isCaseInsensitive(null)).toBe(false)
  })

  it('picks the connection override over the preference', () => {
    expect(effectiveCollation(undefined, BG2)).toEqual(BG2)
    expect(effectiveCollation(null, BG2)).toBeNull()
    expect(effectiveCollation({ locale: 'ru' }, BG2)).toEqual({ locale: 'ru' })
    expect(effectiveCollation(undefined, null)).toBeNull()
    expect(effectiveCollation({ strength: 2 } as never, BG2)).toBeNull()
  })
})

describe('queries with a collation', () => {
  it('sorts Bulgarian words in dictionary order with locale bg, by code point without', async () => {
    const binary = await ops.find(client, DB, 'words', { filter: {}, sort: { name: 1 }, skip: 0, limit: 0 })
    // Code point order: Ё (U+0401) before А, every capital before every lowercase letter, ѝ (U+045D) last.
    expect(names(binary.docs)).toEqual(['Ёж', 'Ана', 'Борис', 'ана', 'ябълка', 'ѝ'])

    const bg = names((await ops.find(client, DB, 'words', { filter: {}, sort: { name: 1 }, skip: 0, limit: 0, collation: BG })).docs)
    expect(bg.slice(0, 2).sort()).toEqual(['Ана', 'ана'])
    expect(bg.indexOf('Борис')).toBe(2)
    // Ё sorts with Е (after Б), ѝ with И, and я is the last letter.
    expect(bg.indexOf('Ёж')).toBeGreaterThan(bg.indexOf('Борис'))
    expect(bg.indexOf('ѝ')).toBeGreaterThan(bg.indexOf('Ёж'))
    expect(bg[bg.length - 1]).toBe('ябълка')
    // Strength 3 (default) puts lowercase first; caseFirst: 'upper' flips it.
    expect(bg.slice(0, 2)).toEqual(['ана', 'Ана'])
    const upper = names((await ops.find(client, DB, 'words', { filter: {}, sort: { name: 1 }, skip: 0, limit: 0, collation: { locale: 'bg', caseFirst: 'upper' } })).docs)
    expect(upper.slice(0, 2)).toEqual(['Ана', 'ана'])
  })

  it('matches equality without regard to case at strength 2', async () => {
    const plain = await ops.find(client, DB, 'words', { filter: { name: 'ана' }, skip: 0, limit: 0 })
    expect(names(plain.docs)).toEqual(['ана'])
    const ci = await ops.find(client, DB, 'words', { filter: { name: 'ана' }, sort: { _id: 1 }, skip: 0, limit: 0, collation: BG2 })
    expect(names(ci.docs)).toEqual(['Ана', 'ана'])
    const strength3 = await ops.find(client, DB, 'words', { filter: { name: 'АНА' }, skip: 0, limit: 0, collation: BG })
    expect(strength3.docs).toEqual([])
    // $in follows the collation too (Filter Builder "in" conditions).
    const inList = await ops.find(client, DB, 'words', { filter: { name: { $in: ['БОРИС', 'ёж'] } }, skip: 0, limit: 0, collation: BG2 })
    expect(names(inList.docs).sort()).toEqual(['Борис', 'Ёж'].sort())
  })

  it('counts with the collation', async () => {
    expect(await ops.count(client, DB, 'words', { name: 'ана' })).toBe(1)
    expect(await ops.count(client, DB, 'words', { name: 'ана' }, 0, BG2)).toBe(2)
    expect(await ops.count(client, DB, 'words', { name: 'ана' }, 0, null)).toBe(1)
    expect(await ops.count(client, DB, 'words', {}, 0, BG2)).toBe(6)
  })

  it('explains with the collation', async () => {
    const plan = await ops.explain(client, DB, 'words', { filter: { name: 'ана' }, skip: 0, limit: 0, collation: BG2 }, 'executionStats')
    const stats = plan.executionStats as Doc
    expect(Number(stats.nReturned)).toBe(2)
    expect(JSON.stringify(plan)).toContain('"locale":"bg"')
  })

  it('refuses an invalid collation with a readable error', async () => {
    await expect(ops.find(client, DB, 'words', { filter: {}, skip: 0, limit: 0, collation: { strength: 2 } })).rejects.toThrow(/locale/)
    await expect(ops.count(client, DB, 'words', {}, 0, { locale: 'bg', strength: 9 })).rejects.toThrow(/strength/)
    // The server checks the locale name itself.
    await expect(ops.find(client, DB, 'words', { filter: {}, skip: 0, limit: 0, collation: { locale: 'xx_nope' } })).rejects.toThrow()
  })

  it('updates and deletes the documents a collated filter matches', async () => {
    await reset('edit')
    const upd = await ops.updateField(client, DB, 'edit', { kind: 'filter', filter: { name: 'АНА' }, collation: BG2 }, { kind: 'set', path: 'hit', value: true })
    expect(upd.matched).toBe(2)
    expect(await client.db(DB).collection('edit').countDocuments({ hit: true })).toBe(2)
    // Without the collation the same filter matches nothing.
    expect((await ops.updateField(client, DB, 'edit', { kind: 'filter', filter: { name: 'АНА' } }, { kind: 'set', path: 'x', value: 1 })).matched).toBe(0)
    expect(await ops.deleteDocuments(client, DB, 'edit', { kind: 'filter', filter: { name: 'ана' } })).toBe(1)
    expect(await ops.deleteDocuments(client, DB, 'edit', { kind: 'filter', filter: { name: 'ЁЖ' }, collation: BG2 })).toBe(1)
    await expect(ops.deleteDocuments(client, DB, 'edit', { kind: 'filter', filter: { name: 'x' }, collation: { strength: 2 } })).rejects.toThrow(/locale/)
    expect(await client.db(DB).collection('edit').countDocuments()).toBe(4)
  })
})

describe('export of a collated query', () => {
  it('filters and sorts the exported documents with the collation', async () => {
    const mgr = new ConnectionManager()
    const finals = new Map<string, (p: JobProgress) => void>()
    const transfers = new Transfers(mgr, { getSettings: async () => DEFAULT_SETTINGS }, join(dir, 'userData'), (p) => {
      if (p.state !== 'running') finals.get(p.jobId)?.(p)
    })
    try {
      const connId = (await mgr.connect(parseUri(server.getUri()))).connId
      const run = (target: string, collation?: Doc): Promise<JobProgress> =>
        new Promise((resolve) => {
          const id = transfers.startExport({
            connId,
            db: DB,
            collections: ['words'],
            format: 'json',
            target,
            json: { flavor: 'relaxed', layout: 'lines', pretty: false },
            query: { filter: { name: { $in: ['ана', 'ябълка', 'борис'] } }, sort: { name: 1 }, collation }
          })
          finals.set(id, resolve)
        })
      const read = async (p: string): Promise<string[]> => (await fs.readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map((l) => (EJSON.parse(l) as Doc).name as string)

      const plain = await run(join(dir, 'plain.json'))
      expect(plain.state).toBe('done')
      expect(await read(join(dir, 'plain.json'))).toEqual(['ана', 'ябълка'])

      const bg = await run(join(dir, 'bg.json'), BG2)
      expect(bg.state).toBe('done')
      expect(bg.total).toBe(4)
      const out = await read(join(dir, 'bg.json'))
      expect(out.slice(0, 2).sort()).toEqual(['Ана', 'ана'])
      expect(out.slice(2)).toEqual(['Борис', 'ябълка'])

      const bad = await run(join(dir, 'bad.json'), { strength: 2 })
      expect(bad.state).toBe('error')
      expect(bad.error).toMatch(/locale/)
    } finally {
      transfers.cancelAll()
      await mgr.closeAll()
    }
  })
})

describe('code generation with a collation', () => {
  const find: CodeQuery = { kind: 'find', db: 'shop', coll: 'customers', filter: { name: 'ана' }, sort: { name: 1 }, collation: BG2 }
  const agg: CodeQuery = { kind: 'aggregate', db: 'shop', coll: 'customers', pipeline: [{ $sort: { name: 1 } }], collation: BG2 }

  it('adds the collation in every language', () => {
    const f = Object.fromEntries(CODE_LANGUAGES.map((l) => [l, generateCode(find, l)]))
    expect(f.mongosh).toContain("db.customers.find({ name: 'ана' })\n  .collation({ locale: 'bg', strength: 2 })\n  .sort({ name: 1 })")
    expect(f.node).toContain("const options = { sort: { name: 1 }, collation: { locale: 'bg', strength: 2 } }")
    expect(f.mongoose).toContain(".collation({ locale: 'bg', strength: 2 })")
    expect(f.python).toContain("cursor = coll.find(filter).collation({'locale': 'bg', 'strength': 2}).sort([('name', 1)])")
    expect(f.java).toContain('import com.mongodb.client.model.*;')
    expect(f.java).toContain('Collation collation = Collation.builder().locale("bg").collationStrength(CollationStrength.SECONDARY).build();')
    expect(f.java).toContain('.collation(collation)')
    expect(f.csharp).toContain('var collation = new Collation("bg", strength: CollationStrength.Secondary);')
    expect(f.csharp).toContain('coll.Find(filter, new FindOptions { Collation = collation })')
    expect(f.go).toContain('SetCollation(&options.Collation{Locale: "bg", Strength: 2})')
    expect(f.php).toContain("'collation' => ['locale' => 'bg', 'strength' => 2]")
    expect(f.ruby).toContain("coll.find(filter, collation: { locale: 'bg', strength: 2 })")
  })

  it('adds the collation to aggregations', () => {
    expect(generateCode(agg, 'mongosh')).toContain(".aggregate([{ $sort: { name: 1 } }], { collation: { locale: 'bg', strength: 2 } })")
    expect(generateCode(agg, 'node')).toContain("coll.aggregate(pipeline, { collation: { locale: 'bg', strength: 2 } })")
    expect(generateCode(agg, 'python')).toContain("coll.aggregate(pipeline, collation={'locale': 'bg', 'strength': 2})")
    expect(generateCode(agg, 'csharp')).toContain('new AggregateOptions { Collation = collation }')
    expect(generateCode(agg, 'go')).toContain('options.Aggregate().SetCollation(&options.Collation{Locale: "bg", Strength: 2})')
    expect(generateCode(agg, 'ruby')).toContain("coll.aggregate(pipeline, collation: { locale: 'bg', strength: 2 })")
  })

  it('maps every option in the typed drivers', () => {
    const all: CodeQuery = { ...find, collation: { locale: 'fr', strength: 1, caseLevel: true, caseFirst: 'upper', numericOrdering: true, alternate: 'shifted', maxVariable: 'punct', backwards: true } }
    expect(generateCode(all, 'java')).toContain(
      'Collation.builder().locale("fr").collationStrength(CollationStrength.PRIMARY).caseLevel(true).collationCaseFirst(CollationCaseFirst.UPPER).numericOrdering(true).collationAlternate(CollationAlternate.SHIFTED).collationMaxVariable(CollationMaxVariable.PUNCT).backwards(true).build()'
    )
    expect(generateCode(all, 'csharp')).toContain(
      'new Collation("fr", strength: CollationStrength.Primary, caseLevel: true, caseFirst: CollationCaseFirst.Upper, numericOrdering: true, alternate: CollationAlternate.Shifted, maxVariable: CollationMaxVariable.Punctuation, backwards: true)'
    )
    expect(generateCode(all, 'go')).toContain('&options.Collation{Locale: "fr", Strength: 1, CaseLevel: true, CaseFirst: "upper", NumericOrdering: true, Alternate: "shifted", MaxVariable: "punct", Backwards: true}')
  })

  it('leaves code without a collation unchanged', () => {
    for (const l of CODE_LANGUAGES) {
      expect(generateCode({ ...find, collation: null }, l)).toBe(generateCode({ ...find, collation: undefined }, l))
      expect(generateCode({ ...find, collation: {} }, l)).not.toMatch(/collation/i)
    }
  })
})

describe('default collation settings', () => {
  it('defaults to none and keeps only valid collations', () => {
    expect(DEFAULT_SETTINGS.defaultCollation).toBeNull()
    expect(normalizeSettings({}).defaultCollation).toBeNull()
    expect(normalizeSettings({ defaultCollation: { strength: 2, locale: 'bg' } }).defaultCollation).toEqual(BG2)
    expect(normalizeSettings({ defaultCollation: { locale: 'bg', strength: 9 } }).defaultCollation).toBeNull()
    expect(normalizeSettings({ defaultCollation: 'bg' }).defaultCollation).toBeNull()
    expect(normalizeSettings({ defaultCollation: {} }).defaultCollation).toBeNull()
  })

  it('persists the preference and default queries with their collation', async () => {
    const codec = { encrypt: async (s: string) => s, decrypt: async (s: string) => s }
    const file = join(dir, 'store.json')
    const store = new Store(file, codec)
    expect((await store.saveSettings({ defaultCollation: { strength: 2, locale: 'bg' } as never })).defaultCollation).toEqual(BG2)
    expect((await store.saveSettings({ defaultCollation: { strength: 2 } as never })).defaultCollation).toBeNull()
    await store.saveSettings({ defaultCollation: BG2 })
    await store.setDefaultQuery('c1', 'collection', 'shop', 'people', { query: '', projection: '', sort: '{ name: 1 }', skip: '', limit: '', collation: "{ locale: 'bg', strength: 2 }" })
    const again = new Store(file, codec)
    expect((await again.getSettings()).defaultCollation).toEqual(BG2)
    expect((await again.getDefaultQuery('c1', 'shop', 'people'))?.value.collation).toBe("{ locale: 'bg', strength: 2 }")
  })

  it('keeps a per-connection default in Shardwise exports', () => {
    const c = { ...newConnectionConfig(), id: 'c1', name: 'Sofia', overrides: { defaultCollation: BG2 } }
    const none = { ...newConnectionConfig(), id: 'c2', name: 'Binary', overrides: { defaultCollation: null } }
    const text = exportConnections([c, none], { format: 'shardwise', includePasswords: false })
    const back = parseConnectionImport(text).connections
    expect(back[0].overrides?.defaultCollation).toEqual(BG2)
    expect(back[1].overrides?.defaultCollation).toBeNull()
    // A URI has no place for app preferences.
    expect(exportConnections([c], { format: 'uri', includePasswords: false })).not.toContain('collation')
  })
})

describe('history and saved queries', () => {
  it('stores the collation with find queries', async () => {
    const lib = new QueryLibrary(join(dir, 'lib'))
    lib.addHistory({ configId: 'c', connName: 'C', db: 'd', coll: 'x', payload: { kind: 'find', query: '{}', projection: '', sort: '{ name: 1 }', skip: '', limit: '', collation: "{ locale: 'bg', strength: 2 }" } })
    lib.addHistory({ configId: 'c', connName: 'C', db: 'd', coll: 'x', payload: { kind: 'find', query: '{}', projection: '', sort: '{ name: 1 }', skip: '', limit: '' } })
    const h = lib.listHistory({ text: 'strength' })
    expect(h).toHaveLength(1)
    expect(h[0].payload).toMatchObject({ kind: 'find', collation: "{ locale: 'bg', strength: 2 }" })
    const saved = lib.save({ name: 'Sorted', db: 'd', coll: 'x', payload: { kind: 'find', query: '{}', projection: '', sort: '', skip: '', limit: '', collation: '' } })
    expect(saved.payload).toMatchObject({ collation: '' })
    // An empty collation is the same query as none for duplicate detection.
    const p = { kind: 'find' as const, query: '{}', projection: '', sort: '', skip: '', limit: '' }
    expect(payloadKey({ ...p, collation: '' })).toBe(payloadKey(p))
    expect(payloadKey({ ...p, collation: "{ locale: 'bg' }" })).not.toBe(payloadKey(p))
    lib.close()
  })
})
