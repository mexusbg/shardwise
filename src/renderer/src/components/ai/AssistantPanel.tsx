import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { create } from 'zustand'
import { parseProposedQuery, fenceInfo, AGGREGATE_FENCE, FIND_FENCE } from '@shared/aiQuery'
import type { AiChatResult, AiStatus, AiStreamEvent, AiTarget, AiUsage } from '@shared/aiApi'
import type { Doc } from '@shared/api'
import { errorText, isToolTab, useStore } from '../../state/store'
import { Icon } from '../Icon'
import { openSettings } from '../SettingsDialog'
import { aiApi, onAiEvent } from './aiClient'
import { CodeBlock, Markdown } from './Markdown'
import { openFindQuery, openPipeline } from './openQuery'
import './assistant.css'

interface TextPart {
  type: 'text'
  text: string
}

interface ToolPart {
  type: 'tool'
  id: string
  name: string
  input: Doc
  status: 'running' | 'ok' | 'error'
  summary?: string
  preview?: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: (TextPart | ToolPart)[]
  target: AiTarget | null
  pending?: boolean
  stopReason?: AiChatResult['stopReason']
  note?: string
  error?: string
}

const emptyUsage = (): AiUsage => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const newChatId = (): string => `chat-${crypto.randomUUID()}`
const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const lsSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // UI preference only
  }
}

interface AssistantState {
  open: boolean
  width: number
  chatId: string
  messages: ChatMessage[]
  busy: boolean
  draft: string
  /** This chat / the whole session. */
  chatUsage: AiUsage
  sessionUsage: AiUsage | null
  toggle: () => void
  setOpen: (open: boolean) => void
}

/** Assistant panel visibility and the current conversation (kept while the panel is hidden). */
export const useAssistant = create<AssistantState>((set) => ({
  open: false,
  width: Math.min(720, Math.max(300, Number(lsGet('assistant.width')) || 400)),
  chatId: newChatId(),
  messages: [],
  busy: false,
  draft: '',
  chatUsage: emptyUsage(),
  sessionUsage: null,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open })
}))

const set = useAssistant.setState
const get = useAssistant.getState

function patchMessage(id: string, p: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)): void {
  set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...(typeof p === 'function' ? p(m) : p) } : m)) }))
}

const pendingId = (): string | undefined => get().messages.findLast((m) => m.pending)?.id

// Text deltas are batched per animation frame; tool events flush first so parts keep their order.
let textBuffer = ''
let frame = 0
function flushText(): void {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  const delta = textBuffer
  textBuffer = ''
  const id = pendingId()
  if (!delta || !id) return
  patchMessage(id, (m) => {
    const parts = [...m.parts]
    const last = parts[parts.length - 1]
    if (last?.type === 'text') parts[parts.length - 1] = { ...last, text: last.text + delta }
    else parts.push({ type: 'text', text: delta })
    return { parts }
  })
}

function onStream(e: AiStreamEvent): void {
  if (e.chatId !== get().chatId) return
  if (e.kind === 'text') {
    textBuffer += e.delta
    if (!frame) frame = requestAnimationFrame(flushText)
    return
  }
  flushText()
  const id = pendingId()
  if (e.kind === 'usage') {
    set((s) => ({
      sessionUsage: e.usage,
      chatUsage: {
        requests: s.chatUsage.requests + e.turn.requests,
        input: s.chatUsage.input + e.turn.input,
        output: s.chatUsage.output + e.turn.output,
        cacheRead: s.chatUsage.cacheRead + e.turn.cacheRead,
        cacheWrite: s.chatUsage.cacheWrite + e.turn.cacheWrite
      }
    }))
    return
  }
  if (!id) return
  if (e.kind === 'tool') {
    patchMessage(id, (m) => ({ parts: [...m.parts, { type: 'tool', id: e.id, name: e.name, input: e.input, status: 'running' }] }))
  } else {
    patchMessage(id, (m) => ({
      parts: m.parts.map((p) => (p.type === 'tool' && p.id === e.id ? { ...p, status: e.ok ? 'ok' : 'error', summary: e.summary, preview: e.preview } : p))
    }))
  }
}

onAiEvent('ai:stream', onStream)

/** The active tab's connection / database / collection. */
function currentTarget(): AiTarget | null {
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTab)
  if (tab && s.live[tab.connId]) {
    const coll = tab.kind === 'query' ? tab.coll : isToolTab(tab) ? tab.coll : undefined
    return { connId: tab.connId, db: tab.db || undefined, coll: coll || undefined }
  }
  const first = Object.keys(s.live)[0]
  return first ? { connId: first } : null
}

