import { useState } from 'react'
import type { ReactElement } from 'react'
import { Icon } from '../Icon'

/**
 * Whether a result view starts with nested objects and arrays folded, remembered per view in localStorage (a UI
 * convenience: the default is folded when storage is unavailable).
 */
export function useNestedCollapsed(storageKey: string): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== 'expanded'
    } catch {
      return true
    }
  })
  const choose = (c: boolean): void => {
    setCollapsed(c)
    try {
      localStorage.setItem(storageKey, c ? 'collapsed' : 'expanded')
    } catch {
      // Then it only lasts for this view.
    }
  }
  return [collapsed, choose]
}

/** Toolbar above the List and JSON views: fold or open every nested value. */
export function NestedBar({ collapsed, onChange }: { collapsed: boolean; onChange: (collapsed: boolean) => void }): ReactElement {
  return (
    <div className="row" style={{ padding: '3px 8px', borderBottom: '1px solid var(--border)', background: 'var(--bg-2)' }}>
      <span className="faint" style={{ fontSize: 12 }}>
        Nested values
      </span>
      <div className="segmented small">
        <button className={collapsed ? 'on' : ''} onClick={() => onChange(true)} title="Fold the objects and arrays inside each document">
          <Icon name="chevronRight" size={12} /> Collapsed
        </button>
        <button className={collapsed ? '' : 'on'} onClick={() => onChange(false)} title="Show nested objects and arrays in full">
          <Icon name="chevronDown" size={12} /> Expanded
        </button>
      </div>
    </div>
  )
}
