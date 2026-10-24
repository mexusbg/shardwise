import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { EditorView } from '@codemirror/view'
import type { PlaygroundLog } from '@shared/api'
import { parseCommand } from '@shared/shell'
import type { ShellResult } from '@shared/shell'
import { dedupeHistory, historyStorageKey, printOptions, pushHistory, SHELL_HISTORY_MAX, trimHistory } from '@shared/shellOptions'
import type { ShellConfirmRequest, ShellEvalOptions, ShellOpenResult, ShellStartupReport } from '@shared/shellOptions'
import { getDataDateDisplay } from '@shared/dateFormat'
import { api, onEvent } from '../../lib/api'
import { useCommandHandlers, useShortcut, withShortcut } from '../../lib/commands'
import { closeTab, connName, dbKey, errorText, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { EntryView, fmtMs, OutputPrefsContext } from './ShellOutput'
import type { CmdEntry, Entry, OutputPrefs } from './ShellOutput'
import { ShellInput } from './ShellInput'
import { ShellConfirm } from './ShellConfirm'
import { SHELL_HISTORY_CLEARED } from './shellHistory'
import { openInMongosh } from './openInMongosh'
import './shell.css'

const MAX_ENTRIES = 300
const TIMEOUTS: [number, string][] = [
  [0, 'No timeout'],
  [10_000, '10 s'],
  [30_000, '30 s'],
  [120_000, '2 min'],
  [600_000, '10 min']
]

type Status = 'connecting' | 'ready' | 'running' | 'lost'

function loadHistory(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(v) ? trimHistory(v.filter((x): x is string => typeof x === 'string'), SHELL_HISTORY_MAX) : []
  } catch {
    return []
  }
}

function saveHistory(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // storage unavailable
  }
}

