import { autoCastFilter, hasCastCandidates } from '@shared/autoCast'
import { knownFieldType } from '@shared/vqb/tree'
import { groupToFilter, filterToGroup } from '@shared/vqb/filter'
import { itemsToProjection, itemsToSort, projectionToItems, sortToItems } from '@shared/vqb/projectionSort'
import { VqbValueError } from '@shared/vqb/types'
import type { DefaultQueryScope, Doc, DocScope, QueryPayload, SavedQuery } from '@shared/api'
import { api } from '../lib/api'
import { formatQuery, parseCollationPart, parseQueryParts, QueryTextError, tryParse } from '../lib/queryText'
import { errorText, getTab, patchTab, toast, useStore } from './store'
import type { AppliedQuery, ExplainVerbosity, QueryTab, VqbState } from './store'

/** Sample documents used to learn field types for auto-casting, per tab. */
const typeSamples = new Map<string, Doc[]>()

async function castQuery(tab: QueryTab, filter: Doc): Promise<{ filter: Doc; casts: number }> {
  if (!useStore.getState().settings.autoCast || !hasCastCandidates(filter)) return { filter, casts: 0 }
  let docs = tab.docs?.length ? tab.docs : typeSamples.get(tab.id)
  if (!docs) {
    try {
      docs = (await api.find(tab.connId, tab.db, tab.coll, { filter: {}, skip: 0, limit: 20 })).docs
      typeSamples.set(tab.id, docs)
    } catch {
      docs = []
    }
  }
  return autoCastFilter(filter, (p) => knownFieldType(docs!, p))
}

/** The tab's query bar as a history / saved-query payload. */
export function findPayload(tab: QueryTab): Extract<QueryPayload, { kind: 'find' }> {
  return { kind: 'find', query: tab.queryText, projection: tab.projectionText, sort: tab.sortText, skip: tab.skipText, limit: tab.limitText, collation: tab.collationText }
}

/** Parsed query bar (filter not yet auto-cast); throws QueryTextError. */
function parseTab(tab: QueryTab): AppliedQuery {
  const p = parseQueryParts(tab.queryText, tab.projectionText, tab.sortText)
  return { ...p, skip: intOr(tab.skipText, 0), limit: intOr(tab.limitText, 0), collation: parseCollationPart(tab.collationText) }
}

/** Add a run to the query history (fire and forget). */
function recordFindRun(tab: QueryTab, ms: number, count?: number): void {
  const live = useStore.getState().live[tab.connId]
  if (!live) return
  void api
    .addHistory({
      configId: live.configId,
      connName: live.name,
      db: tab.db,
      coll: tab.coll,
      payload: findPayload(tab),
      ms,
      count
    })
    .catch(() => {})
}

const intOr = (s: string, d: number): number => {
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : d
}

/** Latest run per tab: an older run finishing later (slow query, quick paging) must not overwrite newer results. */
const runSeq = new Map<string, number>()

