import { useState } from 'react'
import type { ReactElement } from 'react'
import {
  bsonTypeOf,
  convertValue,
  defaultValue,
  editText,
  isEditableType,
  isPlainDoc,
  parseShellValue,
  parseTyped,
  shellText,
  TYPE_LABELS
} from '@shared/bsonValue'
import type { EditableType } from '@shared/bsonValue'
import { getPath, lastSegment, parentPath, setPath } from '@shared/docPaths'
import type { Doc, DocScope, FieldOp } from '@shared/api'
import { api } from '../../lib/api'
import { errorText, getTab, guardWrite, toast, useStore } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { queryScope, refreshPage, reloadDoc, replaceDocInPage, selectedIds } from '../../state/queryActions'
import { CodeEditor } from '../CodeEditor'
import { confirmDialog, Modal, openModal } from '../Modal'
import { TypeSelect, ValueInput } from './ValueInput'
import { historyWrites } from '../changes/changesClient'
import { historyCapText, isHistoryCapError } from '@shared/changeHistoryApi'
import type { WriteOptions } from '@shared/changeHistoryApi'
import { dataDateText } from '@shared/dateFormat'
import { prefDocText } from '../../lib/docText'
import { collationLabel, toCollation } from '@shared/collation'

/** ` (collation bg · 2)` for a filter scope with a collation. */
function collationNote(scope: DocScope): string {
  if (scope.kind !== 'filter') return ''
  try {
    const c = toCollation(scope.collation)
    return c ? ` (collation ${collationLabel(c)})` : ''
  } catch {
    return ''
  }
}

const plural = (n: number, w: string): string => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

