import { isPlainDoc, parseShellValue } from './bsonValue'

/**
 * Collation of a query (MongoDB `collation` option): language-aware string comparison for sort, equality,
 * ranges, count and the write operations that match by filter. Stored in the query bar as shell text
 * (`{ locale: 'bg', strength: 2 }`); empty text = no collation (binary order or the collection default).
 */
export interface Collation {
  locale: string
  /** 1 = base letters, 2 = + accents (case-insensitive), 3 = + case (ICU default), 4 = + punctuation, 5 = identical. */
  strength?: number
  caseLevel?: boolean
  caseFirst?: 'upper' | 'lower' | 'off'
  numericOrdering?: boolean
  alternate?: 'non-ignorable' | 'shifted'
  maxVariable?: 'punct' | 'space'
  normalization?: boolean
  backwards?: boolean
}

/** Field order of formatted collation text. */
export const COLLATION_KEYS = ['locale', 'strength', 'caseLevel', 'caseFirst', 'numericOrdering', 'alternate', 'maxVariable', 'normalization', 'backwards'] as const

export class CollationError extends Error {}

/** Locales offered in pickers; any other ICU locale can be typed. `''` = no collation. */
export const COLLATION_LOCALES: { value: string; label: string }[] = [
  { value: '', label: 'None (binary / collection default)' },
  { value: 'simple', label: 'simple (force binary)' },
  { value: 'bg', label: 'Bulgarian (bg)' },
  { value: 'ru', label: 'Russian (ru)' },
  { value: 'uk', label: 'Ukrainian (uk)' },
  { value: 'sr', label: 'Serbian (sr)' },
  { value: 'mk', label: 'Macedonian (mk)' },
  { value: 'be', label: 'Belarusian (be)' },
  { value: 'en', label: 'English (en)' },
  { value: 'de', label: 'German (de)' },
  { value: 'fr', label: 'French (fr)' },
  { value: 'es', label: 'Spanish (es)' },
  { value: 'it', label: 'Italian (it)' },
  { value: 'pt', label: 'Portuguese (pt)' },
  { value: 'nl', label: 'Dutch (nl)' },
  { value: 'pl', label: 'Polish (pl)' },
  { value: 'cs', label: 'Czech (cs)' },
  { value: 'ro', label: 'Romanian (ro)' },
  { value: 'el', label: 'Greek (el)' },
  { value: 'tr', label: 'Turkish (tr)' },
  { value: 'sv', label: 'Swedish (sv)' },
  { value: 'fi', label: 'Finnish (fi)' },
  { value: 'da', label: 'Danish (da)' },
  { value: 'nb', label: 'Norwegian (nb)' },
  { value: 'hu', label: 'Hungarian (hu)' },
  { value: 'ar', label: 'Arabic (ar)' },
  { value: 'he', label: 'Hebrew (he)' },
  { value: 'zh', label: 'Chinese (zh)' },
  { value: 'ja', label: 'Japanese (ja)' },
  { value: 'ko', label: 'Korean (ko)' }
]

export const COLLATION_STRENGTHS: { value: number; label: string }[] = [
  { value: 1, label: '1 — base letters (ignore case and accents)' },
  { value: 2, label: '2 — ignore case' },
  { value: 3, label: '3 — case-sensitive (default)' },
  { value: 4, label: '4 — + punctuation' },
  { value: 5, label: '5 — identical' }
]

const num = (v: unknown): unknown => (v !== null && typeof v === 'object' && typeof (v as { valueOf(): unknown }).valueOf === 'function' ? (v as { valueOf(): unknown }).valueOf() : v)

function oneOf<T extends string>(v: unknown, key: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new CollationError(`${key} must be ${allowed.map((a) => `'${a}'`).join(', ')}`)
  return v as T
}

function bool(v: unknown, key: string): boolean {
  if (typeof v !== 'boolean') throw new CollationError(`${key} must be true or false`)
  return v
}

