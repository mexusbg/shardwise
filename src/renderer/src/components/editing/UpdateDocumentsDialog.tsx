import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { Doc } from '@shared/api'
import { parseShellValue } from '@shared/bsonValue'
import { collectPaths } from '@shared/docPaths'
import { updateProblem } from '@shared/updateDocuments'
import { tryParse } from '../../lib/queryText'
import { refreshPage } from '../../state/queryActions'
import { errorText, toast } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { historyWrites } from '../changes/changesClient'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { confirmDialog, Modal, openModal } from '../Modal'
import { canWrite, withHistoryFallback } from './dialogs'
import { defaultPreset, presetCollation, presetText, QueryScopeEditor, useMatchCount } from './QueryScopeEditor'
import type { QueryPreset } from './QueryScopeEditor'

const UPDATE_DOC = '{\n  $set: {\n    \n  }\n}'
const UPDATE_PIPELINE = '[\n  { $set: { } }\n]'
const plural = (n: number, w: string): string => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

/** Update Documents: edit the query (all / the tab's query / the selection) and the update, then run it. */
export function updateDocumentsDialog(tab: QueryTab): void {
  if (!canWrite(tab)) return
  void openModal<void>((close) => <UpdateDocuments tab={tab} onDone={() => close()} />)
}

function UpdateDocuments({ tab, onDone }: { tab: QueryTab; onDone: () => void }): ReactElement {
  const [preset, setPreset] = useState<QueryPreset>(() => defaultPreset(tab))
  const [queryText, setQueryText] = useState(() => presetText(tab, defaultPreset(tab)))
  const [pipeline, setPipeline] = useState(false)
  const [updateText, setUpdateText] = useState(UPDATE_DOC)
  const [multi, setMulti] = useState(true)
  const [upsert, setUpsert] = useState(false)
  const [history, setHistory] = useState(true)
  const [pane, setPane] = useState<'query' | 'update'>('update')
  const [busy, setBusy] = useState(false)
  const fields = useMemo(() => collectPaths(tab.docs ?? []), [tab.docs])
  const collation = presetCollation(tab, preset)

  const filter = tryParse('query', queryText)
  const matches = useMatchCount(tab, filter, collation)
  const parsedUpdate = useMemo((): { value?: unknown; error?: string } => {
    try {
      return { value: parseShellValue(updateText) }
    } catch (e) {
      return { error: errorText(e) }
    }
  }, [updateText])
  const problem =
    filter === undefined || filter === null
      ? 'The query is not valid'
      : parsedUpdate.error
        ? `The update is not valid: ${parsedUpdate.error}`
        : updateProblem(parsedUpdate.value, pipeline)

  const setMode = (pipe: boolean): void => {
    setPipeline(pipe)
    if (updateText === UPDATE_DOC || updateText === UPDATE_PIPELINE) setUpdateText(pipe ? UPDATE_PIPELINE : UPDATE_DOC)
  }
  const validate = (): void => {
    if (problem) toast(problem, 'error')
    else toast(`Query and update are valid${matches !== null ? ` · ${plural(matches, 'document')} match` : ''}`, 'success')
  }

  const affected = matches === null ? null : multi ? matches : Math.min(matches, 1)
  const run = async (): Promise<void> => {
    if (problem || busy || !filter) return
    if (multi && !Object.keys(filter).length) {
      const ok = await confirmDialog({
        title: 'Update every document?',
        message: (
          <>
            The query is empty: the update applies to <b>all {matches !== null ? matches.toLocaleString() : ''} documents</b> of {tab.coll}.
          </>
        ),
        confirmLabel: 'Update all',
        danger: true
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const req = { filter, update: parsedUpdate.value as Doc | Doc[], multi, upsert, collation }
      const r = await withHistoryFallback((o) => historyWrites.updateDocuments(tab.connId, tab.db, tab.coll, req, history ? o : { ...o, skipHistory: true }))
      if (!r) return
      onDone()
      await refreshPage(tab.id)
      toast(`${plural(r.matched, 'document')} matched, ${r.modified.toLocaleString()} modified${r.upserted ? `, ${r.upserted.toLocaleString()} inserted (upsert)` : ''}`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Update Documents — ${tab.coll}`}
      icon="update"
      onClose={onDone}
      width={720}
      footer={
        <>
          <button className="btn" onClick={validate}>
            <Icon name="check" size={13} /> Validate
          </button>
          <span className="spacer" />
          <span className="faint ud-affected">
            {problem ? '' : affected === null ? 'Counting…' : upsert && !affected ? 'No match: a new document is inserted' : `${plural(affected, 'document')} will be updated`}
          </span>
          <button className="btn" onClick={onDone}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!problem || busy} title={problem ?? undefined} onClick={() => void run()}>
            {busy ? 'Updating…' : 'Update'}
          </button>
        </>
      }
    >
      <div className="segmented ud-tabs">
        <button className={pane === 'query' ? 'on' : ''} onClick={() => setPane('query')}>
          Query {filter === undefined && <Icon name="warn" size={11} />}
        </button>
        <button className={pane === 'update' ? 'on' : ''} onClick={() => setPane('update')}>
          Update {parsedUpdate.error && <Icon name="warn" size={11} />}
        </button>
      </div>

      {pane === 'query' ? (
        <QueryScopeEditor
          tab={tab}
          label="Update the documents matching this query:"
          action="Update"
          preset={preset}
          onPreset={(p) => {
            setPreset(p)
            setQueryText(presetText(tab, p))
          }}
          text={queryText}
          onText={setQueryText}
          invalid={filter === undefined}
          fields={fields}
          onSubmit={() => void run()}
          autoFocus
        />
      ) : (
        <div className="ud-pane">
          <div className="ud-label">{pipeline ? 'Aggregation pipeline run on the matching documents:' : 'Update run on the matching documents:'}</div>
          <CodeEditor value={updateText} onChange={setUpdateText} fields={fields} full minHeight={150} maxHeight={260} invalid={!!parsedUpdate.error} onSubmit={() => void run()} autoFocus />
          <div className="row ud-row">
            <span className="faint">Update mode</span>
            <div className="segmented small">
              <button className={!pipeline ? 'on' : ''} onClick={() => setMode(false)} title="Update operators: $set, $unset, $inc, $push…">
                Update document
              </button>
              <button className={pipeline ? 'on' : ''} onClick={() => setMode(true)} title="Stages $set, $unset, $project, $replaceWith… (values can use other fields)">
                Aggregation pipeline
              </button>
            </div>
          </div>
        </div>
      )}

      {problem && <div className="notice error ud-notice">{problem}</div>}

      <div className="ud-options">
        <label className="check" title="Update every matching document; off: only the first one">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Multi — all matching documents
        </label>
        <label className="check" title="Insert a new document when nothing matches">
          <input type="checkbox" checked={upsert} onChange={(e) => setUpsert(e.target.checked)} /> Upsert
        </label>
        <label className="check" title="Keep the previous version of each updated document (Change History), so the update can be undone">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Record in Change History
        </label>
      </div>
    </Modal>
  )
}