/** Run the tab's query (from the text fields) and show the given page. */
export async function runQuery(tabId: string, page = 0, opts: { keepApplied?: boolean } = {}): Promise<void> {
  const tab = getTab(tabId)
  if (!tab) return
  const seq = (runSeq.get(tabId) ?? 0) + 1
  runSeq.set(tabId, seq)
  const stale = (): boolean => runSeq.get(tabId) !== seq
  let applied: AppliedQuery
  if (opts.keepApplied && tab.applied) {
    applied = tab.applied
  } else {
    try {
      applied = parseTab(tab)
    } catch (e) {
      // An earlier run still in flight is superseded, so stop its loading state too.
      if (e instanceof QueryTextError) patchTab(tabId, { loading: false, error: { part: e.part, message: e.message } })
      else patchTab(tabId, { loading: false, error: { part: 'run', message: errorText(e) } })
      return
    }
    const c = await castQuery(tab, applied.filter)
    if (stale()) return
    applied = { ...applied, filter: c.filter }
    patchTab(tabId, { casts: c.casts })
  }
  const skip = applied.skip + page * tab.pageSize
  let limit = tab.pageSize
  if (applied.limit) limit = Math.min(limit, applied.limit - page * tab.pageSize)
  if (limit <= 0) {
    patchTab(tabId, { loading: false })
    return
  }
  const newQuery = !opts.keepApplied
  patchTab(tabId, { loading: true, error: undefined, ...(newQuery ? { count: null } : {}) })
  try {
    const r = await api.find(tab.connId, tab.db, tab.coll, {
      filter: applied.filter,
      projection: applied.projection,
      sort: applied.sort,
      skip,
      limit: limit + 1,
      collation: applied.collation
    })
    if (stale()) return
    const hasMore = r.docs.length > limit && (!applied.limit || applied.skip + (page + 1) * tab.pageSize < applied.skip + applied.limit)
    if (newQuery) recordFindRun(tab, r.ms, r.docs.length > limit ? undefined : r.docs.length)
    patchTab(tabId, (t) => ({
      docs: r.docs.slice(0, limit),
      hasMore,
      page,
      ms: r.ms,
      loading: false,
      applied,
      selection: [],
      rev: t.rev + 1,
      tablePath: newQuery ? [] : t.tablePath,
      // A count started while this query ran belongs to the previous filter.
      ...(newQuery ? { count: null } : {})
    }))
  } catch (e) {
    if (!stale()) patchTab(tabId, { loading: false, error: { part: 'run', message: errorText(e) } })
  }
}

export async function countDocuments(tabId: string): Promise<number | null> {
  const tab = getTab(tabId)
  if (!tab) return null
  const filter = tab.applied?.filter ?? {}
  patchTab(tabId, { counting: true })
  try {
    let n = await api.count(tab.connId, tab.db, tab.coll, filter, tab.applied?.collation ?? null)
    const a = tab.applied
    if (a) {
      n = Math.max(0, n - a.skip)
      if (a.limit) n = Math.min(n, a.limit)
    }
    // A different query ran meanwhile: this count no longer matches the shown results.
    if (getTab(tabId)?.applied !== a) {
      patchTab(tabId, { counting: false })
      return null
    }
    patchTab(tabId, { count: n, counting: false })
    return n
  } catch (e) {
    patchTab(tabId, { counting: false })
    toast(`Count failed: ${errorText(e)}`, 'error')
    return null
  }
}

export async function gotoLastPage(tabId: string): Promise<void> {
  const tab = getTab(tabId)
  if (!tab) return
  const n = tab.count ?? (await countDocuments(tabId))
  if (n == null) return
  const last = Math.max(0, Math.ceil(n / tab.pageSize) - 1)
  await runQuery(tabId, last, { keepApplied: true })
}

/** Re-read the current page after an edit. */
export const refreshPage = (tabId: string): Promise<void> => runQuery(tabId, getTab(tabId)?.page ?? 0, { keepApplied: true })

/** Scope of "documents matching the current query" (strings match with the query's collation). */
export function queryScope(tab: QueryTab): DocScope {
  const f = tab.applied?.filter ?? {}
  const collation = tab.applied?.collation
  return Object.keys(f).length ? { kind: 'filter', filter: f, ...(collation ? { collation } : {}) } : { kind: 'all' }
}

export function selectedIds(tab: QueryTab): unknown[] {
  const docs = tab.docs ?? []
  return tab.selection.map((i) => docs[i]?._id).filter((id) => id !== undefined)
}

// ---------------------------------------------------------------------------
// Filter Builder <-> text sync
// ---------------------------------------------------------------------------

