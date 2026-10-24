/** Searchable index of the Settings dialog. */

export type PrefTab = 'workspace' | 'data' | 'editing' | 'shell' | 'keyboard' | 'dates' | 'safety' | 'ai' | 'network' | 'about'

/** Sections of the Settings dialog, grouped by what you are doing (in dialog order). */
export const PREF_TABS: [PrefTab, string][] = [
  ['workspace', 'Workspace'],
  ['data', 'Browsing data'],
  ['editing', 'Writing code'],
  ['shell', 'Shell & Playground'],
  ['keyboard', 'Shortcuts'],
  ['dates', 'Dates & time zones'],
  ['safety', 'Safety & undo'],
  ['ai', 'AI & automation'],
  ['network', 'Network & tools'],
  ['about', 'About']
]

export interface PrefEntry {
  /** `data-pref` id of the field, or for tabs rendered by other components the field's label text. */
  id: string
  tab: PrefTab
  label: string
  hint?: string
  /** Extra words that should find the entry. */
  keywords?: string
}

export const PREF_ENTRIES: PrefEntry[] = [
  { id: 'theme', tab: 'workspace', label: 'Theme', keywords: 'dark light system appearance colour color mode' },
  { id: 'uiZoom', tab: 'workspace', label: 'Interface zoom', hint: 'Scale of the whole window', keywords: 'size scale bigger smaller font text ui' },
  { id: 'restoreSession', tab: 'workspace', label: 'Restore tabs on launch', keywords: 'session startup reopen previous' },
  { id: 'connectionManagerOnStart', tab: 'workspace', label: 'Connection Manager at launch', hint: 'Open the connection list when the app starts', keywords: 'startup connect dialog open' },
  { id: 'valueColors', tab: 'workspace', label: 'Value colours', hint: 'Colour of strings, numbers, dates, ObjectIds… per theme', keywords: 'color colour type syntax highlight string number date objectid boolean null theme' },

  { id: 'queryTimeoutMS', tab: 'data', label: 'Query timeout', keywords: 'maxTimeMS slow limit milliseconds' },
  { id: 'autoCast', tab: 'data', label: 'Auto-cast', hint: 'Hex strings as ObjectId, ISO strings as Date', keywords: 'objectid date convert type' },
  { id: 'historyLimit', tab: 'data', label: 'Query history size', hint: 'How many recent queries are kept', keywords: 'entries limit prune recent runs' },
  { id: 'runQueryOnOpen', tab: 'data', label: 'Run the query when a collection opens', keywords: 'auto automatic execute open empty grid manual' },
  { id: 'pageSize', tab: 'data', label: 'Default page size', keywords: 'documents per page rows limit' },
  { id: 'defaultResultView', tab: 'data', label: 'Default view', hint: 'Table, Tree or JSON for new collection tabs', keywords: 'result table tree json' },
  { id: 'rememberResultView', tab: 'data', label: 'Remember the view per collection', keywords: 'last used result table tree json' },
  { id: 'filterBuilderOnOpen', tab: 'data', label: 'Show the Filter Builder when a collection opens', keywords: 'visual query builder vqb panel open default' },
  { id: 'defaultCollation', tab: 'data', label: 'Default collation', hint: 'Language-aware sort and case-insensitive matching for new query tabs', keywords: 'collation locale language sort order alphabetical case insensitive strength cyrillic bulgarian russian icu' },
  { id: 'treeExpandFirst', tab: 'data', label: 'Expand the first document', hint: 'Tree view', keywords: 'tree open automatically' },
  { id: 'jsonStyle', tab: 'data', label: 'JSON style', hint: 'JSON view and copied documents', keywords: 'ejson extended relaxed canonical shell mongosh copy document format' },

  { id: 'editorFontFamily', tab: 'editing', label: 'Font', keywords: 'family monospace typeface code' },
  { id: 'editorFontSize', tab: 'editing', label: 'Font size', keywords: 'text size bigger smaller code' },
  { id: 'editorTabWidth', tab: 'editing', label: 'Tab width', keywords: 'indent indentation spaces' },
  { id: 'editorCloseBrackets', tab: 'editing', label: 'Close brackets and quotes', keywords: 'auto pair parentheses braces' },
  { id: 'editorLineWrapping', tab: 'editing', label: 'Wrap long lines', keywords: 'word wrap soft horizontal scroll' },
  { id: 'editorAutocomplete', tab: 'editing', label: 'Suggest while typing', hint: 'Autocomplete per editor', keywords: 'autocomplete completion suggestions query pipeline shell sql playground' },

  { id: 'shellStartupScript', tab: 'shell', label: 'Shell startup script', hint: 'Runs when a shell session starts', keywords: 'mongoshrc rc init script file helpers' },
  { id: 'playgroundRunStartup', tab: 'shell', label: 'Run the startup script in the playground', keywords: 'playground startup script mongoshrc' },
  { id: 'shellBatchSize', tab: 'shell', label: 'Shell results per page', hint: 'Documents per cursor batch', keywords: 'it batch size cursor page documents' },
  { id: 'shellMaxOutputLines', tab: 'shell', label: 'Shell output per command', hint: 'Lines and characters before Show more', keywords: 'truncate limit lines characters show more output' },
  { id: 'shellPrintDepth', tab: 'shell', label: 'Shell nesting depth', keywords: 'depth nested object print levels' },
  { id: 'shellNumberDisplay', tab: 'shell', label: 'Shell numbers', hint: 'NumberInt / NumberLong / NumberDecimal or plain', keywords: 'int32 long decimal int64 wrappers plain number display' },
  { id: 'shellDateDisplay', tab: 'shell', label: 'Shell dates', hint: 'ISODate() or the Dates & times format', keywords: 'isodate date display format zone' },
  { id: 'shellConfirm', tab: 'shell', label: 'Ask before running shell commands', hint: 'Confirm drops and empty-filter deletes', keywords: 'confirm destructive drop delete approve dangerous safety writes' },
  { id: 'shellHistoryLimit', tab: 'shell', label: 'Shell history size', keywords: 'commands history limit up arrow' },
  { id: 'shellHistoryDedupe', tab: 'shell', label: 'Shell history duplicates', keywords: 'dedupe repeat consecutive history' },
  { id: 'shellHistoryScope', tab: 'shell', label: 'Shell history per connection', keywords: 'global shared history scope' },
  { id: 'shellHistoryClear', tab: 'shell', label: 'Clear shell history', keywords: 'delete remove history commands' },
  { id: 'shellTimeoutMS', tab: 'shell', label: 'Shell command time limit', keywords: 'timeout default stop seconds' },
  { id: 'playgroundTimeoutMS', tab: 'shell', label: 'Playground time limit', keywords: 'timeout default stop seconds playground' },
  { id: 'mongoshPath', tab: 'shell', label: 'mongosh path', hint: 'Open in mongosh', keywords: 'external mongosh terminal executable path version' },

  { id: 'keymap', tab: 'keyboard', label: 'Keyboard shortcuts', hint: 'Change, add or remove the keys of any command', keywords: 'keys keymap hotkeys bindings accelerators rebind shortcut ctrl cmd import export' },

  { id: 'Date format', tab: 'dates', label: 'Date format', keywords: 'dd mm yyyy pattern day month year' },
  { id: 'Time format', tab: 'dates', label: 'Time format', keywords: 'hh mm ss 24 12 hour clock' },
  { id: 'Time zone', tab: 'dates', label: 'Time zone', keywords: 'utc local iana offset' },
  { id: 'Show as', tab: 'dates', label: 'Show database dates as', keywords: 'iso 8601 interface format' },

  { id: 'confirmSingleDelete', tab: 'safety', label: 'Confirm deleting one document', keywords: 'ask are you sure prompt remove delete confirmation' },
  { id: 'Keep changes for', tab: 'safety', label: 'Change History retention', keywords: 'keep days undo audit' },
  { id: 'Maximum size', tab: 'safety', label: 'Change History maximum size', keywords: 'mb disk undo' },
  { id: 'Per operation', tab: 'safety', label: 'Change History per operation', keywords: 'documents limit undo bulk' },

  { id: 'Anthropic API key', tab: 'ai', label: 'Anthropic API key', keywords: 'claude token secret assistant' },
  { id: 'Model', tab: 'ai', label: 'AI model', keywords: 'claude assistant' },
  { id: 'Effort', tab: 'ai', label: 'AI effort', keywords: 'thinking reasoning claude' },
  { id: 'Privacy', tab: 'ai', label: 'AI privacy', keywords: 'send data documents sample values claude' },
  { id: 'Max documents per result', tab: 'ai', label: 'AI max documents per result', keywords: 'claude limit' },
  { id: 'Port', tab: 'ai', label: 'MCP server port', keywords: 'model context protocol agent http' },
  { id: 'Max documents', tab: 'ai', label: 'MCP max documents', keywords: 'model context protocol limit' },
  { id: 'Connections', tab: 'ai', label: 'MCP connections', keywords: 'model context protocol expose allow' },
  { id: 'Writes', tab: 'ai', label: 'MCP writes', keywords: 'model context protocol read-only approve' },
  { id: 'Token', tab: 'ai', label: 'MCP token', keywords: 'model context protocol bearer secret' },

  { id: 'toolsPath', tab: 'network', label: 'Database Tools folder', keywords: 'mongodump mongorestore path download binaries' },
  { id: 'proxyMode', tab: 'network', label: 'Proxy', hint: 'No proxy, system settings or a manual proxy server', keywords: 'network http https socks socks5 pac firewall corporate internet' },
  { id: 'proxyServer', tab: 'network', label: 'Proxy server', keywords: 'network host port http socks socks5' },
  { id: 'proxyCredentials', tab: 'network', label: 'Proxy user name and password', keywords: 'network authentication login credentials basic' },
  { id: 'proxyBypass', tab: 'network', label: 'Proxy bypass list', hint: 'Hosts that are reached directly', keywords: 'network no_proxy exceptions exclude direct cidr wildcard' },
  { id: 'proxyTest', tab: 'network', label: 'Test the proxy', keywords: 'network check connection latency' },

  { id: 'checkUpdates', tab: 'about', label: 'Check for updates when Shardwise starts', hint: 'Newest release on GitHub', keywords: 'update upgrade new version release download github' },
  { id: 'about', tab: 'about', label: 'About Shardwise', keywords: 'version third-party notices licence license electron fidweb author mexus website support ko-fi donate coffee' },
]

