import { Compartment, EditorState, StateField } from '@codemirror/state'
import type { Extension, Text } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'
import { indentUnit } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import type { AppSettings, EditorArea } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/settings'

type CompletionConfig = NonNullable<Parameters<typeof autocompletion>[0]>

/** Editor preferences shared by every CodeMirror instance (Settings → Writing code). */
export type EditorPrefs = Pick<AppSettings, 'editorTabWidth' | 'editorCloseBrackets' | 'editorLineWrapping' | 'editorAutocomplete'>

export interface EditorPrefOptions {
  /** Which autocomplete switch applies; without it suggestions follow typing whenever `completion` is set. */
  area?: EditorArea
  /** 'pref' follows the line-wrapping preference; single-line inputs always wrap, some never do. */
  wrap: 'pref' | 'always' | 'never'
  /** Autocompletion options of this editor (activateOnTyping comes from the preference). */
  completion?: Omit<CompletionConfig, 'activateOnTyping'>
}

let prefs: EditorPrefs = pick(DEFAULT_SETTINGS)

function pick(s: AppSettings): EditorPrefs {
  return {
    editorTabWidth: s.editorTabWidth,
    editorCloseBrackets: s.editorCloseBrackets,
    editorLineWrapping: s.editorLineWrapping,
    editorAutocomplete: { ...s.editorAutocomplete }
  }
}

/**
 * Lines longer than this switch wrapping off in that editor: a wrapped line is laid out in full (a 1 MB string
 * froze the document editor for a minute), an unwrapped one only where it is visible.
 */
const LONG_LINE = 10_000

function hasLongLine(doc: Text): boolean {
  if (doc.length <= LONG_LINE) return false
  for (const it = doc.iterLines(); !it.next().done; ) if (it.value.length > LONG_LINE) return true
  return false
}

const longLines = StateField.define<boolean>({
  create: (s) => hasLongLine(s.doc),
  update: (v, tr) => (tr.docChanged ? hasLongLine(tr.state.doc) : v)
})

/** EditorView.lineWrapping, except while the document has a very long line. */
const wrapUnlessLongLines: Extension = [longLines, EditorView.contentAttributes.compute([longLines], (s): Record<string, string> => (s.field(longLines) ? {} : { class: 'cm-lineWrapping' }))]

function build(p: EditorPrefs, o: EditorPrefOptions): Extension[] {
  const width = p.editorTabWidth || 2
  const ext: Extension[] = [EditorState.tabSize.of(width), indentUnit.of(' '.repeat(width))]
  if (p.editorCloseBrackets) ext.push(closeBrackets(), keymap.of(closeBracketsKeymap))
  if (o.wrap === 'always' || (o.wrap === 'pref' && p.editorLineWrapping)) ext.push(wrapUnlessLongLines)
  if (o.completion) ext.push(autocompletion({ ...o.completion, activateOnTyping: o.area ? p.editorAutocomplete[o.area] !== false : true }))
  return ext
}

const views = new Map<EditorView, { comp: Compartment; o: EditorPrefOptions }>()

/**
 * Tab width, auto-closing brackets, line wrapping and autocomplete for one editor. Place it before the
 * editor's own keymaps so the bracket keymap (Backspace deletes a pair) wins over the default one.
 * Editors created with it follow later preference changes without being recreated.
 */
export function editorPrefs(o: EditorPrefOptions): Extension {
  const comp = new Compartment()
  const track = ViewPlugin.define((view) => {
    views.set(view, { comp, o })
    return { destroy: () => void views.delete(view) }
  })
  return [comp.of(build(prefs, o)), track]
}

/** Apply new preferences to every open editor. */
export function setEditorPrefs(s: AppSettings): void {
  const next = pick(s)
  if (JSON.stringify(next) === JSON.stringify(prefs)) return
  prefs = next
  for (const [view, { comp, o }] of views) view.dispatch({ effects: comp.reconfigure(build(prefs, o)) })
}