/** Apply a builder change and write the resulting query/projection/sort text. */
export function setVqb(tabId: string, next: VqbState): void {
  const tab = getTab(tabId)
  if (!tab) return
  const patch: Partial<QueryTab> = { vqb: { ...next, errorRuleId: undefined, errorMessage: undefined, unsupported: undefined } }
  try {
    const filter = next.useQuery ? groupToFilter(next.root) : {}
    patch.queryText = Object.keys(filter).length ? formatQuery(filter) : ''
  } catch (e) {
    if (e instanceof VqbValueError) {
      patch.vqb = { ...next, errorRuleId: e.ruleId, errorMessage: e.message, unsupported: undefined }
    } else throw e
  }
  try {
    patch.projectionText = next.useProjection ? formatQuery(itemsToProjection(next.projection)) : ''
  } catch {
    // Invalid $slice text — keep the old projection text until fixed.
  }
  patch.sortText = next.useSort ? formatQuery(itemsToSort(next.sort)) : ''
  patchTab(tabId, patch)
}

/** After the user edits a text field, re-read it into the builder when possible. */
export function syncTextToVqb(tabId: string, part: 'query' | 'projection' | 'sort'): void {
  const tab = getTab(tabId)
  if (!tab) return
  const text = part === 'query' ? tab.queryText : part === 'projection' ? tab.projectionText : tab.sortText
  const parsed = tryParse(part, text)
  if (parsed === undefined) return
  const v = tab.vqb
  if (part === 'query') {
    const root = filterToGroup(parsed)
    if (!root) {
      patchTab(tabId, { vqb: { ...v, unsupported: 'The current query cannot be represented in the Filter Builder.' } })
      return
    }
    patchTab(tabId, { vqb: { ...v, root, useQuery: true, unsupported: undefined, errorRuleId: undefined } })
  } else if (part === 'projection') {
    const items = projectionToItems(parsed)
    if (items) patchTab(tabId, { vqb: { ...v, projection: items, useProjection: true } })
  } else {
    const items = sortToItems(parsed)
    if (items) patchTab(tabId, { vqb: { ...v, sort: items, useSort: true } })
  }
}

export function replaceDocInPage(tabId: string, index: number, doc: Doc): void {
  patchTab(tabId, (t) => {
    if (!t.docs) return {}
    const docs = [...t.docs]
    docs[index] = doc
    return { docs, rev: t.rev + 1 }
  })
}

