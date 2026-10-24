import { describe, expect, it } from 'vitest'
import { Decimal128, Double, Int32, Long, ObjectId } from 'bson'
import { DEFAULT_SETTINGS, normalizeSettings } from '@shared/settings'
import { setDataDateDisplay } from '@shared/dateFormat'
import {
  classifyShellOp,
  clipOutput,
  dedupeHistory,
  historyStorageKey,
  isEmptyFilter,
  leafText,
  needsConfirm,
  normalizeShellSettings,
  printValue,
  pushHistory,
  SHELL_DEFAULTS,
  trimHistory
} from '@shared/shellOptions'
import type { ShellOp } from '@shared/shellOptions'
import { searchPrefs } from '@shared/prefSearch'

describe('shell settings validation', () => {
  it('defaults are part of the app defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject(SHELL_DEFAULTS)
    expect(normalizeSettings({})).toMatchObject({ shellBatchSize: 20, shellHistoryLimit: 1000, shellConfirm: 'destructive', playgroundRunStartup: false, shellTimeoutMS: 0 })
  })

  it('keeps valid values', () => {
    const s = normalizeShellSettings({
      shellStartupSource: 'file',
      shellStartupFile: '  /home/me/.shardwiserc.js ',
      shellBatchSize: 50,
      shellMaxOutputLines: 2000,
      shellMaxOutputChars: 5000,
      shellPrintDepth: 3,
      shellNumberDisplay: 'plain',
      shellDateDisplay: 'data',
      shellConfirm: 'writes',
      shellHistoryLimit: 250,
      shellHistoryDedupe: false,
      shellHistoryScope: 'global',
      shellTimeoutMS: 30000,
      playgroundTimeoutMS: 120000,
      playgroundRunStartup: true,
      mongoshPath: ' C:\\tools\\mongosh.exe '
    })
    expect(s).toMatchObject({
      shellStartupSource: 'file',
      shellStartupFile: '/home/me/.shardwiserc.js',
      shellBatchSize: 50,
      shellPrintDepth: 3,
      shellNumberDisplay: 'plain',
      shellDateDisplay: 'data',
      shellConfirm: 'writes',
      shellHistoryLimit: 250,
      shellHistoryDedupe: false,
      shellHistoryScope: 'global',
      shellTimeoutMS: 30000,
      playgroundTimeoutMS: 120000,
      playgroundRunStartup: true,
      mongoshPath: 'C:\\tools\\mongosh.exe'
    })
  })

  it('clamps numbers and replaces values of the wrong type', () => {
    const s = normalizeSettings({
      shellStartupSource: 'url',
      shellStartupScript: 42,
      shellBatchSize: 0,
      shellMaxOutputLines: 1e9,
      shellMaxOutputChars: 'lots',
      shellPrintDepth: -2,
      shellNumberDisplay: 'hex',
      shellDateDisplay: true,
      shellConfirm: 'always',
      shellHistoryLimit: 3,
      shellHistoryDedupe: 'yes',
      shellHistoryScope: 'tab',
      shellTimeoutMS: -5,
      playgroundTimeoutMS: '1500',
      mongoshPath: null
    })
    expect(s).toMatchObject({
      shellStartupSource: 'inline',
      shellStartupScript: '',
      shellBatchSize: 1,
      shellMaxOutputLines: 100000,
      shellMaxOutputChars: SHELL_DEFAULTS.shellMaxOutputChars,
      shellPrintDepth: 1,
      shellNumberDisplay: 'typed',
      shellDateDisplay: 'iso',
      shellConfirm: 'destructive',
      shellHistoryLimit: 10,
      shellHistoryDedupe: true,
      shellHistoryScope: 'connection',
      shellTimeoutMS: 0,
      playgroundTimeoutMS: 1500,
      mongoshPath: ''
    })
  })

  it('is searchable in Settings', () => {
    expect(searchPrefs('mongoshrc')[0]).toMatchObject({ tab: 'shell', id: 'shellStartupScript' })
    expect(searchPrefs('confirm drop')[0]).toMatchObject({ tab: 'shell', id: 'shellConfirm' })
    expect(searchPrefs('mongosh path')[0]).toMatchObject({ tab: 'shell', id: 'mongoshPath' })
  })
})

