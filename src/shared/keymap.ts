/**
 * Keyboard shortcut notation and keymap logic (no DOM, no Electron).
 *
 * Bindings are stored in a portable notation: modifiers then the key, joined with "-", e.g. "Mod-Enter",
 * "Mod-Shift-s", "Ctrl-Tab", "F5". "Mod" is the platform's primary modifier (Ctrl on Windows / Linux,
 * Command on macOS); "Ctrl" and "Meta" always mean those physical keys. Letters are lower case.
 */

export type Platform = 'mac' | 'other'

export const platformOf = (nodePlatform: string): Platform => (nodePlatform === 'darwin' ? 'mac' : 'other')

/** Where a command applies. Nested scopes are active together with their ancestors. */
export type KeyScope = 'global' | 'query' | 'table' | 'pipeline' | 'playground' | 'sql' | 'shell' | 'editor' | 'dialog'

/** Parent scope; null = a root. Dialogs are their own root: tab and window shortcuts pause while one is open. */
export const SCOPE_PARENT: Record<KeyScope, KeyScope | null> = {
  global: null,
  query: 'global',
  table: 'query',
  pipeline: 'global',
  playground: 'global',
  sql: 'global',
  shell: 'global',
  editor: 'global',
  dialog: null
}

export const SCOPE_LABELS: Record<KeyScope, string> = {
  global: 'Anywhere',
  query: 'Collection tab',
  table: 'Table view',
  pipeline: 'Pipeline editor',
  playground: 'Playground',
  sql: 'SQL query',
  shell: 'Shell',
  editor: 'Code editors',
  dialog: 'Dialogs'
}

/** The scope and its ancestors, innermost first. */
export function scopeChain(s: KeyScope): KeyScope[] {
  const out: KeyScope[] = []
  for (let c: KeyScope | null = s; c; c = SCOPE_PARENT[c]) out.push(c)
  return out
}

/** Two scopes can be active at the same time (one contains the other). */
export const scopesOverlap = (a: KeyScope, b: KeyScope): boolean => scopeChain(a).includes(b) || scopeChain(b).includes(a)

export const MAX_BINDINGS = 3

export interface CommandDef {
  id: string
  label: string
  category: string
  scope: KeyScope
  /** Default bindings (portable notation), at most MAX_BINDINGS. */
  keys: readonly string[]
  /** Extra words for the search box. */
  keywords?: string
}

/** Command id → bindings. As a setting it holds only the commands whose bindings differ from the defaults. */
export type Keymap = Record<string, string[]>

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

export interface ParsedKey {
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** Canonical key name: 'a', '5', '/', 'Enter', 'F5', 'ArrowUp', 'Space'… */
  key: string
}

const NAMED_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ContextMenu',
  'Pause',
  'PrintScreen'
]

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter',
  esc: 'Escape',
  del: 'Delete',
  ins: 'Insert',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  pagedn: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  spacebar: 'Space',
  apps: 'ContextMenu',
  plus: '+',
  minus: '-'
}
for (const k of NAMED_KEYS) KEY_ALIASES[k.toLowerCase()] = k

const MODIFIER_ALIASES: Record<string, keyof Omit<ParsedKey, 'key'>> = {
  mod: 'mod',
  cmdorctrl: 'mod',
  commandorcontrol: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta'
}

/** Canonical key name, or null when it is not a usable key. */
export function normalizeKeyName(name: string): string | null {
  if (name === ' ') return 'Space'
  if ([...name].length === 1) return /\s/.test(name) ? null : name.toLowerCase()
  const lower = name.toLowerCase()
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower)
  if (f) return `F${f[1]}`
  return KEY_ALIASES[lower] ?? null
}

/** Parse a binding ("Mod-Shift-s", "Ctrl+Alt+Del", "CmdOrCtrl+Enter"); null when invalid. */
export function parseKey(text: string): ParsedKey | null {
  if (typeof text !== 'string') return null
  const s = text.trim()
  if (!s) return null
  // Split on "-" or "+", except a trailing one that is the key itself ("Mod--", "Ctrl++").
  const parts = s.split(/[-+](?!$)/)
  const keyPart = parts.pop()!
  const p: ParsedKey = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: '' }
  for (const m of parts) {
    const flag = MODIFIER_ALIASES[m.trim().toLowerCase()]
    if (!flag || p[flag]) return null
    p[flag] = true
  }
  const key = normalizeKeyName(keyPart.trim() || keyPart)
  if (!key) return null
  p.key = key
  return p
}

