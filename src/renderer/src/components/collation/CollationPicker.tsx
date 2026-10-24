import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  COLLATION_LOCALES,
  COLLATION_STRENGTHS,
  collationLabel,
  effectiveCollation,
  formatCollation,
  isCaseInsensitive,
  parseCollationText,
  tryCollationText
} from '@shared/collation'
import type { Collation } from '@shared/collation'
import { connConfig, patchTab, useStore } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { runQuery } from '../../state/queryActions'
import { shortcutLabel } from '../../lib/commands'
import { Icon } from '../Icon'
import './collation.css'

const OTHER = '__other'
const KNOWN = new Set(COLLATION_LOCALES.map((l) => l.value))

/** Locale, strength and the common ICU options. `null` = no collation. */
export function CollationForm({ value, onChange }: { value: Collation | null; onChange: (c: Collation | null) => void }): ReactElement {
  const locale = value?.locale ?? ''
  const [custom, setCustom] = useState(() => !!locale && !KNOWN.has(locale))
  // A listed locale typed in the text field selects it in the list again.
  useEffect(() => {
    if (locale && KNOWN.has(locale)) setCustom(false)
  }, [locale])
  const isOther = custom || (!!locale && !KNOWN.has(locale))
  const off = !value || value.locale === 'simple'
  const set = (p: Partial<Collation>): void => {
    if (!value) return
    const next: Collation = { ...value, ...p }
    for (const k of Object.keys(next) as (keyof Collation)[]) if (next[k] === undefined) delete next[k]
    onChange(next)
  }
  const chooseLocale = (v: string): void => {
    if (v === OTHER) {
      setCustom(true)
      return
    }
    setCustom(false)
    if (!v) onChange(null)
    // 'simple' takes no other options; a language keeps the options already chosen.
    else if (v === 'simple') onChange({ locale: 'simple' })
    else onChange({ ...(value && value.locale !== 'simple' ? value : {}), locale: v })
  }
  return (
    <div className="coll-form">
      <label>Locale</label>
      <div className="row" style={{ gap: 6, minWidth: 0 }}>
        <select className="select small grow" value={isOther ? OTHER : locale} onChange={(e) => chooseLocale(e.target.value)} data-testid="collation-locale">
          {COLLATION_LOCALES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
        {isOther && (
          <input
            className="input small mono"
            style={{ width: 110 }}
            value={KNOWN.has(locale) ? '' : locale}
            placeholder="e.g. de@collation=phonebook"
            autoFocus
            onChange={(e) => {
              const v = e.target.value.trim()
              if (v) onChange({ ...(value && value.locale !== 'simple' ? value : {}), locale: v })
            }}
          />
        )}
      </div>
      <label>Strength</label>
      <select className="select small" disabled={off} value={value?.strength ?? ''} onChange={(e) => set({ strength: e.target.value ? Number(e.target.value) : undefined })} data-testid="collation-strength">
        <option value="">Default (3 — case-sensitive)</option>
        {COLLATION_STRENGTHS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <label>Case first</label>
      <select className="select small" disabled={off} value={value?.caseFirst ?? ''} onChange={(e) => set({ caseFirst: (e.target.value || undefined) as Collation['caseFirst'] })}>
        <option value="">Default (locale)</option>
        <option value="upper">Uppercase first (А before а)</option>
        <option value="lower">Lowercase first (а before А)</option>
      </select>
      <div className="coll-checks">
        <label className="check" title="numericOrdering: compare digit sequences as numbers">
          <input type="checkbox" disabled={off} checked={!!value?.numericOrdering} onChange={(e) => set({ numericOrdering: e.target.checked || undefined })} /> Numeric (2 &lt; 10)
        </label>
        <label className="check" title="caseLevel: with strength 1, distinguish case but not accents">
          <input type="checkbox" disabled={off} checked={!!value?.caseLevel} onChange={(e) => set({ caseLevel: e.target.checked || undefined })} /> Case level
        </label>
        <label className="check" title="alternate: 'shifted' — spaces and punctuation are ignored (strength 1–3)">
          <input type="checkbox" disabled={off} checked={value?.alternate === 'shifted'} onChange={(e) => set({ alternate: e.target.checked ? 'shifted' : undefined })} /> Ignore spaces &amp; punctuation
        </label>
        <label className="check" title="backwards: accents compared from the end of the string (French dictionary order)">
          <input type="checkbox" disabled={off} checked={!!value?.backwards} onChange={(e) => set({ backwards: e.target.checked || undefined })} /> Backwards accents
        </label>
      </div>
    </div>
  )
}

/** Default collation of new tabs on the tab's connection. */
function tabDefault(tab: QueryTab): Collation | null {
  return effectiveCollation(connConfig(tab.connId)?.overrides?.defaultCollation, useStore.getState().settings.defaultCollation)
}

const POP_WIDTH = 380

function usePosition(anchor: RefObject<HTMLElement | null>): { top: number; left: number } {
  const [pos, setPos] = useState({ top: 0, left: 0 })
  useLayoutEffect(() => {
    const place = (): void => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - POP_WIDTH, window.innerWidth - POP_WIDTH - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])
  return pos
}

function CollationPopover({ tab, anchor, close }: { tab: QueryTab; anchor: RefObject<HTMLElement | null>; close: () => void }): ReactElement {
  const panel = useRef<HTMLDivElement>(null)
  const pos = usePosition(anchor)
  const [raw, setRaw] = useState(tab.collationText)
  const rawError = (() => {
    try {
      parseCollationText(raw)
      return null
    } catch (e) {
      return (e as Error).message
    }
  })()
  const value = tryCollationText(tab.collationText)
  const def = tabDefault(tab)
  const defText = formatCollation(def)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.modal')) {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, close])

  const setText = (text: string): void => {
    setRaw(text)
    patchTab(tab.id, (t) => ({ collationText: text, error: t.error?.part === 'collation' ? undefined : t.error }))
  }
  const fromForm = (c: Collation | null): void => setText(formatCollation(c))
  const run = (): void => {
    close()
    void runQuery(tab.id)
  }

  return (
    <div ref={panel} className="coll-pop" style={{ top: pos.top, left: pos.left, width: POP_WIDTH }} role="dialog" aria-label="Collation" data-testid="collation-popover">
      <div className="coll-pop-head">
        <Icon name="collation" size={14} />
        <b>Collation</b>
        <span className="spacer" />
        <button className="btn ghost icon small" title="Close" onClick={close}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="coll-pop-body">
        <CollationForm value={value} onChange={fromForm} />
        <div className="coll-raw">
          <input
            className={`input small mono grow ${rawError ? 'invalid' : ''}`}
            value={raw}
            spellCheck={false}
            placeholder="{ locale: 'bg', strength: 2 }"
            title="Collation document (shell syntax)"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !rawError) run()
            }}
          />
        </div>
        {rawError && <div className="coll-err">{rawError}</div>}
        <div className="coll-hint">
          {isCaseInsensitive(value) ? (
            <>
              <b>Case-insensitive:</b> sorting ignores case and equality matches (including Filter Builder conditions) find <span className="mono">Ана</span> for{' '}
              <span className="mono">ана</span>.
            </>
          ) : (
            <>
              <b>Strength 2 = case-insensitive</b> (equality, including Filter Builder conditions, then ignores case; 1 also ignores accents). Without a collation, strings compare by
              code point: all capitals before lowercase, Ѝ and Ё after Я.
            </>
          )}{' '}
          Used for sort, filter, count, explain, export and Update / Delete matching; an index is used only when its collation is the same.
        </div>
      </div>
      <div className="coll-pop-foot">
        <button className="btn small" disabled={!tab.collationText.trim()} onClick={() => setText('')}>
          Clear
        </button>
        <button className="btn small" disabled={tab.collationText.trim() === defText} title={defText ? `Settings / connection default: ${defText}` : 'Settings / connection default: none'} onClick={() => setText(defText)}>
          Use default{def ? ` (${collationLabel(def)})` : ''}
        </button>
        <span className="spacer" />
        <button className="btn small primary" disabled={!!rawError} onClick={run} title={shortcutLabel('query.run') ? `Run the query (${shortcutLabel('query.run')} in the query bar)` : 'Run the query'}>
          <Icon name="play" size={11} /> Run
        </button>
      </div>
    </div>
  )
}

