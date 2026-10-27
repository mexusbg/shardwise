import { isPlainDoc } from './bsonValue'

type Doc = Record<string, unknown>

/** Dot paths of all leaf and object fields in a document (arrays are leaves). */
export function docPaths(doc: Doc, prefix = '', out: string[] = [], seen = new Set<string>()): string[] {
  for (const [k, v] of Object.entries(doc)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
    if (isPlainDoc(v)) docPaths(v, p, out, seen)
  }
  return out
}

/** Union of field paths across documents, in first-seen order. */
export function collectPaths(docs: Doc[], leavesOnly = false): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of docs) docPaths(d, '', out, seen)
  if (!leavesOnly) return out
  return out.filter((p) => !out.some((q) => q.startsWith(`${p}.`)))
}

/** Read a dot path; numeric segments index into arrays. */
export function getPath(doc: unknown, path: string): unknown {
  if (!path) return doc
  let cur: unknown = doc
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined
    else if (typeof cur === 'object') cur = (cur as Doc)[seg]
    else return undefined
  }
  return cur
}

/**
 * Whether `path` holds an array in the given documents: 'array' if any of them does, 'other' if it only holds
 * other values, 'unknown' if no document has it (e.g. nothing loaded yet).
 */
export function arrayFieldState(docs: unknown[], path: string): 'array' | 'other' | 'unknown' {
  let seen = false
  for (const d of docs) {
    const v = getPath(d, path)
    if (Array.isArray(v)) return 'array'
    if (v !== undefined) seen = true
  }
  return seen ? 'other' : 'unknown'
}

export function hasPath(doc: unknown, path: string): boolean {
  const segs = path.split('.')
  const last = segs.pop()!
  const parent = segs.length ? getPath(doc, segs.join('.')) : doc
  if (Array.isArray(parent)) return /^\d+$/.test(last) && Number(last) < parent.length
  return parent !== null && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, last)
}

/** Immutable set of a dot path (creates intermediate objects). */
export function setPath<T>(doc: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.')
  const container: unknown = doc
  if (Array.isArray(container)) {
    const copy = [...container]
    const i = Number(head)
    copy[i] = rest.length ? setPath(copy[i] ?? {}, rest.join('.'), value) : value
    return copy as T
  }
  const obj = { ...(container as Doc) }
  obj[head] = rest.length ? setPath(obj[head] ?? {}, rest.join('.'), value) : value
  return obj as T
}

export const joinPath = (a: string, b: string | number): string => (a ? `${a}.${b}` : String(b))

export const parentPath = (p: string): string => p.split('.').slice(0, -1).join('.')

export const lastSegment = (p: string): string => p.split('.').pop() ?? p
