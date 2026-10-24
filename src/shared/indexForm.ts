import { parseFilter, toJSString } from 'mongodb-query-parser'

type Doc = Record<string, unknown>

/** Index key kinds offered by the key builder. */
export type KeyKind = '1' | '-1' | 'text' | '2dsphere' | '2d' | 'hashed' | 'wildcard'

export const KEY_KINDS: { value: KeyKind; label: string }[] = [
  { value: '1', label: 'Ascending (1)' },
  { value: '-1', label: 'Descending (-1)' },
  { value: 'text', label: 'Text' },
  { value: '2dsphere', label: '2dsphere' },
  { value: '2d', label: '2d' },
  { value: 'hashed', label: 'Hashed' },
  { value: 'wildcard', label: 'Wildcard ($**)' }
]

export interface KeyRow {
  field: string
  kind: KeyKind
}

export interface IndexForm {
  keys: KeyRow[]
  name: string
  unique: boolean
  sparse: boolean
  hidden: boolean
  ttlEnabled: boolean
  ttl: string
  /** Shell syntax; empty = none. */
  partialFilter: string
  /** Empty = no collation. */
  collationLocale: string
  collationStrength: number
  defaultLanguage: string
  /** Shell syntax, e.g. `{ title: 10, body: 1 }`; empty = none. */
  weights: string
  /** Shell syntax; only with a whole-document `$**` key. */
  wildcardProjection: string
}

export const emptyIndexForm = (keys: KeyRow[] = [{ field: '', kind: '1' }]): IndexForm => ({
  keys,
  name: '',
  unique: false,
  sparse: false,
  hidden: false,
  ttlEnabled: false,
  ttl: '3600',
  partialFilter: '',
  collationLocale: '',
  collationStrength: 3,
  defaultLanguage: '',
  weights: '',
  wildcardProjection: ''
})

export const COLLATION_LOCALES: { value: string; label: string }[] = [
  { value: 'simple', label: 'simple (binary)' },
  { value: 'en', label: 'English (en)' },
  { value: 'en_US', label: 'English, US (en_US)' },
  { value: 'en_GB', label: 'English, UK (en_GB)' },
  { value: 'fr', label: 'French (fr)' },
  { value: 'de', label: 'German (de)' },
  { value: 'es', label: 'Spanish (es)' },
  { value: 'it', label: 'Italian (it)' },
  { value: 'pt', label: 'Portuguese (pt)' },
  { value: 'nl', label: 'Dutch (nl)' },
  { value: 'sv', label: 'Swedish (sv)' },
  { value: 'da', label: 'Danish (da)' },
  { value: 'nb', label: 'Norwegian (nb)' },
  { value: 'fi', label: 'Finnish (fi)' },
  { value: 'pl', label: 'Polish (pl)' },
  { value: 'cs', label: 'Czech (cs)' },
  { value: 'ro', label: 'Romanian (ro)' },
  { value: 'hu', label: 'Hungarian (hu)' },
  { value: 'tr', label: 'Turkish (tr)' },
  { value: 'el', label: 'Greek (el)' },
  { value: 'ru', label: 'Russian (ru)' },
  { value: 'uk', label: 'Ukrainian (uk)' },
  { value: 'ar', label: 'Arabic (ar)' },
  { value: 'he', label: 'Hebrew (he)' },
  { value: 'hi', label: 'Hindi (hi)' },
  { value: 'th', label: 'Thai (th)' },
  { value: 'vi', label: 'Vietnamese (vi)' },
  { value: 'ja', label: 'Japanese (ja)' },
  { value: 'ko', label: 'Korean (ko)' },
  { value: 'zh', label: 'Chinese (zh)' }
]

export const COLLATION_STRENGTHS: { value: number; label: string }[] = [
  { value: 1, label: '1 — base letters only (ignore case & accents)' },
  { value: 2, label: '2 — + accents (ignore case)' },
  { value: 3, label: '3 — + case (default)' },
  { value: 4, label: '4 — + punctuation' },
  { value: 5, label: '5 — identical' }
]

