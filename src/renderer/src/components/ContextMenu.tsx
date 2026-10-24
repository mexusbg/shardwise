import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { create } from 'zustand'
import { Icon } from './Icon'

export type MenuItem =
  | { separator: true }
  | {
      label: string
      onClick?: () => void
      disabled?: boolean
      danger?: boolean
      shortcut?: string
      icon?: string
      submenu?: MenuItem[]
    }

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

const useMenu = create<{ menu: MenuState | null }>(() => ({ menu: null }))

export function showMenu(e: ReactMouseEvent | MouseEvent, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items } })
}

export function showMenuAt(x: number, y: number, items: MenuItem[]): void {
  useMenu.setState({ menu: { x, y, items } })
}

const closeMenu = (): void => useMenu.setState({ menu: null })

function MenuList({ items, x, y }: MenuState): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [openSub, setOpenSub] = useState<number | null>(null)
  const [subPos, setSubPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    })
  }, [x, y])

  return (
    <>
      <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
        {items.map((it, i) =>
          'separator' in it ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <div
              key={i}
              className={`ctx-item ${it.disabled ? 'disabled' : ''} ${it.danger ? 'danger' : ''} ${openSub === i ? 'open' : ''}`}
              onMouseEnter={(e) => {
                if (it.submenu) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSubPos({ x: r.right + 2, y: r.top - 4 })
                  setOpenSub(i)
                } else setOpenSub(null)
              }}
              onClick={() => {
                if (it.disabled || it.submenu) return
                closeMenu()
                it.onClick?.()
              }}
            >
              {it.icon ? <Icon name={it.icon} size={14} /> : <span style={{ width: 14 }} />}
              <span>{it.label}</span>
              {it.shortcut && <span className="short">{it.shortcut}</span>}
              {it.submenu && (
                <span className="short">
                  <Icon name="chevronRight" size={12} />
                </span>
              )}
            </div>
          )
        )}
      </div>
      {openSub !== null && 'submenu' in items[openSub] && (
        <MenuList items={(items[openSub] as { submenu: MenuItem[] }).submenu} x={subPos.x} y={subPos.y} />
      )}
    </>
  )
}

export function ContextMenuHost(): ReactElement | null {
  const menu = useMenu((s) => s.menu)
  useEffect(() => {
    if (!menu) return
    const close = (): void => closeMenu()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])
  if (!menu) return null
  return <MenuList {...menu} />
}