export function canWrite(tab: QueryTab): boolean {
  if (tab.isView) {
    toast('Views are read-only', 'error')
    return false
  }
  if (!guardWrite(tab.connId, 'Edits')) return false
  if (tab.readOnly) {
    toast('Read-only mode is on. Unlock the tab to make changes.', 'error')
    return false
  }
  const idProj = tab.applied?.projection?._id as { valueOf(): unknown } | number | boolean | null | undefined
  if (idProj != null && !Number(idProj.valueOf())) {
    toast('_id field is currently excluded by the projection; editing is disabled.', 'error')
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Scope picker
// ---------------------------------------------------------------------------

type ScopeKind = 'doc' | 'selected' | 'query' | 'all'

function scopeOf(tab: QueryTab, kind: ScopeKind, docIndex?: number): DocScope {
  switch (kind) {
    case 'doc':
      return { kind: 'ids', ids: [tab.docs![docIndex!]._id] }
    case 'selected':
      return { kind: 'ids', ids: selectedIds(tab) }
    case 'query':
      return queryScope(tab)
    case 'all':
      return { kind: 'all' }
  }
}

function ScopePicker({ tab, value, onChange, hasDoc }: { tab: QueryTab; value: ScopeKind; onChange: (k: ScopeKind) => void; hasDoc: boolean }): ReactElement {
  const sel = tab.selection.length
  const hasFilter = Object.keys(tab.applied?.filter ?? {}).length > 0
  return (
    <div className="col" style={{ gap: 4 }}>
      {hasDoc && (
        <label className="check">
          <input type="radio" checked={value === 'doc'} onChange={() => onChange('doc')} /> Current document only
        </label>
      )}
      {sel > 1 && (
        <label className="check">
          <input type="radio" checked={value === 'selected'} onChange={() => onChange('selected')} /> Selected documents ({sel})
        </label>
      )}
      {hasFilter && (
        <label className="check">
          <input type="radio" checked={value === 'query'} onChange={() => onChange('query')} /> All documents matching the current query
        </label>
      )}
      <label className="check">
        <input type="radio" checked={value === 'all'} onChange={() => onChange('all')} /> All documents in the collection
      </label>
    </div>
  )
}

/** Runs a write; when Change History refuses it (too many documents to capture), offers to run it without history. */
export async function withHistoryFallback<T>(run: (opts?: WriteOptions) => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (e) {
    if (!isHistoryCapError(e)) throw e
    const ok = await confirmDialog({
      title: 'Too many documents for Change History',
      message: (
        <>
          {historyCapText(e)}
          <div className="muted" style={{ marginTop: 8 }}>
            Continue without recording it? This change cannot be undone from Change History.
          </div>
        </>
      ),
      confirmLabel: 'Continue without history',
      danger: true
    })
    return ok ? run({ allowWithoutHistory: true }) : null
  }
}

async function applyFieldOp(tab: QueryTab, scope: DocScope, op: FieldOp, docIndex?: number): Promise<boolean> {
  if (scope.kind !== 'ids') {
    const what = scope.kind === 'all' ? `ALL documents in ${tab.coll}` : `all documents matching the current query${collationNote(scope)}`
    const ok = await confirmDialog({
      title: 'Update multiple documents',
      message: (
        <>
          This will update <b>{what}</b>. Continue?
        </>
      ),
      confirmLabel: 'Update',
      danger: true
    })
    if (!ok) return false
  }
  try {
    const r = await withHistoryFallback((o) => historyWrites.updateField(tab.connId, tab.db, tab.coll, scope, op, o))
    if (!r) return false
    if (scope.kind === 'ids' && scope.ids.length === 1 && docIndex !== undefined) await reloadDoc(tab.id, docIndex)
    else await refreshPage(tab.id)
    toast(`${plural(r.modified, 'document')} modified`, 'success')
    return true
  } catch (e) {
    toast(errorText(e), 'error')
    return false
  }
}

/** True when a field name containing '.' lies on the path, so the dot path would address another field. */
function dottedKeyOnPath(doc: unknown, path: string): boolean {
  let cur = doc
  let rest = path
  while (cur !== null && typeof cur === 'object' && rest) {
    for (const k of Object.keys(cur)) if (k.includes('.') && (rest === k || rest.startsWith(`${k}.`))) return true
    const i = rest.indexOf('.')
    const head = i < 0 ? rest : rest.slice(0, i)
    cur = (cur as Record<string, unknown>)[head]
    rest = i < 0 ? '' : rest.slice(i + 1)
  }
  return false
}

/** Projections that reshape arrays make displayed indexes differ from stored ones. */
function reshapesArrays(tab: QueryTab): boolean {
  const p = tab.applied?.projection
  if (!p) return false
  return Object.entries(p).some(([k, v]) => k.includes('.$') || (v !== null && typeof v === 'object' && ('$slice' in v || '$elemMatch' in v)))
}

/** Reason a per-field edit at `path` would hit the wrong field, or null when it is safe. */
export function pathEditBlocked(tab: QueryTab, docIndex: number | undefined, path: string): string | null {
  if (docIndex !== undefined && tab.docs?.[docIndex] && dottedKeyOnPath(tab.docs[docIndex], path)) {
    return 'This field name contains a dot, which field updates cannot address. Use Edit Document (JSON) instead.'
  }
  if (/(^|\.)\d+(\.|$)/.test(path) && reshapesArrays(tab)) {
    return 'The projection reshapes arrays ($slice / $elemMatch / $), so element positions differ from the stored document. Remove it to edit array elements.'
  }
  return null
}

function guardPath(tab: QueryTab, docIndex: number | undefined, path: string): boolean {
  const reason = pathEditBlocked(tab, docIndex, path)
  if (reason) toast(reason, 'error')
  return !reason
}

// ---------------------------------------------------------------------------
// In-place edit (used by Table and Tree views)
// ---------------------------------------------------------------------------

/** Save a value typed into an in-place editor, keeping the original type. */
export async function saveInPlace(tabId: string, docIndex: number, path: string, text: string): Promise<boolean> {
  const tab = getTab(tabId)
  if (!tab?.docs || !guardPath(tab, docIndex, path)) return false
  const doc = tab.docs[docIndex]
  const old = getPath(doc, path)
  const t = bsonTypeOf(old)
  const type: EditableType = isEditableType(t) ? t : 'string'
  if (type === 'array' || type === 'object') return false
  let value: unknown
  try {
    value = parseTyped(text, type)
  } catch (e) {
    toast(errorText(e), 'error')
    return false
  }
  if (editText(old) === editText(value) && bsonTypeOf(value) === t) return true
  try {
    await api.updateField(tab.connId, tab.db, tab.coll, { kind: 'ids', ids: [doc._id] }, { kind: 'set', path, value })
    replaceDocInPage(tabId, docIndex, setPath(doc, path, value))
    return true
  } catch (e) {
    toast(errorText(e), 'error')
    return false
  }
}

// ---------------------------------------------------------------------------
// Edit Value / Type
// ---------------------------------------------------------------------------

function EditValueBody({ tab, docIndex, path, onDone }: { tab: QueryTab; docIndex: number; path: string; onDone: () => void }): ReactElement {
  const doc = tab.docs![docIndex]
  const old = getPath(doc, path)
  const oldType = bsonTypeOf(old)
  const [type, setType] = useState<EditableType>(isEditableType(oldType) ? oldType : 'string')
  const [text, setText] = useState(isEditableType(oldType) ? editText(old) : shellText(old))
  const [mode, setMode] = useState<'force' | 'convert'>('force')
  const [err, setErr] = useState<string | null>(null)

  const changeType = (t: EditableType): void => {
    setType(t)
    try {
      const conv = mode === 'convert' ? convertValue(old, t) : t === type ? parseTyped(text, type) : defaultValue(t)
      setText(t === 'null' ? '' : editText(conv))
      setErr(null)
    } catch {
      setText(t === 'null' ? '' : editText(defaultValue(t)))
    }
  }

  const save = async (): Promise<void> => {
    let value: unknown
    try {
      value = parseTyped(text, type)
    } catch (e) {
      setErr(errorText(e))
      return
    }
    if (await applyFieldOp(tab, { kind: 'ids', ids: [doc._id] }, { kind: 'set', path, value }, docIndex)) onDone()
  }

  return (
    <Modal
      title={`Edit Value / Type — ${path}`}
      icon="edit"
      onClose={onDone}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onDone}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Update
          </button>
        </>
      }
    >
      <div className="field">
        <label>Current type</label>
        <span>{TYPE_LABELS[oldType]}</span>
      </div>
      <div className="field">
        <label>Type change</label>
        <div className="segmented small">
          <button className={mode === 'force' ? 'on' : ''} onClick={() => setMode('force')} title="Replace the value with what you type">
            Always change value (Force)
          </button>
          <button className={mode === 'convert' ? 'on' : ''} onClick={() => setMode('convert')} title="Convert the current value to the new type">
            Only change type (Convert)
          </button>
        </div>
      </div>
      <div className="field">
        <label>New type</label>
        <div className="row">
          <TypeSelect value={type} onChange={changeType} />
        </div>
      </div>
      <div className={`field ${type === 'array' || type === 'object' ? 'top' : ''}`}>
        <label>Value</label>
        <div className="row">
          <ValueInput type={type} text={text} onChange={(v) => (setText(v), setErr(null))} invalid={!!err} onSubmit={save} />
        </div>
      </div>
      {oldType === 'objectId' && (
        <div className="field">
          <label>Created</label>
          <span className="muted">{dataDateText((old as { getTimestamp(): Date }).getTimestamp())}</span>
        </div>
      )}
      {err && <div className="notice error">{err}</div>}
    </Modal>
  )
}

