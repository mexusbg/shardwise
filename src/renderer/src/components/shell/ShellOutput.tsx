import { createContext, memo, useContext, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { bsonTypeOf, shellText } from '@shared/bsonValue'
import type { Doc, PlaygroundLog } from '@shared/api'
import type { ShellResult } from '@shared/shell'
import { clipOutput, DEFAULT_PRINT, leafText } from '@shared/shellOptions'
import type { ShellPrintOptions, ShellStartupReport } from '@shared/shellOptions'
import { emptyVqb, toast } from '../../state/store'
import type { QueryTab } from '../../state/store'
import { api } from '../../lib/api'
import { Icon } from '../Icon'
import { TableView } from '../views/TableView'

export interface CmdEntry {
  kind: 'cmd'
  id: number
  code: string
  db: string
  logs: PlaygroundLog[]
  result?: ShellResult
  running: boolean
}

export interface SysEntry {
  kind: 'sys'
  id: number
  level: 'info' | 'warn' | 'error'
  text: string
  /** Shows a Reconnect button. */
  reconnect?: boolean
}

/** Startup scripts that ran when the session (re)started. */
export interface StartupEntry {
  kind: 'startup'
  id: number
  reports: ShellStartupReport[]
}

export type Entry = CmdEntry | SysEntry | StartupEntry

/** How results print and how much output a command shows before "Show more" (Settings → Shell & Playground). */
export interface OutputPrefs {
  print: ShellPrintOptions
  maxLines: number
  maxChars: number
}

export const OutputPrefsContext = createContext<OutputPrefs>({ print: DEFAULT_PRINT, maxLines: 500, maxChars: 100_000 })

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** JavaScript with lezer highlight classes (tok-*), styled in shell.css. */
export function Highlighted({ code }: { code: string }): ReactElement {
  const parts = useMemo(() => {
    const out: ReactNode[] = []
    let pos = 0
    highlightTree(javascriptLanguage.parser.parse(code), classHighlighter, (from, to, classes) => {
      if (from > pos) out.push(code.slice(pos, from))
      out.push(
        <span key={from} className={classes}>
          {code.slice(from, to)}
        </span>
      )
      pos = to
    })
    if (pos < code.length) out.push(code.slice(pos))
    return out
  }, [code])
  return <>{parts}</>
}

const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] => {
  const t = bsonTypeOf(v)
  return t === 'object' || t === 'array'
}

const KEY_RE = /^[A-Za-z_$][\w$]*$/
const PAGE = 100

function Leaf({ v }: { v: unknown }): ReactElement {
  const { print } = useContext(OutputPrefsContext)
  return <span className={`sh-v sh-${bsonTypeOf(v)}`}>{leafText(v, print)}</span>
}

function JsonNode({ name, v, depth, comma }: { name?: string; v: unknown; depth: number; comma: boolean }): ReactElement {
  const { print } = useContext(OutputPrefsContext)
  const container = isContainer(v)
  const isArr = Array.isArray(v)
  const entries = useMemo(() => (container ? (isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>)) : []), [v, container, isArr])
  // Levels beyond the print depth start folded; within it, small or shallow nodes start open.
  const [open, setOpen] = useState(() => depth < print.depth && (depth < 2 || entries.length <= 6))
  const [shown, setShown] = useState(PAGE)
  const key = name !== undefined && (
    <>
      <span className="sh-key">{KEY_RE.test(name) ? name : `'${name.replace(/'/g, "\\'")}'`}</span>
      <span className="sh-punct">: </span>
    </>
  )
  const tail = comma ? <span className="sh-punct">,</span> : null
  if (!container) {
    return (
      <div className="sh-line">
        {key}
        <Leaf v={v} />
        {tail}
      </div>
    )
  }
  const [o, c] = isArr ? ['[', ']'] : ['{', '}']
  if (!entries.length) {
    return (
      <div className="sh-line">
        {key}
        <span className="sh-punct">{`${o}${c}`}</span>
        {tail}
      </div>
    )
  }
  if (!open) {
    return (
      <div className="sh-line">
        <button className="sh-fold" onClick={() => setOpen(true)} title="Expand">
          <Icon name="chevronRight" size={10} />
        </button>
        {key}
        <span className="sh-punct">{o}</span>
        <button className="sh-collapsed" onClick={() => setOpen(true)}>
          {isArr ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : `${entries.length} field${entries.length === 1 ? '' : 's'}`}
        </button>
        <span className="sh-punct">{c}</span>
        {tail}
      </div>
    )
  }
  const visible = entries.slice(0, shown)
  return (
    <div className="sh-node">
      <div className="sh-line">
        <button className="sh-fold open" onClick={() => setOpen(false)} title="Collapse">
          <Icon name="chevronRight" size={10} />
        </button>
        {key}
        <span className="sh-punct">{o}</span>
      </div>
      <div className="sh-children">
        {visible.map(([k, x], i) => (
          <JsonNode key={k} name={isArr ? undefined : k} v={x} depth={depth + 1} comma={i < entries.length - 1} />
        ))}
        {entries.length > shown && (
          <button className="sh-more-items" onClick={() => setShown((n) => n + PAGE * 5)}>
            … {(entries.length - shown).toLocaleString()} more
          </button>
        )}
      </div>
      <div className="sh-line">
        <span className="sh-punct">{c}</span>
        {tail}
      </div>
    </div>
  )
}