export const TEXT_LANGUAGES = [
  'none', 'danish', 'dutch', 'english', 'finnish', 'french', 'german', 'hungarian', 'italian', 'norwegian', 'portuguese', 'romanian',
  'russian', 'spanish', 'swedish', 'turkish'
]

const MAX_TTL = 2147483647
const SPECIAL = new Set(['text', '2dsphere', '2d', 'hashed'])
const IDENT = /^[A-Za-z_$][\w$]*$/

/** Key value written for a key builder row. */
function keyEntry(r: KeyRow): [string, unknown] {
  const field = r.field.trim()
  if (r.kind === 'wildcard') return [field && field !== '$**' ? `${field.replace(/\.\$\*\*$/, '')}.$**` : '$**', 1]
  if (r.kind === '1' || r.kind === '-1') return [field, Number(r.kind)]
  return [field, r.kind]
}

export const keyDocFromRows = (rows: KeyRow[]): Doc => Object.fromEntries(rows.map(keyEntry))

/** Name the server would generate for a key pattern. */
export const defaultIndexName = (key: Doc): string =>
  Object.entries(key)
    .map(([k, v]) => `${k}_${typeof v === 'object' ? String((v as { valueOf(): unknown }).valueOf()) : String(v)}`)
    .join('_')

/** Classify an index spec: text, 2dsphere, 2d, hashed, wildcard, ttl, compound or regular. */
export function indexType(spec: { key: Doc; expireAfterSeconds?: unknown }): string {
  const keys = Object.keys(spec.key ?? {})
  const vals = Object.values(spec.key ?? {})
  if (vals.includes('text')) return 'text'
  if (vals.includes('2dsphere')) return '2dsphere'
  if (vals.includes('2d')) return '2d'
  if (vals.includes('hashed')) return 'hashed'
  if (keys.some((k) => k === '$**' || k.endsWith('.$**'))) return 'wildcard'
  if (spec.expireAfterSeconds != null) return 'ttl'
  if (keys.length > 1) return 'compound'
  return 'regular'
}

const asNumber = (v: unknown): unknown => {
  const t = (v as { _bsontype?: string } | null)?._bsontype
  return t === 'Int32' || t === 'Double' || t === 'Long' ? Number((v as { valueOf(): unknown }).valueOf()) : v
}

/**
 * The key pattern as the user wrote it: text indexes are stored as `{ _fts: 'text', _ftsx: 1 }` plus
 * weights, which is turned back into `{ field: 'text', … }`.
 */
export function logicalKeys(spec: { key: Doc; weights?: Doc }): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const [k, v] of Object.entries(spec.key ?? {})) {
    if (k === '_ftsx') continue
    if (k === '_fts') {
      const w = Object.keys(spec.weights ?? {})
      if (w.length) for (const f of w) out.push([f, 'text'])
      else out.push(['$**', 'text'])
      continue
    }
    out.push([k, asNumber(v)])
  }
  return out
}

interface ParsedText {
  value?: Doc
  error?: string
}

function parseDocText(text: string, what: string): ParsedText {
  if (!text.trim()) return {}
  try {
    const v = parseFilter(text) as unknown
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { error: `${what} must be a document` }
    return { value: v as Doc }
  } catch (e) {
    return { error: `${what}: ${(e as Error).message.replace(/\s+in\s*\([\s\S]*\)\s*$/, '').trim()}` }
  }
}

export interface BuiltIndex {
  keys: Doc
  options: Doc
  errors: string[]
  warnings: string[]
}

export interface ExistingIndexLike {
  name: string
  key: Doc
  weights?: Doc
}