export function editValueDialog(tab: QueryTab, docIndex: number, path: string): void {
  if (!canWrite(tab) || !guardPath(tab, docIndex, path)) return
  void openModal<void>((close) => <EditValueBody tab={tab} docIndex={docIndex} path={path} onDone={() => close()} />)
}

// ---------------------------------------------------------------------------
// Set value / Add field / Rename / Remove with scope
// ---------------------------------------------------------------------------

function FieldOpBody({ tab, kind, path, docIndex, onDone }: { tab: QueryTab; kind: 'set' | 'add' | 'rename' | 'remove'; path: string; docIndex?: number; onDone: () => void }): ReactElement {
  const hasDoc = docIndex !== undefined
  const [scope, setScope] = useState<ScopeKind>(tab.selection.length > 1 ? 'selected' : hasDoc ? 'doc' : 'query')
  const cur = hasDoc ? getPath(tab.docs![docIndex!], path) : undefined
  const curType = bsonTypeOf(cur)
  const [fieldPath, setFieldPath] = useState(kind === 'add' ? (path ? `${path}.` : '') : path)
  const [newName, setNewName] = useState(lastSegment(path))
  const [type, setType] = useState<EditableType>(kind === 'set' && isEditableType(curType) && cur !== undefined ? curType : 'string')
  const [text, setText] = useState(kind === 'set' && cur !== undefined && isEditableType(curType) ? editText(cur) : '')
  const [err, setErr] = useState<string | null>(null)

  const title = { set: 'Set Value', add: 'Add Field', rename: 'Rename Field', remove: 'Remove Field' }[kind]

  const run = async (): Promise<void> => {
    let op: FieldOp
    const p = fieldPath.trim()
    if (!p || p.endsWith('.')) return setErr('Field name is required')
    if (kind === 'rename') {
      if (!newName.trim() || newName.includes('.')) return setErr('Enter a new field name without dots')
      op = { kind: 'rename', path: p, newName: newName.trim() }
    } else if (kind === 'remove') op = { kind: 'unset', path: p }
    else {
      try {
        op = { kind: 'set', path: p, value: parseTyped(text, type) }
      } catch (e) {
        return setErr(errorText(e))
      }
    }
    if (await applyFieldOp(tab, scopeOf(tab, scope, docIndex), op, docIndex)) onDone()
  }

  return (
    <Modal
      title={title}
      icon={kind === 'remove' ? 'trash' : 'edit'}
      onClose={onDone}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onDone}>
            Cancel
          </button>
          <button className={`btn ${kind === 'remove' ? 'danger solid' : 'primary'}`} onClick={run}>
            {title}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{kind === 'add' ? 'New field path' : 'Field'}</label>
        <input className="input mono" value={fieldPath} onChange={(e) => (setFieldPath(e.target.value), setErr(null))} disabled={kind !== 'add'} autoFocus={kind === 'add'} />
      </div>
      {kind === 'rename' && (
        <div className="field">
          <label>New name</label>
          <input className="input mono" value={newName} onChange={(e) => (setNewName(e.target.value), setErr(null))} autoFocus onKeyDown={(e) => e.key === 'Enter' && run()} />
        </div>
      )}
      {(kind === 'set' || kind === 'add') && (
        <>
          <div className="field">
            <label>Type</label>
            <div className="row">
              <TypeSelect
                value={type}
                onChange={(t) => {
                  setType(t)
                  setText(t === 'null' ? '' : editText(defaultValue(t)))
                }}
              />
            </div>
          </div>
          <div className={`field ${type === 'array' || type === 'object' ? 'top' : ''}`}>
            <label>Value</label>
            <div className="row">
              <ValueInput type={type} text={text} onChange={(v) => (setText(v), setErr(null))} invalid={!!err} onSubmit={run} />
            </div>
          </div>
        </>
      )}
      <div className="field top">
        <label>Apply to</label>
        <ScopePicker tab={tab} value={scope} onChange={setScope} hasDoc={hasDoc} />
      </div>
      {kind === 'rename' && scope !== 'doc' && (
        <div className="notice" style={{ marginBottom: 8 }}>
          If a field named '{newName}' already exists in any of the documents, it will be overwritten.
        </div>
      )}
      {err && <div className="notice error">{err}</div>}
    </Modal>
  )
}

