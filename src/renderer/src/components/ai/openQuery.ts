import type { ProposedQuery } from '@shared/aiQuery'
import type { Doc } from '@shared/api'
import { formatQuery } from '../../lib/queryText'
import { dbKey, getTab, openAggregationTab, openCollectionTab, patchTab, toast, useStore } from '../../state/store'
import { runQuery, syncTextToVqb } from '../../state/queryActions'

const text = (v: Doc | null): string => (v && Object.keys(v).length ? formatQuery(v) : '')

/** Opens a proposed find in a new query tab and runs it. */
export function openFindQuery(connId: string, db: string, q: Extract<ProposedQuery, { kind: 'find' }>, fallbackColl?: string): void {
  const coll = q.coll ?? fallbackColl
  if (!useStore.getState().live[connId]) return toast('The connection is closed', 'error')
  if (!coll) return toast('The query does not name a collection', 'error')
  const isView = useStore.getState().collections[dbKey(connId, db)]?.find((c) => c.name === coll)?.type === 'view'
  const id = openCollectionTab(connId, db, coll, isView)
  // `loading` keeps the tab from loading its saved default query over this one.
  patchTab(id, {
    queryText: text(q.filter),
    projectionText: text(q.projection),
    sortText: text(q.sort),
    skipText: q.skip ? String(q.skip) : '',
    limitText: q.limit ? String(q.limit) : '',
    loading: true
  })
  syncTextToVqb(id, 'query')
  syncTextToVqb(id, 'projection')
  syncTextToVqb(id, 'sort')
  void runQuery(id).finally(() => {
    const t = getTab(id)
    if (t?.loading && !t.docs) patchTab(id, { loading: false })
  })
}

export function openPipeline(connId: string, db: string, q: Extract<ProposedQuery, { kind: 'aggregate' }>, fallbackColl?: string): void {
  const coll = q.coll ?? fallbackColl
  if (!useStore.getState().live[connId]) return toast('The connection is closed', 'error')
  if (!coll) return toast('The pipeline does not name a collection', 'error')
  openAggregationTab(connId, db, coll, { pipeline: q.text })
}