/** A time limit label for values not in the menu (set in Settings). */
const timeoutLabel = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${+(ms / 1000).toFixed(1)} s`)

function useElapsed(running: boolean): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!running) return
    const start = Date.now()
    setNow(0)
    const t = setInterval(() => setNow(Date.now() - start), 100)
    return () => clearInterval(t)
  }, [running])
  return now
}

function StopIcon(): ReactElement {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
    </svg>
  )
}

export function ShellView({ tab }: { tab: ToolTab }): ReactElement {
  const live = useStore((s) => s.live[tab.connId])
  const isActive = useStore((s) => s.activeTab === tab.id)
  const [db, setDb] = useState(tab.db)
  const storeColls = useStore((s) => s.collections[dbKey(tab.connId, db)])
  const [fetched, setFetched] = useState<Record<string, string[]>>({})
  const [entries, setEntries] = useState<Entry[]>([])
  const [status, setStatus] = useState<Status>('connecting')
  const settings = useStore((s) => s.settings)
  const [timeoutMS, setTimeoutMS] = useState(settings.shellTimeoutMS)
  const [ask, setAsk] = useState<ShellConfirmRequest | null>(null)
  const elapsed = useElapsed(status === 'running')

  const session = useRef<string | null>(null)
  const generation = useRef(0)
  const seq = useRef(0)
  const runningId = useRef<number | null>(null)
  const lastCmdId = useRef<number | null>(null)
  /** Streamed lines waiting for the next frame, per entry. */
  const logBuffer = useRef(new Map<number, PlaygroundLog[]>())
  /** Lines received per running entry, and late copies to drop once the result (which carries them) is in. */
  const streamed = useRef(new Map<number, number>())
  const skip = useRef(new Map<number, number>())
  const view = useRef<EditorView | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const dbRef = useRef(db)
  dbRef.current = db

  const histKey = historyStorageKey(settings.shellHistoryScope, live?.configId ?? tab.connId)
  const hist = useRef<{ key: string; list: string[]; index: number; draft: string }>({ key: '', list: [], index: 0, draft: '' })
  if (hist.current.key !== histKey) {
    const list = trimHistory(loadHistory(histKey), settings.shellHistoryLimit)
    hist.current = { key: histKey, list, index: list.length, draft: '' }
  }
  const histOpts = useRef({ limit: settings.shellHistoryLimit, dedupe: settings.shellHistoryDedupe })
  histOpts.current = { limit: settings.shellHistoryLimit, dedupe: settings.shellHistoryDedupe }

  // Settings → Shell & Playground → Clear history.
  useEffect(() => {
    const onClear = (): void => {
      hist.current = { ...hist.current, list: [], index: 0, draft: '' }
    }
    window.addEventListener(SHELL_HISTORY_CLEARED, onClear)
    return () => window.removeEventListener(SHELL_HISTORY_CLEARED, onClear)
  }, [])

  const outputPrefs = useMemo<OutputPrefs>(
    () => ({ print: printOptions(settings), maxLines: settings.shellMaxOutputLines, maxChars: settings.shellMaxOutputChars }),
    [settings]
  )
  /** Options sent with every command (the date display may change while the tab is open). */
  const evalOptions = (): ShellEvalOptions => ({
    batchSize: settings.shellBatchSize,
    confirm: settings.shellConfirm,
    print: printOptions(settings, settings.shellDateDisplay === 'data' ? getDataDateDisplay() : undefined)
  })

  const databases = (live?.databases ?? []).map((d) => d.name)
  if (!databases.includes(db)) databases.unshift(db)
  const collections = fetched[db] ?? storeColls?.map((c) => c.name) ?? []
  const dataRef = useRef({ collections, databases })
  dataRef.current = { collections, databases }

  const refreshCollections = useCallback(
    (name: string) => {
      api
        .listCollections(tab.connId, name)
        .then((list) => setFetched((f) => ({ ...f, [name]: list.map((c) => c.name) })))
        .catch(() => {})
    },
    [tab.connId]
  )

  useEffect(() => {
    if (!storeColls && !fetched[db] && live) refreshCollections(db)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, !!live])

  const push = useCallback((e: Entry | Entry[]) => {
    setEntries((list) => {
      const next = list.concat(e)
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    })
  }, [])

  const patchEntry = useCallback((id: number, p: (e: CmdEntry) => Partial<CmdEntry>) => {
    setEntries((list) => list.map((e) => (e.id === id && e.kind === 'cmd' ? { ...e, ...p(e) } : e)))
  }, [])

  const sys = useCallback((level: 'info' | 'warn' | 'error', text: string, reconnect = false) => push({ kind: 'sys', id: ++seq.current, level, text, reconnect }), [push])
  const showStartup = useCallback((reports?: ShellStartupReport[]) => {
    if (reports?.length) push({ kind: 'startup', id: ++seq.current, reports })
  }, [push])

  const openSession = useCallback(
    async (name: string, greet: boolean): Promise<void> => {
      const gen = ++generation.current
      setStatus('connecting')
      try {
        const opened = (await api.shellOpen(tab.connId, name)) as ShellOpenResult
        const id = opened.sessionId
        if (gen !== generation.current) {
          void api.shellClose(id).catch(() => {})
          return
        }
        session.current = id
        setStatus('ready')
        if (greet) sys('info', `Connected to ${connName(tab.connId)}${live?.serverVersion ? ` (MongoDB ${live.serverVersion})` : ''}. Type help for commands.`)
        showStartup(opened.startup)
      } catch (e) {
        if (gen !== generation.current) return
        setStatus('lost')
        sys('error', `Could not start the shell: ${errorText(e)}`, true)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.connId, sys, showStartup]
  )

  const closeSession = useCallback(() => {
    generation.current++
    const id = session.current
    session.current = null
    runningId.current = null
    setAsk(null)
    if (id) void api.shellClose(id).catch(() => {})
  }, [])

  useEffect(() => {
    void openSession(tab.db, true)
    return closeSession
  }, [openSession, closeSession, tab.db])

  // Console output of the running command, batched per frame.
  useEffect(() => {
    let frame = 0
    const flush = (): void => {
      frame = 0
      const pending = logBuffer.current
      logBuffer.current = new Map()
      for (const [id, logs] of pending) patchEntry(id, (e) => ({ logs: [...e.logs, ...logs] }))
    }
    const off = onEvent('shell:log', ({ sessionId, log }) => {
      if (sessionId !== session.current) return
      const running = runningId.current
      const id = running ?? lastCmdId.current
      if (id === null) return
      if (running !== null) {
        streamed.current.set(id, (streamed.current.get(id) ?? 0) + 1)
      } else {
        const n = skip.current.get(id) ?? 0
        if (n > 0) return void skip.current.set(id, n - 1)
      }
      const list = logBuffer.current.get(id) ?? []
      list.push(log)
      logBuffer.current.set(id, list)
      if (!frame) frame = requestAnimationFrame(flush)
    })
    return () => {
      off()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [patchEntry])

  // Approval requests of the running command (Settings → Shell & Playground → Confirm).
  useEffect(() => {
    return onEvent('shell:confirm', (req) => {
      if (req.sessionId === session.current) setAsk(req)
    })
  }, [])

  const answer = (approved: boolean): void => {
    const req = ask
    setAsk(null)
    if (req) void api.shellConfirmReply(req.sessionId, req.id, approved).catch(() => {})
  }

  const clear = useCallback(() => {
    setEntries((list) => list.filter((e) => e.kind === 'cmd' && e.running))
  }, [])

  const reconnect = useCallback(() => {
    closeSession()
    void openSession(dbRef.current, false).then(() => {
      if (session.current) sys('info', 'Reconnected. Variables from the previous session are gone.')
    })
  }, [closeSession, openSession, sys])

  const resetSession = (): void => {
    closeSession()
    sys('info', 'Session reset: variables were cleared.')
    void openSession(dbRef.current, false)
  }

  const remember = (code: string): void => {
    const h = hist.current
    // Another shell may have added to a shared (or the same connection's) history meanwhile.
    const stored = loadHistory(h.key)
    const base = stored.length >= h.list.length ? stored : h.list
    const o = histOpts.current
    h.list = pushHistory(o.dedupe ? dedupeHistory(base) : base, code, o)
    h.index = h.list.length
    h.draft = ''
    saveHistory(h.key, h.list)
  }

  const run = (code: string): boolean => {
    if (status === 'running' || status === 'connecting') return false
    remember(code)
    stick.current = true
    const cmd = parseCommand(code)
    if (cmd?.kind === 'cls') {
      clear()
      return true
    }
    if (cmd?.kind === 'exit') {
      closeTab(tab.id)
      return true
    }
    const id = session.current
    if (!id || status === 'lost') {
      sys('error', 'The shell is not connected.', true)
      return false
    }
    const entryId = ++seq.current
    runningId.current = entryId
    lastCmdId.current = entryId
    push({ kind: 'cmd', id: entryId, code, db: dbRef.current, logs: [], running: true })
    setStatus('running')
    const gen = generation.current
    void api
      .shellEval(id, code, timeoutMS, evalOptions())
      .then((r) => r as ShellResult)
      .catch((e): ShellResult => ({ runId: id, ok: false, valueKind: 'undefined', logs: [], ms: 0, error: errorText(e), lost: /closed/i.test(errorText(e)) }))
      .then((r) => {
        if (gen !== generation.current) return
        runningId.current = null
        setAsk(null)
        // The result carries every line logged before it: drop what still waits for a frame, and skip the
        // copies whose events arrive after the reply.
        logBuffer.current.delete(entryId)
        skip.current.clear()
        skip.current.set(entryId, Math.max(0, r.logs.length - (streamed.current.get(entryId) ?? 0)))
        streamed.current.clear()
        patchEntry(entryId, () => ({ running: false, result: r, logs: r.logs }))
        showStartup(r.startup)
        if (r.db && r.db !== dbRef.current) setDb(r.db)
        if (r.lost) {
          setStatus('lost')
          sys('error', 'The shell lost its connection to the server.', true)
        } else {
          setStatus('ready')
        }
        if (r.ok && !/^\s*(it|show\s|help)/.test(code)) refreshCollections(r.db ?? dbRef.current)
      })
    return true
  }

  const interrupt = (): void => {
    if (status === 'running' && session.current) void api.shellInterrupt(session.current).catch(() => {})
  }

  const onHistory = (dir: -1 | 1, current: string): string | null => {
    const h = hist.current
    if (dir < 0) {
      if (h.index <= 0) return null
      if (h.index === h.list.length) h.draft = current
      h.index--
      return h.list[h.index]
    }
    if (h.index >= h.list.length) return null
    h.index++
    return h.index === h.list.length ? h.draft : h.list[h.index]
  }

  const rerun = useCallback((code: string) => {
    const v = view.current
    if (!v) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: code }, selection: { anchor: code.length } })
    v.focus()
  }, [])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [entries])

  useEffect(() => {
    if (isActive) requestAnimationFrame(() => view.current?.focus())
  }, [isActive])

  // Outside the input (Settings → Shortcuts → Shell); the input handles the same commands itself.
  useCommandHandlers(isActive, {
    'shell.interrupt': () => {
      // Copying selected output keeps working.
      if (window.getSelection()?.toString()) return false
      interrupt()
    },
    'shell.clear': () => clear()
  })
  useShortcut('shell.clear')

  const running = status === 'running'
  const statusEl =
    status === 'connecting' ? (
      <span className="sh-status">
        <span className="sh-spinner" /> Connecting…
      </span>
    ) : status === 'running' ? (
      <span className="sh-status running">
        <span className="sh-spinner" /> Running… {fmtMs(elapsed)}
      </span>
    ) : status === 'lost' ? (
      <span className="sh-status lost">
        <span className="sh-dot" /> Disconnected
      </span>
    ) : (
      <span className="sh-status ok">
        <span className="sh-dot" /> Ready
      </span>
    )

  return (
    <div className="sh">
      <div className="crumbs">
        <Icon name="server" size={13} style={{ color: live?.color ?? 'var(--leaf)' }} />
        <span>{connName(tab.connId)}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name="database" size={13} />
        <span className="sh-db">{db}</span>
        <Icon name="chevronRight" size={11} />
        <Icon name="terminal" size={13} />
        <b>{tab.title}</b>
      </div>
      <div className="sh-toolbar">
        <button className="btn danger small" onClick={interrupt} disabled={!running} title={`${withShortcut('Interrupt the running command', 'shell.interrupt')}. The session restarts and variables are reset.`}>
          <StopIcon /> Stop
        </button>
        <button className="btn ghost small" onClick={clear} title={withShortcut('Clear the screen', 'shell.clear')}>
          <Icon name="trash" size={13} /> Clear
        </button>
        <button className="btn ghost small" onClick={resetSession} disabled={status === 'connecting'} title="Start a fresh session: variables are cleared">
          <Icon name="refresh" size={13} /> Reset session
        </button>
        <button className="btn ghost small" onClick={() => void openInMongosh(tab.connId, db)} title="Open this database in the external mongosh, in a terminal window">
          <Icon name="terminal" size={13} /> mongosh
        </button>
        <span className="sh-sep" />
        <label className="sh-field" title="Interrupt commands running longer than">
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="13" r="8" />
            <path d="M12 9v4l2.5 2.5M10 2h4" />
          </svg>
          <select className="select small" value={timeoutMS} onChange={(e) => setTimeoutMS(Number(e.target.value))}>
            {(TIMEOUTS.some(([ms]) => ms === timeoutMS) ? TIMEOUTS : [...TIMEOUTS, [timeoutMS, timeoutLabel(timeoutMS)] as [number, string]].sort((a, b) => a[0] - b[0])).map(([ms, label]) => (
              <option key={ms} value={ms}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {statusEl}
      </div>
      <div className="sh-body">
        {running && <div className="loading-bar" />}
        <div
          className="sh-scroll selectable"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
          }}
          onMouseUp={(e) => {
            if (e.target === e.currentTarget && !window.getSelection()?.toString()) view.current?.focus()
          }}
        >
          <OutputPrefsContext.Provider value={outputPrefs}>
            {entries.map((e) => (
              <EntryView key={e.id} entry={e} elapsed={e.kind === 'cmd' && e.running ? elapsed : 0} onReconnect={reconnect} onRerun={rerun} />
            ))}
          </OutputPrefsContext.Provider>
        </div>
      </div>
      <ShellInput
        prompt={db}
        running={running}
        disabled={status === 'connecting' || status === 'lost'}
        onRun={run}
        onHistory={onHistory}
        onClear={clear}
        onInterrupt={interrupt}
        completionData={() => dataRef.current}
        onView={(v) => (view.current = v)}
      />
      {ask && <ShellConfirm req={ask} connection={connName(tab.connId)} onAnswer={answer} />}
    </div>
  )
}
