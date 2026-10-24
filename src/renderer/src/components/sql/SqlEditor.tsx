import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, placeholder } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, StreamLanguage, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { completionKeymap } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import { SQL_FUNCTIONS, SQL_RESERVED } from '@shared/sqlToMongo'
import { sqlIdent } from '@shared/mongoToSql'
import { editorPrefs } from '../../lib/editorPrefs'
import { commandKeymap } from '../../lib/commands'
import { editorSearch } from '../../lib/editorSearch'

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--t-date)', fontWeight: '600' },
  { tag: t.string, color: 'var(--t-string)' },
  { tag: t.number, color: 'var(--t-number)' },
  { tag: t.atom, color: 'var(--t-bool)' },
  { tag: t.special(t.propertyName), color: 'var(--t-oid)' },
  { tag: t.function(t.variableName), color: 'var(--t-oid)' },
  { tag: t.typeName, color: 'var(--t-binary)' },
  { tag: t.variableName, color: 'var(--text)' },
  { tag: t.comment, color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation], color: 'var(--text-2)' }
])

const KEYWORDS = new Set([...SQL_RESERVED, 'FIRST', 'NEXT', 'ONLY', 'OVER'])
const TYPED = new Set(['OBJECTID', 'ISODATE'])

const sqlLanguage = StreamLanguage.define<{ comment: boolean }>({
  name: 'sql',
  startState: () => ({ comment: false }),
  token(stream, st) {
    if (st.comment) {
      if (stream.skipTo('*/')) {
        stream.match('*/')
        st.comment = false
      } else stream.skipToEnd()
      return 'comment'
    }
    if (stream.eatSpace()) return null
    if (stream.match('--')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('/*')) {
      st.comment = true
      return 'comment'
    }
    const ch = stream.peek()!
    if (ch === "'" || ch === '`' || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch
      stream.next()
      while (!stream.eol()) {
        if (stream.next() === close) {
          if (stream.peek() === close) stream.next()
          else break
        }
      }
      return ch === "'" ? 'string' : 'propertyName.special'
    }
    if (stream.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^[\p{L}_][\p{L}\p{N}_$]*/u)) {
      const w = stream.current().toUpperCase()
      if (w === 'TRUE' || w === 'FALSE' || w === 'NULL') return 'atom'
      if (stream.match(/^\s*\(/, false)) return TYPED.has(w) ? 'typeName' : 'variableName.function'
      if (KEYWORDS.has(w)) return 'keyword'
      return 'variableName'
    }
    if (stream.match(/^(?:<=|>=|<>|!=|\|\||[=<>+\-*/%])/)) return 'operator'
    stream.next()
    return 'punctuation'
  },
  languageData: { commentTokens: { line: '--', block: { open: '/*', close: '*/' } } }
})

const KEYWORD_OPTIONS: Completion[] = [
  'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'IS NULL', 'IS NOT NULL', 'GROUP BY',
  'HAVING', 'ORDER BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'ON', 'AS', 'TRUE', 'FALSE', 'NULL'
].map((k) => ({ label: k, type: 'keyword' }))
const AGG = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])
const FUNCTION_OPTIONS: Completion[] = SQL_FUNCTIONS.map((f) => ({
  label: f,
  type: 'function',
  apply: f === 'ObjectId' || f === 'ISODate' ? `${f}('')` : `${f}(`,
  detail: f === 'ObjectId' || f === 'ISODate' ? 'literal' : AGG.has(f) ? 'aggregate' : undefined
}))

const quotePath = (p: string): string => p.split('.').map(sqlIdent).join('.')
const quoteColl = (c: string): string => (c.split('.').every((s) => sqlIdent(s) === s) ? c : sqlIdent(c))

export interface SqlCompletionData {
  collections: string[]
  fields: string[]
}

