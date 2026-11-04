import { memo, useRef, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { bsonTypeOf, cellText, editText, isEditableType, shellText } from '@shared/bsonValue'
import { joinPath } from '@shared/docPaths'
import type { Doc } from '@shared/api'
import { useDateSettingsKey } from '../../lib/datetime'
import type { QueryTab } from '../../state/store'
import { patchTab } from '../../state/store'
import { showMenu } from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { Icon } from '../Icon'
import { canWrite, copyDocs, deleteSelected, duplicateDocument, editDocumentDialog, editValueDialog, saveInPlace } from '../editing/dialogs'
import { docMenu, FieldValue, isContainer, sameResultTab, selectRow, startFieldDrag, typeLabel } from './common'
import { CellEditor } from './CellEditor'
import { NestedBar, useNestedCollapsed } from './NestedBar'

/** Fields shown per document or sub-document before "Show N more fields". */
const FIRST_FIELDS = 25

interface EditState {
  key: string
  docIndex: number
  path: string
  text: string
}

const docKey = (d: Doc, i: number): string => (d._id !== undefined ? shellText(d._id) : `#${i}`)

function entries(v: unknown): [string, string | number, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), i, x])
  return Object.entries(v as Doc).map(([k, x]) => [k, k, x])
}

/** Keys of `v` and every container below it. */
function containerKeys(base: string, path: string, v: unknown, out: string[] = []): string[] {
  if (!isContainer(v)) return out
  if (path) out.push(`${base}|${path}`)
  for (const [, seg, x] of entries(v)) containerKeys(base, joinPath(path, seg), x, out)
  return out
}

/**
 * Documents as cards with one line per field (like MongoDB Compass): sub-documents and arrays open in place, long
 * documents show their first fields until "Show more". Values edit in place with a double click.
 */
