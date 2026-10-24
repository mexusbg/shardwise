import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { Doc } from '@shared/api'
import { idsFilter } from '@shared/updateDocuments'
import { api } from '../../lib/api'
import { formatQuery } from '../../lib/queryText'
import { selectedIds } from '../../state/queryActions'
import type { QueryTab } from '../../state/store'
import { CodeEditor } from '../CodeEditor'

/** Where the editable query of the Update / Delete Documents dialogs starts from. */
export type QueryPreset = 'all' | 'query' | 'selected'

export function presetText(tab: QueryTab, p: QueryPreset): string {
  if (p === 'all') return '{}'
  if (p === 'query') return formatQuery(tab.applied?.filter ?? {}) || '{}'
  const ids = selectedIds(tab)
  return ids.length ? formatQuery(idsFilter(ids)) : '{}'
}

export const defaultPreset = (tab: QueryTab): QueryPreset => (selectedIds(tab).length ? 'selected' : 'query')

/** The tab's collation applies to "the query from the tab" only, as in the tab itself. */
export const presetCollation = (tab: QueryTab, p: QueryPreset): Doc | null => (p === 'query' ? (tab.applied?.collation ?? null) : null)

/** Documents matching `filter` (debounced while typing); null while counting or when the query is invalid. */
export function useMatchCount(tab: QueryTab, filter: Doc | null | undefined, collation: Doc | null): number | null {
  const [n, setN] = useState<number | null>(null)
  const key = filter ? JSON.stringify(filter) : ''
  useEffect(() => {
    setN(null)
    if (!filter) return
    let alive = true
    const t = setTimeout(() => {
      api.count(tab.connId, tab.db, tab.coll, filter, collation).then(
        (c) => alive && setN(c),
        () => {}
      )
    }, 300)
    return () => {
      alive = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, collation])
  return n
}

interface Props {
  tab: QueryTab
  label: string
  /** Verb in front of the preset buttons: "Delete:" / "Update:". */
  action: string
  preset: QueryPreset
  onPreset: (p: QueryPreset) => void
  text: string
  onText: (t: string) => void
  invalid: boolean
  fields: string[]
  onSubmit: () => void
  autoFocus?: boolean
}

/** Query editor with preset buttons ("Delete: All documents | The tab's query | Selected documents"). */
export function QueryScopeEditor(p: Props): ReactElement {
  const selected = selectedIds(p.tab).length
  return (
    <div className="ud-pane">
      <div className="ud-label">{p.label}</div>
      <CodeEditor value={p.text} onChange={p.onText} fields={p.fields} full minHeight={150} maxHeight={260} invalid={p.invalid} onSubmit={p.onSubmit} autoFocus={p.autoFocus} />
      <div className="row ud-row">
        <span className="faint">{p.action}:</span>
        <div className="segmented small">
          <button className={p.preset === 'all' ? 'on' : ''} onClick={() => p.onPreset('all')}>
            All documents
          </button>
          <button className={p.preset === 'query' ? 'on' : ''} onClick={() => p.onPreset('query')} title="The query currently run in the collection tab">
            The tab's query
          </button>
          <button className={p.preset === 'selected' ? 'on' : ''} disabled={!selected} onClick={() => p.onPreset('selected')}>
            Selected documents ({selected})
          </button>
        </div>
      </div>
    </div>
  )
}