export function fieldOpDialog(tab: QueryTab, kind: 'set' | 'add' | 'rename' | 'remove', path: string, docIndex?: number): void {
  if (!canWrite(tab) || (kind !== 'add' && path && !guardPath(tab, docIndex, path))) return
  if ((kind === 'rename' || kind === 'remove' || kind === 'set') && (path === '_id' || path.startsWith('_id.'))) {
    toast('_id field cannot be changed', 'error')
    return
  }
  void openModal<void>((close) => <FieldOpBody tab={tab} kind={kind} path={path} docIndex={docIndex} onDone={() => close()} />)
}

export async function setNullInPlace(tab: QueryTab, docIndex: number, path: string): Promise<void> {
  if (!canWrite(tab) || !guardPath(tab, docIndex, path)) return
  await applyFieldOp(tab, { kind: 'ids', ids: [tab.docs![docIndex]._id] }, { kind: 'set', path, value: null }, docIndex)
}

// ---------------------------------------------------------------------------
// Document JSON editor / viewer / insert
// ---------------------------------------------------------------------------

function parseDocsText(text: string): Doc[] {
  const v = parseShellValue(text.trim() || '{}')
  const list = Array.isArray(v) ? v : [v]
  if (!list.every(isPlainDoc)) throw new Error('Enter a document { … } or an array of documents [ { … }, … ]')
  return list as Doc[]
}

