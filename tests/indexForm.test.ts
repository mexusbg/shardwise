import { describe, expect, it } from 'vitest'
import { Int32 } from 'bson'
import {
  buildIndex,
  createIndexShell,
  defaultIndexName,
  emptyIndexForm,
  humanBytes,
  indexType,
  keyDocFromRows,
  keyLabel,
  logicalKeys,
  specCommand
} from '@shared/indexForm'
import type { IndexForm, KeyRow } from '@shared/indexForm'

const form = (keys: KeyRow[], p: Partial<IndexForm> = {}): IndexForm => ({ ...emptyIndexForm(keys), ...p })

describe('indexForm', () => {
  it('builds key documents for every key kind', () => {
    expect(
      keyDocFromRows([
        { field: 'a', kind: '1' },
        { field: 'b', kind: '-1' },
        { field: 'c', kind: 'hashed' }
      ])
    ).toEqual({ a: 1, b: -1, c: 'hashed' })
    expect(keyDocFromRows([{ field: '', kind: 'wildcard' }])).toEqual({ '$**': 1 })
    expect(keyDocFromRows([{ field: 'attrs', kind: 'wildcard' }])).toEqual({ 'attrs.$**': 1 })
    expect(keyDocFromRows([{ field: 'loc', kind: '2dsphere' }])).toEqual({ loc: '2dsphere' })
  })

  it('names indexes like the server', () => {
    expect(defaultIndexName({ a: 1, b: -1 })).toBe('a_1_b_-1')
    expect(defaultIndexName({ bio: 'text' })).toBe('bio_text')
    expect(defaultIndexName({ x: new Int32(1) })).toBe('x_1')
  })

  it('classifies index types', () => {
    expect(indexType({ key: { _id: 1 } })).toBe('regular')
    expect(indexType({ key: { a: 1, b: 1 } })).toBe('compound')
    expect(indexType({ key: { _fts: 'text', _ftsx: 1 } })).toBe('text')
    expect(indexType({ key: { loc: '2dsphere', a: 1 } })).toBe('2dsphere')
    expect(indexType({ key: { loc: '2d' } })).toBe('2d')
    expect(indexType({ key: { a: 'hashed' } })).toBe('hashed')
    expect(indexType({ key: { '$**': 1 } })).toBe('wildcard')
    expect(indexType({ key: { 'a.$**': 1 } })).toBe('wildcard')
    expect(indexType({ key: { at: 1 }, expireAfterSeconds: 0 })).toBe('ttl')
  })

  it('builds options and keeps TTL 0', () => {
    const b = buildIndex(form([{ field: 'createdAt', kind: '1' }], { ttlEnabled: true, ttl: '0', name: 'exp', hidden: true }))
    expect(b.errors).toEqual([])
    expect(b.keys).toEqual({ createdAt: 1 })
    expect(b.options).toEqual({ name: 'exp', hidden: true, expireAfterSeconds: 0 })
  })

  it('parses partial filter, collation, text options and wildcard projection', () => {
    const b = buildIndex(
      form([{ field: 'email', kind: '1' }], { unique: true, partialFilter: "{ email: { $exists: true }, at: { $gt: ISODate('2024-01-01') } }", collationLocale: 'fr', collationStrength: 2 })
    )
    expect(b.errors).toEqual([])
    expect(b.options.unique).toBe(true)
    expect((b.options.partialFilterExpression as { at: { $gt: Date } }).at.$gt).toBeInstanceOf(Date)
    expect(b.options.collation).toEqual({ locale: 'fr', strength: 2 })

    const t = buildIndex(form([{ field: 'title', kind: 'text' }, { field: 'body', kind: 'text' }], { defaultLanguage: 'french', weights: '{ title: 10 }' }))
    expect(t.errors).toEqual([])
    expect(t.options).toEqual({ default_language: 'french', weights: { title: 10 } })

    const w = buildIndex(form([{ field: '', kind: 'wildcard' }], { wildcardProjection: '{ secret: 0 }', defaultLanguage: 'french' }))
    expect(w.errors).toEqual([])
    expect(w.options).toEqual({ wildcardProjection: { secret: 0 } })
  })

  it('validates invalid combinations', () => {
    const errs = (f: IndexForm): string => buildIndex(f).errors.join(' | ')
    expect(errs(form([]))).toMatch(/at least one key/)
    expect(errs(form([{ field: '', kind: '1' }]))).toMatch(/field name/)
    expect(errs(form([{ field: 'a', kind: '1' }, { field: 'a', kind: '-1' }]))).toMatch(/more than once/)
    expect(errs(form([{ field: 'a', kind: 'hashed' }], { unique: true }))).toMatch(/Hashed indexes cannot be unique/)
    expect(errs(form([{ field: 'a', kind: '1' }, { field: 'b', kind: '1' }], { ttlEnabled: true }))).toMatch(/single ascending or descending date field/)
    expect(errs(form([{ field: 'a', kind: 'text' }], { ttlEnabled: true }))).toMatch(/single ascending/)
    expect(errs(form([{ field: 'a', kind: '1' }], { ttlEnabled: true, ttl: '-5' }))).toMatch(/whole number/)
    expect(errs(form([{ field: 'a', kind: '1' }], { partialFilter: '{ a: ' }))).toMatch(/Partial filter/)
    expect(errs(form([{ field: 'a', kind: '1' }], { partialFilter: '{ a: 1 }', sparse: true }))).toMatch(/cannot be combined/)
    expect(errs(form([{ field: 'a', kind: 'text' }], { collationLocale: 'en' }))).toMatch(/simple collation/)
    expect(errs(form([{ field: 'a', kind: '1' }, { field: 'g', kind: '2d' }]))).toMatch(/first field/)
    expect(errs(form([{ field: 'a', kind: '1' }], { wildcardProjection: '{ a: 1 }' }))).toMatch(/whole-document/)
    expect(errs(form([{ field: 't', kind: 'text' }], { weights: '{ t: 0 }' }))).toMatch(/Weights/)
    expect(buildIndex(form([{ field: 'a', kind: '1' }], { name: 'a_1' }), [{ name: 'a_1', key: { b: 1 } }]).errors.join()).toMatch(/already exists/)
  })

  it('warns about an existing text index and duplicate key patterns', () => {
    const existing = [
      { name: '_id_', key: { _id: 1 } },
      { name: 'bio_text', key: { _fts: 'text', _ftsx: 1 }, weights: { bio: 1 } },
      { name: 'a_1', key: { a: new Int32(1) } }
    ]
    expect(buildIndex(form([{ field: 'title', kind: 'text' }]), existing).warnings.join()).toMatch(/only one text index; bio_text/)
    expect(buildIndex(form([{ field: 'a', kind: '1' }]), existing).warnings.join()).toMatch(/a_1 already has this key pattern/)
  })

  it('renders shell commands', () => {
    expect(createIndexShell('users', { email: 1 })).toBe('db.users.createIndex({ email: 1 })')
    expect(createIndexShell('my-coll', { 'a.b': -1 }, { unique: true, partialFilterExpression: { s: { $in: ['x'] } } })).toBe(
      "db.getCollection('my-coll').createIndex({ 'a.b': -1 }, { unique: true, partialFilterExpression: { s: { $in: [ 'x' ] } } })"
    )
    expect(createIndexShell('e', { at: 1 }, { expireAfterSeconds: 0, x: new Date(0) })).toBe(
      "db.e.createIndex({ at: 1 }, { expireAfterSeconds: 0, x: ISODate('1970-01-01T00:00:00.000Z') })"
    )
  })

  it('rebuilds commands for existing indexes', () => {
    const text = { v: 2, name: 'title_text_body_text', key: { _fts: 'text', _ftsx: 1 }, weights: { title: 5, body: 1 }, default_language: 'english', language_override: 'language', textIndexVersion: 3 }
    expect(logicalKeys(text)).toEqual([
      ['title', 'text'],
      ['body', 'text']
    ])
    expect(specCommand('docs', text)).toBe("db.docs.createIndex({ title: 'text', body: 'text' }, { name: 'title_text_body_text', weights: { title: 5, body: 1 } })")
    const ttl = { v: 2, name: 'ttl', key: { at: new Int32(1) }, expireAfterSeconds: new Int32(0), hidden: true }
    expect(specCommand('e', ttl)).toBe("db.e.createIndex({ at: 1 }, { name: 'ttl', hidden: true, expireAfterSeconds: 0 })")
    const col = { name: 'n_1', key: { n: 1 }, collation: { locale: 'fr', caseLevel: false, caseFirst: 'off', strength: 2, numericOrdering: false, alternate: 'non-ignorable', version: '57.1' } }
    expect(specCommand('c', col)).toBe("db.c.createIndex({ n: 1 }, { name: 'n_1', collation: { locale: 'fr', strength: 2 } })")
  })

  it('formats sizes and key labels', () => {
    expect(humanBytes(undefined)).toBe('—')
    expect(humanBytes(512)).toBe('512 B')
    expect(humanBytes(20480)).toBe('20 KB')
    expect(humanBytes(1536 * 1024)).toBe('1.5 MB')
    expect(keyLabel(1)).toBe('↑')
    expect(keyLabel(new Int32(-1))).toBe('↓')
    expect(keyLabel('2dsphere')).toBe('2dsphere')
  })
})