let seq = 0
export async function sendToAssistant(text: string): Promise<void> {
  const s = get()
  if (s.busy || !text.trim()) return
  const target = currentTarget()
  const chatId = s.chatId
  const reply: ChatMessage = { id: `m${++seq}`, role: 'assistant', parts: [], target, pending: true }
  set({ messages: [...s.messages, { id: `m${++seq}`, role: 'user', parts: [{ type: 'text', text: text.trim() }], target }, reply], busy: true, draft: '', open: true })
  try {
    const r = await aiApi.aiChatSend({ chatId, target, text: text.trim() })
    flushText()
    patchMessage(reply.id, { pending: false, stopReason: r.stopReason, note: r.note ?? (r.stopReason === 'stopped' ? 'Stopped.' : undefined) })
  } catch (e) {
    flushText()
    patchMessage(reply.id, { pending: false, error: errorText(e) })
  } finally {
    if (get().chatId === chatId) set({ busy: false })
  }
}

function newChat(): void {
  const s = get()
  void aiApi.aiChatReset(s.chatId).catch(() => {})
  textBuffer = ''
  set({ chatId: newChatId(), messages: [], busy: false, chatUsage: emptyUsage() })
}

const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const TOOL_LABELS: Record<string, string> = {
  list_databases: 'List databases',
  list_collections: 'List collections',
  collection_schema: 'Collection schema',
  find: 'Find',
  aggregate: 'Aggregate',
  count: 'Count',
  explain: 'Explain'
}

function ToolCard({ part }: { part: ToolPart }): ReactElement {
  const [open, setOpen] = useState(false)
  const ns = [part.input.db, part.input.collection].filter((x) => typeof x === 'string' && x).join('.')
  const args = Object.entries(part.input).filter(([k, v]) => k !== 'db' && k !== 'collection' && v !== '' && v !== null && v !== undefined)
  return (
    <div className={`as-tool ${part.status}`}>
      <button className="as-tool-head" onClick={() => setOpen(!open)} title={open ? 'Hide details' : 'Show arguments and result'}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
        {part.status === 'running' ? <span className="as-spinner" /> : <Icon name={part.status === 'ok' ? 'check' : 'warn'} size={12} className="as-tool-icon" />}
        <b>{TOOL_LABELS[part.name] ?? part.name}</b>
        {ns && <span className="as-tool-ns ellipsis">{ns}</span>}
        <span className="spacer" />
        <span className="as-tool-summary ellipsis" title={part.summary}>
          {part.status === 'running' ? 'running…' : part.summary}
        </span>
      </button>
      {open && (
        <div className="as-tool-body">
          {args.length > 0 && (
            <div className="as-tool-args">
              {args.map(([k, v]) => (
                <div key={k} className="as-tool-arg">
                  <span className="faint">{k}</span>
                  <code className="selectable">{typeof v === 'string' ? v : JSON.stringify(v)}</code>
                </div>
              ))}
            </div>
          )}
          {part.preview !== undefined && <pre className="as-tool-result selectable">{part.preview || '(empty)'}</pre>}
        </div>
      )}
    </div>
  )
}

