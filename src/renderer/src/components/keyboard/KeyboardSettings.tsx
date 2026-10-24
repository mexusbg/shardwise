import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import type { AppSettings } from '@shared/api'
import { COMMANDS } from '@shared/commands'
import {
  conflictsFor,
  diffKeymap,
  effectiveKeymap,
  eventToKey,
  findConflicts,
  keyLabel,
  MAX_BINDINGS,
  menuShortcut,
  parseKeymapFile,
  resolveKey,
  SCOPE_LABELS,
  serializeKeymap,
  unbindFrom
} from '@shared/keymap'
import type { CommandDef, Keymap } from '@shared/keymap'
import { api } from '../../lib/api'
import { platform, setRecording } from '../../lib/commands'
import { errorText, toast } from '../../state/store'
import { Icon } from '../Icon'
import './keyboard.css'

type SetS = (s: AppSettings) => void

const label = (k: string): string => keyLabel(k, platform)
const fold = (s: string): string => s.toLocaleLowerCase()

/** What is being recorded: a new binding (index null) or a replacement for binding `index`. */
interface Target {
  id: string
  index: number | null
}

interface Pending extends Target {
  key: string
  clashes: CommandDef[]
}

/** Captures one key combination. Esc cancels, Backspace clears (removes the binding being replaced). */
function Recorder({ onKey, onCancel, onClear }: { onKey: (key: string) => void; onCancel: () => void; onClear: () => void }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null)
  const [held, setHeld] = useState('')
  useEffect(() => {
    setRecording(true)
    ref.current?.focus()
    return () => setRecording(false)
  }, [])
  const mods = (e: ReactKeyboardEvent): string => {
    const parts = platform === 'mac' ? [e.ctrlKey && '⌃', e.altKey && '⌥', e.shiftKey && '⇧', e.metaKey && '⌘'] : [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win']
    const list = parts.filter(Boolean) as string[]
    return platform === 'mac' ? list.join('') : list.join('+')
  }
  return (
    <span
      ref={ref}
      className="kb-recorder"
      tabIndex={0}
      role="textbox"
      aria-label="Press the new shortcut"
      data-testid="kb-recorder"
      onKeyDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
        if (plain && e.key === 'Escape') return onCancel()
        if (plain && e.key === 'Backspace') return onClear()
        const key = eventToKey(e.nativeEvent, platform)
        if (!key) return setHeld(mods(e))
        onKey(key)
      }}
      onKeyUp={(e) => {
        e.preventDefault()
        setHeld(mods(e))
      }}
      onBlur={onCancel}
    >
      {held ? `${held}${platform === 'mac' ? '' : '+'}…` : 'Press keys…'}
    </span>
  )
}

