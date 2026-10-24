import type { CommandDef } from './keymap'

/**
 * Every command that has (or can be given) a keyboard shortcut. The order is the order of the
 * Settings → Shortcuts list and, for conflicting bindings in one scope, the order of precedence.
 */
const DEFS = [
  // --- Application ---
  { id: 'app.connectionManager', label: 'Open Connection Manager', category: 'Application', scope: 'global', keys: ['Mod-Shift-o'], keywords: 'connect' },
  { id: 'app.newConnection', label: 'New connection', category: 'Application', scope: 'global', keys: ['Mod-Shift-n'] },
  { id: 'app.preferences', label: 'Settings', category: 'Application', scope: 'global', keys: ['Mod-,'], keywords: 'settings options' },
  { id: 'app.quickOpen', label: 'Go to collection…', category: 'Application', scope: 'global', keys: ['Mod-p'], keywords: 'search find open quick jump collection view' },
  { id: 'app.findInDatabase', label: 'Find in database', category: 'Application', scope: 'global', keys: ['Mod-Shift-f'], keywords: 'search full text' },
  { id: 'app.import', label: 'Import…', category: 'Application', scope: 'global', keys: [] },
  { id: 'app.export', label: 'Export…', category: 'Application', scope: 'global', keys: [] },
  { id: 'app.openShell', label: 'Open shell for the current database', category: 'Application', scope: 'global', keys: [], keywords: 'mongosh console terminal' },
  { id: 'app.openPlayground', label: 'Open playground for the current database', category: 'Application', scope: 'global', keys: [], keywords: 'script javascript' },
  { id: 'app.openSql', label: 'Open SQL query for the current database', category: 'Application', scope: 'global', keys: [] },
  { id: 'app.toggleAssistant', label: 'Show or hide the AI assistant', category: 'Application', scope: 'global', keys: [], keywords: 'claude ai chat' },

  // --- Tabs ---
  { id: 'tab.close', label: 'Close tab', category: 'Tabs', scope: 'global', keys: ['Mod-w'] },
  { id: 'tab.next', label: 'Next tab', category: 'Tabs', scope: 'global', keys: ['Ctrl-Tab', 'Ctrl-PageDown'], keywords: 'switch' },
  { id: 'tab.previous', label: 'Previous tab', category: 'Tabs', scope: 'global', keys: ['Ctrl-Shift-Tab', 'Ctrl-PageUp'], keywords: 'switch' },
  { id: 'tab.duplicate', label: 'Duplicate tab', category: 'Tabs', scope: 'global', keys: ['Mod-Shift-d'], keywords: 'clone copy' },
  { id: 'tab.closeOthers', label: 'Close other tabs', category: 'Tabs', scope: 'global', keys: [] },
  { id: 'tab.closeAll', label: 'Close all tabs', category: 'Tabs', scope: 'global', keys: [] },

  // --- Collection tab ---
  { id: 'query.run', label: 'Run query', category: 'Collection tab', scope: 'query', keys: ['Mod-Enter', 'Mod-r', 'F5'], keywords: 'execute find' },
  { id: 'query.refresh', label: 'Refresh the current page', category: 'Collection tab', scope: 'query', keys: ['Mod-Shift-r'], keywords: 'reload' },
  { id: 'query.count', label: 'Count matching documents', category: 'Collection tab', scope: 'query', keys: ['Mod-Shift-c'] },
  { id: 'query.explain', label: 'Explain plan', category: 'Collection tab', scope: 'query', keys: ['Mod-Shift-x'], keywords: 'performance index' },
  { id: 'query.focusBar', label: 'Focus the query bar', category: 'Collection tab', scope: 'query', keys: ['Mod-e'], keywords: 'filter edit' },
  { id: 'query.toggleFilterBuilder', label: 'Show or hide the Filter Builder', category: 'Collection tab', scope: 'query', keys: ['Mod-b'], keywords: 'visual query builder vqb' },
  { id: 'query.viewTable', label: 'Table view', category: 'Collection tab', scope: 'query', keys: ['Mod-1'], keywords: 'result grid' },
  { id: 'query.viewTree', label: 'Tree view', category: 'Collection tab', scope: 'query', keys: ['Mod-2'], keywords: 'result' },
  { id: 'query.viewJson', label: 'JSON view', category: 'Collection tab', scope: 'query', keys: ['Mod-3'], keywords: 'result text' },
  { id: 'query.viewCode', label: 'Query code', category: 'Collection tab', scope: 'query', keys: [], keywords: 'codegen language' },
  { id: 'query.nextPage', label: 'Next page', category: 'Collection tab', scope: 'query', keys: [] },
  { id: 'query.previousPage', label: 'Previous page', category: 'Collection tab', scope: 'query', keys: [] },
  { id: 'query.insertDocument', label: 'New document', category: 'Collection tab', scope: 'query', keys: [], keywords: 'insert add' },
  { id: 'query.export', label: 'Export query results', category: 'Collection tab', scope: 'query', keys: ['Mod-Shift-e'] },
  { id: 'query.editJson', label: 'Edit the selected document as JSON', category: 'Collection tab', scope: 'query', keys: ['Mod-j'], keywords: 'document editor open' },
  { id: 'query.updateDocuments', label: 'Update documents…', category: 'Collection tab', scope: 'query', keys: ['Mod-Shift-u'], keywords: 'update many set modify bulk' },
  { id: 'query.showJson', label: 'Show the selected document as JSON', category: 'Collection tab', scope: 'query', keys: ['Mod-Shift-j'], keywords: 'document view read only open' },
  { id: 'query.toggleReadOnly', label: 'Toggle read-only lock', category: 'Collection tab', scope: 'query', keys: ['Mod-Shift-l'], keywords: 'lock protect' },
  { id: 'query.openPipeline', label: 'Open in Pipeline Editor', category: 'Collection tab', scope: 'query', keys: [], keywords: 'aggregate aggregation' },

  // --- Table view ---
  { id: 'table.edit', label: 'Edit the focused cell', category: 'Table view', scope: 'table', keys: ['Enter', 'F2'], keywords: 'change value step into' },
  { id: 'table.delete', label: 'Delete selected documents', category: 'Table view', scope: 'table', keys: ['Delete'], keywords: 'remove' },
  { id: 'table.copyValue', label: 'Copy the focused value', category: 'Table view', scope: 'table', keys: ['Mod-c'] },
  { id: 'table.selectAll', label: 'Select all rows', category: 'Table view', scope: 'table', keys: ['Mod-a'] },
  { id: 'table.parent', label: 'Back to the parent level', category: 'Table view', scope: 'table', keys: ['Backspace'], keywords: 'step out up' },

  // --- Pipeline editor ---
  { id: 'pipeline.run', label: 'Run pipeline', category: 'Pipeline editor', scope: 'pipeline', keys: ['Mod-Enter', 'F5'], keywords: 'aggregate aggregation execute' },

  // --- Playground ---
  { id: 'playground.run', label: 'Run script (or the selection)', category: 'Playground', scope: 'playground', keys: ['Mod-Enter', 'F5'], keywords: 'execute' },
  { id: 'playground.stop', label: 'Stop the running script', category: 'Playground', scope: 'playground', keys: ['Escape'], keywords: 'cancel' },
  { id: 'playground.save', label: 'Save script', category: 'Playground', scope: 'playground', keys: ['Mod-s'] },
  { id: 'playground.saveAs', label: 'Save script as…', category: 'Playground', scope: 'playground', keys: ['Mod-Shift-s'] },
  { id: 'playground.open', label: 'Open script file…', category: 'Playground', scope: 'playground', keys: ['Mod-o'] },

  // --- SQL ---
  { id: 'sql.run', label: 'Run SQL statement (or the selection)', category: 'SQL query', scope: 'sql', keys: ['Mod-Enter', 'F5'], keywords: 'execute select' },

  // --- Shell ---
  { id: 'shell.run', label: 'Run command (new line if incomplete)', category: 'Shell', scope: 'shell', keys: ['Enter'], keywords: 'execute' },
  { id: 'shell.runForce', label: 'Run command as typed', category: 'Shell', scope: 'shell', keys: ['Mod-Enter'], keywords: 'execute' },
  { id: 'shell.newline', label: 'Insert a new line', category: 'Shell', scope: 'shell', keys: ['Shift-Enter'], keywords: 'multi-line' },
  { id: 'shell.historyPrevious', label: 'Previous command from history', category: 'Shell', scope: 'shell', keys: ['ArrowUp'] },
  { id: 'shell.historyNext', label: 'Next command from history', category: 'Shell', scope: 'shell', keys: ['ArrowDown'] },
  { id: 'shell.clear', label: 'Clear the screen', category: 'Shell', scope: 'shell', keys: ['Mod-l'], keywords: 'cls' },
  { id: 'shell.interrupt', label: 'Interrupt, or clear the input', category: 'Shell', scope: 'shell', keys: ['Ctrl-c'], keywords: 'cancel stop abort' },
  { id: 'shell.cancel', label: 'Interrupt the running command', category: 'Shell', scope: 'shell', keys: ['Escape'], keywords: 'cancel stop abort' },

  // --- Code editors and dialogs ---
  { id: 'editor.submit', label: 'Run or apply from a code editor', category: 'Editors and dialogs', scope: 'editor', keys: ['Mod-Enter'], keywords: 'validation filter test submit' },
  { id: 'editor.find', label: 'Find and replace in a code editor', category: 'Editors and dialogs', scope: 'editor', keys: ['Mod-f'], keywords: 'search document json playground sql' },
  { id: 'editor.findNext', label: 'Find next match', category: 'Editors and dialogs', scope: 'editor', keys: ['F3', 'Mod-g'], keywords: 'search' },
  { id: 'editor.findPrevious', label: 'Find previous match', category: 'Editors and dialogs', scope: 'editor', keys: ['Shift-F3', 'Mod-Shift-g'], keywords: 'search' },
  { id: 'dialog.submit', label: 'Save or confirm from a dialog editor', category: 'Editors and dialogs', scope: 'dialog', keys: ['Mod-Enter'], keywords: 'ok apply update insert document' },
  { id: 'dialog.close', label: 'Close the dialog', category: 'Editors and dialogs', scope: 'dialog', keys: ['Escape'], keywords: 'cancel dismiss' }
] as const satisfies readonly CommandDef[]

export type CommandId = (typeof DEFS)[number]['id']

export const COMMANDS: readonly CommandDef[] = DEFS

export const COMMAND_IDS = new Set<string>(DEFS.map((c) => c.id))

export const commandDef = (id: string): CommandDef | undefined => COMMANDS.find((c) => c.id === id)