/** Query bar control: the tab's collation as a chip (`bg · 2`), opening the picker. */
export function CollationButton({ tab }: { tab: QueryTab }): ReactElement {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const text = tab.collationText.trim()
  const value = tryCollationText(text)
  const invalid = (!!text && !value) || tab.error?.part === 'collation'
  return (
    <>
      <button
        ref={btn}
        // No collation: a plain icon button like its neighbours; set (or invalid): a chip with the short label.
        className={value || invalid ? `coll-chip ${value ? 'on' : ''} ${invalid ? 'invalid' : ''} ${open ? 'open' : ''}` : `btn icon ${open ? 'active' : ''}`}
        title={
          value
            ? `Collation ${formatCollation(value)}`
            : invalid
              ? `Invalid collation: ${text}`
              : 'Collation: none — binary order (all capitals before lowercase). Click to sort and match by language, e.g. Bulgarian, or ignore case.'
        }
        onClick={() => setOpen((o) => !o)}
        data-testid="collation-chip"
      >
        <Icon name="collation" size={value || invalid ? 12 : 15} />
        {value ? collationLabel(value) : invalid ? 'invalid' : null}
      </button>
      {open && createPortal(<CollationPopover tab={tab} anchor={btn} close={() => setOpen(false)} />, document.body)}
    </>
  )
}