/** Checked copy of a collation document (fields in canonical order); throws CollationError. */
export function validateCollation(v: unknown): Collation {
  if (!isPlainDoc(v)) throw new CollationError('Collation must be an object such as { locale: \'bg\', strength: 2 }')
  for (const k of Object.keys(v)) if (!(COLLATION_KEYS as readonly string[]).includes(k)) throw new CollationError(`Unknown collation field "${k}"`)
  const locale = v.locale
  if (typeof locale !== 'string' || !locale.trim()) throw new CollationError('Collation needs a locale, e.g. { locale: \'bg\' }')
  if (/\s/.test(locale.trim())) throw new CollationError(`Invalid locale "${locale}"`)
  const out: Collation = { locale: locale.trim() }
  if (v.strength !== undefined) {
    const s = num(v.strength)
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 1 || s > 5) throw new CollationError('strength must be a whole number from 1 to 5')
    out.strength = s
  }
  if (v.caseLevel !== undefined) out.caseLevel = bool(v.caseLevel, 'caseLevel')
  if (v.caseFirst !== undefined) out.caseFirst = oneOf(v.caseFirst, 'caseFirst', ['upper', 'lower', 'off'] as const)
  if (v.numericOrdering !== undefined) out.numericOrdering = bool(v.numericOrdering, 'numericOrdering')
  if (v.alternate !== undefined) out.alternate = oneOf(v.alternate, 'alternate', ['non-ignorable', 'shifted'] as const)
  if (v.maxVariable !== undefined) out.maxVariable = oneOf(v.maxVariable, 'maxVariable', ['punct', 'space'] as const)
  if (v.normalization !== undefined) out.normalization = bool(v.normalization, 'normalization')
  if (v.backwards !== undefined) out.backwards = bool(v.backwards, 'backwards')
  return out
}

/** Collation option for the driver: none for null / undefined / `{}`, else validated (throws CollationError). */
export function toCollation(v: unknown): Collation | undefined {
  if (v === null || v === undefined) return undefined
  if (isPlainDoc(v) && !Object.keys(v).length) return undefined
  return validateCollation(v)
}

/** Query bar text → collation; empty text = none. Throws CollationError with a readable message. */
export function parseCollationText(text: string): Collation | null {
  const t = text.trim()
  if (!t) return null
  let v: unknown
  try {
    v = parseShellValue(t)
  } catch (e) {
    throw new CollationError((e as Error).message.replace(/\s+in\s*\([\s\S]*\)\s*$/, '').trim() || 'Invalid collation')
  }
  return toCollation(v) ?? null
}

/** Like parseCollationText, but null for text that is empty or invalid. */
export function tryCollationText(text: string | undefined): Collation | null {
  try {
    return parseCollationText(text ?? '')
  } catch {
    return null
  }
}

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** Shell text of a collation (`{ locale: 'bg', strength: 2 }`); '' for none. */
export function formatCollation(c: Collation | null | undefined): string {
  if (!c) return ''
  const parts: string[] = []
  for (const k of COLLATION_KEYS) {
    const v = c[k]
    if (v === undefined) continue
    parts.push(`${k}: ${typeof v === 'string' ? quote(v) : String(v)}`)
  }
  return `{ ${parts.join(', ')} }`
}

/** Short chip text: `bg · 2`, `ru · 2 · 1-2-10`. */
export function collationLabel(c: Collation): string {
  const parts = [c.locale]
  if (c.strength !== undefined) parts.push(String(c.strength))
  if (c.numericOrdering) parts.push('1-2-10')
  if (c.caseFirst && c.caseFirst !== 'off') parts.push(c.caseFirst === 'upper' ? 'A<a' : 'a<A')
  if (c.caseLevel) parts.push('case')
  if (c.alternate === 'shifted') parts.push('shifted')
  if (c.backwards) parts.push('backwards')
  return parts.join(' · ')
}

/** Equality ignores case at strength 1 and 2 (unless caseLevel is on). */
export const isCaseInsensitive = (c: Collation | null | undefined): boolean => !!c && c.locale !== 'simple' && (c.strength ?? 3) <= 2 && !c.caseLevel

/**
 * Default collation of new query tabs: the connection's override when it has one (`null` there = none),
 * else the preference. Invalid stored values count as none.
 */
export function effectiveCollation(override: Collation | null | undefined, global: Collation | null | undefined): Collation | null {
  const v = override !== undefined ? override : global
  try {
    return toCollation(v) ?? null
  } catch {
    return null
  }
}
