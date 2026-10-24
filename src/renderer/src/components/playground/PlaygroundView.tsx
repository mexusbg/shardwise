import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { EditorView } from '@codemirror/view'
import { shellText } from '@shared/bsonValue'
import type { CollectionInfo, PlaygroundLanguage, PlaygroundLog, PlaygroundResult } from '@shared/api'
import { api, onEvent } from '../../lib/api'
import { useCommandHandlers, useShortcut, withShortcut, withShortcuts } from '../../lib/commands'
import { connName, dbKey, errorText, getPlayground, openPlaygroundTab, patchPlayground, toast, useStore } from '../../state/store'
import type { PlaygroundTab } from '../../state/store'
import { Icon } from '../Icon'
import { PlaygroundEditor } from './PlaygroundEditor'
import { ConsoleView, fmtMs, ResultView, resultSummary } from './PlaygroundResults'
import type { ResultPane } from './PlaygroundResults'
import { generateCodeDialog } from '../ai/AiActions'
import './playground.css'

const TIMEOUTS: [number, string][] = [
  [0, 'No timeout'],
  [30_000, '30 s'],
  [120_000, '2 min'],
  [600_000, '10 min']
]
const FILE_FILTERS = [
  { name: 'Scripts', extensions: ['js', 'ts', 'mjs', 'cjs', 'mts'] },
  { name: 'All files', extensions: ['*'] }
]
const LS_SPLIT = 'shardwise.playground.split'
const draftKey = (title: string): string => `shardwise.playground.draft:${title}`

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // storage unavailable
  }
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const languageOf = (path: string): PlaygroundLanguage => (/\.m?ts$/i.test(path) ? 'typescript' : 'javascript')

function StopIcon(): ReactElement {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
    </svg>
  )
}

function SaveIcon(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 4h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M8 4v5h7V4M8 20v-6h8v6" />
    </svg>
  )
}

/** Code to run: the selection (padded so line numbers still match the editor) or the whole script. */
function codeToRun(view: EditorView | null, fallback: string): { code: string; selection: boolean } {
  if (!view) return { code: fallback, selection: false }
  const sel = view.state.selection.main
  if (sel.empty) return { code: view.state.doc.toString(), selection: false }
  const line = view.state.doc.lineAt(sel.from)
  const pad = '\n'.repeat(line.number - 1) + ' '.repeat(sel.from - line.from)
  return { code: pad + view.state.sliceDoc(sel.from, sel.to), selection: true }
}

function useElapsed(running: boolean): number {
  const [now, setNow] = useState(0)
  const start = useRef(0)
  useEffect(() => {
    if (!running) return
    start.current = Date.now()
    setNow(0)
    const t = setInterval(() => setNow(Date.now() - start.current), 100)
    return () => clearInterval(t)
  }, [running])
  return now
}