/** Read-only stand-in so the collection table view can render shell documents. */
function tableTab(id: number, docs: Doc[]): QueryTab {
  return {
    kind: 'query',
    id: `shell-result-${id}`,
    connId: '',
    db: '',
    coll: 'result',
    isView: true,
    queryText: '',
    projectionText: '',
    sortText: '',
    skipText: '',
    limitText: '',
    collationText: '',
    pageSize: Math.max(1, docs.length),
    page: 0,
    docs,
    hasMore: false,
    loading: false,
    view: 'table',
    tablePath: [],
    hiddenColumns: [],
    readOnly: true,
    vqbOpen: false,
    vqb: emptyVqb(),
    selection: [],
    rev: 0
  }
}

function copy(text: string): void {
  void api.copyText(text).then(() => toast('Copied', 'success'))
}

function ResultBlock({ id, r }: { id: number; r: ShellResult }): ReactElement | null {
  const [table, setTable] = useState(false)
  const docs = r.ok && r.valueKind === 'documents' ? (r.value as Doc[]) : null
  const fake = useMemo(() => (docs && table ? tableTab(id, docs) : null), [docs, table, id])

  if (!r.ok) {
    return (
      <div className={`sh-error ${r.cancelled ? 'stopped' : ''}`}>
        <div className="sh-error-head">
          <Icon name="warn" size={14} />
          <span>{r.error ?? 'Failed'}</span>
        </div>
        {r.stack && <pre className="sh-error-stack">{r.stack}</pre>}
      </div>
    )
  }
  if (r.valueKind === 'undefined') return null
  // Text results are shown (and cut at the output limits) with the console output.
  if (typeof r.value === 'string') return null
  const asText = (): string => shellText(r.value, 2)
  return (
    <div className={`sh-result ${fake ? 'table' : ''}`}>
      <div className="sh-result-tools">
        {docs && docs.length > 1 && (
          <div className="segmented small">
            <button className={!table ? 'on' : ''} onClick={() => setTable(false)} title="Show as JSON">
              <Icon name="json" size={12} /> JSON
            </button>
            <button className={table ? 'on' : ''} onClick={() => setTable(true)} title="View as table">
              <Icon name="table" size={12} /> Table
            </button>
          </div>
        )}
        <button className="btn ghost icon small" title="Copy as shell JSON" onClick={() => copy(asText())}>
          <Icon name="copy" size={12} />
        </button>
      </div>
      {fake ? (
        <div className="sh-table" style={{ height: Math.min(420, 30 + 26 * docs!.length + 14) }}>
          <TableView tab={fake} />
        </div>
      ) : docs ? (
        docs.length === 0 ? (
          <div className="sh-dim">No documents</div>
        ) : (
          <div className="sh-json">
            {docs.map((d, i) => (
              <JsonNode key={i} v={d} depth={0} comma={false} />
            ))}
          </div>
        )
      ) : (
        <div className="sh-json">
          <JsonNode v={r.value} depth={0} comma={false} />
        </div>
      )}
    </div>
  )
}

function docCount(r: ShellResult): string | null {
  if (!r.ok) return null
  if (r.valueKind === 'documents') {
    const n = (r.value as unknown[]).length
    return `${n.toLocaleString()} document${n === 1 ? '' : 's'}`
  }
  if (r.valueKind === 'document') return '1 document'
  return null
}

