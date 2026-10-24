/**
 * Colours of BSON values in the table, tree and JSON views. The defaults are the theme tokens in styles.css
 * (`--t-string` …); users override single types per theme in Settings → Browsing data.
 */

export type ValueColorKey = 'string' | 'number' | 'bool' | 'date' | 'oid' | 'null' | 'object' | 'regex' | 'binary'
export type ThemeName = 'light' | 'dark'

/** Overrides per theme; a missing type keeps the default colour. */
export type ValueColors = Partial<Record<ThemeName, Partial<Record<ValueColorKey, string>>>>

export const VALUE_COLOR_TYPES: { key: ValueColorKey; label: string; sample: string }[] = [
  { key: 'string', label: 'String', sample: "'Иван Петров'" },
  { key: 'number', label: 'Number', sample: '1024' },
  { key: 'bool', label: 'Boolean', sample: 'true' },
  { key: 'date', label: 'Date', sample: '2026-10-22T09:15:00Z' },
  { key: 'oid', label: 'ObjectId', sample: '6537a1f…' },
  { key: 'null', label: 'Null', sample: 'null' },
  { key: 'object', label: 'Object / array', sample: '{ 3 fields }' },
  { key: 'regex', label: 'Regex', sample: '/^ord-/i' },
  { key: 'binary', label: 'Binary / UUID', sample: 'Binary(4)' }
]

/** Must match the `--t-*` values in styles.css. */
export const DEFAULT_VALUE_COLORS: Record<ThemeName, Record<ValueColorKey, string>> = {
  light: {
    string: '#0a7a3d',
    number: '#0b5cad',
    bool: '#8a3ffc',
    date: '#a3510a',
    oid: '#b3266b',
    null: '#646b78',
    object: '#5a6270',
    regex: '#9a6700',
    binary: '#6b5b95'
  },
  dark: {
    string: '#7ee2a8',
    number: '#79b8ff',
    bool: '#c4a7ff',
    date: '#ffb86b',
    oid: '#ff8fc8',
    null: '#959ca8',
    object: '#a7aeb9',
    regex: '#e3b341',
    binary: '#b9a7e8'
  }
}

const HEX = /^#[0-9a-f]{6}$/i
const KEYS = new Set<string>(VALUE_COLOR_TYPES.map((t) => t.key))

/** Keeps valid `#rrggbb` overrides that differ from the default; drops everything else. */
export function normalizeValueColors(raw: unknown): ValueColors {
  const out: ValueColors = {}
  if (!raw || typeof raw !== 'object') return out
  for (const theme of ['light', 'dark'] as const) {
    const src = (raw as Record<string, unknown>)[theme]
    if (!src || typeof src !== 'object') continue
    const picked: Partial<Record<ValueColorKey, string>> = {}
    for (const [k, v] of Object.entries(src)) {
      if (!KEYS.has(k) || typeof v !== 'string' || !HEX.test(v)) continue
      const key = k as ValueColorKey
      if (v.toLowerCase() !== DEFAULT_VALUE_COLORS[theme][key]) picked[key] = v.toLowerCase()
    }
    if (Object.keys(picked).length) out[theme] = picked
  }
  return out
}

export const valueColor = (vc: ValueColors, theme: ThemeName, key: ValueColorKey): string => vc[theme]?.[key] ?? DEFAULT_VALUE_COLORS[theme][key]

const decls = (o: Partial<Record<ValueColorKey, string>> | undefined): string =>
  Object.entries(o ?? {})
    .map(([k, v]) => `--t-${k}: ${v};`)
    .join(' ')

/**
 * CSS applying the overrides. `html:root` outranks the theme rules in styles.css (`:root`, `:root[data-theme=dark]`,
 * `:root:not([data-theme=light])` inside the dark media query) so the overrides win in every theme mode.
 */
export function valueColorsCss(vc: ValueColors): string {
  const light = decls(vc.light)
  const dark = decls(vc.dark)
  const out: string[] = []
  if (light) {
    out.push(`html:root[data-theme='light'] { ${light} }`)
    out.push(`@media (prefers-color-scheme: light) { html:root:not([data-theme='dark']) { ${light} } }`)
  }
  if (dark) {
    out.push(`html:root[data-theme='dark'] { ${dark} }`)
    out.push(`@media (prefers-color-scheme: dark) { html:root:not([data-theme='light']) { ${dark} } }`)
  }
  return out.join('\n')
}
