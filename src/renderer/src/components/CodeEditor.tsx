import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { completionKeymap } from '@codemirror/autocomplete'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import type { EditorArea } from '@shared/api'
import { editorPrefs } from '../lib/editorPrefs'
import { commandKeymap } from '../lib/commands'
import type { CommandId } from '../lib/commands'
import { editorSearch } from '../lib/editorSearch'

const highlight = HighlightStyle.define([
  { tag: [t.string, t.special(t.string)], color: 'var(--t-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--t-number)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--t-bool)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--text)' },
  { tag: [t.function(t.variableName), t.variableName], color: 'var(--t-oid)' },
  { tag: [t.regexp], color: 'var(--t-regex)' },
  { tag: [t.comment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.keyword, t.operator], color: 'var(--t-date)' }
])

const QUERY_OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not', '$exists', '$type',
  '$regex', '$options', '$elemMatch', '$all', '$size', '$mod', '$text', '$search', '$where', '$expr', '$slice',
  '$geoWithin', '$geoIntersects', '$near', '$nearSphere', '$jsonSchema', '$bitsAllSet', '$bitsAnySet', '$meta'
]
const SHELL_HELPERS = ['ObjectId("")', 'ISODate("")', 'NumberLong("")', 'NumberInt()', 'NumberDecimal("")', 'UUID("")', 'Timestamp(0, 0)', 'BinData(0, "")', 'RegExp("")']

function completer(getFields: () => string[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    // Field names may be non-Latin (Cyrillic etc.): \w alone would not complete them.
    const word = ctx.matchBefore(/[$\p{L}\p{N}_.]+/u)
    if (!word && !ctx.explicit) return null
    const from = word ? word.from : ctx.pos
    const text = word?.text ?? ''
    const options = [
      ...QUERY_OPERATORS.map((o) => ({ label: o, type: 'keyword' })),
      ...SHELL_HELPERS.map((h) => ({ label: h.replace(/\(.*$/, ''), apply: h, type: 'function', detail: 'BSON' })),
      ...getFields().map((f) => ({ label: f, apply: /^[A-Za-z_$][\w$]*$/.test(f) ? f : JSON.stringify(f), type: 'property', boost: 1 }))
    ]
    if (text.startsWith('$')) return { from, options: options.filter((o) => o.label.startsWith('$')) }
    return { from, options, validFor: /^[$\p{L}\p{N}_.]*$/u }
  }
}

interface Props {
  value: string
  onChange?: (v: string) => void
  /** Run by the shortcuts of `submitCommand` (default Ctrl/Cmd+Enter). */
  onSubmit?: () => void
  /** Command whose shortcuts call onSubmit; default: "dialog.submit" inside a dialog, else "editor.submit". */
  submitCommand?: CommandId
  onBlur?: () => void
  placeholder?: string
  readOnly?: boolean
  /** Field names for autocomplete. */
  fields?: string[]
  /** Full editor with line numbers and folding (document editing / JSON view). */
  full?: boolean
  minHeight?: number
  maxHeight?: number
  invalid?: boolean
  className?: string
  autoFocus?: boolean
  /** Autocomplete preference that applies (default: query editors). */
  area?: EditorArea
  /** Show only the first line, cut with an ellipsis, until the editor gets focus (query bar). */
  collapse?: boolean
}

export function CodeEditor(p: Props): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(p)
  latest.current = p
  const [focused, setFocused] = useState(false)
  const readOnlyComp = useRef(new Compartment())

  useEffect(() => {
    const exts: Extension[] = [
      // Single-line style inputs (query bar) always wrap; full editors follow the preference.
      editorPrefs({ area: p.area ?? 'query', wrap: p.full ? 'pref' : 'always', completion: { override: [completer(() => latest.current.fields ?? [])] } }),
      history(),
      javascript(),
      syntaxHighlighting(highlight),
      bracketMatching(),
      // Submit keys come from the command registry (Settings → Shortcuts) and follow rebinding live.
      commandKeymap(() => {
        const submit = (): boolean => {
          latest.current.onSubmit?.()
          return !!latest.current.onSubmit
        }
        const id: CommandId = latest.current.submitCommand ?? (host.current?.closest('.modal') ? 'dialog.submit' : 'editor.submit')
        return { [id]: submit }
      }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...foldKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) latest.current.onChange?.(u.state.doc.toString())
        if (u.focusChanged) {
          setFocused(u.view.hasFocus)
          if (!u.view.hasFocus) latest.current.onBlur?.()
        }
      }),
      // Read-only editors stay focusable (not `editable: false`): selecting, copying and Ctrl+F need keyboard focus.
      readOnlyComp.current.of(EditorState.readOnly.of(!!p.readOnly))
    ]
    if (p.placeholder) exts.push(cmPlaceholder(p.placeholder))
    if (p.full) exts.push(lineNumbers(), foldGutter(), highlightActiveLine(), editorSearch())
    const style: Record<string, string> = {}
    if (p.minHeight) style.minHeight = `${p.minHeight}px`
    if (p.maxHeight) style.maxHeight = `${p.maxHeight}px`
    exts.push(EditorView.theme({ '&': style, '.cm-scroller': { overflow: 'auto' } }))
    const v = new EditorView({ state: EditorState.create({ doc: p.value, extensions: exts }), parent: host.current! })
    view.current = v
    if (p.autoFocus) v.focus()
    return () => v.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== p.value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value } })
    }
  }, [p.value])

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyComp.current.reconfigure(EditorState.readOnly.of(!!p.readOnly))
    })
  }, [p.readOnly])

  const collapsed = p.collapse && !focused ? (p.value.trim().includes('\n') ? 'collapsed more' : 'collapsed') : ''
  return (
    <div
      ref={host}
      className={`cm-wrap ${focused ? 'focused' : ''} ${p.invalid ? 'invalid' : ''} ${p.full ? 'full' : ''} ${collapsed} ${p.className ?? ''}`}
    />
  )
}
