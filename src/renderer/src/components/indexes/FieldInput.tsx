import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  fields: string[]
  placeholder?: string
  invalid?: boolean
  autoFocus?: boolean
  /** Lets the dialog keep Escape for the suggestion list while it is open. */
  onOpenChange?: (open: boolean) => void
}

/** Text input with a suggestion list of sampled field paths. */
export function FieldInput({ value, onChange, fields, placeholder, invalid, autoFocus, onOpenChange }: Props): ReactElement {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase()
    const hits = fields.filter((f) => f !== value && f.toLowerCase().includes(q))
    hits.sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.length - b.length || a.localeCompare(b))
    return hits.slice(0, 60)
  }, [fields, value])

  const shown = open && matches.length > 0
  useEffect(() => {
    onOpenChange?.(shown)
  }, [shown, onOpenChange])
  useEffect(() => {
    setHi(0)
  }, [value])
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const pick = (f: string): void => {
    onChange(f)
    setOpen(false)
  }

  return (
    <div className="ixf-field">
      <input
        className={`input mono ${invalid ? 'invalid' : ''}`}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!shown) {
            if (e.key === 'ArrowDown') setOpen(true)
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => Math.min(matches.length - 1, h + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => Math.max(0, h - 1))
          } else if (e.key === 'Enter' || (e.key === 'Tab' && value.trim() && matches[hi] !== value)) {
            if (e.key === 'Enter') e.preventDefault()
            pick(matches[hi])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
          }
        }}
      />
      {shown && (
        <div className="ixf-suggest" ref={listRef}>
          {matches.map((f, i) => {
            const at = value.trim() ? f.toLowerCase().indexOf(value.trim().toLowerCase()) : -1
            return (
              <div
                key={f}
                className={`ixf-opt mono ${i === hi ? 'on' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(f)
                }}
                onMouseEnter={() => setHi(i)}
              >
                {at >= 0 ? (
                  <>
                    {f.slice(0, at)}
                    <b>{f.slice(at, at + value.trim().length)}</b>
                    {f.slice(at + value.trim().length)}
                  </>
                ) : (
                  f
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
