/** Find in Database: value search across the collections of one database. */

export type SearchType = 'auto' | 'string' | 'number' | 'objectId' | 'regex'

export interface SearchRequest {
  connId: string
  db: string
  text: string
  /** `auto`: numbers also match numeric fields, 24-hex / ObjectId("…") also ObjectId fields, /re/i is a regex. */
  type: SearchType
  /** Strings only: substring or whole value. */
  match: 'contains' | 'exact'
  caseSensitive: boolean
  /** null = every collection (views excluded). */
  collections: string[] | null
  /** Restrict to one dot path. */
  field?: string
  maxPerCollection: number
  /** Scan every document instead of querying the field paths found in a sample (slower, finds rare fields). */
  deep: boolean
}

export interface SearchMatch {
  /** Path with array positions, e.g. `items.2.sku`. */
  path: string
  /** Display text of the value (shortened). */
  value: string
  type: 'string' | 'number' | 'objectId'
}

export interface SearchHit {
  _id: unknown
  matches: SearchMatch[]
}

export interface SearchCollectionResult {
  coll: string
  hits: SearchHit[]
  /** More matches exist beyond `maxPerCollection`. */
  truncated: boolean
  /** Field paths queried (sample mode). */
  paths: number
  ms: number
  error?: string
}

export type SearchEvent =
  | { searchId: string; kind: 'collection'; result: SearchCollectionResult }
  | { searchId: string; kind: 'progress'; done: number; total: number; current: string[] }
  | { searchId: string; kind: 'done'; state: 'done' | 'cancelled' | 'error'; error?: string; ms: number }

/** Renderer-callable methods; implemented by `searchHandlers()` in src/main/search/search.ts. */
export interface SearchApi {
  /** Results stream as `search:event`. */
  searchStart(req: SearchRequest): string
  searchCancel(searchId: string): void
}

export interface SearchEvents {
  'search:event': SearchEvent
}
