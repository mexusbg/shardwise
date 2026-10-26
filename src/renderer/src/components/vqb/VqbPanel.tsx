import { useEffect, useMemo, useState } from 'react'
import type { DragEvent, KeyboardEvent, ReactElement, ReactNode } from 'react'
import { collectPaths } from '@shared/docPaths'
import { itemsToProjection } from '@shared/vqb/projectionSort'
import { newProjectionItem, newSortItem, nid } from '@shared/vqb/types'
import type { ProjectionItem, SortItem } from '@shared/vqb/types'
import { api } from '../../lib/api'
import { emptyVqb, errorText, patchTab, toast } from '../../state/store'
import type { QueryTab, VqbState } from '../../state/store'
import { runQuery, setVqb } from '../../state/queryActions'
import { Icon } from '../Icon'
import { DND_FIELD } from '../views/common'
import { cls, DragHandle, MIME_NODE, MIME_PROJECTION, MIME_SORT, useDrop } from './vqbDnd'
import { editVqb, insertItem, moveItem } from './vqbActions'
import { countRules, QueryTree } from './VqbQuery'
import { AddButton, FieldChip, RowActions, Seg, Switch } from './vqbUi'
import { matches, useShortcut } from '../../lib/commands'
import './vqb.css'

type Item = ProjectionItem | SortItem
type ListKey = 'projection' | 'sort'

const DRAG_TYPES = [DND_FIELD, MIME_NODE, MIME_PROJECTION, MIME_SORT]

const DEFAULT_WIDTH = 430
const MIN_WIDTH = 300
const WIDTH_KEY = 'vqbW'
const clampWidth = (w: number): number => Math.round(Math.max(MIN_WIDTH, Math.min(w, window.innerWidth * 0.7)))

function savedWidth(): number {
  try {
    return clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH)
  } catch {
    return DEFAULT_WIDTH
  }
}

/** Width of the builder, dragged at its left edge (double-click resets); kept in this window's localStorage. */
function useResizableWidth(): [number, { onMouseDown: (e: React.MouseEvent) => void; onDoubleClick: () => void }, boolean] {
  const [width, setWidth] = useState(savedWidth)
  const [dragging, setDragging] = useState(false)
  const save = (w: number): void => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w))
    } catch {
      // Non-essential UI preference.
    }
  }
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    let last = w0
    setDragging(true)
    const move = (ev: MouseEvent): void => setWidth((last = clampWidth(w0 + x0 - ev.clientX)))
    const up = (): void => {
      setDragging(false)
      save(last)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const onDoubleClick = (): void => {
    setWidth(DEFAULT_WIDTH)
    save(DEFAULT_WIDTH)
  }
  return [width, { onMouseDown, onDoubleClick }, dragging]
}

/** True while something the builder accepts is dragged over it (drop targets light up). */
function useDragActive(): [boolean, { onDragEnter: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDropCapture: () => void }] {
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (!active) return
    const off = (): void => setActive(false)
    window.addEventListener('dragend', off)
    window.addEventListener('drop', off)
    return () => {
      window.removeEventListener('dragend', off)
      window.removeEventListener('drop', off)
    }
  }, [active])
  return [
    active,
    {
      onDragEnter: (e) => {
        if (!active && DRAG_TYPES.some((t) => e.dataTransfer.types.includes(t))) setActive(true)
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Element | null)) setActive(false)
      },
      onDropCapture: () => setActive(false)
    }
  ]
}

/** Enter in a value box runs the query (not in field pickers or list tokens, which use Enter themselves); Escape leaves the control. */
function keys(e: KeyboardEvent, run: () => void): void {
  const t = e.target as HTMLElement
  if (matches(e.nativeEvent, 'query.run')) {
    e.preventDefault()
    run()
  } else if (e.key === 'Enter' && !e.defaultPrevented && !e.shiftKey && t instanceof HTMLInputElement && !t.matches('.vqb-field-input, .vqb-token-input')) {
    e.preventDefault()
    run()
  } else if (e.key === 'Escape' && !e.defaultPrevented && t !== e.currentTarget && t.matches('input, select, textarea, button, [contenteditable]')) {
    t.blur()
  }
}