function DocEditorBody({ tab, docIndex, doc, onDone, readOnly }: { tab: QueryTab; docIndex: number; doc: Doc; onDone: () => void; readOnly?: boolean }): ReactElement {
  const [text, setText] = useState(shellText(doc, 2))
  const [err, setErr] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    let next: Doc
    try {
      const list = parseDocsText(text)
      if (list.length !== 1) throw new Error('Enter exactly one document')
      next = list[0]
    } catch (e) {
      return setErr(errorText(e))
    }
    try {
      await api.replaceDocument(tab.connId, tab.db, tab.coll, doc._id, next)
      await reloadDoc(tab.id, docIndex)
      toast('Document updated', 'success')
      onDone()
    } catch (e) {
      setErr(errorText(e))
    }
  }
  return (
    <Modal
      title={readOnly ? `View Document — ${tab.coll}` : `Edit Document — ${tab.coll}`}
      icon="json"
      onClose={onDone}
      width={820}
      footer={
        readOnly ? (
          <>
            <button className="btn" onClick={() => api.copyText(text).then(() => toast('Copied', 'success'))}>
              Copy
            </button>
            <button className="btn primary" onClick={onDone}>
              Close
            </button>
          </>
        ) : (
          <>
            <span className="muted">
              <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> to save
            </span>
            <span className="spacer" />
            <button className="btn" onClick={onDone}>
              Cancel
            </button>
            <button className="btn primary" onClick={save}>
              Update
            </button>
          </>
        )
      }
    >
      <CodeEditor value={text} onChange={(v) => (setText(v), setErr(null))} full readOnly={readOnly} minHeight={360} maxHeight={560} onSubmit={readOnly ? undefined : save} invalid={!!err} autoFocus />
      {err && (
        <div className="notice error selectable" style={{ marginTop: 8 }}>
          {err}
        </div>
      )}
    </Modal>
  )
}

/**
 * The page shows projected documents; editing or copying those would drop the hidden fields.
 * With a projection, read the full document from the server first.
 */
async function fullDocument(tab: QueryTab, docIndex: number): Promise<Doc | null> {
  const doc = tab.docs![docIndex]
  if (!tab.applied?.projection) return doc
  try {
    const full = await api.getDocument(tab.connId, tab.db, tab.coll, doc._id)
    if (!full) toast('Document not found (it may have been deleted)', 'error')
    return full
  } catch (e) {
    toast(errorText(e), 'error')
    return null
  }
}

export async function editDocumentDialog(tab: QueryTab, docIndex: number): Promise<void> {
  if (!canWrite(tab)) return
  const doc = await fullDocument(tab, docIndex)
  if (doc) void openModal<void>((close) => <DocEditorBody tab={tab} docIndex={docIndex} doc={doc} onDone={() => close()} />)
}

export async function viewDocumentDialog(tab: QueryTab, docIndex: number): Promise<void> {
  const doc = await fullDocument(tab, docIndex)
  if (doc) void openModal<void>((close) => <DocEditorBody tab={tab} docIndex={docIndex} doc={doc} onDone={() => close()} readOnly />)
}

