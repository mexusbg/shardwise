import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactElement } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { bsonTypeOf, cellText, editText, isEditableType, shellText } from '@shared/bsonValue'
import { joinPath } from '@shared/docPaths'
import type { Doc } from '@shared/api'
import { useDateSettingsKey } from '../../lib/datetime'
import type { QueryTab } from '../../state/store'
import { patchTab, useStore } from '../../state/store'
import { showMenu } from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { Icon } from '../Icon'
import { canWrite, editValueDialog, saveInPlace } from '../editing/dialogs'
import { docMenu, isContainer, sameResultTab, selectRow, startFieldDrag, typeLabel, ValueText } from './common'

const ROW_H = 26

interface Row {
  key: string
  base: string
  docIndex: number
  path: string
  depth: number
  label: string
  value: unknown
  container: boolean
  open: boolean
}

interface EditState {
  key: string
  docIndex: number
  path: string
  text: string
}

const docKey = (d: Doc, i: number): string => (d._id !== undefined ? shellText(d._id) : `#${i}`)

function children(v: unknown): [string, string | number, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [`[${i}]`, i, x])
  return Object.entries(v as Doc).map(([k, x]) => [k, k, x])
}

/** Keys of `v` and every container below it. */
function containerKeys(base: string, path: string, v: unknown, out: string[] = []): string[] {
  if (!isContainer(v)) return out
  out.push(`${base}|${path}`)
  for (const [, seg, x] of children(v)) containerKeys(base, joinPath(path, seg), x, out)
  return out
}

