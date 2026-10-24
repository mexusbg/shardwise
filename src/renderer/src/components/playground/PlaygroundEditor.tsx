import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript, javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { completionKeymap } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import type { PlaygroundLanguage } from '@shared/api'
import { playgroundCompletions } from './completions'
import { editorPrefs } from '../../lib/editorPrefs'
import { commandKeymap } from '../../lib/commands'
import { editorSearch } from '../../lib/editorSearch'
import type { CompletionData } from './completions'

const highlight = HighlightStyle.define([
  { tag: [t.string, t.special(t.string)], color: 'var(--t-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--t-number)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--t-bool)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--text)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--t-oid)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--text)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--t-binary)' },
  { tag: [t.regexp], color: 'var(--t-regex)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--t-date)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--text-2)' }
])

const lang = (l: PlaygroundLanguage) => javascript({ typescript: l === 'typescript' })

interface Props {
  value: string
  language: PlaygroundLanguage
  onChange: (v: string) => void
  onRun: () => void
  onSave: () => void
  completionData: () => CompletionData
  /** Receives the view so the parent can read the selection. */
  onView: (v: EditorView | null) => void
}

export function PlaygroundEditor(p: Props): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(p)
  latest.current = p
  const langComp = useRef(new Compartment())
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const complete = playgroundCompletions(() => latest.current.completionData())
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          editorPrefs({ area: 'playground', wrap: 'pref', completion: { icons: true } }),
          lineNumbers(),
          foldGutter(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(highlight),
          langComp.current.of(lang(p.language)),
          javascriptLanguage.data.of({ autocomplete: complete }),
          typescriptLanguage.data.of({ autocomplete: complete }),
          // Run / save keys from the command registry (Settings → Shortcuts → Playground).
          commandKeymap(() => ({
            'playground.run': () => latest.current.onRun(),
            'playground.save': () => latest.current.onSave()
          })),
          editorSearch(),
          keymap.of([
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
            if (u.focusChanged) setFocused(u.view.hasFocus)
          }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } })
        ]
      })
    })
    view.current = v
    latest.current.onView(v)
    return () => {
      latest.current.onView(null)
      v.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== p.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value } })
  }, [p.value])

  useEffect(() => {
    view.current?.dispatch({ effects: langComp.current.reconfigure(lang(p.language)) })
  }, [p.language])

  return <div ref={host} className={`cm-wrap full pg-editor ${focused ? 'focused' : ''}`} />
}