/** Portable canonical text of a parsed binding. */
export function formatKey(p: ParsedKey): string {
  const out: string[] = []
  if (p.mod) out.push('Mod')
  if (p.ctrl) out.push('Ctrl')
  if (p.alt) out.push('Alt')
  if (p.shift) out.push('Shift')
  if (p.meta) out.push('Meta')
  out.push(p.key)
  return out.join('-')
}

/** Canonical portable form of a binding, or null when invalid. */
export function normalizeKey(text: string): string | null {
  const p = parseKey(text)
  return p ? formatKey(p) : null
}

/** "Mod" replaced by the platform's physical key: what the binding means on that platform. */
export function concreteKey(p: ParsedKey, platform: Platform): ParsedKey {
  return {
    mod: false,
    ctrl: p.ctrl || (p.mod && platform !== 'mac'),
    alt: p.alt,
    shift: p.shift,
    meta: p.meta || (p.mod && platform === 'mac'),
    key: p.key
  }
}

/** Platform-specific identity of a binding (two bindings with the same identity are the same keys). */
export function resolveKey(text: string, platform: Platform): string | null {
  const p = parseKey(text)
  return p ? formatKey(concreteKey(p, platform)) : null
}

const MAC_KEY_LABELS: Record<string, string> = {
  Enter: '↩',
  Escape: '⎋',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘',
  Space: 'Space'
}

const PC_KEY_LABELS: Record<string, string> = {
  Escape: 'Esc',
  Delete: 'Del',
  Insert: 'Ins',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ContextMenu: 'Menu',
  PrintScreen: 'PrtSc'
}

const keyCap = (key: string): string => (key.length === 1 ? key.toUpperCase() : key)