/** Turn the dialog form into createIndex keys + options, with validation messages. */
export function buildIndex(form: IndexForm, existing: ExistingIndexLike[] = []): BuiltIndex {
  const errors: string[] = []
  const warnings: string[] = []
  const rows = form.keys
  const keys = keyDocFromRows(rows)
  const options: Doc = {}

  if (!rows.length) errors.push('Add at least one key')
  if (rows.some((r) => r.kind !== 'wildcard' && !r.field.trim())) errors.push('Every key needs a field name')
  if (rows.some((r) => r.field.trim().startsWith('$') && r.field.trim() !== '$**')) errors.push('Field names cannot start with $')
  const fields = rows.map((r) => keyEntry(r)[0]).filter(Boolean)
  const dup = fields.find((f, i) => fields.indexOf(f) !== i)
  if (dup) errors.push(`Field ${dup} appears more than once`)

  const kinds = rows.map((r) => r.kind)
  const has = (k: KeyKind): boolean => kinds.includes(k)
  const hasText = has('text')
  if (kinds.filter((k) => k === 'hashed').length > 1) errors.push('An index can contain only one hashed field')
  if (kinds.filter((k) => k === '2d').length > 1) errors.push('An index can contain only one 2d field')
  if (has('2d') && rows[0]?.kind !== '2d') errors.push('A 2d key must be the first field of the index')
  if (has('wildcard') && (hasText || has('hashed') || has('2d') || has('2dsphere'))) errors.push('Wildcard keys cannot be combined with text, geo or hashed keys')
  if (kinds.filter((k) => k === 'wildcard').length > 1) errors.push('An index can contain only one wildcard key')

  const name = form.name.trim()
  if (name) {
    options.name = name
    if (existing.some((x) => x.name === name)) errors.push(`An index named ${name} already exists`)
  }

  if (form.unique) {
    options.unique = true
    if (has('hashed')) errors.push('Hashed indexes cannot be unique')
    if (has('wildcard')) errors.push('Wildcard indexes cannot be unique')
  }
  if (form.sparse) options.sparse = true
  if (form.hidden) options.hidden = true

  if (form.ttlEnabled) {
    const t = form.ttl.trim()
    const n = Number(t)
    if (!t || !Number.isInteger(n) || n < 0 || n > MAX_TTL) errors.push(`TTL must be a whole number of seconds between 0 and ${MAX_TTL}`)
    else options.expireAfterSeconds = n
    if (rows.length !== 1 || !(rows[0].kind === '1' || rows[0].kind === '-1')) errors.push('TTL needs a single ascending or descending date field')
    else if (rows[0].field.trim() === '_id') errors.push('TTL cannot be set on _id')
  }

  const pf = parseDocText(form.partialFilter, 'Partial filter')
  if (pf.error) errors.push(pf.error)
  else if (pf.value && Object.keys(pf.value).length) {
    options.partialFilterExpression = pf.value
    if (form.sparse) errors.push('Partial filter and sparse cannot be combined')
  }

  if (form.collationLocale) {
    const c: Doc = { locale: form.collationLocale }
    if (form.collationLocale !== 'simple' && form.collationStrength !== 3) c.strength = form.collationStrength
    options.collation = c
    if (hasText && form.collationLocale !== 'simple') errors.push('Text indexes support only the simple collation')
  }

  if (hasText) {
    if (form.defaultLanguage) options.default_language = form.defaultLanguage
    const w = parseDocText(form.weights, 'Weights')
    if (w.error) errors.push(w.error)
    else if (w.value && Object.keys(w.value).length) {
      const bad = Object.values(w.value).some((v) => {
        const n = Number(asNumber(v))
        return typeof asNumber(v) !== 'number' || !Number.isInteger(n) || n < 1 || n > 99999
      })
      if (bad) errors.push('Weights must be whole numbers from 1 to 99999')
      options.weights = w.value
    }
    const otherText = existing.find((x) => Object.values(x.key ?? {}).includes('text'))
    if (otherText) warnings.push(`A collection can have only one text index; ${otherText.name} already exists`)
  }

  const hasWildcardAll = rows.some((r) => r.kind === 'wildcard' && (!r.field.trim() || r.field.trim() === '$**'))
  const wp = parseDocText(form.wildcardProjection, 'Wildcard projection')
  if (wp.error) errors.push(wp.error)
  else if (wp.value && Object.keys(wp.value).length) {
    if (!hasWildcardAll) errors.push('A wildcard projection needs a whole-document $** key')
    options.wildcardProjection = wp.value
  }

  if (!errors.length) {
    const same = existing.find((x) => JSON.stringify(logicalKeys(x)) === JSON.stringify(Object.entries(keys)))
    if (same) warnings.push(`Index ${same.name} already has this key pattern`)
  }
  if (form.ttlEnabled && options.expireAfterSeconds !== undefined) warnings.push('TTL deletes only documents whose field holds a date or an array of dates')
  if (form.unique && !form.sparse && !options.partialFilterExpression) {
    if (rows.length === 1 && rows[0].field.trim() !== '_id') warnings.push('Documents missing the field count as null: only one of them can exist with a unique index')
  }

  return { keys, options, errors, warnings }
}