/** Re-fetch one document by _id and replace it in the page. */
export async function reloadDoc(tabId: string, index: number): Promise<void> {
  const tab = getTab(tabId)
  const id = tab?.docs?.[index]?._id
  if (!tab || id === undefined) return
  try {
    const fresh = await api.getDocument(tab.connId, tab.db, tab.coll, id)
    if (fresh) {
      // Re-apply projection client-side would be complex; re-run page when a projection is active.
      if (tab.applied?.projection) await refreshPage(tabId)
      else replaceDocInPage(tabId, index, fresh)
    }
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

// ---------------------------------------------------------------------------
// Default queries per connection / database / collection
// ---------------------------------------------------------------------------

const configIdOf = (tab: QueryTab): string | undefined => useStore.getState().live[tab.connId]?.configId

export const SCOPE_LABEL: Record<DefaultQueryScope, string> = {
  collection: 'collection',
  database: 'database',
  connection: 'connection'
}

function currentQuery(tab: QueryTab): SavedQuery {
  return { query: tab.queryText, projection: tab.projectionText, sort: tab.sortText, skip: tab.skipText, limit: tab.limitText, collation: tab.collationText }
}

function applySaved(tabId: string, q: SavedQuery, scope?: DefaultQueryScope): void {
  // Defaults saved before collation support keep the tab's collation (the preference / connection default).
  const collation = typeof q.collation === 'string' ? { collationText: q.collation } : {}
  patchTab(tabId, { queryText: q.query, projectionText: q.projection, sortText: q.sort, skipText: q.skip, limitText: q.limit, ...collation, defaultScope: scope, error: undefined })
  syncTextToVqb(tabId, 'query')
  syncTextToVqb(tabId, 'projection')
  syncTextToVqb(tabId, 'sort')
}

/** Load the most specific saved default (collection > database > connection) into the query bar. */
export async function loadDefaultQuery(tabId: string): Promise<boolean> {
  const tab = getTab(tabId)
  const configId = tab && configIdOf(tab)
  if (!tab || !configId) return false
  try {
    const m = await api.getDefaultQuery(configId, tab.db, tab.coll)
    if (!m) {
      patchTab(tabId, { defaultScope: undefined })
      return false
    }
    applySaved(tabId, m.value, m.scope)
    return true
  } catch {
    return false
  }
}

export async function saveDefaultQuery(tabId: string, scope: DefaultQueryScope): Promise<void> {
  const tab = getTab(tabId)
  const configId = tab && configIdOf(tab)
  if (!tab || !configId) return
  try {
    await api.setDefaultQuery(configId, scope, tab.db, tab.coll, currentQuery(tab))
    patchTab(tabId, { defaultScope: scope })
    const where = scope === 'collection' ? tab.coll : scope === 'database' ? `all collections in ${tab.db}` : `all collections of this connection`
    toast(`Default query saved for ${where}`, 'success')
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

export async function clearDefaultQuery(tabId: string, scope: DefaultQueryScope): Promise<void> {
  const tab = getTab(tabId)
  const configId = tab && configIdOf(tab)
  if (!tab || !configId) return
  await api.setDefaultQuery(configId, scope, tab.db, tab.coll, null)
  if (tab.defaultScope === scope) patchTab(tabId, { defaultScope: undefined })
  toast(`Default query for this ${SCOPE_LABEL[scope]} removed`, 'success')
}

export async function listDefaultScopes(tabId: string): Promise<DefaultQueryScope[]> {
  const tab = getTab(tabId)
  const configId = tab && configIdOf(tab)
  if (!tab || !configId) return []
  return api.listDefaultQueries(configId, tab.db, tab.coll).catch(() => [])
}

/** Header click sorting: asc -> desc -> off. With `add`, keeps the other sort fields. */
export function toggleSort(tabId: string, field: string, add: boolean): void {
  const tab = getTab(tabId)
  if (!tab) return
  const current = (tryParse('sort', tab.sortText) ?? {}) as Record<string, unknown>
  const dir = Number((current[field] as { valueOf(): unknown } | undefined)?.valueOf() ?? 0)
  const next: Record<string, number> = {}
  if (add) for (const [k, v] of Object.entries(current)) if (k !== field) next[k] = Number((v as { valueOf(): unknown }).valueOf())
  if (dir === 0) next[field] = 1
  else if (dir === 1) next[field] = -1
  if (!add && dir === -1) delete next[field]
  patchTab(tabId, { sortText: Object.keys(next).length ? formatQuery(next) : '' })
  syncTextToVqb(tabId, 'sort')
  if (!Object.keys(next).length) patchTab(tabId, (t) => ({ vqb: { ...t.vqb, sort: [] } }))
  void runQuery(tabId)
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

/** Explain the tab's applied query (or the current text when nothing ran yet). */
export async function runExplain(tabId: string, verbosity?: ExplainVerbosity): Promise<void> {
  const tab = getTab(tabId)
  if (!tab) return
  let q: AppliedQuery
  try {
    q = parseTab(tab)
  } catch (e) {
    if (e instanceof QueryTextError) patchTab(tabId, { error: { part: e.part, message: e.message } })
    return
  }
  q = { ...q, filter: (await castQuery(tab, q.filter)).filter }
  const v = verbosity ?? tab.explain?.verbosity ?? 'executionStats'
  patchTab(tabId, { explain: { loading: true, verbosity: v, query: q, result: tab.explain?.result } })
  try {
    const result = await api.explain(tab.connId, tab.db, tab.coll, { filter: q.filter, projection: q.projection, sort: q.sort, skip: q.skip, limit: q.limit, collation: q.collation }, v)
    patchTab(tabId, { explain: { loading: false, verbosity: v, query: q, result } })
  } catch (e) {
    patchTab(tabId, { explain: { loading: false, verbosity: v, query: q, error: errorText(e) } })
  }
}
