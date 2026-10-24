import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { FieldReport, TypeStats } from '@shared/schema'
import { Icon } from '../Icon'
import { fmtPct, typeColor, typeSummary } from './schemaUi'

interface Row {
  f: FieldReport
  hasKids: boolean
  open: boolean
}

/** Rows to show for the current expansion state and filter. */
function visibleRows(fields: readonly FieldReport[], expanded: ReadonlySet<string>, filter: string, mixedOnly: boolean): Row[] {
  const q = filter.trim().toLowerCase()
  const filtering = !!q || mixedOnly
  const matches = (f: FieldReport): boolean => (!q || f.path.toLowerCase().includes(q)) && (!mixedOnly || f.mixed)
  const out: Row[] = []
  const walk = (list: readonly FieldReport[]): boolean => {
    let any = false
    for (const f of list) {
      const start = out.length
      const row: Row = { f, hasKids: f.children.length > 0, open: false }
      out.push(row)
      if (filtering) {
        const kidHit = walk(f.children)
        const hit = matches(f)
        if (!hit && !kidHit) out.length = start
        else {
          row.open = kidHit
          any = true
        }
      } else {
        any = true
        row.open = expanded.has(f.path)
        if (row.open) walk(f.children)
      }
    }
    return any
  }
  walk(fields)
  return out
}

export function TypeBar({ types, className = 'sx-tbar' }: { types: readonly TypeStats[]; className?: string }): ReactElement {
  return (
    <span className={className} aria-hidden>
      {types.map((t) => (
        <span key={t.type} style={{ flexGrow: t.pct, background: typeColor(t.type) }} title={`${t.label} ${fmtPct(t.pct)}`} />
      ))}
    </span>
  )
}

interface Props {
  fields: readonly FieldReport[]
  selected: string | null
  onSelect: (path: string) => void
  expanded: ReadonlySet<string>
  onToggle: (path: string, open?: boolean) => void
  filter: string
  mixedOnly: boolean
}

export function FieldTree({ fields, selected, onSelect, expanded, onToggle, filter, mixedOnly }: Props): ReactElement {
  const rows = useMemo(() => visibleRows(fields, expanded, filter, mixedOnly), [fields, expanded, filter, mixedOnly])
  const selRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const onKey = (e: KeyboardEvent): void => {
    const i = rows.findIndex((r) => r.f.path === selected)
    const r = rows[i]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) onSelect(next.f.path)
    } else if (e.key === 'ArrowRight' && r?.hasKids) {
      if (!r.open) onToggle(r.f.path, true)
      else if (rows[i + 1]) onSelect(rows[i + 1].f.path)
    } else if (e.key === 'ArrowLeft' && r) {
      if (r.open && r.hasKids) onToggle(r.f.path, false)
      else {
        const parent = rows.slice(0, i).reverse().find((x) => x.f.depth < r.f.depth)
        if (parent) onSelect(parent.f.path)
      }
    } else return
    e.preventDefault()
  }

  if (!rows.length) return <div className="sx-tree-empty">{filter || mixedOnly ? 'No matching fields' : 'No fields'}</div>

  return (
    <div className="sx-tree" tabIndex={0} role="tree" onKeyDown={onKey}>
      {rows.map(({ f, hasKids, open }) => {
        const sum = typeSummary(f)
        const sel = f.path === selected
        return (
          <div
            key={f.path}
            ref={sel ? selRef : undefined}
            role="treeitem"
            aria-selected={sel}
            aria-expanded={hasKids ? open : undefined}
            className={`sx-row${sel ? ' selected' : ''}`}
            onClick={() => onSelect(f.path)}
            onDoubleClick={() => hasKids && onToggle(f.path)}
          >
            <span className="sx-name" style={{ paddingLeft: f.depth * 14 }}>
              <span
                className="twisty"
                onClick={(e) => {
                  e.stopPropagation()
                  if (hasKids) onToggle(f.path)
                }}
              >
                {hasKids && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
              </span>
              {f.isElement ? (
                <span className="ellipsis">
                  <span className="sx-el">[ ]</span> <span className="faint">elements</span>
                </span>
              ) : (
                <span className="ellipsis" title={f.path}>
                  {f.name}
                </span>
              )}
              {f.mixed && (
                <span className="sx-warn-ico" title="Mixed types">
                  <Icon name="warn" size={12} />
                </span>
              )}
            </span>
            <span className={`sx-type ellipsis${sum.type ? ` t-${sum.type}` : ' sx-mixed'}`}>{sum.label}</span>
            <span className="sx-pct">{fmtPct(f.presence)}</span>
            <TypeBar types={f.types} />
          </div>
        )
      })}
    </div>
  )
}
