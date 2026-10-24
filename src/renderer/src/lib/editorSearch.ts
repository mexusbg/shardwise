import { closeSearchPanel, findNext, findPrevious, highlightSelectionMatches, openSearchPanel, search } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { commandKeymap } from './commands'

/**
 * Find / replace panel of the multi-line code editors (document editor and viewer, JSON view, playground, SQL).
 * The keys come from the command registry (Settings → Shortcuts → Code editors) and also work inside the
 * panel; Enter / Shift+Enter in the search field step through matches, Escape closes the panel.
 */
export function editorSearch(): Extension {
  return [
    search({ top: true }),
    highlightSelectionMatches(),
    // CodeMirror's labels are lower case; the rest of the app capitalises buttons and options.
    EditorState.phrases.of({
      next: 'Next',
      previous: 'Previous',
      all: 'All',
      'match case': 'Match case',
      regexp: 'Regex',
      'by word': 'Whole word',
      replace: 'Replace',
      'replace all': 'Replace all',
      close: 'Close'
    }),
    commandKeymap(
      () => ({
        'editor.find': (view) => openSearchPanel(view),
        'editor.findNext': (view) => findNext(view),
        'editor.findPrevious': (view) => findPrevious(view)
      }),
      'high',
      'editor search-panel'
    ),
    keymap.of([{ key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' }])
  ]
}
