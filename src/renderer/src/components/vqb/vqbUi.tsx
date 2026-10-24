import { Fragment, useRef } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { EDITABLE_TYPES, TYPE_LABELS } from '@shared/bsonValue'
import type { EditableType } from '@shared/bsonValue'
import { Icon } from '../Icon'
import { cls } from './vqbDnd'

export const TYPE_COLOR: Record<EditableType, string> = {
  string: 'var(--t-string)',
  int: 'var(--t-number)',
  long: 'var(--t-number)',
  double: 'var(--t-number)',
  decimal: 'var(--t-number)',
  bool: 'var(--t-bool)',
  date: 'var(--t-date)',
  objectId: 'var(--t-oid)',
  null: 'var(--t-null)',
  regex: 'var(--t-regex)',
  array: 'var(--t-object)',
  object: 'var(--t-object)'
}

const TYPE_SHORT: Record<EditableType, string> = {
  string: 'str',
  int: 'int',
  long: 'long',
  double: 'dbl',
  decimal: 'dec',
  bool: 'bool',
  date: 'date',
  objectId: 'oid',
  null: 'null',
  regex: 'regex',
  array: 'arr',
  object: 'obj'
}

/** Coloured type pill; an invisible native select on top opens the type menu. */
export function TypeBadge({ value, onChange }: { value: EditableType; onChange: (t: EditableType) => void }): ReactElement {
  return (
    <span className="vqb-type-badge" style={{ '--tc': TYPE_COLOR[value] } as CSSProperties} title={`Value type: ${TYPE_LABELS[value]}`}>
      {TYPE_SHORT[value]}
      <select value={value} aria-label="Value type" onChange={(e) => onChange(e.target.value as EditableType)}>
        {EDITABLE_TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABELS[t]}
          </option>
        ))}
      </select>
    </span>
  )
}

/** Field name chip with autocomplete from the result documents. */
export function FieldChip({ value, listId, onChange, placeholder = 'field', disabled, title }: { value: string; listId: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; title?: string }): ReactElement {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <span className={cls('vqb-field', disabled && 'static')}>
      <input
        ref={ref}
        className="vqb-field-input"
        list={listId}
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        title={title ?? (value || 'Field name (dot notation for nested fields)')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {!disabled && (
        <button
          className="vqb-caret"
          tabIndex={-1}
          aria-label="Pick a field"
          onClick={() => {
            ref.current?.focus()
            try {
              ref.current?.showPicker()
            } catch {
              // No picker available.
            }
          }}
        >
          <Icon name="chevronDown" size={11} />
        </button>
      )}
    </span>
  )
}

export interface Choice<T extends string> {
  value: T
  label: string
  title?: string
}

/** Native select dressed as an inline word chip. Options may be grouped. */
export function ChipSelect<T extends string>({ value, groups, onChange, title, className }: { value: T; groups: { label?: string; options: Choice<T>[] }[]; onChange: (v: T) => void; title?: string; className?: string }): ReactElement {
  const opts = (o: Choice<T>[]): ReactNode =>
    o.map((c) => (
      <option key={c.value} value={c.value} title={c.title}>
        {c.label}
      </option>
    ))
  return (
    <span className={cls('vqb-pick', className)}>
      <select value={value} title={title} onChange={(e) => onChange(e.target.value as T)}>
        {groups.map((g, i) =>
          g.label ? (
            <optgroup key={g.label} label={g.label}>
              {opts(g.options)}
            </optgroup>
          ) : (
            <Fragment key={i}>{opts(g.options)}</Fragment>
          )
        )}
      </select>
      <Icon name="chevronDown" size={11} />
    </span>
  )
}

/** Compact uppercase pill showing `label`; an invisible native select on top opens the menu. */
export function PillSelect<T extends string>({ value, label, options, onChange, title }: { value: T; label: string; options: Choice<T>[]; onChange: (v: T) => void; title?: string }): ReactElement {
  return (
    <span className="vqb-gpill" title={title}>
      {label}
      <Icon name="chevronDown" size={10} />
      <select value={value} aria-label={title} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.title ? `${o.label} — ${o.title}` : o.label}
          </option>
        ))}
      </select>
    </span>
  )
}

export function Seg<T extends string | number>({ value, options, onChange, label, children }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string; children?: ReactNode }): ReactElement {
  return (
    <span className="vqb-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={cls(o.value === value && 'on')} title={o.title} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
      {children}
    </span>
  )
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }): ReactElement {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      className={cls('vqb-switch', on && 'on')}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!on)
      }}
    >
      <span />
    </button>
  )
}

export function Toggle({ on, onChange, children, title }: { on: boolean; onChange: (on: boolean) => void; children: ReactNode; title?: string }): ReactElement {
  return (
    <button className={cls('vqb-flag', on && 'on')} aria-pressed={on} title={title} onClick={() => onChange(!on)}>
      {children}
    </button>
  )
}

const Eye = ({ off }: { off?: boolean }): ReactElement => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.8" />
    {off && <path d="M4 4l16 16" />}
  </svg>
)

/** Hover-revealed row controls: enable/disable, duplicate, remove. */
export function RowActions({ enabled, onEnabled, onDuplicate, onRemove, what }: { enabled: boolean; onEnabled: (on: boolean) => void; onDuplicate: () => void; onRemove: () => void; what: string }): ReactElement {
  return (
    <span className="vqb-actions">
      <button className={cls(!enabled && 'on')} title={enabled ? `Turn this ${what} off` : `Turn this ${what} on`} aria-pressed={!enabled} onClick={() => onEnabled(!enabled)}>
        <Eye off={!enabled} />
      </button>
      <button title={`Duplicate ${what}`} onClick={onDuplicate}>
        <Icon name="duplicate" size={13} />
      </button>
      <button className="danger" title={`Delete ${what}`} onClick={onRemove}>
        <Icon name="trash" size={13} />
      </button>
    </span>
  )
}

export function AddButton({ label, title, onClick }: { label: string; title?: string; onClick: () => void }): ReactElement {
  return (
    <button className="vqb-add" title={title} onClick={onClick}>
      <Icon name="plus" size={12} />
      {label}
    </button>
  )
}
