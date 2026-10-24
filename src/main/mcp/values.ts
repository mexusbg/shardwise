import { EJSON } from 'bson'
import { parseShellValue, shellText } from '@shared/bsonValue'
import type { Doc } from '@shared/api'

/** Keys of Extended JSON type wrappers (`{ $oid: … }`, `{ $date: … }`…). Query operators are not among them. */
const WRAPPERS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$type',
  '$uuid',
  '$timestamp',
  '$regularExpression',
  '$minKey',
  '$maxKey',
  '$symbol',
  '$code',
  '$scope',
  '$dbPointer',
  '$undefined'
])

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

/**
 * Turn Extended JSON wrappers inside plain JSON into BSON values. Unlike EJSON.deserialize this leaves
 * `{ $regex, $options, $ne }` alone: the legacy regex form would silently drop `$ne` and widen a filter.
 */
export function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive)
  if (!isPlain(v)) return v
  const keys = Object.keys(v)
  if (keys.length && keys.every((k) => WRAPPERS.has(k)) && !(keys.length === 1 && keys[0] === '$type')) {
    try {
      return EJSON.deserialize(v, { relaxed: false })
    } catch {
      /* not a valid wrapper: keep as is */
    }
  }
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = revive(v[k])
  return out
}

/** Parse a value given either as JSON / Extended JSON data or as text (JSON, Extended JSON or mongo shell syntax). */
export function parseValue(v: unknown, what: string): unknown {
  if (typeof v !== 'string') return revive(v)
  const text = v.trim()
  if (!text) return undefined
  try {
    return revive(JSON.parse(text))
  } catch {
    /* shell syntax */
  }
  try {
    return parseShellValue(text)
  } catch (e) {
    throw new Error(`Could not parse ${what}: ${(e as Error).message}`)
  }
}

export function parseDoc(v: unknown, what: string, fallback?: Doc): Doc {
  if (v === undefined || v === null) {
    if (fallback) return fallback
    throw new Error(`${what} is required`)
  }
  const d = parseValue(v, what)
  if (d === undefined && fallback) return fallback
  if (!isPlain(d)) throw new Error(`${what} must be an object`)
  return d as Doc
}

export function parseDocs(v: unknown, what: string): Doc[] {
  const d = parseValue(v, what)
  if (!Array.isArray(d)) throw new Error(`${what} must be an array`)
  for (const x of d) if (!isPlain(x)) throw new Error(`Every element of ${what} must be an object`)
  return d as Doc[]
}

export const ejson = (v: unknown): string => EJSON.stringify(v, undefined, 0, { relaxed: true })

export const RESULT_CAP = 50_000

export interface Formatted {
  text: string
  truncated: boolean
}

/** Relaxed EJSON of a document list, dropping trailing documents beyond the byte cap. */
export function formatDocs(header: string, docs: unknown[], cap = RESULT_CAP): Formatted {
  const parts: string[] = []
  let size = header.length + 2
  let truncated = false
  for (const d of docs) {
    const t = ejson(d)
    if (size + t.length + 1 > cap && parts.length) {
      truncated = true
      break
    }
    parts.push(t)
    size += t.length + 1
  }
  let text = `${header}\n[${parts.join(',\n')}]`
  if (truncated) text += `\n… output capped at ${Math.round(cap / 1000)} KB: showing ${parts.length} of ${docs.length} documents. Add a projection, narrow the filter or lower the limit.`
  else if (text.length > cap) {
    text = text.slice(0, cap) + `\n… output truncated at ${Math.round(cap / 1000)} KB (a single document is larger). Add a projection.`
    truncated = true
  }
  return { text, truncated }
}

/** Relaxed EJSON of any value, cut at the byte cap. */
export function formatValue(v: unknown, cap = RESULT_CAP): Formatted {
  const text = EJSON.stringify(v, undefined, 1, { relaxed: true })
  if (text.length <= cap) return { text, truncated: false }
  return { text: text.slice(0, cap) + `\n… output truncated at ${Math.round(cap / 1000)} KB of ${Math.round(text.length / 1000)} KB.`, truncated: true }
}

/** Short summary of tool arguments for the activity log. */
export function summarizeArgs(args: Record<string, unknown> | undefined, max = 300): string {
  if (!args) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue
    let t: string
    try {
      t = typeof v === 'string' ? v : JSON.stringify(v)
    } catch {
      t = String(v)
    }
    if (Array.isArray(v) && t.length > 80) t = `[${v.length} items]`
    else if (t.length > 120) t = `${t.slice(0, 117)}…`
    parts.push(`${k}=${t}`)
  }
  const s = parts.join(' ')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Shell-syntax text for the approval dialog, capped so a huge insert cannot freeze the UI. */
export function shell(v: unknown, cap = 20_000): string {
  const t = shellText(v, 2)
  return t.length > cap ? `${t.slice(0, cap)}\n/* … ${t.length - cap} more characters */` : t
}

export const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