export function KeyboardSettings({ s, setS }: { s: AppSettings; setS: SetS }): ReactElement {
  const [query, setQuery] = useState('')
  const [recording, setRecordingTarget] = useState<Target | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [note, setNote] = useState<{ id: string; text: string } | null>(null)
  const [importNote, setImportNote] = useState<string[] | null>(null)

  const keymap = useMemo(() => effectiveKeymap(COMMANDS, s.keymap), [s.keymap])
  const changed = useMemo(() => diffKeymap(COMMANDS, s.keymap), [s.keymap])
  const byId = useMemo(() => new Map(COMMANDS.map((c) => [c.id, c])), [])

  /** id → concrete keys of that command that clash with another command. */
  const clashes = useMemo(() => {
    const out = new Map<string, { key: string; others: string[] }[]>()
    for (const c of findConflicts(COMMANDS, keymap, platform)) {
      for (const id of c.ids) {
        const list = out.get(id) ?? []
        list.push({ key: c.key, others: c.ids.filter((x) => x !== id) })
        out.set(id, list)
      }
    }
    return out
  }, [keymap])

  const save = (next: Keymap): void => setS({ ...s, keymap: diffKeymap(COMMANDS, next) })

  const apply = (p: Pending, replace: boolean): void => {
    let next: Keymap = { ...keymap }
    if (replace) next = unbindFrom(next, p.clashes.map((c) => c.id), p.key, platform)
    const list = [...(next[p.id] ?? [])]
    if (p.index === null) list.push(p.key)
    else list[p.index] = p.key
    next[p.id] = list.filter((k, i) => list.findIndex((x) => resolveKey(x, platform) === resolveKey(k, platform)) === i).slice(0, MAX_BINDINGS)
    save(next)
    setPending(null)
    const menu = menuShortcut(p.key, platform)
    setNote(menu ? { id: p.id, text: `${label(p.key)} is also the window menu's “${menu}” shortcut; this command takes precedence where it applies.` } : null)
  }

  const recorded = (t: Target, key: string): void => {
    setRecordingTarget(null)
    const own = keymap[t.id] ?? []
    const r = resolveKey(key, platform)
    const dup = own.findIndex((k) => resolveKey(k, platform) === r)
    if (dup >= 0 && dup !== t.index) {
      setNote({ id: t.id, text: `${label(key)} is already a shortcut of this command.` })
      return
    }
    const p: Pending = { ...t, key, clashes: conflictsFor(COMMANDS, keymap, platform, t.id, key) }
    if (p.clashes.length) {
      setNote(null)
      setPending(p)
    } else apply(p, false)
  }

  const remove = (id: string, index: number): void => {
    save({ ...keymap, [id]: (keymap[id] ?? []).filter((_, i) => i !== index) })
    setNote(null)
  }

  const resetOne = (id: string): void => {
    const next = { ...s.keymap }
    delete next[id]
    setS({ ...s, keymap: next })
    setNote(null)
  }

  const exportKeymap = async (): Promise<void> => {
    try {
      const path = await api.saveFile({ title: 'Export keyboard shortcuts', defaultPath: 'shardwise-keymap.json', filters: [{ name: 'Keymap', extensions: ['json'] }] })
      if (!path) return
      await api.writeTextFile(path, serializeKeymap(COMMANDS, s.keymap))
      const n = Object.keys(changed).length
      toast(`Exported ${n} changed shortcut${n === 1 ? '' : 's'}`, 'success')
    } catch (e) {
      toast(`Could not export: ${errorText(e)}`, 'error')
    }
  }

  const importKeymap = async (): Promise<void> => {
    try {
      const paths = await api.openFile({ title: 'Import keyboard shortcuts', filters: [{ name: 'Keymap', extensions: ['json'] }] })
      if (!paths?.[0]) return
      const { overrides, warnings } = parseKeymapFile(await api.readTextFile(paths[0]), COMMANDS)
      setS({ ...s, keymap: overrides })
      const n = Object.keys(overrides).length
      setImportNote([`Imported ${n} changed shortcut${n === 1 ? '' : 's'}; everything else is back to the defaults. Press Save to keep them.`, ...warnings])
    } catch (e) {
      setImportNote([`Could not import: ${errorText(e)}`])
    }
  }

  const words = fold(query).split(/\s+/).filter(Boolean)
  const visible = COMMANDS.filter((c) => {
    if (!words.length) return true
    const keys = (keymap[c.id] ?? []).map((k) => fold(label(k))).join(' ')
    const hay = fold([c.label, c.category, SCOPE_LABELS[c.scope], c.keywords ?? '', c.id, keys].join(' '))
    return words.every((w) => hay.includes(w))
  })
  const categories = [...new Set(visible.map((c) => c.category))]
  const modNote =
    platform === 'mac'
      ? 'Shortcuts with ⌘ use Ctrl on Windows and Linux when you share a keymap file.'
      : 'Shortcuts with Ctrl use ⌘ on macOS when you share a keymap file.'

  return (
    <div className="kb" data-pref="keymap">
      <div className="kb-top">
        <input className="input kb-search" type="search" placeholder="Search commands or keys" aria-label="Search shortcuts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <button className="btn small" onClick={() => void importKeymap()} title="Load shortcuts from a keymap file">
          <Icon name="import" size={13} /> Import…
        </button>
        <button className="btn small" onClick={() => void exportKeymap()} title="Save the changed shortcuts to a keymap file">
          <Icon name="export" size={13} /> Export…
        </button>
        <button
          className="btn small"
          disabled={!Object.keys(changed).length}
          onClick={() => {
            setS({ ...s, keymap: {} })
            setPending(null)
            setNote(null)
          }}
          title="Restore every default shortcut"
        >
          <Icon name="refresh" size={13} /> Reset all
        </button>
      </div>
      <div className="pref-hint kb-hint">
        Click <b>+</b> and press the keys (Esc cancels, Backspace clears). Click a shortcut to change it. {modNote} Changes apply when you press Save.
      </div>
      {importNote && (
        <div className="notice kb-import">
          {importNote.map((t, i) => (
            <div key={i} className={i ? 'faint' : undefined}>
              {t}
            </div>
          ))}
        </div>
      )}
      {!visible.length && <div className="result-empty" style={{ padding: 24 }}>No commands match "{query}".</div>}
      {categories.map((cat) => (
        <div key={cat} className="kb-group">
          <div className="section-title">{cat}</div>
          {visible
            .filter((c) => c.category === cat)
            .map((c) => {
              const keys = keymap[c.id] ?? []
              const modified = Object.hasOwn(changed, c.id)
              const clash = clashes.get(c.id)
              const clashKeys = new Set(clash?.map((x) => x.key))
              const rec = recording?.id === c.id ? recording : null
              const pend = pending?.id === c.id ? pending : null
              return (
                <div key={c.id} className={`kb-row ${modified ? 'modified' : ''}`} data-command={c.id}>
                  <div className="kb-label">
                    <span className="kb-name">{c.label}</span>
                    <span className="kb-scope">{SCOPE_LABELS[c.scope]}</span>
                    {clash && (
                      <span
                        className="kb-warn"
                        title={clash.map((x) => `${label(x.key)} is also used by ${x.others.map((o) => `“${byId.get(o)?.label}”`).join(', ')}`).join('\n')}
                      >
                        <Icon name="warn" size={13} />
                      </span>
                    )}
                  </div>
                  <div className="kb-keys">
                    {keys.map((k, i) =>
                      rec && rec.index === i ? (
                        <Recorder key={`rec-${i}`} onKey={(key) => recorded(rec, key)} onCancel={() => setRecordingTarget(null)} onClear={() => (setRecordingTarget(null), remove(c.id, i))} />
                      ) : (
                        <span key={k} className={`kb-chip ${clashKeys.has(resolveKey(k, platform) ?? '') ? 'conflict' : ''}`}>
                          <button className="kb-chip-key" title="Change this shortcut" onClick={() => (setPending(null), setRecordingTarget({ id: c.id, index: i }))}>
                            {label(k)}
                          </button>
                          <button className="kb-chip-x" title="Remove this shortcut" aria-label={`Remove ${label(k)}`} onClick={() => remove(c.id, i)}>
                            <Icon name="close" size={10} />
                          </button>
                        </span>
                      )
                    )}
                    {rec && rec.index === null && (
                      <Recorder onKey={(key) => recorded(rec, key)} onCancel={() => setRecordingTarget(null)} onClear={() => setRecordingTarget(null)} />
                    )}
                    {!rec && keys.length < MAX_BINDINGS && (
                      <button className="btn ghost icon small kb-add" title="Add a shortcut" aria-label={`Add a shortcut to ${c.label}`} onClick={() => (setPending(null), setRecordingTarget({ id: c.id, index: null }))}>
                        <Icon name="plus" size={12} />
                      </button>
                    )}
                    {!keys.length && !rec && <span className="faint kb-none">none</span>}
                  </div>
                  <div className="kb-actions">
                    {modified && (
                      <button
                        className="btn ghost icon small"
                        title={`Reset to the default (${(byId.get(c.id)?.keys ?? []).map(label).join(', ') || 'none'})`}
                        aria-label={`Reset ${c.label}`}
                        onClick={() => resetOne(c.id)}
                      >
                        <Icon name="refresh" size={12} />
                      </button>
                    )}
                  </div>
                  {pend && (
                    <div className="kb-pending notice">
                      <Icon name="warn" size={13} />
                      <span className="grow">
                        <b>{label(pend.key)}</b> is already used by {pend.clashes.map((o, i) => (
                          <span key={o.id}>
                            {i ? ', ' : ''}“{o.label}” ({SCOPE_LABELS[o.scope]})
                          </span>
                        ))}
                        .
                      </span>
                      <button className="btn small primary" onClick={() => apply(pend, true)}>
                        Replace
                      </button>
                      <button className="btn small" onClick={() => apply(pend, false)} title="Keep the key on both commands; where both apply, the more specific scope or the command listed first wins">
                        Keep both
                      </button>
                      <button className="btn small ghost" onClick={() => setPending(null)}>
                        Cancel
                      </button>
                    </div>
                  )}
                  {note?.id === c.id && <div className="kb-note faint">{note.text}</div>}
                </div>
              )
            })}
        </div>
      ))}
    </div>
  )
}
