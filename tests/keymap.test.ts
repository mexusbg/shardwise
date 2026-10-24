import { describe, expect, it } from 'vitest'
import { COMMANDS } from '@shared/commands'
import {
  buildKeyIndex,
  commandsForKey,
  conflictsFor,
  diffKeymap,
  effectiveKeymap,
  eventIdentity,
  eventKeyName,
  eventToKey,
  findConflicts,
  isTypingCombo,
  keyLabel,
  MAX_BINDINGS,
  menuShortcut,
  normalizeBindings,
  normalizeKey,
  normalizeOverrides,
  parseKey,
  parseKeymapFile,
  resolveKey,
  scopesOverlap,
  serializeKeymap,
  unbindFrom
} from '@shared/keymap'
import type { CommandDef, KeyEventLike } from '@shared/keymap'
import { DEFAULT_SETTINGS, normalizeSettings } from '@shared/settings'

const ev = (key: string, o: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, code: o.code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o })

describe('key notation', () => {
  it('normalizes modifiers, aliases and case', () => {
    expect(normalizeKey('Mod-Enter')).toBe('Mod-Enter')
    expect(normalizeKey('shift-mod-S')).toBe('Mod-Shift-s')
    expect(normalizeKey('CmdOrCtrl+Shift+E')).toBe('Mod-Shift-e')
    expect(normalizeKey('Ctrl+Alt+Del')).toBe('Ctrl-Alt-Delete')
    expect(normalizeKey('cmd-,')).toBe('Meta-,')
    expect(normalizeKey('Option-Up')).toBe('Alt-ArrowUp')
    expect(normalizeKey('esc')).toBe('Escape')
    expect(normalizeKey('f12')).toBe('F12')
    expect(normalizeKey('Ctrl-pgdn')).toBe('Ctrl-PageDown')
    expect(normalizeKey(' ')).toBe(null)
    expect(normalizeKey('Space')).toBe('Space')
  })

  it('keeps "-" and "+" usable as keys', () => {
    expect(normalizeKey('Mod--')).toBe('Mod--')
    expect(normalizeKey('Mod-=')).toBe('Mod-=')
    expect(normalizeKey('Ctrl++')).toBe('Ctrl-+')
    expect(parseKey('Mod--')?.key).toBe('-')
  })

  it('rejects invalid bindings', () => {
    for (const bad of ['', 'Mod-', 'Hyper-x', 'Ctrl-Ctrl-x', 'Mod-F25', 'Mod-Shift', 'a-b', 'Mod-Enterr']) expect(normalizeKey(bad), bad).toBe(null)
    expect(parseKey(42 as unknown as string)).toBe(null)
  })

  it('resolves Mod per platform', () => {
    expect(resolveKey('Mod-s', 'other')).toBe('Ctrl-s')
    expect(resolveKey('Mod-s', 'mac')).toBe('Meta-s')
    expect(resolveKey('Ctrl-s', 'other')).toBe('Ctrl-s')
    expect(resolveKey('Ctrl-s', 'mac')).toBe('Ctrl-s')
    expect(resolveKey('Mod-Ctrl-s', 'other')).toBe('Ctrl-s')
  })

  it('formats labels per platform', () => {
    expect(keyLabel('Mod-Shift-s', 'other')).toBe('Ctrl+Shift+S')
    expect(keyLabel('Mod-Shift-s', 'mac')).toBe('⇧⌘S')
    expect(keyLabel('Mod-Enter', 'mac')).toBe('⌘↩')
    expect(keyLabel('Ctrl-Alt-Delete', 'other')).toBe('Ctrl+Alt+Del')
    expect(keyLabel('Ctrl-Alt-Delete', 'mac')).toBe('⌃⌥⌦')
    expect(keyLabel('Ctrl-PageDown', 'other')).toBe('Ctrl+PgDn')
    expect(keyLabel('F5', 'other')).toBe('F5')
    expect(keyLabel('Meta-a', 'other')).toBe('Win+A')
    expect(keyLabel('Mod-,', 'mac')).toBe('⌘,')
  })
})

