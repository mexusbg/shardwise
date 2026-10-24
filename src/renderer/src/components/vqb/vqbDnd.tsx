import { useState } from 'react'
import type { DragEvent, ReactElement } from 'react'
import { Icon } from '../Icon'
import { DND_FIELD, readFieldDrop } from '../views/common'

/** Internal drag types (moving builder nodes / list rows), distinct from result-view field drags. */
export const MIME_NODE = 'application/x-shardwise-vqb-node'
export const MIME_PROJECTION = 'application/x-shardwise-vqb-projection'
export const MIME_SORT = 'application/x-shardwise-vqb-sort'

// dataTransfer data can't be read during dragover, so the dragged id is kept here.
let dragging: { mime: string; id: string } | null = null

export const cls = (...c: (string | false | undefined)[]): string => c.filter(Boolean).join(' ')

/** Card-like copy of a row used as the drag image (live form values copied over), removed after the snapshot. */
function ghost(row: HTMLElement): HTMLElement {
  const g = row.cloneNode(true) as HTMLElement
  const src = row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')
  g.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((el, i) => (el.value = src[i]?.value ?? el.value))
  g.classList.add('vqb-ghost')
  g.style.width = `${Math.min(row.offsetWidth, 360)}px`
  const host = row.closest('.vqb') ?? document.body
  host.appendChild(g)
  setTimeout(() => g.remove())
  return g
}

export function DragHandle({ mime, id, title }: { mime: string; id: string; title: string }): ReactElement {
  return (
    <span
      className="vqb-grip"
      draggable
      title={title}
      onDragStart={(e) => {
        e.stopPropagation()
        dragging = { mime, id }
        e.dataTransfer.setData(mime, id)
        e.dataTransfer.effectAllowed = 'move'
        const row = e.currentTarget.closest<HTMLElement>('.vqb-rule, .vqb-grp, .vqb-entry')
        if (row) {
          e.dataTransfer.setDragImage(ghost(row), 14, 14)
          row.classList.add('vqb-src')
        }
      }}
      onDragEnd={(e) => {
        dragging = null
        e.currentTarget.closest('.vqb-src')?.classList.remove('vqb-src')
      }}
    >
      <Icon name="grip" size={13} />
    </span>
  )
}

export type FieldDrop = NonNullable<ReturnType<typeof readFieldDrop>>

interface DropOpts {
  mime: string
  onMove: (id: string) => void
  onField: (f: FieldDrop) => void
  canMove?: (id: string) => boolean
}

interface DropHandlers {
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}

/** Drop target accepting internal moves of `mime` and field drags from the result views. */
export function useDrop({ mime, onMove, onField, canMove }: DropOpts): [boolean, DropHandlers] {
  const [over, setOver] = useState(false)
  // true = internal move, false = field drag, null = not accepted
  const kind = (e: DragEvent): boolean | null => {
    const types = e.dataTransfer.types
    if (types.includes(mime)) return dragging?.mime === mime && (canMove?.(dragging.id) ?? true) ? true : null
    return types.includes(DND_FIELD) ? false : null
  }
  return [
    over,
    {
      onDragOver: (e) => {
        const k = kind(e)
        if (k === null) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = k ? 'move' : 'copy'
        if (!over) setOver(true)
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Element | null)) setOver(false)
      },
      onDrop: (e) => {
        const k = kind(e)
        setOver(false)
        if (k === null) return
        e.preventDefault()
        e.stopPropagation()
        if (k && dragging) onMove(dragging.id)
        else if (!k) {
          const f = readFieldDrop(e)
          if (f) onField(f)
        }
        dragging = null
      }
    }
  ]
}