/** Human-readable label: "Ctrl+Shift+S" on Windows / Linux, "⇧⌘S" on macOS. */
export function keyLabel(text: string, platform: Platform): string {
  const parsed = parseKey(text)
  if (!parsed) return text
  const p = concreteKey(parsed, platform)
  if (platform === 'mac') {
    return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.meta ? '⌘' : ''}${MAC_KEY_LABELS[p.key] ?? keyCap(p.key)}`
  }
  const out: string[] = []
  if (p.ctrl) out.push('Ctrl')
  if (p.alt) out.push('Alt')
  if (p.shift) out.push('Shift')
  if (p.meta) out.push('Win')
  out.push(PC_KEY_LABELS[p.key] ?? keyCap(p.key))
  return out.join('+')
}

// ---------------------------------------------------------------------------
// Keyboard events
// ---------------------------------------------------------------------------

/** The parts of a KeyboardEvent the keymap reads. */
export interface KeyEventLike {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIER_KEY_NAMES = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Hyper', 'Super', 'Fn', 'FnLock', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock', 'Dead', 'Process', 'Unidentified'])

/** US-layout characters of punctuation keys, by physical position (used when Shift or the layout changes the character). */
const CODE_CHARS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  IntlBackslash: '\\'
}

/**
 * Key name of an event, or null for a modifier on its own. Latin letters come from the typed character
 * (so AZERTY / Dvorak users get the letter printed on the key); other layouts (Cyrillic, Greek…) and
 * shifted digits / punctuation fall back to the physical key, so Ctrl+W still works with a Bulgarian layout.
 */
export function eventKeyName(e: KeyEventLike): string | null {
  if (MODIFIER_KEY_NAMES.has(e.key)) return null
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) return e.key.toLowerCase()
  const code = e.code ?? ''
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1].toLowerCase()
  m = /^Digit([0-9])$/.exec(code)
  if (m) return m[1]
  if (CODE_CHARS[code] && (e.shiftKey || e.altKey || e.key.length !== 1 || !/[\x21-\x7e]/.test(e.key))) return CODE_CHARS[code]
  return normalizeKeyName(e.key)
}

/** Platform-specific identity of an event (comparable with resolveKey), or null for a lone modifier. */
export function eventIdentity(e: KeyEventLike): string | null {
  const key = eventKeyName(e)
  if (!key) return null
  return formatKey({ mod: false, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key })
}

/** Portable binding for a pressed combination (what the shortcut recorder stores), or null for a lone modifier. */
export function eventToKey(e: KeyEventLike, platform: Platform): string | null {
  const key = eventKeyName(e)
  if (!key) return null
  return formatKey({
    mod: platform === 'mac' ? e.metaKey : e.ctrlKey,
    ctrl: platform === 'mac' ? e.ctrlKey : false,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: platform === 'mac' ? false : e.metaKey,
    key
  })
}

const TYPING_KEYS = new Set(['Space', 'Enter', 'Backspace', 'Delete', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

/**
 * Whether the combination types or edits text when a text field has focus (a plain or shifted character,
 * Backspace, arrows… and AltGr / Option characters). App-wide shortcuts leave such keys to the field.
 */
export function isTypingCombo(identity: string, platform: Platform): boolean {
  const p = parseKey(identity)
  if (!p) return false
  const printable = p.key.length === 1 || TYPING_KEYS.has(p.key)
  if (!printable) return false
  if (!p.ctrl && !p.meta) return true
  // Ctrl+Alt is AltGr on Windows / Linux layouts.
  return platform !== 'mac' && p.ctrl && p.alt && !p.meta && p.key.length === 1
}

// ---------------------------------------------------------------------------
// Keymaps
// ---------------------------------------------------------------------------

/** Valid, de-duplicated (by meaning on any platform), canonical bindings, at most MAX_BINDINGS. */
export function normalizeBindings(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const k of list) {
    const n = typeof k === 'string' ? normalizeKey(k) : null
    if (n && !out.includes(n)) out.push(n)
    if (out.length >= MAX_BINDINGS) break
  }
  return out
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

const defaultsOf = (c: CommandDef): string[] => normalizeBindings([...c.keys])

/** Bindings of every command: the override when there is one, else the defaults. */
export function effectiveKeymap(commands: readonly CommandDef[], overrides: Keymap | undefined): Keymap {
  const out: Keymap = {}
  for (const c of commands) out[c.id] = overrides && Object.hasOwn(overrides, c.id) ? normalizeBindings(overrides[c.id]) : defaultsOf(c)
  return out
}

/** Only the commands whose bindings differ from the defaults (what is saved). */
export function diffKeymap(commands: readonly CommandDef[], keymap: Keymap): Keymap {
  const out: Keymap = {}
  for (const c of commands) {
    if (!Object.hasOwn(keymap, c.id)) continue
    const keys = normalizeBindings(keymap[c.id])
    if (!sameList(keys, defaultsOf(c))) out[c.id] = keys
  }
  return out
}

/** Stored overrides cleaned up: known commands only, valid bindings, no entries equal to the defaults. */
export function normalizeOverrides(raw: unknown, commands: readonly CommandDef[]): Keymap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const picked: Keymap = {}
  for (const c of commands) if (Object.hasOwn(r, c.id) && Array.isArray(r[c.id])) picked[c.id] = normalizeBindings(r[c.id])
  return diffKeymap(commands, picked)
}

export const isModified = (commands: readonly CommandDef[], overrides: Keymap, id: string): boolean => Object.hasOwn(diffKeymap(commands, overrides), id)

/** Concrete key → command ids bound to it (registry order). */
export function buildKeyIndex(commands: readonly CommandDef[], keymap: Keymap, platform: Platform): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const c of commands) {
    for (const k of keymap[c.id] ?? []) {
      const r = resolveKey(k, platform)
      if (!r) continue
      const list = index.get(r) ?? []
      if (!list.includes(c.id)) list.push(c.id)
      index.set(r, list)
    }
  }
  return index
}

export interface Conflict {
  /** Concrete key (platform identity). */
  key: string
  /** Commands in overlapping scopes bound to it. */
  ids: string[]
}

/** Keys bound to more than one command whose scopes can be active together. */
export function findConflicts(commands: readonly CommandDef[], keymap: Keymap, platform: Platform): Conflict[] {
  const byId = new Map(commands.map((c) => [c.id, c]))
  const out: Conflict[] = []
  for (const [key, ids] of buildKeyIndex(commands, keymap, platform)) {
    if (ids.length < 2) continue
    const involved = ids.filter((a) => ids.some((b) => a !== b && scopesOverlap(byId.get(a)!.scope, byId.get(b)!.scope)))
    if (involved.length) out.push({ key, ids: involved })
  }
  return out
}

/** Other commands that `key` would clash with if it were bound to `id`. */
export function conflictsFor(commands: readonly CommandDef[], keymap: Keymap, platform: Platform, id: string, key: string): CommandDef[] {
  const self = commands.find((c) => c.id === id)
  const r = resolveKey(key, platform)
  if (!self || !r) return []
  return commands.filter((c) => c.id !== id && scopesOverlap(c.scope, self.scope) && (keymap[c.id] ?? []).some((k) => resolveKey(k, platform) === r))
}

/** Remove every binding of `key` (same meaning on `platform`) from the given commands. */
export function unbindFrom(keymap: Keymap, ids: string[], key: string, platform: Platform): Keymap {
  const r = resolveKey(key, platform)
  const out: Keymap = { ...keymap }
  for (const id of ids) out[id] = (out[id] ?? []).filter((k) => resolveKey(k, platform) !== r)
  return out
}

/** Command ids bound to `identity`, innermost scope first, then registry order. */
export function commandsForKey(commands: readonly CommandDef[], index: Map<string, string[]>, identity: string): string[] {
  const ids = index.get(identity)
  if (!ids?.length) return []
  const depth = new Map(commands.map((c) => [c.id, scopeChain(c.scope).length]))
  return [...ids].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0))
}

// ---------------------------------------------------------------------------
// Keymap files
// ---------------------------------------------------------------------------

export const KEYMAP_FILE_FORMAT = 'shardwise-keymap'

/** File text for the given overrides (only bindings that differ from the defaults). */
export function serializeKeymap(commands: readonly CommandDef[], overrides: Keymap): string {
  const diff = diffKeymap(commands, overrides)
  const bindings = Object.fromEntries(commands.filter((c) => Object.hasOwn(diff, c.id)).map((c) => [c.id, diff[c.id]]))
  return JSON.stringify({ format: KEYMAP_FILE_FORMAT, version: 1, bindings }, null, 2) + '\n'
}

export interface KeymapImport {
  overrides: Keymap
  warnings: string[]
}

/**
 * Read a keymap file: `{ format, version, bindings: { id: [keys] } }` (or a bare `{ id: [keys] }` object).
 * Unknown commands and invalid keys are skipped with a warning; malformed files throw.
 */
export function parseKeymapFile(text: string, commands: readonly CommandDef[]): KeymapImport {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('The file is not valid JSON')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The file does not contain a keymap')
  const obj = data as Record<string, unknown>
  if (obj.format !== undefined && obj.format !== KEYMAP_FILE_FORMAT) throw new Error(`Unknown keymap format "${String(obj.format)}"`)
  if (typeof obj.version === 'number' && obj.version > 1) throw new Error(`Keymap version ${obj.version} is newer than this version of Shardwise supports`)
  const raw = obj.format !== undefined || 'bindings' in obj ? obj.bindings : obj
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The file has no "bindings" object')
  const known = new Set(commands.map((c) => c.id))
  const warnings: string[] = []
  const picked: Keymap = {}
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(id)) {
      warnings.push(`Unknown command "${id}" skipped`)
      continue
    }
    if (!Array.isArray(list)) {
      warnings.push(`"${id}": expected a list of keys`)
      continue
    }
    const valid: string[] = []
    for (const k of list) {
      const n = typeof k === 'string' ? normalizeKey(k) : null
      if (!n) warnings.push(`"${id}": invalid key ${JSON.stringify(k)} skipped`)
      else if (!valid.includes(n)) valid.push(n)
    }
    if (valid.length > MAX_BINDINGS) warnings.push(`"${id}": only the first ${MAX_BINDINGS} keys are kept`)
    picked[id] = valid.slice(0, MAX_BINDINGS)
  }
  return { overrides: diffKeymap(commands, picked), warnings }
}

// ---------------------------------------------------------------------------
// Window menu
// ---------------------------------------------------------------------------

/** Accelerators of the application menu (src/main/index.ts), for an informational note when one is rebound. */
export function menuShortcut(key: string, platform: Platform): string | null {
  const r = resolveKey(key, platform)
  if (!r) return null
  const list: [string, string][] = [
    ['Mod-r', 'Reload'],
    ['Mod-0', 'Actual Size'],
    ['Mod-=', 'Zoom In'],
    ['Mod-Shift-=', 'Zoom In'],
    ['Mod--', 'Zoom Out'],
    ['Mod-z', 'Undo'],
    ['Mod-Shift-z', 'Redo'],
    ['Mod-x', 'Cut'],
    ['Mod-c', 'Copy'],
    ['Mod-v', 'Paste'],
    ['Mod-a', 'Select All'],
    ['Mod-m', 'Minimize'],
    ['Mod-w', 'Close Window'],
    ...(platform === 'mac'
      ? ([
          ['Alt-Mod-i', 'Toggle Developer Tools'],
          ['Ctrl-Mod-f', 'Toggle Full Screen'],
          ['Mod-q', 'Quit'],
          ['Mod-h', 'Hide']
        ] as [string, string][])
      : ([
          ['Mod-Shift-i', 'Toggle Developer Tools'],
          ['Mod-y', 'Redo'],
          ['F11', 'Toggle Full Screen']
        ] as [string, string][]))
  ]
  return list.find(([k]) => resolveKey(k, platform) === r)?.[1] ?? null
}