describe('keyboard events', () => {
  it('maps the primary modifier to Mod when recording', () => {
    expect(eventToKey(ev('Enter', { ctrlKey: true }), 'other')).toBe('Mod-Enter')
    expect(eventToKey(ev('Enter', { metaKey: true }), 'mac')).toBe('Mod-Enter')
    expect(eventToKey(ev('c', { code: 'KeyC', ctrlKey: true }), 'mac')).toBe('Ctrl-c')
    expect(eventToKey(ev('a', { code: 'KeyA', metaKey: true }), 'other')).toBe('Meta-a')
    expect(eventToKey(ev('Control', { ctrlKey: true }), 'other')).toBe(null)
    expect(eventToKey(ev('Shift', { shiftKey: true }), 'other')).toBe(null)
  })

  it('uses the physical key for non-Latin layouts and shifted characters', () => {
    // Bulgarian / Russian layout: Ctrl+W types "в" / "ц".
    expect(eventKeyName(ev('ц', { code: 'KeyW', ctrlKey: true }))).toBe('w')
    expect(eventKeyName(ev('!', { code: 'Digit1', shiftKey: true }))).toBe('1')
    expect(eventKeyName(ev('?', { code: 'Slash', shiftKey: true }))).toBe('/')
    expect(eventKeyName(ev('/', { code: 'Slash' }))).toBe('/')
    // AZERTY: the letter printed on the key wins over its position.
    expect(eventKeyName(ev('a', { code: 'KeyQ', ctrlKey: true }))).toBe('a')
    expect(eventKeyName(ev(' ', { code: 'Space' }))).toBe('Space')
    expect(eventKeyName(ev('Esc'))).toBe('Escape')
    expect(eventKeyName(ev('Dead'))).toBe(null)
  })

  it('event identity matches the resolved binding', () => {
    const e = ev('S', { code: 'KeyS', ctrlKey: true, shiftKey: true })
    expect(eventIdentity(e)).toBe(resolveKey('Mod-Shift-s', 'other'))
    expect(eventIdentity(ev('s', { code: 'KeyS', metaKey: true }))).toBe(resolveKey('Mod-s', 'mac'))
  })

  it('leaves typing keys to text fields', () => {
    expect(isTypingCombo('a', 'other')).toBe(true)
    expect(isTypingCombo('Shift-a', 'other')).toBe(true)
    expect(isTypingCombo('Backspace', 'other')).toBe(true)
    expect(isTypingCombo('Ctrl-Alt-q', 'other')).toBe(true) // AltGr
    expect(isTypingCombo('Alt-e', 'mac')).toBe(true) // Option character
    expect(isTypingCombo('Ctrl-a', 'other')).toBe(false)
    expect(isTypingCombo('F5', 'other')).toBe(false)
    expect(isTypingCombo('Escape', 'other')).toBe(false)
    expect(isTypingCombo('Ctrl-Tab', 'other')).toBe(false)
  })
})

