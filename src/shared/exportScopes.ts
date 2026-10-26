import type { Doc, ExportRequest } from './api'
import { idsFilter } from './updateDocuments'

/** Which documents "Export…" from a collection tab writes. */
export type ExportScopeId = 'query' | 'page' | 'selected' | 'all'

export interface ExportScope {
  id: ExportScopeId
  label: string
  /** Number of documents, when known. */
  count: number | null
  /** Undefined = the whole collection. */
  query?: ExportRequest['query']
  /** Why the scope cannot be used right now. */
  disabled?: string
}

export interface ScopeInput {
  /** The tab's last run query; undefined before the first run. */
  applied?: { filter: Doc; projection: Doc | null; sort: Doc | null; skip: number; limit: number; collation: Doc | null }
  /** Documents of the current page. */
  docs: Doc[]
  /** Selected row indexes into `docs`. */
  selection: number[]
  page: number
  pageSize: number
  /** Documents matching the query, when counted. */
  count: number | null
}

const idsOf = (docs: Doc[]): unknown[] => docs.map((d) => d._id).filter((id) => id !== undefined)

/**
 * Export choices of a collection tab, as in Studio 3T: the whole query result, the current page, the selected
 * documents, or the whole collection. The page and the selection are exported by `_id`, so they are exact in
 * every format (mongodump applies only a filter); the projection and sort of the view still apply.
 */
export function exportScopes(s: ScopeInput): ExportScope[] {
  const a = s.applied
  const all: ExportScope = { id: 'all', label: 'Whole collection', count: null }
  if (!a) return [all]
  const view = { projection: a.projection, sort: a.sort, collation: a.collation }

  const pageIds = idsOf(s.docs)
  const page: ExportScope = { id: 'page', label: 'This page', count: s.docs.length }
  if (!s.docs.length) page.disabled = 'This page has no documents'
  else if (pageIds.length === s.docs.length) page.query = { filter: idsFilter(pageIds), ...view }
  // Documents without _id (a projection that hides it): the same window of the query instead.
  else page.query = { filter: a.filter, ...view, skip: a.skip + s.page * s.pageSize, limit: s.docs.length }

  const picked = s.selection.map((i) => s.docs[i]).filter((d): d is Doc => !!d)
  const selIds = idsOf(picked)
  const selected: ExportScope = { id: 'selected', label: 'Selected documents', count: picked.length }
  if (!picked.length) selected.disabled = 'Select documents in the results first'
  else if (selIds.length !== picked.length) selected.disabled = 'The selected documents have no _id in this view'
  else selected.query = { filter: idsFilter(selIds), ...view }

  return [{ id: 'query', label: 'Query result', count: s.count, query: { filter: a.filter, ...view, skip: a.skip, limit: a.limit } }, page, selected, all]
}