export function PlaygroundView({ tab }: { tab: PlaygroundTab }): ReactElement {
  const live = useStore((s) => s.live[tab.connId])
  const isActive = useStore((s) => s.activeTab === tab.id)
  const storeColls = useStore((s) => s.collections[dbKey(tab.connId, tab.db)])
  const [fetched, setFetched] = useState<Record<string, CollectionInfo[]>>({})
  const [pane, setPane] = useState<ResultPane>('result')
  // Starts at Settings → Shell & Playground → Playground runs; the menu changes it for this tab.
  const [timeoutMS, setTimeoutMS] = useState(() => useStore.getState().settings.playgroundTimeoutMS)
  const [split, setSplit] = useState(() => Math.min(0.85, Math.max(0.15, Number(lsGet(LS_SPLIT)) || 0.55)))
  const [dragging, setDragging] = useState(false)
  const [ranSelection, setRanSelection] = useState(false)
  const view = useRef<EditorView | null>(null)
  const splitBox = useRef<HTMLDivElement>(null)
  const elapsed = useElapsed(tab.running)

  const collections = storeColls ?? fetched[tab.db]
  const databases = (live?.databases ?? []).map((d) => d.name)
  if (!databases.includes(tab.db)) databases.unshift(tab.db)

  useEffect(() => {
    if (storeColls || fetched[tab.db] || !live) return
    api
      .listCollections(tab.connId, tab.db)
      .then((list) => setFetched((f) => ({ ...f, [tab.db]: list })))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connId, tab.db, !!storeColls, !!live])

  const dataRef = useRef({ collections: [] as string[], databases: [] as string[] })
  dataRef.current = { collections: (collections ?? []).map((c) => c.name), databases }

  // Restore an unsaved draft for this title (convenience only).
  useEffect(() => {
    if (tab.filePath || tab.dirty) return
    const raw = lsGet(draftKey(tab.title))
    if (!raw) return
    try {
      const d = JSON.parse(raw) as { code: string; language: PlaygroundLanguage }
      if (typeof d.code === 'string' && d.code !== tab.code) patchPlayground(tab.id, { code: d.code, language: d.language === 'typescript' ? 'typescript' : 'javascript', dirty: true })
    } catch {
      // ignore broken drafts
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  useEffect(() => {
    if (!tab.dirty || tab.filePath) return
    const t = setTimeout(() => lsSet(draftKey(tab.title), JSON.stringify({ code: tab.code, language: tab.language })), 400)
    return () => clearTimeout(t)
  }, [tab.code, tab.language, tab.dirty, tab.filePath, tab.title])

  // Stream console output of the current run, batched per frame.
  useEffect(() => {
    let buffer: PlaygroundLog[] = []
    let frame = 0
    const flush = (): void => {
      frame = 0
      const logs = buffer
      buffer = []
      patchPlayground(tab.id, (t) => (t.running ? { logs: [...t.logs, ...logs] } : {}))
    }
    const off = onEvent('playground:log', ({ runId, log }) => {
      const t = getPlayground(tab.id)
      if (!t?.running || t.runId !== runId) return
      buffer.push(log)
      if (!frame) frame = requestAnimationFrame(flush)
    })
    return () => {
      off()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [tab.id])

  const run = useCallback(async (): Promise<void> => {
    const t = getPlayground(tab.id)
    if (!t || t.running) return
    if (!useStore.getState().live[t.connId]) return toast('The connection is closed', 'error')
    const { code, selection } = codeToRun(view.current, t.code)
    if (!code.trim()) return
    const runId = crypto.randomUUID()
    setRanSelection(selection)
    patchPlayground(tab.id, { running: true, runId, logs: [], result: undefined })
    let result: PlaygroundResult
    try {
      result = await api.playgroundRun({ runId, connId: t.connId, db: t.db, code, language: t.language, timeoutMS })
    } catch (e) {
      result = { runId, ok: false, valueKind: 'undefined', logs: getPlayground(tab.id)?.logs ?? [], ms: 0, error: errorText(e) }
    }
    if (getPlayground(tab.id)?.runId !== runId) return
    patchPlayground(tab.id, { running: false, result, logs: result.logs })
    setPane(result.ok && result.valueKind === 'undefined' && result.logs.length ? 'console' : 'result')
  }, [tab.id, timeoutMS])

  const stop = (): void => {
    if (tab.runId) void api.playgroundCancel(tab.runId)
  }

  const saveAs = async (): Promise<void> => {
    const t = getPlayground(tab.id)
    if (!t) return
    const ext = t.language === 'typescript' ? 'ts' : 'js'
    const path = await api.saveFile({ title: 'Save Script', defaultPath: t.filePath ?? `${t.title.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`, filters: FILE_FILTERS })
    if (!path) return
    await write(path)
  }

  const write = async (path: string): Promise<void> => {
    const t = getPlayground(tab.id)
    if (!t) return
    try {
      await api.writeTextFile(path, t.code)
      if (!t.filePath) lsSet(draftKey(t.title), null)
      patchPlayground(tab.id, { filePath: path, title: baseName(path), dirty: false })
      toast(`Saved ${baseName(path)}`, 'success')
    } catch (e) {
      toast(`Could not save: ${errorText(e)}`, 'error')
    }
  }

  const save = (): void => {
    const t = getPlayground(tab.id)
    if (t?.filePath) void write(t.filePath)
    else void saveAs()
  }

  const open = async (): Promise<void> => {
    const paths = await api.openFile({ title: 'Open Script', filters: FILE_FILTERS })
    const path = paths?.[0]
    if (!path) return
    try {
      const code = await api.readTextFile(path)
      const t = getPlayground(tab.id)
      const language = languageOf(path)
      if (t && !t.dirty && !t.filePath && !t.running) {
        patchPlayground(tab.id, { code, language, filePath: path, title: baseName(path), dirty: false, result: undefined, logs: [] })
      } else {
        openPlaygroundTab(tab.connId, tab.db, { code, language, filePath: path, title: baseName(path) })
      }
    } catch (e) {
      toast(`Could not open ${baseName(path)}: ${errorText(e)}`, 'error')
    }
  }

  /** Inserts AI-generated code at the cursor (or over the selection); never runs it. */
  const generateCode = async (): Promise<void> => {
    const t = getPlayground(tab.id)
    if (!t) return
    const v = view.current
    const sel = v?.state.selection.main
    const code = await generateCodeDialog({ connId: t.connId, db: t.db, language: t.language, code: t.code, selection: v && sel && !sel.empty ? v.state.sliceDoc(sel.from, sel.to) : '' })
    if (code === null) return
    const cur = view.current
    if (!cur) return patchPlayground(tab.id, (x) => ({ code: `${x.code.replace(/\n*$/, '\n')}${code}\n`, dirty: true }))
    const r = cur.state.selection.main
    cur.dispatch({ changes: { from: r.from, to: r.to, insert: code }, selection: { anchor: r.from, head: r.from + code.length }, scrollIntoView: true })
    cur.focus()
  }

  const latest = useRef({ run, save, open, stop })
  latest.current = { run, save, open, stop }
  // Settings → Shortcuts → Playground (the editor handles run / save itself while it has focus).
  useCommandHandlers(isActive, {
    'playground.run': () => void run(),
    'playground.save': () => save(),
    'playground.saveAs': () => void saveAs(),
    'playground.open': () => void open(),
    'playground.stop': () => {
      if (!getPlayground(tab.id)?.running) return false
      stop()
    }
  })
  useShortcut('playground.run')

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const box = splitBox.current?.getBoundingClientRect()
    if (!box) return
    setDragging(true)
    let last = split
    const move = (ev: MouseEvent): void => {
      last = Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height))
      setSplit(last)
    }
    const up = (): void => {
      setDragging(false)
      lsSet(LS_SPLIT, String(last))
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const r = tab.result
  const errors = tab.logs.filter((l) => l.level === 'error').length
  const status = tab.running ? (
    <span className="pg-status running">
      <span className="pg-spinner" /> Running… {fmtMs(elapsed)}
    </span>
  ) : r ? (
    <span className={`pg-status ${r.ok ? 'ok' : r.cancelled ? 'stopped' : 'failed'}`}>
      {r.ok ? `Ran${ranSelection ? ' selection' : ''} in ${fmtMs(r.ms)}` : r.cancelled ? r.error : `Failed after ${fmtMs(r.ms)}`}
    </span>
  ) : null

  return (
    <div className="pg">
      <div className="crumbs">
        <Icon name="server" size={13} style={{ color: live?.color ?? 'var(--leaf)' }} />
        <span>{connName(tab.connId)}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name="database" size={13} />
        <span>{tab.db}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name="code" size={13} />
        <b>{tab.title}</b>
        {tab.dirty && <span className="badge">unsaved</span>}
        {tab.filePath && (
          <span className="faint ellipsis pg-path" title={tab.filePath}>
            {tab.filePath}
          </span>
        )}
      </div>

      <div className="pg-toolbar">
        {tab.running ? (
          <button className="btn danger" onClick={stop} title={withShortcut('Stop the script', 'playground.stop')}>
            <StopIcon /> Stop
          </button>
        ) : (
          <button className="btn primary" onClick={() => void run()} title={`${withShortcuts('Run', 'playground.run')}. Runs the selection when text is selected.`} disabled={!live}>
            <Icon name="play" size={12} /> Run
          </button>
        )}
        <div className="segmented" title="Language">
          {(['javascript', 'typescript'] as const).map((l) => (
            <button key={l} className={tab.language === l ? 'on' : ''} onClick={() => patchPlayground(tab.id, { language: l })}>
              {l === 'javascript' ? 'JavaScript' : 'TypeScript'}
            </button>
          ))}
        </div>
        <span className="pg-sep" />
        <label className="pg-field" title="Database used as `db`">
          <Icon name="database" size={13} />
          <select className="select small" value={tab.db} onChange={(e) => patchPlayground(tab.id, { db: e.target.value })} disabled={tab.running}>
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="pg-field" title="Stop the script after">
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="13" r="8" />
            <path d="M12 9v4l2.5 2.5M10 2h4" />
          </svg>
          <select className="select small" value={timeoutMS} onChange={(e) => setTimeoutMS(Number(e.target.value))}>
            {(TIMEOUTS.some(([ms]) => ms === timeoutMS) ? TIMEOUTS : [...TIMEOUTS, [timeoutMS, timeoutMS % 60_000 === 0 ? `${timeoutMS / 60_000} min` : `${+(timeoutMS / 1000).toFixed(1)} s`] as [number, string]].sort((a, b) => a[0] - b[0])).map(([ms, label]) => (
              <option key={ms} value={ms}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className="pg-sep" />
        <button className="btn ghost small" onClick={() => void open()} title={withShortcut('Open a .js / .ts file', 'playground.open')}>
          <Icon name="folder" size={14} /> Open…
        </button>
        <button className="btn ghost small" onClick={save} title={withShortcut('Save', 'playground.save')}>
          <SaveIcon /> Save
        </button>
        <button className="btn ghost small" onClick={() => void saveAs()} title={withShortcut('Save As…', 'playground.saveAs')}>
          Save As…
        </button>
        <span className="pg-sep" />
        <button className="btn ghost small" onClick={() => void generateCode()} disabled={!live || tab.running} title="Describe a script and let Claude write it (inserted, not run)">
          <Icon name="sparkle" size={13} /> Generate code…
        </button>
        <span className="spacer" />
        {status}
      </div>

      <div className={`pg-split ${dragging ? 'dragging' : ''}`} ref={splitBox}>
        <div className="pg-editor-box" style={{ height: `${split * 100}%` }}>
          <PlaygroundEditor
            value={tab.code}
            language={tab.language}
            onChange={(code) => patchPlayground(tab.id, { code, dirty: true })}
            onRun={() => void latest.current.run()}
            onSave={() => latest.current.save()}
            completionData={() => dataRef.current}
            onView={(v) => (view.current = v)}
          />
        </div>
        <div className="pg-resizer" onMouseDown={startDrag} title="Drag to resize" />
        <div className="pg-results">
          <div className="result-toolbar pg-results-bar">
            <div className="pg-tabs">
              <button className={pane === 'result' ? 'on' : ''} onClick={() => setPane('result')}>
                Result
                {r && <span className={`pg-count ${r.ok ? '' : r.cancelled ? 'warn' : 'bad'}`}>{resultSummary(r)}</span>}
              </button>
              <button className={pane === 'console' ? 'on' : ''} onClick={() => setPane('console')}>
                Console
                {tab.logs.length > 0 && <span className={`pg-count ${errors ? 'bad' : ''}`}>{tab.logs.length.toLocaleString()}</span>}
              </button>
            </div>
            <span className="spacer" />
            {pane === 'console' && tab.logs.length > 0 && (
              <>
                <button className="btn ghost small" title="Copy console output" onClick={() => void api.copyText(tab.logs.map((l) => `[${l.level}] ${l.text}`).join('\n')).then(() => toast('Console output copied', 'success'))}>
                  <Icon name="copy" size={13} /> Copy
                </button>
                <button className="btn ghost small" title="Clear console" disabled={tab.running} onClick={() => patchPlayground(tab.id, { logs: [] })}>
                  <Icon name="trash" size={13} /> Clear
                </button>
              </>
            )}
            {pane === 'result' && r?.ok && r.valueKind !== 'undefined' && (
              <button className="btn ghost small" title="Copy result as shell JSON" onClick={() => void copyResult(r)}>
                <Icon name="copy" size={13} /> Copy
              </button>
            )}
          </div>
          <div className="result-area">
            {tab.running && <div className="loading-bar" />}
            {pane === 'result' ? <ResultView tab={tab} /> : <ConsoleView logs={tab.logs} running={tab.running} />}
          </div>
        </div>
      </div>
    </div>
  )
}

async function copyResult(r: PlaygroundResult): Promise<void> {
  await api.copyText(typeof r.value === 'string' ? r.value : shellText(r.value, 2))
  toast('Result copied', 'success')
}