function QueryFence({ info, code, closed, target }: { info: string; code: string; closed: boolean; target: AiTarget | null }): ReactElement {
  const { lang, coll } = fenceInfo(info)
  let action: ReactNode = null
  let problem: string | null = null
  if (closed && target?.db) {
    try {
      const q = parseProposedQuery(lang, code, coll)
      const db = target.db
      action =
        q.kind === 'find' ? (
          <button className="btn small md-code-action" onClick={() => openFindQuery(target.connId, db, q, target.coll)} title="Open in a new query tab and run it">
            <Icon name="play" size={10} /> Open in query tab
          </button>
        ) : (
          <button className="btn small md-code-action" onClick={() => openPipeline(target.connId, db, q, target.coll)} title="Open in the aggregation editor">
            <Icon name="aggregate" size={12} /> Open in pipeline editor
          </button>
        )
    } catch (e) {
      problem = errorText(e)
    }
  }
  const label = `${lang === FIND_FENCE ? 'find' : 'aggregate'}${coll || target?.coll ? ` · ${coll ?? target?.coll}` : ''}`
  return (
    <>
      <CodeBlock info={label} code={code} actions={action} />
      {problem && <div className="as-fence-problem">Can't open this query: {problem}</div>}
    </>
  )
}

// Memoized: typing a draft or streaming into the last answer must not re-render (and re-parse) every earlier message.
const MessageView = memo(function MessageView({ m }: { m: ChatMessage }): ReactElement {
  if (m.role === 'user') {
    return (
      <div className="as-msg user">
        <div className="as-bubble selectable">{(m.parts[0] as TextPart).text}</div>
      </div>
    )
  }
  const renderCode = (info: string, code: string, closed: boolean): ReactNode | undefined => {
    const { lang } = fenceInfo(info)
    return lang === FIND_FENCE || lang === AGGREGATE_FENCE ? <QueryFence info={info} code={code} closed={closed} target={m.target} /> : undefined
  }
  const keyError = m.error && /api key/i.test(m.error)
  return (
    <div className="as-msg assistant">
      {m.parts.map((p, i) => (p.type === 'text' ? <Markdown key={i} text={p.text} renderCode={renderCode} /> : <ToolCard key={p.id} part={p} />))}
      {m.pending && m.parts.length === 0 && (
        <div className="as-thinking">
          <span className="as-dots">
            <i />
            <i />
            <i />
          </span>
          Thinking…
        </div>
      )}
      {m.pending && m.parts.length > 0 && m.parts[m.parts.length - 1].type === 'tool' && m.parts.every((p) => p.type !== 'tool' || p.status !== 'running') && (
        <div className="as-thinking">
          <span className="as-dots">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
      {m.note && <div className={`as-note ${m.stopReason === 'refusal' ? 'warn' : ''}`}>{m.note}</div>}
      {m.error && (
        <div className="notice error as-error selectable">
          {m.error}
          {keyError && (
            <>
              {' '}
              <button className="link" onClick={() => void openSettings('ai')}>
                Open Settings
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
})

const SUGGESTIONS = {
  coll: ['Describe this collection', 'Show the 10 most recent documents', 'Which fields look like good index candidates?', 'Find documents with missing or null fields'],
  conn: ['List the databases and their sizes', 'Which collections are in this database?'],
  none: ['How do I model a one-to-many relationship?', 'Explain the ESR rule for compound indexes']
}

function Empty({ target, status }: { target: AiTarget | null; status: AiStatus | null }): ReactElement {
  return (
    <div className="as-empty">
      <div className="as-empty-icon">
        <Icon name="sparkle" size={22} />
      </div>
      <b>Ask about your data</b>
      <div className="muted">
        {target?.coll
          ? 'Questions go with the active tab’s database and collection. Proposed queries open in a query tab or the aggregation editor.'
          : target
            ? 'Open a collection to give the assistant context, or ask about any database on this connection.'
            : 'Connect to a server to let the assistant look at your data. General MongoDB questions work without one.'}
      </div>
      {status?.configured !== false && (
        <div className="as-suggestions">
          {SUGGESTIONS[target?.coll ? 'coll' : target ? 'conn' : 'none'].map((s) => (
            <button key={s} className="as-suggestion" onClick={() => void sendToAssistant(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function AssistantPanel(): ReactElement {
  const { width, messages, busy, draft, chatUsage, sessionUsage, chatId } = useAssistant()
  // Re-render when the active tab's target or the connections change: the context follows them.
  // (A string, so edits inside tabs, e.g. typing a query, do not re-render the panel.)
  useStore((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTab)
    return t ? `${t.connId}\u0000${t.db}\u0000${t.kind === 'query' ? t.coll : isToolTab(t) ? (t.coll ?? '') : ''}` : ''
  })
  const live = useStore((s) => s.live)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [tools, setTools] = useState<{ allowQueries: boolean; sendSamples: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)

  // Re-read the key status and privacy settings whenever the panel opens or Settings may have changed them.
  const refresh = (): void => {
    aiApi.aiStatus().then(setStatus, () => setStatus(null))
    aiApi.aiGetSettings().then((s) => setTools({ allowQueries: s.allowQueries, sendSamples: s.sendSamples }), () => setTools(null))
    if (!get().sessionUsage) aiApi.aiUsage().then((u) => set({ sessionUsage: u }), () => {})
  }
  useEffect(() => {
    refresh()
    input.current?.focus()
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const target = currentTarget()
  const conn = target ? live[target.connId] : undefined

  const submit = (): void => {
    stick.current = true
    if (status?.configured === false) refresh()
    void sendToAssistant(get().draft)
  }

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    setDragging(true)
    let last = width
    const move = (ev: MouseEvent): void => {
      last = Math.min(Math.max(300, window.innerWidth - ev.clientX), Math.min(900, window.innerWidth - 420))
      set({ width: last })
    }
    const up = (): void => {
      setDragging(false)
      lsSet('assistant.width', String(last))
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <aside className="as" style={{ width }}>
      <div className={`as-resizer ${dragging ? 'dragging' : ''}`} onMouseDown={startDrag} title="Drag to resize" />
      <div className="as-head">
        <Icon name="sparkle" size={15} className="as-head-icon" />
        <b>Assistant</b>
        <span className="as-context ellipsis" title={target ? `${conn?.name ?? ''} › ${target.db ?? ''}${target.coll ? `.${target.coll}` : ''}` : 'No connection'}>
          {target ? (
            <>
              <span className="conn-dot" style={{ background: conn?.color ?? 'var(--leaf)' }} />
              {target.db ? `${target.db}${target.coll ? `.${target.coll}` : ''}` : conn?.name}
            </>
          ) : (
            'No connection'
          )}
        </span>
        <span className="spacer" />
        <button className="btn ghost icon small" title="New chat" onClick={newChat} disabled={!messages.length && !busy}>
          <Icon name="plus" size={14} />
        </button>
        <button className="btn ghost icon small" title="Close the assistant" onClick={() => set({ open: false })}>
          <Icon name="close" size={14} />
        </button>
      </div>

      {status?.configured === false && (
        <div className="notice as-banner">
          {status.missingModel
            ? `Choose a model of ${status.label} to use the assistant.`
            : status.provider === 'openai'
              ? `Add the API key of ${status.label} to use the assistant.`
              : 'Set up an AI provider (Claude or an OpenAI-compatible service) to use the assistant.'}{' '}
          <button className="link" onClick={() => void openSettings('ai').then(refresh)}>
            Open Settings
          </button>
        </div>
      )}

      <div
        className="as-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {messages.length === 0 ? <Empty target={target} status={status} /> : messages.map((m) => <MessageView key={m.id} m={m} />)}
      </div>

      <div className="as-compose">
        <textarea
          ref={input}
          className="input as-input"
          rows={3}
          value={draft}
          placeholder={target?.coll ? `Ask about ${target.coll}…` : 'Ask about MongoDB or your data…'}
          onChange={(e) => set({ draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="as-compose-bar">
          <span className="faint as-hint">
            {tools ? (
              <>
                <span title={tools.allowQueries ? 'The assistant may run read-only queries (Settings → AI & automation)' : 'Query tools are off (Settings → AI & automation)'}>
                  <Icon name={tools.allowQueries ? 'search' : 'lock'} size={11} /> {tools.allowQueries ? 'read-only queries' : 'no queries'}
                </span>
                <span title={tools.sendSamples ? 'Sample values are sent with the context' : 'Only field names and types are sent with the context'}>
                  · {tools.sendSamples ? 'with sample values' : 'names & types only'}
                </span>
              </>
            ) : (
              <>Enter to send · Shift+Enter for a new line</>
            )}
          </span>
          <span className="spacer" />
          {busy ? (
            <button className="btn small danger" onClick={() => void aiApi.aiChatStop(chatId)} title="Stop the answer">
              <svg width={10} height={10} viewBox="0 0 24 24" aria-hidden>
                <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
              </svg>
              Stop
            </button>
          ) : (
            <button className="btn small primary" onClick={submit} disabled={!draft.trim()} title="Send (Enter)">
              Send
            </button>
          )}
        </div>
      </div>

      <div className="as-foot" title={`Session: ${sessionUsage?.requests ?? 0} requests · cache read ${fmtTokens(sessionUsage?.cacheRead ?? 0)} · cache write ${fmtTokens(sessionUsage?.cacheWrite ?? 0)}`}>
        <span>
          Chat {fmtTokens(chatUsage.input + chatUsage.cacheRead + chatUsage.cacheWrite)} in · {fmtTokens(chatUsage.output)} out
        </span>
        <span className="spacer" />
        <span>
          Session {fmtTokens((sessionUsage?.input ?? 0) + (sessionUsage?.cacheRead ?? 0) + (sessionUsage?.cacheWrite ?? 0))} in · {fmtTokens(sessionUsage?.output ?? 0)} out
        </span>
        <button className="btn ghost icon small" title="AI settings" onClick={() => void openSettings('ai').then(refresh)}>
          <Icon name="settings" size={12} />
        </button>
      </div>
    </aside>
  )
}