const keyText = (k: string): string => (IDENT.test(k) ? k : `'${k.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)

/** Compact shell-syntax text: `{ a: 1, b: { $gt: ISODate('…') } }`. */
export function shellLiteral(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.length ? `[ ${v.map(shellLiteral).join(', ')} ]` : '[]'
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && !('_bsontype' in (v as object))) {
    const e = Object.entries(v as Doc)
    return e.length ? `{ ${e.map(([k, x]) => `${keyText(k)}: ${shellLiteral(x)}`).join(', ')} }` : '{}'
  }
  return toJSString(v as object, 0) ?? String(v)
}

/** `db.coll.createIndex(keys, options)` shell command. */
export function createIndexShell(coll: string, keys: Doc, options: Doc = {}): string {
  const target = IDENT.test(coll) ? `db.${coll}` : `db.getCollection('${coll.replace(/'/g, "\\'")}')`
  const opts = Object.keys(options).length ? `, ${shellLiteral(options)}` : ''
  return `${target}.createIndex(${shellLiteral(keys)}${opts})`
}

/** Options needed to recreate an existing index (server defaults left out). */
export function specOptions(spec: Doc): Doc {
  const o: Doc = { name: spec.name }
  const key = (spec.key ?? {}) as Doc
  if (spec.unique) o.unique = true
  if (spec.sparse) o.sparse = true
  if (spec.hidden) o.hidden = true
  if (spec.expireAfterSeconds != null) o.expireAfterSeconds = asNumber(spec.expireAfterSeconds)
  if (spec.partialFilterExpression) o.partialFilterExpression = spec.partialFilterExpression
  const col = spec.collation as Doc | undefined
  if (col && col.locale) {
    const c: Doc = { locale: col.locale }
    if (col.strength != null && asNumber(col.strength) !== 3) c.strength = asNumber(col.strength)
    if (col.caseLevel) c.caseLevel = true
    if (col.caseFirst && col.caseFirst !== 'off') c.caseFirst = col.caseFirst
    if (col.numericOrdering) c.numericOrdering = true
    if (col.alternate && col.alternate !== 'non-ignorable') c.alternate = col.alternate
    o.collation = c
  }
  if ('_fts' in key) {
    const w = (spec.weights ?? {}) as Doc
    if (Object.values(w).some((v) => asNumber(v) !== 1)) o.weights = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, asNumber(v)]))
    if (spec.default_language && spec.default_language !== 'english') o.default_language = spec.default_language
    if (spec.language_override && spec.language_override !== 'language') o.language_override = spec.language_override
  }
  if (spec.wildcardProjection) o.wildcardProjection = spec.wildcardProjection
  for (const k of ['bits', 'min', 'max']) if (spec[k] != null) o[k] = asNumber(spec[k])
  return o
}

/** Shell command recreating an existing index. */
export function specCommand(coll: string, spec: Doc): string {
  const keys = Object.fromEntries(logicalKeys(spec as { key: Doc; weights?: Doc }))
  return createIndexShell(coll, keys, specOptions(spec))
}

export function humanBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`
}

/** Short display label of a key value: ↑ / ↓ for directions, the type name otherwise. */
export function keyLabel(v: unknown): string {
  const n = asNumber(v)
  if (typeof n === 'number') return n < 0 ? '↓' : '↑'
  return String(n)
}

export const isSpecialKey = (v: unknown): boolean => typeof v === 'string' && SPECIAL.has(v)
