import { parseFilter, parseProject, parseSort, toJSString } from 'mongodb-query-parser'
import type { Doc } from '@shared/api'
import { CollationError, parseCollationText } from '@shared/collation'

/** Shell-syntax text for the query bar; short values stay on one line. */
export function formatQuery(v: unknown): string {
  if (v == null) return ''
  const flat = toJSString(v as object, 0) ?? ''
  if (flat.length <= 90) return spaced(flat)
  return toJSString(v as object, 2) ?? flat
}

/** Add breathing room to compact output: `{a:1}` → `{ a: 1 }`. Strings are left untouched. */
function spaced(s: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      out += c
      if (c === '\\') out += s[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      out += c
    } else if (c === '{' && s[i + 1] !== '}') out += '{ '
    else if (c === '}' && s[i - 1] !== '{') out += ' }'
    else if (c === ':') out += ': '
    else if (c === ',') out += ', '
    else out += c
  }
  return out
}

export interface ParsedQuery {
  filter: Doc
  projection: Doc | null
  sort: Doc | null
}

export class QueryTextError extends Error {
  constructor(
    public part: 'query' | 'projection' | 'sort' | 'collation',
    message: string
  ) {
    super(message)
  }
}

const clean = (m: string): string => m.replace(/\s+in\s*\([\s\S]*\)\s*$/, '').trim()

export function parseQueryParts(query: string, projection: string, sort: string): ParsedQuery {
  let filter: Doc
  try {
    filter = query.trim() ? (parseFilter(query) as Doc) : {}
  } catch (e) {
    throw new QueryTextError('query', clean((e as Error).message))
  }
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) throw new QueryTextError('query', 'Query must be an object')
  let proj: Doc | null = null
  try {
    proj = projection.trim() ? (parseProject(projection) as Doc) : null
  } catch (e) {
    throw new QueryTextError('projection', clean((e as Error).message))
  }
  let srt: Doc | null = null
  try {
    srt = sort.trim() ? (parseSort(sort) as Doc) : null
  } catch (e) {
    throw new QueryTextError('sort', clean((e as Error).message))
  }
  return { filter, projection: proj, sort: srt }
}

/** Collation text of the query bar → document (null = none); errors as QueryTextError('collation'). */
export function parseCollationPart(text: string): Doc | null {
  try {
    return parseCollationText(text) as Doc | null
  } catch (e) {
    throw new QueryTextError('collation', e instanceof CollationError ? e.message : clean((e as Error).message))
  }
}

/** Parse without throwing; undefined on error. */
export function tryParse(kind: 'query' | 'projection' | 'sort', text: string): Doc | null | undefined {
  try {
    if (!text.trim()) return kind === 'query' ? {} : null
    const v = kind === 'query' ? parseFilter(text) : kind === 'projection' ? parseProject(text) : parseSort(text)
    return v as Doc | null
  } catch {
    return undefined
  }
}
