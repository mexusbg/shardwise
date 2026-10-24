import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { bsonTypeOf, editText, isEditableType, isPlainDoc } from '@shared/bsonValue'
import { getPath, joinPath } from '@shared/docPaths'
import { patchTab } from '../../state/store'
import { useDateSettingsKey } from '../../lib/datetime'
import type { QueryTab } from '../../state/store'
import { runQuery, toggleSort } from '../../state/queryActions'
import { formatQuery } from '../../lib/queryText'
import { showMenu } from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { canWrite, copyPath, copyValue, deleteSelected, fieldOpDialog, saveInPlace } from '../editing/dialogs'
import { addFieldToBuilder } from '../vqb/vqbActions'
import { docMenu, isContainer, sameResultTab, selectRow, startFieldDrag, ValueText } from './common'
import { matchCommand } from '../../lib/commands'

const TABLE_COMMANDS = ['table.edit', 'table.parent', 'table.delete', 'table.copyValue', 'table.selectAll'] as const

const ROW_H = 26
const SCALAR_COL = '(value)'

function keysOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((_, i) => String(i))
  if (isPlainDoc(v)) return Object.keys(v)
  return []
}

/** Columns for the current step-in level: union of keys in first-seen order. */
function computeColumns(values: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let scalar = false
  for (const v of values) {
    if (v === undefined) continue
    if (!isPlainDoc(v) && !Array.isArray(v)) scalar = true
    for (const k of keysOf(v))
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
  }
  if (out.includes('_id')) out.splice(out.indexOf('_id'), 1), out.unshift('_id')
  if (scalar) out.unshift(SCALAR_COL)
  return out
}

function CellEditor({ initial, onDone }: { initial: string; onDone: (text: string | null) => void }): ReactElement {
  const [v, setV] = useState(initial)
  const done = useRef(false)
  const finish = (text: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(text)
  }
  return (
    <input
      className="cell-edit"
      autoFocus
      value={v}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(v)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(v)}
    />
  )
}

/** Type of the value; dates also show the exact UTC instant, whatever zone they are displayed in. */
function cellTitle(v: unknown): string {
  const t = bsonTypeOf(v)
  return t === 'date' && !isNaN((v as Date).getTime()) ? `date · ${(v as Date).toISOString()}` : t
}

/** Above this many columns only the visible ones are drawn (documents with a different key set each: thousands). */
const VIRTUAL_COLUMNS = 60
const ROWNUM_W = 56
const spacer = { padding: 0, border: 0 }

