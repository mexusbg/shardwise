import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { EditorState } from '@codemirror/state'
import { drawSelection, EditorView, highlightSpecialChars, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { completionKeymap, completionStatus } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { classHighlighter } from '@lezer/highlight'
import { isIncomplete } from '@shared/shell'
import { playgroundCompletions } from '../playground/completions'
import type { CompletionData } from '../playground/completions'
import { editorPrefs } from '../../lib/editorPrefs'
import { commandKeymap } from '../../lib/commands'

const SHOW_WHAT: Completion[] = [
  { label: 'dbs', detail: 'databases and sizes' },
  { label: 'collections', detail: 'of the current database' },
  { label: 'users', detail: 'of the current database' },
  { label: 'roles', detail: 'of the current database' },
  { label: 'profile', detail: 'last 5 profiled operations' }
].map((c) => ({ ...c, type: 'keyword' }))

const COMMANDS: Completion[] = [
  { label: 'show', detail: 'dbs | collections | users | roles | profile', apply: 'show ' },
  { label: 'it', detail: 'next batch of the last cursor' },
  { label: 'help', detail: 'shell commands' },
  { label: 'cls', detail: 'clear the screen' },
  { label: 'exit', detail: 'close this shell' }
].map((c) => ({ ...c, type: 'keyword' }))

/** Statement commands at the start of the input, then the playground completions. */
function shellCompletions(get: () => CompletionData) {
  const base = playgroundCompletions(get)
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(0, ctx.pos)
    let m = /^\s*show\s+(\w*)$/.exec(before)
    if (m) return { from: ctx.pos - m[1].length, options: SHOW_WHAT, validFor: /^\w*$/ }
    m = /^\s*use\s+([^\s]*)$/.exec(before)
    if (m) return { from: ctx.pos - m[1].length, options: get().databases.map((d) => ({ label: d, type: 'property', detail: 'database' })), validFor: /^\S*$/ }
    const r = base(ctx)
    m = /^\s*(\w*)$/.exec(before)
    if (m && r && (m[1].length > 0 || ctx.explicit)) return { ...r, options: [...COMMANDS, ...r.options] }
    return r
  }
}

interface Props {
  prompt: string
  running: boolean
  disabled: boolean
  /** Returns false when the code was not accepted (the input is then kept). */
  onRun: (code: string) => boolean
  /** Older (-1) / newer (+1) history entry, or null when there is none. */
  onHistory: (dir: -1 | 1, current: string) => string | null
  onClear: () => void
  onInterrupt: () => void
  completionData: () => CompletionData
  onView: (v: EditorView | null) => void
}

const setDoc = (v: EditorView, text: string): void => {
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.length } })
}

export function ShellInput(p: Props): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(p)
  latest.current = p
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const complete = shellCompletions(() => latest.current.completionData())
    const run = (v: EditorView, force: boolean): boolean => {
      const code = v.state.doc.toString()
      if (!force && isIncomplete(code)) return insertNewlineAndIndent(v)
      if (!code.trim()) return true
      if (latest.current.onRun(code)) setDoc(v, '')
      return true
    }
    const historyMove = (dir: -1 | 1) => (v: EditorView): boolean => {
      if (completionStatus(v.state)) return false
      const sel = v.state.selection.main
      if (!sel.empty) return false
      const line = v.state.doc.lineAt(sel.head).number
      if (dir < 0 ? line !== 1 : line !== v.state.doc.lines) return false
      const next = latest.current.onHistory(dir, v.state.doc.toString())
      if (next === null) return false
      setDoc(v, next)
      return true
    }
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        extensions: [
          editorPrefs({ area: 'shell', wrap: 'never', completion: { icons: true, aboveCursor: true } }),
          highlightSpecialChars(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(classHighlighter),
          javascript(),
          javascriptLanguage.data.of({ autocomplete: complete }),
          placeholder('Type a command, e.g. db.getCollectionNames() — help for help'),
          // Keys from the command registry (Settings → Shortcuts → Shell), looked up on every key press.
          commandKeymap(() => ({
            'shell.run': (view) => run(view, false),
            'shell.runForce': (view) => run(view, true),
            'shell.newline': (view) => insertNewlineAndIndent(view),
            'shell.historyPrevious': historyMove(-1),
            'shell.historyNext': historyMove(1),
            'shell.clear': () => (latest.current.onClear(), true),
            'shell.interrupt': (view) => {
              if (latest.current.running) {
                latest.current.onInterrupt()
                return true
              }
              if (!view.state.selection.main.empty) return false
              if (view.state.doc.length) setDoc(view, '')
              return true
            },
            'shell.cancel': () => {
              if (!latest.current.running) return false
              latest.current.onInterrupt()
              return true
            }
          })),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.focusChanged) setFocused(u.view.hasFocus)
          })
        ]
      })
    })
    latest.current.onView(v)
    return () => {
      latest.current.onView(null)
      v.destroy()
    }
  }, [])

  return (
    <div className={`sh-inputbar ${focused ? 'focused' : ''} ${p.disabled ? 'disabled' : ''}`}>
      <span className="sh-prompt">{p.prompt}&gt;</span>
      <div ref={host} className="sh-editor" />
    </div>
  )
}