export const TreeView = memo(function TreeView({ tab }: { tab: QueryTab }): ReactElement {
  // Date cells depend on the date settings, which are not part of the tab.
  useDateSettingsKey()
  const docs = tab.docs ?? []
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const editRef = useRef<EditState | null>(null)
  editRef.current = edit
  const expandFirst = useStore((s) => s.settings.treeExpandFirst)

  // Settings → Browsing data: open the first document of each new result.
  useEffect(() => {
    const first = tab.docs?.[0]
    if (!expandFirst || !first || !isContainer(first)) return
    const key = `${docKey(first, 0)}|`
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [tab.docs, expandFirst])

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (base: string, docIndex: number, path: string, depth: number, label: string, v: unknown): void => {
      const key = `${base}|${path}`
      const container = isContainer(v)
      const open = container && expanded.has(key)
      out.push({ key, base, docIndex, path, depth, label, value: v, container, open })
      if (open) for (const [l, seg, x] of children(v)) walk(base, docIndex, joinPath(path, seg), depth + 1, l, x)
    }
    docs.forEach((d, i) => {
      const base = docKey(d, i)
      walk(base, i, '', 0, `(${i + 1}) ${d._id !== undefined ? shellText(d._id) : ''}`, d)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, tab.rev, expanded])

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
    scrollMargin: ROW_H,
    scrollPaddingStart: ROW_H
  })

  const focusIndex = focusKey ? rows.findIndex((r) => r.key === focusKey) : -1

  const setOpen = (keys: string[], open: boolean): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (open) next.add(k)
        else next.delete(k)
      }
      return next
    })

  const toggle = (r: Row): void => {
    if (r.container) setOpen([r.key], !r.open)
  }

  const expandRecursive = (r: Row): void => setOpen(containerKeys(r.base, r.path, r.value), true)

  const collapseBelow = (r: Row): void => {
    const prefix = r.path ? `${r.key}.` : r.key
    setExpanded((prev) => new Set([...prev].filter((k) => k !== r.key && !k.startsWith(prefix))))
  }

  const expandAll = (): void => setExpanded(new Set(docs.flatMap((d, i) => containerKeys(docKey(d, i), '', d))))

  const focusRow = (i: number): void => {
    const r = rows[i]
    if (!r) return
    setFocusKey(r.key)
    if (!(tab.selection.length === 1 && tab.selection[0] === r.docIndex)) patchTab(tab.id, { selection: [r.docIndex] })
    virt.scrollToIndex(i)
  }

  const startEdit = (r: Row): void => {
    if (r.container || r.path === '_id' || r.path.startsWith('_id.')) return
    if (!canWrite(tab)) return
    if (!isEditableType(bsonTypeOf(r.value))) return editValueDialog(tab, r.docIndex, r.path)
    setEdit({ key: r.key, docIndex: r.docIndex, path: r.path, text: editText(r.value) })
  }

  const finishEdit = (save: boolean): void => {
    const e = editRef.current
    if (!e) return
    editRef.current = null
    setEdit(null)
    scrollRef.current?.focus()
    if (save) void saveInPlace(tab.id, e.docIndex, e.path, e.text)
  }

  const onClick = (e: MouseEvent, r: Row): void => {
    setFocusKey(r.key)
    selectRow(tab, r.docIndex, e)
  }

  const onContext = (e: MouseEvent, r: Row): void => {
    setFocusKey(r.key)
    let t = tab
    if (!tab.selection.includes(r.docIndex)) {
      patchTab(tab.id, { selection: [r.docIndex] })
      t = { ...tab, selection: [r.docIndex] }
    }
    const extra: MenuItem[] = r.container
      ? [
          { label: 'Expand Recursively', icon: 'chevronDown', onClick: () => expandRecursive(r) },
          { label: 'Collapse All', icon: 'chevronRight', onClick: () => collapseBelow(r) },
          { separator: true }
        ]
      : []
    showMenu(e, docMenu(t, r.docIndex, r.path, extra))
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (edit || !rows.length) return
    const r = rows[focusIndex]
    switch (e.key) {
      case 'ArrowDown':
        focusRow(Math.min(focusIndex + 1, rows.length - 1))
        break
      case 'ArrowUp':
        focusRow(Math.max(focusIndex - 1, 0))
        break
      case 'Home':
        focusRow(0)
        break
      case 'End':
        focusRow(rows.length - 1)
        break
      case 'ArrowRight':
        if (!r?.container) break
        if (!r.open) toggle(r)
        else focusRow(focusIndex + 1)
        break
      case 'ArrowLeft': {
        if (!r) break
        if (r.open) toggle(r)
        else if (r.depth > 0) {
          let p = focusIndex - 1
          while (p >= 0 && rows[p].depth >= r.depth) p--
          focusRow(p)
        }
        break
      }
      case 'Enter':
      case 'F2':
        if (r) {
          if (r.container) toggle(r)
          else startEdit(r)
        }
        break
      default:
        return
    }
    e.preventDefault()
  }

  if (!docs.length) return <div className="result-empty">No documents</div>

  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <div className="row" style={{ padding: '3px 8px', borderBottom: '1px solid var(--border)', background: 'var(--bg-2)' }}>
        <button className="btn ghost small" onClick={expandAll} title="Expand all documents recursively">
          <Icon name="chevronDown" size={13} /> Expand All
        </button>
        <button className="btn ghost small" onClick={() => setExpanded(new Set())} title="Collapse all documents">
          <Icon name="chevronRight" size={13} /> Collapse All
        </button>
      </div>
      <div className="tv" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown} style={{ outline: 'none' }}>
        <div className="tv-head">
          <div>Key</div>
          <div>Value</div>
          <div>Type</div>
        </div>
        <div style={{ position: 'relative', height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((vi) => {
            const r = rows[vi.index]
            const sel = r.key === focusKey || (r.depth === 0 && tab.selection.includes(r.docIndex))
            const editing = edit && edit.key === r.key ? edit : null
            return (
              <div
                key={r.key}
                className={`tv-row ${sel ? 'sel' : ''}`}
                style={{ position: 'absolute', left: 0, right: 0, top: 0, transform: `translateY(${vi.start - ROW_H}px)` }}
                draggable={!!r.path && !editing}
                onDragStart={(e) => startFieldDrag(e, r.path, r.value)}
                onClick={(e) => onClick(e, r)}
                onDoubleClick={() => (r.container ? toggle(r) : startEdit(r))}
                onContextMenu={(e) => onContext(e, r)}
              >
                <div className="tv-key" style={{ paddingLeft: 8 + r.depth * 16 }} title={r.path || undefined}>
                  <span
                    className="twisty"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(r)
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    {r.container && <Icon name={r.open ? 'chevronDown' : 'chevronRight'} size={12} />}
                  </span>
                  <span className="ellipsis">{r.label}</span>
                </div>
                <div title={editing || r.container ? undefined : cellText(r.value)}>
                  {editing ? (
                    <input
                      className="cell-edit"
                      autoFocus
                      value={editing.text}
                      onChange={(e) => setEdit({ ...editing, text: e.target.value })}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') finishEdit(true)
                        else if (e.key === 'Escape') finishEdit(false)
                      }}
                      onBlur={() => finishEdit(true)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <ValueText v={r.value} />
                  )}
                </div>
                <div className="type-tag">{r.depth === 0 ? 'Document' : typeLabel(r.value)}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}, sameResultTab)