export function VqbPanel({ tab }: { tab: QueryTab }): ReactElement {
  const v = tab.vqb
  const listId = `vqb-fields-${tab.id}`
  const runKey = useShortcut('query.run')
  const paths = useMemo(() => collectPaths(tab.docs ?? []), [tab.docs])
  const toggle = (k: 'useQuery' | 'useProjection' | 'useSort', on: boolean): void => editVqb(tab.id, () => ({ [k]: on }))
  const reset = (): void => setVqb(tab.id, emptyVqb())
  const run = (): void => {
    if (v.errorMessage) toast(v.errorMessage, 'error')
    else void runQuery(tab.id)
  }
  const query = tab.queryText.replace(/\s+/g, ' ').trim()
  const copy = (): void => {
    api.copyText(tab.queryText.trim() || '{}').then(
      () => toast('Filter copied to clipboard', 'success'),
      (e) => toast(errorText(e), 'error')
    )
  }
  const [dragActive, dragHandlers] = useDragActive()
  const [width, resizeHandlers, resizing] = useResizableWidth()
  return (
    <div className={cls('vqb', dragActive && 'dnd')} style={{ width }} onKeyDown={(e) => keys(e, run)} {...dragHandlers}>
      <div className={cls('splitter vqb-splitter', resizing && 'dragging')} title="Drag to resize · double-click to reset" {...resizeHandlers} />
      <div className="vqb-top">
        <div className="vqb-title">
          <span className="vqb-logo">
            <Icon name="leaf" size={12} />
          </span>
          <span className="grow ellipsis">Filter Builder</span>
          <button className="btn small primary" title={runKey ? `Run query (Enter in a value, or ${runKey})` : 'Run query (Enter in a value)'} onClick={run}>
            <Icon name="play" size={10} />
            Run
          </button>
          <button className="btn small" title="Remove every condition, field and order" onClick={reset}>
            Clear
          </button>
          <button className="btn ghost icon small" title="Close the builder" onClick={() => patchTab(tab.id, { vqbOpen: false })}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className={cls('vqb-preview', v.errorMessage ? 'error' : !query && 'empty')}>
          {v.errorMessage ? (
            <>
              <Icon name="warn" size={12} />
              <span className="ellipsis" title={v.errorMessage}>
                {v.errorMessage}
              </span>
            </>
          ) : (
            <span className="ellipsis" title={query || 'Empty filter: every document matches'}>
              {query || '{ }'}
              {!query && <em> every document</em>}
            </span>
          )}
          <button className="vqb-copy" title="Copy the filter" onClick={copy}>
            <Icon name="copy" size={12} />
          </button>
        </div>
      </div>
      <div className="vqb-scroll">
        {v.unsupported && (
          <div className="vqb-notice">
            <Icon name="warn" size={14} />
            <div>
              This filter can't be shown as conditions. Changing anything here replaces it.{' '}
              <button className="link" onClick={reset}>
                Start over
              </button>
            </div>
          </div>
        )}
        <Card id="filter" title="Filter" hint="which documents" count={countRules(v.root)} on={v.useQuery} onToggle={(on) => toggle('useQuery', on)}>
          <QueryTree tab={tab} listId={listId} />
        </Card>
        <Card id="fields" title="Fields" hint="what each document shows" count={v.projection.length} on={v.useProjection} onToggle={(on) => toggle('useProjection', on)}>
          <ItemList
            tab={tab}
            k="projection"
            mime={MIME_PROJECTION}
            empty="Drag a column here to show or hide it"
            make={(f) => newProjectionItem(f)}
            render={(it, patch) => <ProjectionControls item={it as ProjectionItem} patch={patch} />}
          />
        </Card>
        <Card id="order" title="Order" hint="how results are sorted" count={v.sort.length} on={v.useSort} onToggle={(on) => toggle('useSort', on)}>
          <ItemList
            tab={tab}
            k="sort"
            mime={MIME_SORT}
            empty="Drag a column here to sort by it"
            make={(f) => newSortItem(f)}
            render={(it, patch) => <SortControls item={it as SortItem} patch={patch} />}
          />
        </Card>
      </div>
      <datalist id={listId}>
        {paths.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  )
}

function Card({ id, title, hint, count, on, onToggle, children }: { id: string; title: string; hint: string; count: number; on: boolean; onToggle: (on: boolean) => void; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(true)
  return (
    <section className={cls('vqb-card', !on && 'off', !open && 'closed')} data-section={id}>
      <header className="vqb-card-head">
        <button className="vqb-card-toggle" aria-expanded={open} title={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          <Icon name="chevronDown" size={12} />
          <span className="vqb-card-title">{title}</span>
          {count > 0 && <span className="vqb-count">{count}</span>}
          <span className="vqb-card-hint ellipsis">{on ? hint : 'not applied'}</span>
        </button>
        <Switch on={on} onChange={onToggle} label={on ? `Applied: turn the ${title.toLowerCase()} section off` : `Not applied: turn the ${title.toLowerCase()} section on`} />
      </header>
      {open && <div className="vqb-card-body">{children}</div>}
    </section>
  )
}

type Patch = (p: Partial<Item>) => void

interface ListProps {
  tab: QueryTab
  k: ListKey
  mime: string
  empty: string
  make: (field: string) => Item
  render: (item: Item, patch: Patch) => ReactNode
}

function ItemList({ tab, k, mime, empty, make, render }: ListProps): ReactElement {
  const items: Item[] = tab.vqb[k]
  const listId = `vqb-fields-${tab.id}`
  const edit = (fn: (l: Item[]) => Item[]): void => editVqb(tab.id, (v: VqbState) => ({ [k]: fn(v[k]) }))
  const dropAt = (index?: number): Parameters<typeof useDrop>[0] => ({
    mime,
    onMove: (id) => edit((l) => moveItem(l, id, index ?? l.length)),
    onField: (f) => edit((l) => insertItem(l, make(f.path), index))
  })
  const [over, drop] = useDrop(dropAt())
  const add = (): void => edit((l) => [...l, make('')])
  return (
    <div className="vqb-list">
      {items.map((it, i) => {
        const patch: Patch = (p) => edit((l) => l.map((x) => (x.id === it.id ? ({ ...x, ...p } as Item) : x)))
        return (
          <ItemRow key={it.id} item={it} mime={mime} drop={dropAt(i)} edit={edit} rank={k === 'sort' ? i + 1 : undefined} controls={render(it, patch)}>
            <FieldChip value={it.field} listId={listId} onChange={(field) => patch({ field })} />
          </ItemRow>
        )
      })}
      <div
        className={cls('vqb-drop', items.length ? 'vqb-foot' : 'vqb-empty', over && 'over')}
        {...drop}
        onDoubleClick={(e) => e.target === e.currentTarget && add()}
        title={items.length ? undefined : 'Drop a column here, or double-click to add an empty row'}
      >
        {!items.length && (
          <>
            <Icon name={k === 'sort' ? 'count' : 'table'} size={13} />
            <span className="grow ellipsis">{empty}</span>
          </>
        )}
        <AddButton label="Field" title={k === 'sort' ? 'Add a field to sort by' : 'Add a field to show or hide'} onClick={add} />
        {items.length > 0 && over && <span className="vqb-foot-hint">Drop to add here</span>}
      </div>
    </div>
  )
}

interface RowProps {
  item: Item
  mime: string
  drop: Parameters<typeof useDrop>[0]
  edit: (fn: (l: Item[]) => Item[]) => void
  rank?: number
  controls: ReactNode
  children: ReactNode
}

/** Field row: drag handle, rank, field, its controls, then the row menu. */
function ItemRow({ item, mime, drop, edit, rank, controls, children }: RowProps): ReactElement {
  const [over, handlers] = useDrop(drop)
  return (
    <div className={cls('vqb-entry', !item.enabled && 'disabled', over && 'drop-before')} {...handlers}>
      <DragHandle mime={mime} id={item.id} title="Drag to reorder" />
      {rank !== undefined && (
        <span className="vqb-rank" title={rank === 1 ? 'Sorted by this field first' : `Then by this field (${rank})`}>
          {rank}
        </span>
      )}
      {children}
      <span className="grow" />
      {controls}
      <RowActions
        what="field"
        enabled={item.enabled}
        onEnabled={(enabled) => edit((l) => l.map((x) => (x.id === item.id ? { ...x, enabled } : x)))}
        onDuplicate={() => edit((l) => insertItem(l, { ...item, id: nid() }, l.findIndex((x) => x.id === item.id) + 1))}
        onRemove={() => edit((l) => l.filter((x) => x.id !== item.id))}
      />
    </div>
  )
}

function sliceOk(it: ProjectionItem): boolean {
  try {
    itemsToProjection([{ ...it, enabled: true, field: 'f' }])
    return true
  } catch {
    return false
  }
}

const MODES: { value: ProjectionItem['mode']; label: string; title: string }[] = [
  { value: 'include', label: 'Show', title: 'Return this field (1)' },
  { value: 'exclude', label: 'Hide', title: 'Leave this field out (0)' },
  { value: 'slice', label: 'Slice', title: 'Return part of an array ($slice)' }
]

function ProjectionControls({ item, patch }: { item: ProjectionItem; patch: Patch }): ReactElement {
  return (
    <Seg label="Projection" value={item.mode} options={MODES} onChange={(mode) => patch({ mode })}>
      {item.mode === 'slice' && (
        <input
          className={cls('vqb-slice', !sliceOk(item) && 'invalid')}
          spellCheck={false}
          placeholder="n"
          title="Array elements: 5 (first five), -5 (last five) or [skip, n]"
          value={item.slice}
          onChange={(e) => patch({ slice: e.target.value })}
        />
      )}
    </Seg>
  )
}

const Arrow = ({ up }: { up?: boolean }): ReactElement => (
  <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={up ? 'M5 8.5v-7M2 4.5l3-3 3 3' : 'M5 1.5v7M2 5.5l3 3 3-3'} />
  </svg>
)

const DIRS: { value: 1 | -1; label: ReactNode; title: string }[] = [
  {
    value: 1,
    label: (
      <>
        <Arrow up /> Asc
      </>
    ),
    title: 'Ascending: smallest first (1)'
  },
  {
    value: -1,
    label: (
      <>
        <Arrow /> Desc
      </>
    ),
    title: 'Descending: largest first (-1)'
  }
]

const SortControls = ({ item, patch }: { item: SortItem; patch: Patch }): ReactElement => <Seg label="Sort direction" value={item.dir} options={DIRS} onChange={(dir) => patch({ dir })} />