describe('keymaps', () => {
  const defs: CommandDef[] = [
    { id: 'a.run', label: 'Run', category: 'A', scope: 'query', keys: ['Mod-Enter', 'F5'] },
    { id: 'a.close', label: 'Close', category: 'A', scope: 'global', keys: ['Mod-w'] },
    { id: 'b.run', label: 'Run B', category: 'B', scope: 'sql', keys: ['Mod-Enter'] },
    { id: 'c.edit', label: 'Edit', category: 'C', scope: 'table', keys: ['Enter'] },
    { id: 'd.save', label: 'Save', category: 'D', scope: 'dialog', keys: ['Mod-Enter'] }
  ]

  it('merges overrides with defaults', () => {
    const k = effectiveKeymap(defs, { 'a.run': ['ctrl-r'], 'b.run': [] })
    expect(k['a.run']).toEqual(['Ctrl-r'])
    expect(k['b.run']).toEqual([])
    expect(k['a.close']).toEqual(['Mod-w'])
  })

  it('keeps only what differs from the defaults', () => {
    const k = effectiveKeymap(defs, {})
    expect(diffKeymap(defs, k)).toEqual({})
    expect(diffKeymap(defs, { ...k, 'a.close': ['Mod-q'], 'b.run': ['mod-enter'] })).toEqual({ 'a.close': ['Mod-q'] })
    expect(diffKeymap(defs, { 'a.run': [] })).toEqual({ 'a.run': [] })
  })

  it('normalizes stored overrides', () => {
    expect(normalizeOverrides(null, defs)).toEqual({})
    expect(normalizeOverrides(['x'], defs)).toEqual({})
    const raw = { 'a.run': ['F6', 'bogus-key', 'f6', 'F7', 'F8', 'F9'], 'gone.cmd': ['F1'], 'a.close': 'Mod-w', 'b.run': ['Mod-Enter'] }
    expect(normalizeOverrides(raw, defs)).toEqual({ 'a.run': ['F6', 'F7', 'F8'] })
  })

  it('limits and de-duplicates bindings', () => {
    expect(normalizeBindings(['F1', 'f1', 'F2', 'F3', 'F4'])).toEqual(['F1', 'F2', 'F3'])
    expect(normalizeBindings('F1')).toEqual([])
    expect(MAX_BINDINGS).toBe(3)
  })

  it('reports conflicts only in overlapping scopes', () => {
    expect(scopesOverlap('table', 'global')).toBe(true)
    expect(scopesOverlap('query', 'sql')).toBe(false)
    expect(scopesOverlap('dialog', 'global')).toBe(false)
    const k = effectiveKeymap(defs, {})
    // Mod-Enter in query, sql and dialog scopes: siblings, no conflict.
    expect(findConflicts(defs, k, 'other')).toEqual([])
    const clash = effectiveKeymap(defs, { 'a.close': ['Mod-w', 'F5'] })
    expect(findConflicts(defs, clash, 'other')).toEqual([{ key: 'F5', ids: ['a.run', 'a.close'] }])
    // A global key clashes with every tab scope, but not with dialogs.
    expect(conflictsFor(defs, k, 'other', 'a.close', 'Mod-Enter').map((c) => c.id)).toEqual(['a.run', 'b.run'])
    expect(conflictsFor(defs, k, 'other', 'b.run', 'F5').map((c) => c.id)).toEqual([])
  })

  it('treats Ctrl and Mod as the same key only where Mod is Ctrl', () => {
    const k = effectiveKeymap(defs, { 'a.close': ['Ctrl-Enter'] })
    expect(findConflicts(defs, k, 'other').map((c) => c.key)).toEqual(['Ctrl-Enter'])
    expect(findConflicts(defs, k, 'mac')).toEqual([])
  })

  it('replaces a key across commands', () => {
    const k = effectiveKeymap(defs, {})
    const next = unbindFrom(k, ['a.run'], 'Ctrl-Enter', 'other')
    expect(next['a.run']).toEqual(['F5'])
    expect(unbindFrom(k, ['a.run'], 'Ctrl-Enter', 'mac')['a.run']).toEqual(['Mod-Enter', 'F5'])
  })

  it('resolves the innermost scope first', () => {
    const k = effectiveKeymap(defs, { 'a.close': ['Mod-w', 'Enter'] })
    const index = buildKeyIndex(defs, k, 'other')
    expect(commandsForKey(defs, index, 'Enter')).toEqual(['c.edit', 'a.close'])
    expect(commandsForKey(defs, index, 'Ctrl-Enter')).toEqual(['a.run', 'b.run', 'd.save'])
    expect(commandsForKey(defs, index, 'F9')).toEqual([])
  })
})