describe('destructive command detection', () => {
  const coll = (method: string, ...args: unknown[]): ShellOp => ({ target: 'collection', db: 'shop', coll: 'orders', method, args })
  const db = (method: string, ...args: unknown[]): ShellOp => ({ target: 'database', db: 'shop', method, args })
  const level = (op: ShellOp): string | undefined => classifyShellOp(op)?.level

  it('treats an empty or missing filter as matching everything', () => {
    expect(isEmptyFilter(undefined)).toBe(true)
    expect(isEmptyFilter(null)).toBe(true)
    expect(isEmptyFilter({})).toBe(true)
    expect(isEmptyFilter({ a: 1 })).toBe(false)
    expect(isEmptyFilter([])).toBe(false)
  })

  it('flags drops, renames, index drops and whole-collection writes as destructive', () => {
    expect(level(coll('drop'))).toBe('destructive')
    expect(level(db('dropDatabase'))).toBe('destructive')
    expect(level(coll('dropIndexes'))).toBe('destructive')
    expect(level(coll('dropIndex', '*'))).toBe('destructive')
    expect(level(coll('renameCollection', 'old', true))).toBe('destructive')
    expect(classifyShellOp(coll('renameCollection', 'old', true))?.summary).toMatch(/replacing/)
    expect(level(coll('deleteMany', {}))).toBe('destructive')
    expect(level(coll('remove', {}))).toBe('destructive')
    expect(level(coll('updateMany', {}, { $set: { a: 1 } }))).toBe('destructive')
    expect(level(coll('bulkWrite', [{ insertOne: { document: {} } }, { deleteMany: { filter: {} } }]))).toBe('destructive')
    expect(level(db('runCommand', { drop: 'orders' }))).toBe('destructive')
    expect(level(db('runCommand', 'dropDatabase'))).toBe('destructive')
    expect(level(db('runCommand', { delete: 'orders', deletes: [{ q: {}, limit: 0 }] }))).toBe('destructive')
    expect(level(db('adminCommand', { renameCollection: 'shop.a', to: 'shop.b' }))).toBe('destructive')
  })

  it('flags filtered and single-document changes as plain writes', () => {
    expect(level(coll('deleteMany', { status: 'old' }))).toBe('write')
    expect(level(coll('remove', {}, true))).toBe('write')
    expect(level(coll('remove', {}, { justOne: true }))).toBe('write')
    expect(level(coll('updateMany', { a: 1 }, { $set: { b: 1 } }))).toBe('write')
    expect(level(coll('insertOne', { a: 1 }))).toBe('write')
    expect(level(coll('deleteOne', {}))).toBe('write')
    expect(level(coll('createIndex', { a: 1 }))).toBe('write')
    expect(level(coll('dropIndex', 'a_1'))).toBe('write')
    expect(level(db('createCollection', 'x'))).toBe('write')
    expect(level(db('runCommand', { insert: 'orders', documents: [{}] }))).toBe('write')
    expect(level(db('runCommand', { delete: 'orders', deletes: [{ q: { a: 1 }, limit: 0 }] }))).toBe('write')
  })

  it('ignores reads', () => {
    expect(classifyShellOp(coll('find', {}))).toBeNull()
    expect(classifyShellOp(coll('countDocuments'))).toBeNull()
    expect(classifyShellOp(db('runCommand', { ping: 1 }))).toBeNull()
    expect(classifyShellOp(db('runCommand', 'serverStatus'))).toBeNull()
    expect(classifyShellOp(db('getCollectionNames'))).toBeNull()
  })

  it('asks according to the mode', () => {
    expect(needsConfirm('off', 'destructive')).toBe(false)
    expect(needsConfirm('destructive', 'destructive')).toBe(true)
    expect(needsConfirm('destructive', 'write')).toBe(false)
    expect(needsConfirm('writes', 'write')).toBe(true)
    expect(needsConfirm('writes', undefined)).toBe(false)
    expect(needsConfirm(undefined, 'destructive')).toBe(false)
  })
})