const fold = (s: string): string => s.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * Entries matching every word of `query` (in the label, hint, keywords or tab name), best first:
 * label prefix, then label words, then other text. Order within a rank follows the dialog.
 */
export function searchPrefs(query: string, entries: PrefEntry[] = PREF_ENTRIES): PrefEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const tabName = new Map(PREF_TABS)
  const scored: { e: PrefEntry; score: number; i: number }[] = []
  entries.forEach((e, i) => {
    const label = fold(e.label)
    const hay = [label, fold(e.hint ?? ''), fold(e.keywords ?? ''), fold(tabName.get(e.tab) ?? '')].join(' ')
    if (!words.every((w) => hay.includes(w))) return
    let score = 0
    for (const w of words) {
      if (label.startsWith(w)) score += 3
      else if (label.split(/[^\p{L}\p{N}]+/u).some((x) => x.startsWith(w))) score += 2
      else if (label.includes(w)) score += 1
    }
    scored.push({ e, score, i })
  })
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.e)
}

/** Number of matches per tab. */
export function hitsByTab(results: PrefEntry[]): Partial<Record<PrefTab, number>> {
  const out: Partial<Record<PrefTab, number>> = {}
  for (const r of results) out[r.tab] = (out[r.tab] ?? 0) + 1
  return out
}

/** Split `text` into plain and matched parts for highlighting. */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const folded = fold(text)
  // Folding can change length (e.g. decomposed accents); fall back to no highlight then.
  if (!words.length || folded.length !== text.length) return [{ text, hit: false }]
  const mark = new Array<boolean>(text.length).fill(false)
  for (const w of words) {
    let i = folded.indexOf(w)
    while (i >= 0) {
      for (let j = i; j < i + w.length; j++) mark[j] = true
      i = folded.indexOf(w, i + w.length)
    }
  }
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1]
    if (last && last.hit === mark[i]) last.text += text[i]
    else out.push({ text: text[i], hit: mark[i] })
  }
  return out
}
