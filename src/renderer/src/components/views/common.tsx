import { updateDocumentsDialog } from '../editing/UpdateDocumentsDialog'
import type { ReactElement } from 'react'
import { EJSON } from 'bson'
import { bsonTypeOf, cellText, TYPE_LABELS } from '@shared/bsonValue'
import type { BsonTypeName } from '@shared/bsonValue'
import { getPath } from '@shared/docPaths'
import type { MenuItem } from '../ContextMenu'
import type { QueryTab } from '../../state/store'
import { patchTab } from '../../state/store'
import { refreshPage, reloadDoc } from '../../state/queryActions'
import {
  copyDocs,
  copyPath,
  copyValue,
  deleteMatching,
  deleteSelected,
  duplicateDocument,
  editDocumentDialog,
  editValueDialog,
  fieldOpDialog,
  insertDocumentDialog,
  pasteDocuments,
  setNullInPlace,
  viewDocumentDialog
} from '../editing/dialogs'
import { addFieldToBuilder } from '../vqb/vqbActions'
import { shortcutLabel } from '../../lib/commands'

/** Drag payload types used between result views and the Filter Builder. */
export const DND_FIELD = 'application/x-shardwise-field'
export const DND_VALUE = 'application/x-shardwise-value'

export function startFieldDrag(e: React.DragEvent, path: string, value?: unknown): void {
  e.dataTransfer.setData(DND_FIELD, path)
  e.dataTransfer.setData('text/plain', path)
  if (value !== undefined) e.dataTransfer.setData(DND_VALUE, EJSON.stringify({ v: value }, { relaxed: false }))
  e.dataTransfer.effectAllowed = 'copy'
}

export function readFieldDrop(e: React.DragEvent): { path: string; value?: unknown; hasValue: boolean } | null {
  const path = e.dataTransfer.getData(DND_FIELD)
  if (!path) return null
  const raw = e.dataTransfer.getData(DND_VALUE)
  if (!raw) return { path, hasValue: false }
  try {
    return { path, value: (EJSON.parse(raw, { relaxed: false }) as { v: unknown }).v, hasValue: true }
  } catch {
    return { path, hasValue: false }
  }
}

/**
 * Props check for the memoized result views: they (and the dialogs / menus they open) only read these
 * fields, so typing in the query bar or toggling the builder does not re-render a large page.
 */
export function sameResultTab(a: { tab: QueryTab }, b: { tab: QueryTab }): boolean {
  const x = a.tab
  const y = b.tab
  return (
    x === y ||
    (x.id === y.id &&
      x.connId === y.connId &&
      x.db === y.db &&
      x.coll === y.coll &&
      x.isView === y.isView &&
      x.readOnly === y.readOnly &&
      x.docs === y.docs &&
      x.rev === y.rev &&
      x.applied === y.applied &&
      x.page === y.page &&
      x.pageSize === y.pageSize &&
      x.tablePath === y.tablePath &&
      x.hiddenColumns === y.hiddenColumns &&
      x.selection === y.selection)
  )
}

export function ValueText({ v, missing }: { v: unknown; missing?: boolean }): ReactElement {
  if (missing) return <span className="faint">—</span>
  const t = bsonTypeOf(v)
  const s = cellText(v)
  return <span className={`t-${t}`}>{t === 'string' ? s.replace(/\n/g, '⏎') : s}</span>
}

export const typeLabel = (v: unknown): string => {
  const t: BsonTypeName = bsonTypeOf(v)
  if (t === 'object') return 'Object'
  if (t === 'array') return `Array[${(v as unknown[]).length}]`
  return TYPE_LABELS[t]
}

export const isContainer = (v: unknown): boolean => {
  const t = bsonTypeOf(v)
  return t === 'object' || t === 'array'
}