describe('shell history', () => {
  it('appends, skips consecutive duplicates and drops the oldest', () => {
    let h: string[] = []
    for (const c of ['a', 'b', 'b', 'c', 'b']) h = pushHistory(h, c, { limit: 3, dedupe: true })
    expect(h).toEqual(['b', 'c', 'b'])
    let all: string[] = []
    for (const c of ['a', 'a', 'a']) all = pushHistory(all, c, { limit: 10, dedupe: false })
    expect(all).toEqual(['a', 'a', 'a'])
  })

  it('does not change the list it was given', () => {
    const list = ['x']
    pushHistory(list, 'y', { limit: 5, dedupe: true })
    expect(list).toEqual(['x'])
  })

  it('trims and dedupes existing lists', () => {
    expect(trimHistory(['1', '2', '3', '4'], 2)).toEqual(['3', '4'])
    expect(trimHistory(['1'], 0)).toEqual([])
    expect(dedupeHistory(['a', 'a', 'b', 'a', 'a'])).toEqual(['a', 'b', 'a'])
  })

  it('stores one list per connection or one for all', () => {
    expect(historyStorageKey('connection', 'abc')).toBe('shardwise.shell.history:abc')
    expect(historyStorageKey('global', 'abc')).toBe('shardwise.shell.history')
  })
})

describe('output clipping', () => {
  it('keeps everything within the limits', () => {
    expect(clipOutput(['a', 'b\nc'], 10, 100)).toEqual({ shown: ['a', 'b\nc'], hiddenLines: 0, hiddenChars: 0 })
    expect(clipOutput(['x'.repeat(50)], 0, 0).hiddenChars).toBe(0)
  })

  it('cuts at the line limit', () => {
    const r = clipOutput(['1\n2\n3', '4\n5'], 4, 1000)
    expect(r.shown).toEqual(['1\n2\n3', '4'])
    expect(r.hiddenLines).toBe(1)
    expect(r.hiddenChars).toBe(1)
  })

  it('cuts at the character limit and hides later texts', () => {
    const r = clipOutput(['abcdef', 'gh', 'ij'], 100, 4)
    expect(r.shown).toEqual(['abcd'])
    expect(r.hiddenChars).toBe(2 + 2 + 2)
    expect(r.hiddenLines).toBe(3)
  })
})

describe('shell printing', () => {
  it('prints numbers with or without their type', () => {
    expect(leafText(new Int32(5))).toBe("NumberInt('5')")
    expect(leafText(Long.fromNumber(7))).toBe("NumberLong('7')")
    const plain = { depth: 6, numbers: 'plain', dates: 'iso' } as const
    expect(leafText(new Int32(5), plain)).toBe('5')
    expect(leafText(Long.fromString('9007199254740993'), plain)).toBe('9007199254740993')
    expect(leafText(Decimal128.fromString('1.50'), plain)).toBe('1.50')
    expect(leafText(new Double(2.5), plain)).toBe('2.5')
  })

  it('prints dates as ISODate() or in the data date format', () => {
    const d = new Date(Date.UTC(2026, 0, 5, 10, 0, 0))
    expect(leafText(d)).toBe("ISODate('2026-01-05T10:00:00.000Z')")
    setDataDateDisplay({ zone: 'UTC', style: 'pattern', pattern: 'dd.MM.yyyy HH:mm' })
    try {
      expect(leafText(d, { depth: 6, numbers: 'typed', dates: 'data' })).toBe('05.01.2026 10:00')
    } finally {
      setDataDateDisplay({ zone: 'UTC', style: 'iso' })
    }
  })

  it('cuts nesting at the depth and keeps short documents on one line', () => {
    const v = { a: { b: { c: { d: 1 } } }, list: [1, 2] }
    expect(printValue(v, { depth: 2, numbers: 'plain', dates: 'iso' })).toBe('{ a: { b: [Object] }, list: [ 1, 2 ] }')
    const long = printValue({ id: new ObjectId('65a1b2c3d4e5f60718293a4b'), text: 'x'.repeat(80) })
    expect(long.split('\n')).toEqual(['{', "  id: ObjectId('65a1b2c3d4e5f60718293a4b'),", `  text: '${'x'.repeat(80)}'`, '}'])
    expect(printValue('top level text')).toBe('top level text')
    expect(printValue({ "it's": 'a\nb' })).toBe("{ 'it\\'s': 'a\\nb' }")
  })
})
