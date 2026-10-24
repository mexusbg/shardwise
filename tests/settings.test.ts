import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { Double, Int32, ObjectId } from 'bson'
import { Store } from '../src/main/store'
import { clampHistoryLimit, DEFAULT_SETTINGS, normalizeSettings } from '@shared/settings'
import { docText } from '@shared/docText'
import { highlightParts, hitsByTab, PREF_ENTRIES, PREF_TABS, searchPrefs } from '@shared/prefSearch'
import { parseViewMap, viewKey, withView } from '@shared/viewMap'

const codec = {
  encrypt: async (s: string) => Buffer.from(s).toString('base64'),
  decrypt: async (s: string) => Buffer.from(s, 'base64').toString()
}

describe('normalizeSettings', () => {
  it('fills every key from the defaults for an empty or missing object', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid values and unknown keys', () => {
    const s = normalizeSettings({ pageSize: 200, theme: 'light', jsonStyle: 'canonical', historyLimit: 5000, futureKey: 1 })
    expect(s).toMatchObject({ pageSize: 200, theme: 'light', jsonStyle: 'canonical', historyLimit: 5000, futureKey: 1 })
  })

  it('replaces values of the wrong type or out of range', () => {
    const s = normalizeSettings({
      runQueryOnOpen: 'no',
      defaultResultView: 'explain',
      jsonStyle: 'xml',
      editorTabWidth: 40,
      editorFontSize: -3,
      historyLimit: 3,
      uiZoom: 9,
      editorFontFamily: '  Fira Code  '
    })
    expect(s.runQueryOnOpen).toBe(true)
    expect(s.defaultResultView).toBe('table')
    expect(s.jsonStyle).toBe('shell')
    expect(s.editorTabWidth).toBe(8)
    expect(s.editorFontSize).toBe(0)
    expect(normalizeSettings({ editorFontSize: 3 }).editorFontSize).toBe(8)
    expect(s.historyLimit).toBe(100)
    expect(s.uiZoom).toBe(2)
    expect(s.editorFontFamily).toBe('Fira Code')
  })

  it('completes a partial autocomplete map', () => {
    const s = normalizeSettings({ editorAutocomplete: { shell: false, sql: 'yes' } })
    expect(s.editorAutocomplete).toEqual({ query: true, pipeline: true, shell: false, sql: true, playground: true })
  })

  it('clamps the history limit', () => {
    expect(clampHistoryLimit(undefined)).toBe(1000)
    expect(clampHistoryLimit('2500')).toBe(2500)
    expect(clampHistoryLimit(99)).toBe(100)
    expect(clampHistoryLimit(1e9)).toBe(10000)
    expect(clampHistoryLimit(1234.6)).toBe(1235)
  })
})

describe('Store settings migration', () => {
  it('adds the new keys to a settings file written by an older version', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mg-settings-')), 'shardwise.json')
    writeFileSync(
      file,
      JSON.stringify({ version: 1, connections: [], defaultQueries: {}, settings: { pageSize: 20, toolsPath: '', queryTimeoutMS: 0, theme: 'light' } })
    )
    const store = new Store(file, codec)
    const s = await store.getSettings()
    expect(s.pageSize).toBe(20)
    expect(s.theme).toBe('light')
    expect(s.restoreSession).toBe('ask')
    expect(s.runQueryOnOpen).toBe(true)
    expect(s.historyLimit).toBe(1000)
    expect(s.editorAutocomplete.playground).toBe(true)
    expect(s.connectionManagerOnStart).toBe(true)
  })

  it('validates saved values and persists them', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mg-settings-')), 'shardwise.json')
    const store = new Store(file, codec)
    const saved = await store.saveSettings({ historyLimit: 20000, runQueryOnOpen: false, editorAutocomplete: { ...DEFAULT_SETTINGS.editorAutocomplete, sql: false } })
    expect(saved.historyLimit).toBe(10000)
    expect(saved.runQueryOnOpen).toBe(false)
    const onDisk = JSON.parse(readFileSync(file, 'utf8')).settings
    expect(onDisk).toMatchObject({ historyLimit: 10000, runQueryOnOpen: false, editorAutocomplete: { sql: false, shell: true } })
    const again = await new Store(file, codec).getSettings()
    expect(again.editorAutocomplete.sql).toBe(false)
  })

  it('returns copies that callers cannot mutate', async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'mg-settings-')), 'shardwise.json'), codec)
    const a = await store.getSettings()
    a.editorAutocomplete.query = false
    expect((await store.getSettings()).editorAutocomplete.query).toBe(true)
  })
})