function sqlCompletions(data: () => SqlCompletionData) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1)
    if (/string|comment/i.test(node.type.name)) return null
    const word = ctx.matchBefore(/[\p{L}\p{N}_$.]*/u)
    if (!word || (word.from === word.to && !ctx.explicit)) return null
    const before = ctx.state.sliceDoc(Math.max(0, word.from - 30), word.from)
    const d = data()
    const tableSpot = /\b(FROM|JOIN)\s+$/i.test(before)
    const collections = d.collections.map((c) => ({ label: quoteColl(c), type: 'class', detail: 'collection', boost: tableSpot ? 20 : -5 }))
    if (tableSpot) return { from: word.from, options: collections, validFor: /^[\p{L}\p{N}_$.]*$/u }
    const fields = d.fields.map((f) => ({ label: quotePath(f), type: 'property', boost: 5 }))
    const dot = word.text.indexOf('.')
    if (dot >= 0) {
      const root = word.text.slice(0, dot)
      if (!d.fields.some((f) => f.startsWith(`${root}.`))) return { from: word.from + dot + 1, options: fields, validFor: /^[\p{L}\p{N}_$.]*$/u }
      return { from: word.from, options: fields, validFor: /^[\p{L}\p{N}_$.]*$/u }
    }
    return { from: word.from, options: [...fields, ...KEYWORD_OPTIONS, ...FUNCTION_OPTIONS, ...collections], validFor: /^[\p{L}\p{N}_$]*$/u }
  }
}

const setError = StateEffect.define<{ from: number; to: number } | null>()
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setError)) continue
      if (!e.value) return Decoration.none
      const len = tr.state.doc.length
      let from = Math.min(e.value.from, len)
      let to = Math.min(Math.max(e.value.to, from), len)
      if (from === to) {
        if (to < len && tr.state.sliceDoc(to, to + 1) !== '\n') to++
        else if (from > 0) from--
      }
      return from === to ? Decoration.none : Decoration.set([Decoration.mark({ class: 'sql-err-mark' }).range(from, to)])
    }
    return tr.docChanged ? Decoration.none : deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

interface Props {
  value: string
  onChange: (v: string) => void
  onRun: () => void
  /** Cursor / selection moved. */
  onCursor: (pos: number, selection: { from: number; to: number } | null) => void
  error: { from: number; to: number } | null
  completionData: () => SqlCompletionData
  onView?: (v: EditorView | null) => void
}

export function SqlEditor(p: Props): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(p)
  latest.current = p
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const complete = sqlCompletions(() => latest.current.completionData())
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: p.value,
        extensions: [
          editorPrefs({ area: 'sql', wrap: 'pref', completion: { icons: true } }),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          history(),
          bracketMatching(),
          sqlLanguage,
          syntaxHighlighting(highlight),
          sqlLanguage.data.of({ autocomplete: complete }),
          errorField,
          placeholder('SELECT * FROM collection WHERE … ORDER BY … LIMIT 50'),
          // Run keys from the command registry (Settings → Shortcuts → SQL query).
          commandKeymap(() => ({ 'sql.run': () => latest.current.onRun() })),
          editorSearch(),
          keymap.of([
            { key: 'Mod-/', run: toggleComment },
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
            if (u.selectionSet || u.docChanged) {
              const s = u.state.selection.main
              latest.current.onCursor(s.head, s.empty ? null : { from: s.from, to: s.to })
            }
            if (u.focusChanged) setFocused(u.view.hasFocus)
          }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } })
        ]
      })
    })
    view.current = v
    latest.current.onView?.(v)
    v.dispatch({ selection: { anchor: v.state.doc.length } })
    v.focus()
    return () => {
      latest.current.onView?.(null)
      v.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== p.value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value } })
  }, [p.value])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const e = p.error
    v.dispatch({
      effects: e ? [setError.of(e), EditorView.scrollIntoView(Math.min(e.from, v.state.doc.length), { y: 'nearest' })] : [setError.of(null)]
    })
  }, [p.error])

  return <div ref={host} className={`cm-wrap full sql-editor ${focused ? 'focused' : ''}`} />
}