describe('keymap files', () => {
  it('round-trips overrides', () => {
    const overrides = { 'query.run': ['F9'], 'tab.close': [] }
    const text = serializeKeymap(COMMANDS, overrides)
    expect(JSON.parse(text)).toMatchObject({ format: 'shardwise-keymap', version: 1 })
    expect(parseKeymapFile(text, COMMANDS)).toEqual({ overrides, warnings: [] })
  })

  it('accepts a bare map and reports what it skips', () => {
    const r = parseKeymapFile(JSON.stringify({ 'query.run': ['CmdOrCtrl+R', 'nonsense-key', 'F1', 'F2', 'F3'], 'no.such': ['F1'], 'tab.close': 'Mod-w' }), COMMANDS)
    expect(r.overrides).toEqual({ 'query.run': ['Mod-r', 'F1', 'F2'] })
    expect(r.warnings.join('\n')).toMatch(/invalid key "nonsense-key"/)
    expect(r.warnings.join('\n')).toMatch(/Unknown command "no.such"/)
    expect(r.warnings.join('\n')).toMatch(/expected a list/)
    expect(r.warnings.join('\n')).toMatch(/only the first 3/)
  })

  it('drops entries equal to the defaults', () => {
    const r = parseKeymapFile(JSON.stringify({ format: 'shardwise-keymap', version: 1, bindings: { 'tab.close': ['mod-w'] } }), COMMANDS)
    expect(r.overrides).toEqual({})
  })

  it('rejects malformed files', () => {
    expect(() => parseKeymapFile('{', COMMANDS)).toThrow(/not valid JSON/)
    expect(() => parseKeymapFile('[]', COMMANDS)).toThrow(/does not contain/)
    expect(() => parseKeymapFile('{"format":"vscode"}', COMMANDS)).toThrow(/Unknown keymap format/)
    expect(() => parseKeymapFile('{"format":"shardwise-keymap","version":2,"bindings":{}}', COMMANDS)).toThrow(/newer/)
    expect(() => parseKeymapFile('{"format":"shardwise-keymap","bindings":[]}', COMMANDS)).toThrow(/bindings/)
  })
})

describe('built-in commands', () => {
  it('have unique ids, valid defaults and at most three keys each', () => {
    const ids = new Set<string>()
    for (const c of COMMANDS) {
      expect(ids.has(c.id), c.id).toBe(false)
      ids.add(c.id)
      expect(c.keys.length).toBeLessThanOrEqual(MAX_BINDINGS)
      for (const k of c.keys) expect(normalizeKey(k), `${c.id}: ${k}`).toBe(k)
    }
  })

  it('have no conflicting defaults on any platform', () => {
    const k = effectiveKeymap(COMMANDS, {})
    expect(findConflicts(COMMANDS, k, 'other')).toEqual([])
    expect(findConflicts(COMMANDS, k, 'mac')).toEqual([])
  })

  it('keep the shortcuts the app had before the registry', () => {
    const k = effectiveKeymap(COMMANDS, {})
    expect(k['query.run']).toEqual(['Mod-Enter', 'Mod-r', 'F5'])
    expect(k['tab.close']).toEqual(['Mod-w'])
    expect(k['playground.save']).toEqual(['Mod-s'])
    expect(k['shell.interrupt']).toEqual(['Ctrl-c'])
    expect(k['table.edit']).toEqual(['Enter', 'F2'])
  })

  it('names the window menu accelerators a binding shadows', () => {
    expect(menuShortcut('Mod-r', 'other')).toBe('Reload')
    expect(menuShortcut('Ctrl-r', 'other')).toBe('Reload')
    expect(menuShortcut('Ctrl-r', 'mac')).toBe(null)
    expect(menuShortcut('F11', 'other')).toBe('Toggle Full Screen')
    expect(menuShortcut('F5', 'other')).toBe(null)
  })
})

describe('settings', () => {
  it('defaults to no overrides and cleans stored ones', () => {
    expect(DEFAULT_SETTINGS.keymap).toEqual({})
    expect(normalizeSettings({}).keymap).toEqual({})
    expect(normalizeSettings({ keymap: 'x' }).keymap).toEqual({})
    expect(normalizeSettings({ keymap: { 'query.run': ['shift-f5'], 'tab.close': ['Mod-w'], nope: ['F1'] } }).keymap).toEqual({ 'query.run': ['Shift-F5'] })
  })
})