function InsertBody({ tab, initial, onDone }: { tab: QueryTab; initial: string; onDone: () => void }): ReactElement {
  const [text, setText] = useState(initial)
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [added, setAdded] = useState(0)

  const validate = (): Doc[] | null => {
    try {
      const d = parseDocsText(text)
      return d
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) })
      return null
    }
  }
  const add = async (cont: boolean): Promise<void> => {
    const docs = validate()
    if (!docs) return
    try {
      const n = await api.insertDocuments(tab.connId, tab.db, tab.coll, docs)
      setAdded((a) => a + n)
      if (cont) {
        setMsg({ kind: 'ok', text: `${plural(n, 'document')} added` })
        setText('{\n  \n}')
      } else {
        toast(`${plural(added + n, 'document')} added`, 'success')
        onDone()
      }
      void refreshPage(tab.id)
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) })
    }
  }
  return (
    <Modal
      title={`Insert Document — ${tab.db}.${tab.coll}`}
      icon="plus"
      onClose={onDone}
      width={820}
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              const d = validate()
              if (d) setMsg({ kind: 'ok', text: `Valid — ${plural(d.length, 'document')}` })
            }}
          >
            Validate JSON
          </button>
          <button
            className="btn"
            onClick={() => {
              const d = validate()
              if (d) setText(d.length === 1 ? shellText(d[0], 2) : shellText(d, 2))
            }}
          >
            Format JSON
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onDone}>
            {added ? 'Close' : 'Cancel'}
          </button>
          <button className="btn" onClick={() => add(true)}>
            Add & Continue
          </button>
          <button className="btn primary" onClick={() => add(false)}>
            Add Document
          </button>
        </>
      }
    >
      <div className="muted" style={{ marginBottom: 8 }}>
        Enter one document or an array of documents. Shell syntax such as <span className="mono">ObjectId("…")</span>, <span className="mono">ISODate("…")</span> and <span className="mono">NumberLong(…)</span> is supported.
      </div>
      <CodeEditor value={text} onChange={(v) => (setText(v), setMsg(null))} full minHeight={320} maxHeight={520} onSubmit={() => add(false)} autoFocus />
      {msg && (
        <div className={`notice ${msg.kind === 'error' ? 'error' : ''} selectable`} style={{ marginTop: 8, background: msg.kind === 'ok' ? 'var(--bg-2)' : undefined }}>
          {msg.text}
        </div>
      )}
    </Modal>
  )
}

export function insertDocumentDialog(tab: QueryTab, initial = '{\n  \n}'): void {
  if (!canWrite(tab)) return
  void openModal<void>((close) => <InsertBody tab={tab} initial={initial} onDone={() => close()} />)
}

export async function duplicateDocument(tab: QueryTab, docIndex: number): Promise<void> {
  const full = await fullDocument(tab, docIndex)
  if (!full) return
  const d = { ...full }
  delete d._id
  insertDocumentDialog(tab, shellText(d, 2))
}

/** Paste documents from the clipboard text into the insert dialog. */
export async function pasteDocuments(tab: QueryTab): Promise<void> {
  const text = await navigator.clipboard.readText().catch(() => '')
  insertDocumentDialog(tab, text || '{\n  \n}')
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteSelected(tab: QueryTab, fallbackIndex?: number): Promise<void> {
  if (!canWrite(tab)) return
  let ids = selectedIds(tab)
  // The focused row can be past the end after the page shrank (delete, last page).
  const fallback = fallbackIndex !== undefined ? tab.docs?.[fallbackIndex] : undefined
  if (!ids.length && fallback) ids = [fallback._id]
  if (!ids.length) return
  // A single document may be deleted without asking (Settings → Browsing data); several always ask.
  const ok =
    (ids.length === 1 && !useStore.getState().settings.confirmSingleDelete) ||
    (await confirmDialog({
    title: ids.length === 1 ? 'Delete Document' : 'Delete Documents',
    message: ids.length === 1 ? <>Delete document with _id <span className="mono">{shellText(ids[0])}</span>?</> : <>Delete the {ids.length} selected documents?</>,
    confirmLabel: 'Delete',
    danger: true
  }))
  if (!ok) return
  try {
    const n = await api.deleteDocuments(tab.connId, tab.db, tab.coll, { kind: 'ids', ids })
    toast(`${plural(n, 'document')} deleted`, 'success')
    await refreshPage(tab.id)
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

/** "Delete all matching": the Delete Documents dialog, starting from the tab's query. */
export async function deleteMatching(tab: QueryTab): Promise<void> {
  const { deleteDocumentsDialog } = await import('./DeleteDocumentsDialog')
  deleteDocumentsDialog(tab, 'query')
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

export async function copyDocs(docs: Doc[]): Promise<void> {
  await api.copyText(docs.length === 1 ? prefDocText(docs[0]) : prefDocText(docs))
  toast(docs.length === 1 ? 'Document copied' : `${docs.length} documents copied`, 'success')
}

export async function copyValue(v: unknown): Promise<void> {
  const t = bsonTypeOf(v)
  await api.copyText(t === 'string' ? (v as string) : isEditableType(t) && t !== 'object' && t !== 'array' ? editText(v) : shellText(v, 2))
  toast('Value copied', 'success')
}

export async function copyPath(path: string): Promise<void> {
  await api.copyText(path)
  toast(`Copied ${path}`, 'success')
}

export const parentOf = parentPath