/** Context menu for a value / field inside a document (Table and Tree views). */
export function docMenu(tab: QueryTab, docIndex: number, path: string, extra: MenuItem[] = []): MenuItem[] {
  const doc = tab.docs![docIndex]
  const v = path ? getPath(doc, path) : doc
  const isField = !!path
  const many = tab.selection.length > 1
  const selectedDocs = many ? tab.selection.map((i) => tab.docs![i]) : [doc]
  // Keyboard shortcuts of the table grid (the Tree view has its own fixed keys).
  const key = (id: 'table.copyValue' | 'table.delete'): string | undefined => (tab.view === 'table' ? shortcutLabel(id) || undefined : undefined)
  return [
    ...extra,
    ...(isField
      ? ([
          { label: 'Change Value or Type…', icon: 'edit', onClick: () => editValueDialog(tab, docIndex, path) },
          { label: 'Set Field…', onClick: () => fieldOpDialog(tab, 'set', path, docIndex) },
          { label: 'Set to null', onClick: () => setNullInPlace(tab, docIndex, path) },
          { label: 'Rename…', onClick: () => fieldOpDialog(tab, 'rename', path, docIndex) },
          { label: 'Remove…', icon: 'trash', onClick: () => fieldOpDialog(tab, 'remove', path, docIndex) },
          { separator: true }
        ] as MenuItem[])
      : []),
    { label: 'Add Field…', icon: 'plus', onClick: () => fieldOpDialog(tab, 'add', isField && isContainer(v) ? path : '', docIndex) },
    { separator: true },
    ...(isField
      ? ([
          { label: 'Add to Filter Builder', icon: 'builder', onClick: () => addFieldToBuilder(tab.id, path, v, true) },
          { separator: true }
        ] as MenuItem[])
      : []),
    {
      label: 'Copy',
      icon: 'copy',
      submenu: [
        ...(isField
          ? ([
              { label: 'Copy Value', shortcut: key('table.copyValue'), onClick: () => copyValue(v) },
              { label: 'Copy Path', onClick: () => copyPath(path) }
            ] as MenuItem[])
          : []),
        { label: many ? `Copy Selected Documents (${selectedDocs.length})` : 'Copy Document', onClick: () => copyDocs(selectedDocs) }
      ]
    },
    { separator: true },
    { label: 'Show as JSON…', icon: 'json', shortcut: shortcutLabel('query.showJson') || undefined, onClick: () => viewDocumentDialog(tab, docIndex) },
    { label: 'Edit as JSON…', icon: 'edit', shortcut: shortcutLabel('query.editJson') || undefined, onClick: () => editDocumentDialog(tab, docIndex) },
    { label: 'New Document…', icon: 'plus', onClick: () => insertDocumentDialog(tab) },
    { label: many ? `Update Selected Documents (${selectedDocs.length})…` : 'Update Documents…', icon: 'update', shortcut: shortcutLabel('query.updateDocuments') || undefined, onClick: () => updateDocumentsDialog(tab) },
    { label: 'Paste as New Document(s)…', onClick: () => pasteDocuments(tab) },
    { label: 'Duplicate…', icon: 'duplicate', onClick: () => duplicateDocument(tab, docIndex) },
    { separator: true },
    { label: 'Reload Document', icon: 'refresh', onClick: () => reloadDoc(tab.id, docIndex) },
    { label: 'Reload Page', onClick: () => refreshPage(tab.id) },
    { separator: true },
    { label: many ? `Delete Selected Documents (${selectedDocs.length})…` : 'Delete Document…', icon: 'trash', danger: true, shortcut: key('table.delete'), onClick: () => deleteSelected(tab, docIndex) },
    { label: 'Delete All Matching…', danger: true, onClick: () => deleteMatching(tab) }
  ]
}

/** Click selection logic shared by views. */
export function selectRow(tab: QueryTab, index: number, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void {
  const sel = tab.selection
  if (e.shiftKey && sel.length) {
    const anchor = sel[sel.length - 1]
    const [a, b] = anchor < index ? [anchor, index] : [index, anchor]
    const range = Array.from({ length: b - a + 1 }, (_, i) => a + i)
    patchTab(tab.id, { selection: [...new Set([...sel.filter((i) => i < a || i > b), ...range.filter((i) => i !== anchor), anchor])] })
  } else if (e.ctrlKey || e.metaKey) {
    patchTab(tab.id, { selection: sel.includes(index) ? sel.filter((i) => i !== index) : [...sel, index] })
  } else if (!(sel.length === 1 && sel[0] === index)) {
    patchTab(tab.id, { selection: [index] })
  }
}