/** Console lines and a text result, cut at the output limits with "Show more" / "Show all". */
function ClippedOutput({ logs, text }: { logs: PlaygroundLog[]; text?: string }): ReactElement | null {
  const prefs = useContext(OutputPrefsContext)
  const [factor, setFactor] = useState(1)
  const [all, setAll] = useState(false)
  const texts = useMemo(() => [...logs.map((l) => l.text), ...(text !== undefined ? [text] : [])], [logs, text])
  const clip = useMemo(
    () => (all ? { shown: texts, hiddenLines: 0, hiddenChars: 0 } : clipOutput(texts, prefs.maxLines * factor, prefs.maxChars * factor)),
    [texts, all, factor, prefs.maxLines, prefs.maxChars]
  )
  if (!texts.length) return null
  const nLogs = Math.min(logs.length, clip.shown.length)
  const hidden = clip.hiddenLines > 0 || clip.hiddenChars > 0
  return (
    <>
      {nLogs > 0 && (
        <div className="sh-logs">
          {clip.shown.slice(0, nLogs).map((t, i) => (
            <pre key={i} className={`sh-log ${logs[i].level}`}>
              {t}
            </pre>
          ))}
        </div>
      )}
      {clip.shown.length > logs.length && <pre className="sh-text">{clip.shown[logs.length]}</pre>}
      {hidden && (
        <div className="sh-clipped">
          <Icon name="warn" size={12} />
          <span>
            Output cut at the limit: {clip.hiddenLines.toLocaleString()} more line{clip.hiddenLines === 1 ? '' : 's'} ({clip.hiddenChars.toLocaleString()} characters).
          </span>
          <button className="btn small ghost" onClick={() => setFactor((f) => f + 1)}>
            Show more
          </button>
          <button className="btn small ghost" onClick={() => setAll(true)}>
            Show all
          </button>
        </div>
      )}
    </>
  )
}

/** What the startup scripts printed, and their errors (the session runs either way). */
function StartupView({ reports }: { reports: ShellStartupReport[] }): ReactElement {
  return (
    <div className="sh-entry sh-startup">
      {reports.map((r, i) => (
        <div key={i}>
          <div className={`sh-sys ${r.ok ? 'info' : 'error'}`}>
            <Icon name={r.ok ? 'terminal' : 'warn'} size={13} />
            <span>
              {r.ok ? 'Ran the startup script' : 'Startup script failed'} ({r.label}){r.ms ? ` in ${fmtMs(r.ms)}` : ''}
            </span>
          </div>
          <ClippedOutput logs={r.logs} />
          {!r.ok && r.error && (
            <div className="sh-error">
              <div className="sh-error-head">
                <Icon name="warn" size={14} />
                <span>{r.error}</span>
              </div>
              {r.stack && <pre className="sh-error-stack">{r.stack}</pre>}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface EntryProps {
  entry: Entry
  elapsed: number
  onReconnect: () => void
  onRerun: (code: string) => void
}

export const EntryView = memo(function EntryView({ entry, elapsed, onReconnect, onRerun }: EntryProps): ReactElement {
  if (entry.kind === 'sys') {
    return (
      <div className={`sh-sys ${entry.level}`}>
        <Icon name={entry.level === 'info' ? 'terminal' : 'warn'} size={13} />
        <span>{entry.text}</span>
        {entry.reconnect && (
          <button className="btn small" onClick={onReconnect}>
            <Icon name="refresh" size={12} /> Reconnect
          </button>
        )}
      </div>
    )
  }
  if (entry.kind === 'startup') return <StartupView reports={entry.reports} />
  const r = entry.result
  const count = r && docCount(r)
  const text = r?.ok && typeof r.value === 'string' ? r.value : undefined
  return (
    <div className={`sh-entry ${entry.running ? 'running' : ''}`}>
      <div className="sh-input-echo">
        <span className="sh-prompt">{entry.db}&gt;</span>
        <pre className="sh-cmd" onDoubleClick={() => onRerun(entry.code)} title="Double-click to edit again">
          <Highlighted code={entry.code} />
        </pre>
      </div>
      <ClippedOutput logs={entry.logs} text={text} />
      {r && <ResultBlock id={entry.id} r={r} />}
      {r?.more && (
        <div className="sh-more">
          Type <span className="kbd">it</span> for more
        </div>
      )}
      <div className="sh-meta">
        {entry.running ? (
          <>
            <span className="sh-spinner" /> Running… {fmtMs(elapsed)}
          </>
        ) : (
          r && (
            <>
              <span className={r.ok ? 'ok' : r.cancelled ? 'stopped' : 'failed'}>{r.ok ? '✓' : r.cancelled ? '■' : '✕'}</span>
              {fmtMs(r.ms)}
              {count && <span>· {count}</span>}
            </>
          )
        )}
      </div>
    </div>
  )
})
