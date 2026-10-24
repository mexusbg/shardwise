import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { DocScope } from '@shared/api'
import { collectPaths } from '@shared/docPaths'
import { tryParse } from '../../lib/queryText'
import { refreshPage } from '../../state/queryActions'
import { errorText, patchTab, toast } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { historyWrites } from '../changes/changesClient'
import { Icon } from '../Icon'
import { confirmDialog, Modal, openModal } from '../Modal'
import { canWrite, withHistoryFallback } from './dialogs'
import { defaultPreset, presetCollation, presetText, QueryScopeEditor, useMatchCount } from './QueryScopeEditor'
import type { QueryPreset } from './QueryScopeEditor'

const plural = (n: number, w: string): string => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

/** Delete Documents: edit the query (selection / the tab's query / all documents), see how many match, delete. */
export function deleteDocumentsDialog(tab: QueryTab, preset?: QueryPreset): void {
  if (!canWrite(tab)) return
  void openModal<void>((close) => <DeleteDocuments tab={tab} initial={preset ?? defaultPreset(tab)} onDone={() => close()} />)
}

function DeleteDocuments({ tab, initial, onDone }: { tab: QueryTab; initial: QueryPreset; onDone: () => void }): ReactElement {
  const [preset, setPreset] = useState<QueryPreset>(initial)
  const [text, setText] = useState(() => presetText(tab, initial))
  const [history, setHistory] = useState(true)
  const [busy, setBusy] = useState(false)
  const fields = useMemo(() => collectPaths(tab.docs ?? []), [tab.docs])
  const filter = tryParse('query', text)
  const collation = presetCollation(tab, preset)
  const matches = useMatchCount(tab, filter, collation)
  const everything = !!filter && !Object.keys(filter).length

  const run = async (): Promise<void> => {
    if (!filter || busy || !matches) return
    if (everything) {
      const ok = await confirmDialog({
        title: 'Delete every document?',
        message: (
          <>
            The query is empty: this deletes <b>all {matches.toLocaleString()} documents</b> of {tab.db}.{tab.coll}.
          </>
        ),
        confirmLabel: 'Delete all',
        danger: true
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const scope: DocScope = everything ? { kind: 'all' } : { kind: 'filter', filter, ...(collation ? { collation } : {}) }
      const n = await withHistoryFallback((o) => historyWrites.deleteDocuments(tab.connId, tab.db, tab.coll, scope, history ? o : { ...o, skipHistory: true }))
      if (n === null) return
      onDone()
      patchTab(tab.id, { selection: [] })
      await refreshPage(tab.id)
      toast(`${plural(n, 'document')} deleted`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Delete Documents — ${tab.coll}`}
      icon="trash"
      onClose={onDone}
      width={680}
      footer={
        <>
          <span className="faint ud-affected">{filter === undefined ? 'The query is not valid' : matches === null ? 'Counting…' : matches ? `${plural(matches, 'document')} will be deleted` : 'No documents match'}</span>
          <span className="spacer" />
          <button className="btn" onClick={onDone}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={!filter || !matches || busy} onClick={() => void run()}>
            <Icon name="trash" size={13} /> {busy ? 'Deleting…' : matches ? `Delete ${plural(matches, 'document')}` : 'Delete'}
          </button>
        </>
      }
    >
      <QueryScopeEditor
        tab={tab}
        label="Delete the documents matching this query:"
        action="Delete"
        preset={preset}
        onPreset={(p) => {
          setPreset(p)
          setText(presetText(tab, p))
        }}
        text={text}
        onText={setText}
        invalid={filter === undefined}
        fields={fields}
        onSubmit={() => void run()}
        autoFocus
      />
      {everything && matches !== null && matches > 0 && (
        <div className="notice error ud-notice">
          <Icon name="warn" size={14} /> The query is empty: every document of the collection matches.
        </div>
      )}
      <div className="ud-options">
        <label className="check" title="Keep each deleted document in Change History so it can be restored">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Record in Change History (restorable)
        </label>
      </div>
    </Modal>
  )
}