export const ListView = memo(function ListView({ tab }: { tab: QueryTab }): ReactElement {
  // Date values depend on the date settings, which are not part of the tab.
  useDateSettingsKey()
  const docs = tab.docs ?? []
  const scrollRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useNestedCollapsed('shardwise.listView.nested')
  // Fields opened (when collapsed) or folded (when expanded) by hand, so a new page follows the chosen mode.
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set())
  const isOpen = (key: string): boolean => collapsed === flipped.has(key)
  const chooseNested = (c: boolean): void => {
    setCollapsed(c)
    setFlipped(new Set())
  }
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set())
  const [edit, setEdit] = useState<EditState | null>(null)
  const editRef = useRef<EditState | null>(null)
  editRef.current = edit

  const virt = useVirtualizer({
    count: docs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => 26 + Math.min(Object.keys(docs[i] ?? {}).length, FIRST_FIELDS + 1) * 20,
    overscan: 4,
    getItemKey: (i) => (docs[i] ? docKey(docs[i], i) : i)
  })

  const toggleIn = (set: (f: (prev: Set<string>) => Set<string>) => void, key: string): void =>
    set((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const setOpen = (keys: string[], open: boolean): void =>
    setFlipped((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (open === collapsed) next.add(k)
        else next.delete(k)
      }
      return next
    })

  const startEdit = (docIndex: number, key: string, path: string, v: unknown): void => {
    if (isContainer(v) || path === '_id' || path.startsWith('_id.')) return
    if (!canWrite(tab)) return
    if (!isEditableType(bsonTypeOf(v))) return editValueDialog(tab, docIndex, path)
    setEdit({ key, docIndex, path, text: editText(v) })
  }

  const finishEdit = (text: string | null): void => {
    const e = editRef.current
    if (!e) return
    editRef.current = null
    setEdit(null)
    if (text !== null) void saveInPlace(tab.id, e.docIndex, e.path, text)
  }

  /** The tab with only this document selected (card buttons act on that one). */
  const only = (docIndex: number): QueryTab => {
    if (!(tab.selection.length === 1 && tab.selection[0] === docIndex)) patchTab(tab.id, { selection: [docIndex] })
    return { ...tab, selection: [docIndex] }
  }

  const onContext = (e: MouseEvent, docIndex: number, base: string, path: string, v: unknown): void => {
    e.stopPropagation()
    const t = tab.selection.includes(docIndex) ? tab : only(docIndex)
    const below = (): string[] => [...(path ? [`${base}|${path}`] : []), ...containerKeys(base, path, v)]
    const extra: MenuItem[] = isContainer(v)
      ? [
          { label: 'Expand Recursively', icon: 'chevronDown', onClick: () => setOpen(below(), true) },
          { label: 'Collapse All', icon: 'chevronRight', onClick: () => setOpen(below(), false) },
          { separator: true }
        ]
      : []
    showMenu(e, docMenu(t, docIndex, path, extra))
  }

  const fields = (docIndex: number, base: string, path: string, v: unknown, depth: number): ReactElement => {
    const all = entries(v)
    const moreKey = `${base}|${path}`
    const full = showAll.has(moreKey) || all.length <= FIRST_FIELDS + 1
    const shown = full ? all : all.slice(0, FIRST_FIELDS)
    return (
      <>
        {shown.map(([label, seg, x]) => {
          const p = joinPath(path, seg)
          const key = `${base}|${p}`
          const container = isContainer(x) && entries(x).length > 0
          const open = container && isOpen(key)
          const editing = edit && edit.key === key ? edit : null
          return (
            <div key={label}>
              <div
                className="lv-field"
                style={{ paddingLeft: depth * 18 }}
                draggable={!editing}
                onDragStart={(e) => startFieldDrag(e, p, x)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (container) toggleIn(setFlipped, key)
                  else startEdit(docIndex, key, p, x)
                }}
                onContextMenu={(e) => onContext(e, docIndex, base, p, x)}
              >
                <span className="twisty" onClick={() => container && toggleIn(setFlipped, key)} onDoubleClick={(e) => e.stopPropagation()}>
                  {container && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />}
                </span>
                <span className="lv-key" title={p}>
                  {label}:
                </span>
                <span className="lv-value" title={editing || isContainer(x) ? undefined : cellText(x)}>
                  {editing ? <CellEditor initial={editing.text} path={p} text={bsonTypeOf(x) === 'string'} onDone={finishEdit} /> : <FieldValue v={x} />}
                </span>
                <span className="lv-type">{typeLabel(x)}</span>
              </div>
              {open && fields(docIndex, base, p, x, depth + 1)}
            </div>
          )
        })}
        {all.length > FIRST_FIELDS + 1 && (
          <button className="lv-more" style={{ marginLeft: depth * 18 + 16 }} onClick={() => toggleIn(setShowAll, moreKey)}>
            <Icon name={full ? 'chevronUp' : 'chevronDown'} size={11} /> {full ? `Hide ${all.length - FIRST_FIELDS} fields` : `Show ${all.length - FIRST_FIELDS} more fields`}
          </button>
        )}
      </>
    )
  }

  if (!docs.length) return <div className="result-empty">No documents</div>

  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <NestedBar collapsed={collapsed} onChange={chooseNested} />
      <div className="lv" ref={scrollRef}>
        <div style={{ position: 'relative', height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((vi) => {
            const i = vi.index
            const d = docs[i]
            const base = docKey(d, i)
            const keys = containerKeys(base, '', d)
            return (
              <div key={vi.key} data-index={i} ref={virt.measureElement} className="lv-slot" style={{ transform: `translateY(${vi.start}px)` }}>
                <div className={`lv-card ${tab.selection.includes(i) ? 'sel' : ''}`} onClick={(e) => selectRow(tab, i, e)} onContextMenu={(e) => onContext(e, i, base, '', d)}>
                  <div className="lv-actions" onClick={(e) => e.stopPropagation()}>
                    {keys.length > 0 && (
                      <button className="btn ghost icon small" title={keys.every(isOpen) ? 'Collapse all fields' : 'Expand all fields'} onClick={() => setOpen(keys, !keys.every(isOpen))}>
                        <Icon name={keys.every(isOpen) ? 'chevronUp' : 'chevronDown'} size={13} />
                      </button>
                    )}
                    <button className="btn ghost icon small" title="Edit as JSON" onClick={() => void editDocumentDialog(only(i), i)}>
                      <Icon name="edit" size={13} />
                    </button>
                    <button className="btn ghost icon small" title="Copy document" onClick={() => void copyDocs([d])}>
                      <Icon name="copy" size={13} />
                    </button>
                    <button className="btn ghost icon small" title="Duplicate…" onClick={() => void duplicateDocument(only(i), i)}>
                      <Icon name="duplicate" size={13} />
                    </button>
                    <button className="btn ghost icon small" title="Delete document…" onClick={() => void deleteSelected(only(i), i)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                  {fields(i, base, '', d, 0)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}, sameResultTab)