describe('docText', () => {
  const doc = { _id: new ObjectId('65a1b2c3d4e5f60718293a4b'), qty: new Int32(3), price: new Double(2.5), at: new Date('2026-01-05T10:00:00Z') }

  it('writes shell syntax by default', () => {
    const t = docText(doc)
    expect(t).toContain("ObjectId('65a1b2c3d4e5f60718293a4b')")
    expect(t).toContain('ISODate(')
  })

  it('writes relaxed Extended JSON', () => {
    const v = JSON.parse(docText(doc, 'relaxed'))
    expect(v).toEqual({ _id: { $oid: '65a1b2c3d4e5f60718293a4b' }, qty: 3, price: 2.5, at: { $date: '2026-01-05T10:00:00Z' } })
  })

  it('writes canonical Extended JSON', () => {
    const v = JSON.parse(docText(doc, 'canonical'))
    expect(v.qty).toEqual({ $numberInt: '3' })
    expect(v.price).toEqual({ $numberDouble: '2.5' })
    expect(v.at).toEqual({ $date: { $numberLong: String(Date.parse('2026-01-05T10:00:00Z')) } })
  })

  it('handles lists and indentation', () => {
    const t = docText([{ a: 1 }, { a: 2 }], 'relaxed', 2)
    expect(JSON.parse(t)).toEqual([{ a: 1 }, { a: 2 }])
    expect(t).toContain('\n  ')
  })
})

describe('Settings search', () => {
  it('has a tab for every entry and unique ids per tab', () => {
    const tabs = new Set(PREF_TABS.map(([t]) => t))
    const seen = new Set<string>()
    for (const e of PREF_ENTRIES) {
      expect(tabs.has(e.tab)).toBe(true)
      const k = `${e.tab}/${e.id}`
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
  })

  it('finds settings by label, keyword and tab name', () => {
    expect(searchPrefs('font').map((e) => e.id)).toEqual(expect.arrayContaining(['editorFontFamily', 'editorFontSize']))
    expect(searchPrefs('ejson')[0].id).toBe('jsonStyle')
    expect(searchPrefs('are you sure')[0].id).toBe('confirmSingleDelete')
    expect(searchPrefs('history size')[0].id).toBe('historyLimit')
    expect(searchPrefs('mcp').every((e) => e.tab === 'ai')).toBe(true)
  })

  it('ranks label matches first and requires every word', () => {
    const r = searchPrefs('tab')
    expect(r[0].id).toBe('editorTabWidth')
    expect(searchPrefs('font zebra')).toEqual([])
    expect(searchPrefs('   ')).toEqual([])
  })

  it('counts hits per tab', () => {
    const hits = hitsByTab(searchPrefs('font'))
    expect(hits.editing).toBeGreaterThanOrEqual(2)
  })

  it('splits text for highlighting', () => {
    expect(highlightParts('Font size', 'size')).toEqual([
      { text: 'Font ', hit: false },
      { text: 'size', hit: true }
    ])
    expect(highlightParts('Tab width', '')).toEqual([{ text: 'Tab width', hit: false }])
  })
})

describe('view memory', () => {
  it('keeps the most recent views up to the maximum', () => {
    let m = {}
    m = withView(m, 'a', 'tree', 3)
    m = withView(m, 'b', 'json', 3)
    m = withView(m, 'c', 'table', 3)
    m = withView(m, 'a', 'json', 3)
    m = withView(m, 'd', 'tree', 3)
    expect(Object.keys(m)).toEqual(['c', 'a', 'd'])
    expect(m).toEqual({ c: 'table', a: 'json', d: 'tree' })
  })

  it('parses stored maps defensively', () => {
    expect(parseViewMap(null)).toEqual({})
    expect(parseViewMap('{oops')).toEqual({})
    expect(parseViewMap('[1,2]')).toEqual({})
    expect(parseViewMap(JSON.stringify({ x: 'tree', y: 'explain', z: 3 }))).toEqual({ x: 'tree' })
  })

  it('keys collections unambiguously', () => {
    expect(viewKey('c', 'a/b', 'd')).not.toBe(viewKey('c', 'a', 'b/d'))
  })
})