export const TableView = memo(function TableView({ tab }: { tab: QueryTab }): ReactElement {
  // Date cells depend on the date settings, which are not part of the tab.
  useDateSettingsKey()
  const docs = tab.docs ?? []
  const base = tab.tablePath.join('.')
  const values = useMemo(() => docs.map((d) => (base ? getPath(d, base) : d)), [docs, base])
  const allColumns = useMemo(() => computeColumns(values), [values])
  const columns = allColumns.filter((c) => !tab.hiddenColumns.includes(joinPath(base, c)))
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [focus, setFocus] = useState<{ row: number; col: number } | null>(null)
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [resizing, setResizing] = useState(false)
  const sortTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const rowVirtualizer = useVirtualizer({ count: docs.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 20 })

  useEffect(() => {
    setFocus(null)
    setEditing(null)
  }, [tab.applied, tab.page, base])

  const appliedSort = (tab.applied?.sort ?? {}) as Record<string, { valueOf(): unknown } | number>
  const sortKeys = Object.keys(appliedSort)
  const sortDir = (c: string): number => {
    const v = appliedSort[fullPath(c)]
    return v === undefined ? 0 : Number(v.valueOf()) < 0 ? -1 : 1
  }

  const width = (c: string): number => widths[c] ?? (c === '_id' ? 230 : c === SCALAR_COL ? 220 : 170)
  const fullPath = (c: string): string => (c === SCALAR_COL ? base : joinPath(base, c))
  const virtualCols = columns.length > VIRTUAL_COLUMNS
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: virtualCols ? columns.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => width(columns[i]),
    paddingStart: ROWNUM_W,
    overscan: 4
  })
  const colKey = columns.join('\u0000')
  useEffect(() => {
    if (virtualCols) colVirtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widths, colKey, virtualCols])
  const cellValue = (row: number, c: string): { v: unknown; missing: boolean } => {
    const rv = values[row]
    if (c === SCALAR_COL) return isPlainDoc(rv) || Array.isArray(rv) || rv === undefined ? { v: undefined, missing: true } : { v: rv, missing: false }
    if (Array.isArray(rv)) return /^\d+$/.test(c) && Number(c) < rv.length ? { v: rv[Number(c)], missing: false } : { v: undefined, missing: true }
    if (isPlainDoc(rv) && Object.prototype.hasOwnProperty.call(rv, c)) return { v: rv[c], missing: false }
    return { v: undefined, missing: true }
  }

  const stepInto = (c: string): void => {
    if (c === SCALAR_COL) return
    patchTab(tab.id, { tablePath: [...tab.tablePath, c] })
  }

  const canEditCell = (c: string, v: unknown, missing: boolean): boolean => {
    if (missing || isContainer(v)) return false
    const p = fullPath(c)
    if (p === '_id' || p.startsWith('_id.') || !p) return false
    const t = bsonTypeOf(v)
    return isEditableType(t) && t !== 'null'
  }

  const activate = (row: number, ci: number): void => {
    const c = columns[ci]
    const { v, missing } = cellValue(row, c)
    if (isContainer(v)) return stepInto(c)
    if (canEditCell(c, v, missing) && canWrite(tab)) setEditing({ row, col: c })
  }

  const finishEdit = async (row: number, c: string, text: string | null): Promise<void> => {
    setEditing(null)
    scroller.current?.focus()
    if (text === null) return
    await saveInPlace(tab.id, row, fullPath(c), text)
  }

  const startResize = (e: React.MouseEvent, c: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const w0 = width(c)
    setResizing(true)
    const move = (ev: MouseEvent): void => setWidths((w) => ({ ...w, [c]: Math.max(50, w0 + ev.clientX - x0) }))
    const up = (): void => {
      setResizing(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const sortBy = (c: string, dir: 1 | -1): void => {
    patchTab(tab.id, { sortText: formatQuery({ [fullPath(c)]: dir }) })
    void runQuery(tab.id)
  }

  const headerMenu = (e: React.MouseEvent, c: string): void => {
    const p = fullPath(c)
    const anyContainer = values.some((_, i) => isContainer(cellValue(i, c).v))
    const items: MenuItem[] = [
      { label: 'Open Nested Column', icon: 'stepIn', disabled: !anyContainer, onClick: () => stepInto(c) },
      ...(tab.tablePath.length ? [{ label: 'Back to Parent', icon: 'stepOut', onClick: () => patchTab(tab.id, { tablePath: tab.tablePath.slice(0, -1) }) }] : []),
      { separator: true },
      { label: 'Sort Ascending', onClick: () => sortBy(c, 1) },
      { label: 'Sort Descending', onClick: () => sortBy(c, -1) },
      { label: 'Add to Filter Builder', icon: 'builder', onClick: () => addFieldToBuilder(tab.id, p, undefined, false) },
      { separator: true },
      { label: 'Hide Column', onClick: () => patchTab(tab.id, { hiddenColumns: [...tab.hiddenColumns, p] }) },
      { label: 'Show All Columns', disabled: !tab.hiddenColumns.length, onClick: () => patchTab(tab.id, { hiddenColumns: [] }) },
      { label: 'Fit Column Width', onClick: () => setWidths((w) => ({ ...w, [c]: Math.min(600, Math.max(80, 8 * Math.max(c.length, ...values.slice(0, 50).map((_, i) => String(editText(cellValue(i, c).v)).length)) + 24)) })) },
      { label: 'Reset Columns', onClick: () => (setWidths({}), patchTab(tab.id, { hiddenColumns: [], tablePath: [] })) },
      { separator: true },
      { label: 'Copy Path', icon: 'copy', onClick: () => copyPath(p) },
      { label: 'Add Field…', icon: 'plus', onClick: () => fieldOpDialog(tab, 'add', base) },
      { label: 'Rename Field…', disabled: c === SCALAR_COL || p === '_id', onClick: () => fieldOpDialog(tab, 'rename', p) },
      { label: 'Remove Field…', icon: 'trash', danger: true, disabled: c === SCALAR_COL || p === '_id', onClick: () => fieldOpDialog(tab, 'remove', p) }
    ]
    showMenu(e, items)
  }

  const cellMenu = (e: React.MouseEvent, row: number, c: string): void => {
    if (!tab.selection.includes(row)) selectRow(tab, row, { ctrlKey: false, metaKey: false, shiftKey: false })
    const { v, missing } = cellValue(row, c)
    const p = fullPath(c)
    const fresh = { ...tab, selection: tab.selection.includes(row) ? tab.selection : [row] }
    const extra: MenuItem[] = []
    if (!missing && isContainer(v)) extra.push({ label: 'Open Nested Value', icon: 'stepIn', onClick: () => stepInto(c) })
    if (tab.tablePath.length) extra.push({ label: 'Back to Parent', icon: 'stepOut', onClick: () => patchTab(tab.id, { tablePath: tab.tablePath.slice(0, -1) }) })
    if (extra.length) extra.push({ separator: true })
    if (missing) {
      showMenu(e, [...extra, ...docMenu(fresh, row, '')])
      return
    }
    showMenu(e, docMenu(fresh, row, p, extra))
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (editing || !docs.length) return
    const f = focus ?? { row: 0, col: 0 }
    const move = (row: number, col: number): void => {
      const r = Math.max(0, Math.min(docs.length - 1, row))
      const c = Math.max(0, Math.min(columns.length - 1, col))
      setFocus({ row: r, col: c })
      rowVirtualizer.scrollToIndex(r)
      if (virtualCols) colVirtualizer.scrollToIndex(c)
      if (!e.shiftKey) patchTab(tab.id, { selection: [r] })
    }
    // Rebindable commands first (Settings → Shortcuts → Table view), then fixed navigation keys.
    switch (matchCommand(e.nativeEvent, TABLE_COMMANDS)) {
      case 'table.edit':
        e.preventDefault()
        if (focus) activate(focus.row, focus.col)
        return
      case 'table.parent':
        if (tab.tablePath.length && !focus) {
          e.preventDefault()
          patchTab(tab.id, { tablePath: tab.tablePath.slice(0, -1) })
        }
        return
      case 'table.delete':
        e.preventDefault()
        void deleteSelected(tab, focus?.row)
        return
      case 'table.copyValue':
        if (focus) {
          e.preventDefault()
          const { v, missing } = cellValue(focus.row, columns[focus.col])
          if (!missing) void copyValue(v)
        }
        return
      case 'table.selectAll':
        e.preventDefault()
        patchTab(tab.id, { selection: docs.map((_, i) => i) })
        return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        return move(f.row + 1, f.col)
      case 'ArrowUp':
        e.preventDefault()
        return move(f.row - 1, f.col)
      case 'ArrowRight':
        e.preventDefault()
        return move(f.row, f.col + 1)
      case 'ArrowLeft':
        e.preventDefault()
        return move(f.row, f.col - 1)
      case 'PageDown':
        e.preventDefault()
        return move(f.row + 20, f.col)
      case 'PageUp':
        e.preventDefault()
        return move(f.row - 20, f.col)
    }
  }

  const items = rowVirtualizer.getVirtualItems()
  const padTop = items.length ? items[0].start : 0
  const padBottom = items.length ? rowVirtualizer.getTotalSize() - items[items.length - 1].end : 0
  const totalWidth = ROWNUM_W + columns.reduce((s, c) => s + width(c), 0)
  // Indexes (into `columns`) of the drawn columns, and the widths left and right of them.
  const colItems = virtualCols ? colVirtualizer.getVirtualItems() : null
  const shown = colItems ? colItems.map((c) => c.index) : columns.map((_, i) => i)
  const padLeft = colItems?.length ? colItems[0].start - ROWNUM_W : 0
  const padRight = colItems?.length ? colVirtualizer.getTotalSize() - colItems[colItems.length - 1].end : 0
  const spanAll = shown.length + 1 + (padLeft > 0 ? 1 : 0) + (padRight > 0 ? 1 : 0)
  const rowOffset = (tab.applied?.skip ?? 0) + tab.page * tab.pageSize

  return (
    <div className="grid" ref={scroller} tabIndex={0} onKeyDown={onKey} style={resizing ? { cursor: 'col-resize' } : undefined}>
      <table style={{ width: totalWidth }}>
        <colgroup>
          <col style={{ width: ROWNUM_W }} />
          {padLeft > 0 && <col style={{ width: padLeft }} />}
          {shown.map((ci) => (
            <col key={columns[ci]} style={{ width: width(columns[ci]) }} />
          ))}
          {padRight > 0 && <col style={{ width: padRight }} />}
        </colgroup>
        <thead>
          <tr>
            <th className="rownum">#</th>
            {padLeft > 0 && <th style={spacer} />}
            {shown.map((ci) => columns[ci]).map((c) => (
              <th
                key={c}
                title={fullPath(c) || 'value'}
                draggable={c !== SCALAR_COL}
                onDragStart={(e) => startFieldDrag(e, fullPath(c))}
                onContextMenu={(e) => headerMenu(e, c)}
                onClick={(e) => {
                  if (c === SCALAR_COL || e.detail > 1) return
                  // Wait so a double-click (step into) does not also sort.
                  const add = e.shiftKey
                  clearTimeout(sortTimer.current)
                  sortTimer.current = setTimeout(() => toggleSort(tab.id, fullPath(c), add), 250)
                }}
                onDoubleClick={() => {
                  clearTimeout(sortTimer.current)
                  if (values.some((_, i) => isContainer(cellValue(i, c).v))) stepInto(c)
                }}
                style={{ position: 'sticky' }}
                className={sortDir(c) ? 'sorted' : undefined}
              >
                {c === SCALAR_COL ? <span className="sub">value</span> : c}
                {base && c !== SCALAR_COL && <span className="sub"> ({fullPath(c)})</span>}
                {sortDir(c) !== 0 && (
                  <span className="sort-ind" title={sortDir(c) === 1 ? 'Ascending' : 'Descending'}>
                    {sortDir(c) === 1 ? '▲' : '▼'}
                    {sortKeys.length > 1 && <sup>{sortKeys.indexOf(fullPath(c)) + 1}</sup>}
                  </span>
                )}
                <span className="col-resize" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
              </th>
            ))}
            {padRight > 0 && <th style={spacer} />}
          </tr>
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr style={{ height: padTop }}>
              <td colSpan={spanAll} style={spacer} />
            </tr>
          )}
          {items.map((vr) => {
            const row = vr.index
            const sel = tab.selection.includes(row)
            return (
              <tr key={row} className={sel ? 'sel' : ''} style={{ height: ROW_H }}>
                <td
                  className="rownum"
                  onMouseDown={(e) => selectRow(tab, row, e)}
                  onContextMenu={(e) => {
                    if (!sel) selectRow(tab, row, { ctrlKey: false, metaKey: false, shiftKey: false })
                    showMenu(e, docMenu({ ...tab, selection: sel ? tab.selection : [row] }, row, ''))
                  }}
                >
                  {rowOffset + row + 1}
                </td>
                {padLeft > 0 && <td style={spacer} />}
                {shown.map((ci) => {
                  const c = columns[ci]
                  const { v, missing } = cellValue(row, c)
                  const isEditing = editing?.row === row && editing.col === c
                  const focused = focus?.row === row && focus.col === ci
                  return (
                    <td
                      key={c}
                      className={`${focused ? 'cell-focus' : ''} ${missing ? 'missing' : ''} ${fullPath(c) === '_id' ? 'id-col' : ''}`}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return
                        setFocus({ row, col: ci })
                        selectRow(tab, row, e)
                      }}
                      onDoubleClick={() => activate(row, ci)}
                      onContextMenu={(e) => {
                        setFocus({ row, col: ci })
                        cellMenu(e, row, c)
                      }}
                      draggable={!missing && !isEditing}
                      onDragStart={(e) => startFieldDrag(e, fullPath(c), v)}
                      title={missing ? undefined : cellTitle(v)}
                    >
                      {isEditing ? (
                        <CellEditor initial={editText(v)} onDone={(t) => finishEdit(row, c, t)} />
                      ) : (
                        <ValueText v={v} missing={missing} />
                      )}
                    </td>
                  )
                })}
                {padRight > 0 && <td style={spacer} />}
              </tr>
            )
          })}
          {padBottom > 0 && (
            <tr style={{ height: padBottom }}>
              <td colSpan={spanAll} style={spacer} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}, sameResultTab)

