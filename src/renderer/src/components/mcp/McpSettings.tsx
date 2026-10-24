import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { MCP_MAX_DOCS_LIMIT } from '@shared/mcpApi'
import type { McpLogEntry, McpSettings as Settings, McpStatus } from '@shared/mcpApi'
import { api } from '../../lib/api'
import { errorText, toast, useStore } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { claudeCommand, jsonConfig, mcpApi, onMcpEvent } from './mcpClient'
import './mcp.css'
import { fmtTime } from '../../lib/datetime'

const time = (d: Date): string => fmtTime(d)
const size = (n?: number): string => (n === undefined ? '' : n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} KB`)

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }): ReactElement {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`mcp-switch ${checked ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

function Snippet({ label, text, masked }: { label: string; text: string; masked: string }): ReactElement {
  return (
    <div className="mcp-snippet">
      <div className="mcp-snippet-head">
        <span>{label}</span>
        <button
          className="btn ghost small"
          onClick={async () => {
            await api.copyText(text)
            toast(`${label} copied (includes the token)`, 'success')
          }}
        >
          <Icon name="copy" /> Copy
        </button>
      </div>
      <pre className="mono selectable">{masked}</pre>
    </div>
  )
}

function LogRow({ e }: { e: McpLogEntry }): ReactElement {
  return (
    <div className={`mcp-log-row ${e.error ? 'err' : ''}`} title={e.error ?? e.args}>
      <span className="mcp-log-time mono">{time(e.time)}</span>
      <span className="mcp-log-tool mono">{e.tool}</span>
      <span className="mcp-log-args mono ellipsis">{e.error ?? e.args}</span>
      {e.approved !== undefined && <span className={`mcp-pill ${e.approved ? 'ok' : 'bad'}`}>{e.approved ? 'approved' : 'denied'}</span>}
      <span className="mcp-log-meta">
        {e.ms} ms{e.size !== undefined ? ` · ${size(e.size)}` : ''}
      </span>
      {e.client && <span className="mcp-log-client ellipsis">{e.client}</span>}
    </div>
  )
}

/** Settings → AI & automation → MCP server. Self-contained: changes apply immediately. */
export function McpSettings(): ReactElement {
  const [st, setSt] = useState<McpStatus | null>(null)
  const [log, setLog] = useState<McpLogEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [port, setPort] = useState('')
  const [maxDocs, setMaxDocs] = useState('')
  const connections = useStore((s) => s.connections)
  const exposed = connections.filter((c) => c.exposeToMcp)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const accept = useCallback((s: McpStatus) => {
    setSt(s)
    setPort(String(s.settings.port))
    setMaxDocs(String(s.settings.maxDocs))
  }, [])

  useEffect(() => {
    mcpApi.mcpStatus().then(accept, (e) => toast(errorText(e), 'error'))
    mcpApi.mcpLog().then(setLog, () => {})
    const off = onMcpEvent('mcp:log', (e) => {
      setLog((l) => [e, ...l].slice(0, 200))
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => mcpApi.mcpStatus().then(setSt, () => {}), 300)
    })
    return () => {
      off()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [accept])

  const configure = async (patch: Partial<Settings>): Promise<void> => {
    setBusy(true)
    try {
      accept(await mcpApi.mcpConfigure(patch))
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!st) return <div className="mcp muted">Loading MCP server settings…</div>

  const s = st.settings
  const url = st.url ?? `http://127.0.0.1:${s.port}/mcp`
  const mask = (t: string): string => (showToken ? t : t.replace(st.token, '•'.repeat(12)))

  const commitPort = (): void => {
    const n = Number(port)
    if (Number.isInteger(n) && n >= 1 && n <= 65535) {
      if (n !== s.port) void configure({ port: n })
    } else setPort(String(s.port))
  }
  const commitMaxDocs = (): void => {
    const n = Number(maxDocs)
    if (Number.isInteger(n) && n >= 1) {
      if (n !== s.maxDocs) void configure({ maxDocs: Math.min(n, MCP_MAX_DOCS_LIMIT) })
    } else setMaxDocs(String(s.maxDocs))
  }

  const regenerate = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Regenerate MCP token',
      message: 'Clients configured with the current token will stop working until you update them with the new one.',
      confirmLabel: 'Regenerate',
      danger: true
    })
    if (!ok) return
    try {
      accept(await mcpApi.mcpRegenerateToken())
      toast('New MCP token generated', 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const state = st.running ? 'on' : st.error ? 'error' : 'off'

  return (
    <div className="mcp">
      <div className="mcp-head">
        <div className="grow">
          <div className="mcp-title">Local MCP server</div>
          <div className="muted mcp-sub">Let AI agents query the connections you expose: Claude Code, Claude Desktop, Cursor, VS Code or any other MCP client. Changes apply immediately.</div>
        </div>
        <Switch label="Enable MCP server" checked={s.enabled} disabled={busy} onChange={(v) => void configure({ enabled: v })} />
      </div>

      <div className={`mcp-status ${state}`}>
        <span className="mcp-dot" />
        {st.running ? (
          <span className="grow">
            Listening on <span className="mono selectable">{st.url}</span>
            <span className="muted">
              {' '}
              · {st.sessions} session{st.sessions === 1 ? '' : 's'}
              {st.clients.length ? ` (${st.clients.join(', ')})` : ''}
            </span>
          </span>
        ) : st.error ? (
          <span className="grow">Not running: {st.error}</span>
        ) : (
          <span className="grow muted">Stopped</span>
        )}
      </div>

      <div className="field">
        <label>Port</label>
        <div className="row">
          <input
            className="input mcp-num mono"
            value={port}
            disabled={busy}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onBlur={commitPort}
            onKeyDown={(e) => e.key === 'Enter' && commitPort()}
          />
          <span className="muted">bound to 127.0.0.1 only</span>
        </div>
      </div>
      <div className="field">
        <label>Max documents</label>
        <div className="row">
          <input
            className="input mcp-num mono"
            value={maxDocs}
            disabled={busy}
            onChange={(e) => setMaxDocs(e.target.value.replace(/\D/g, ''))}
            onBlur={commitMaxDocs}
            onKeyDown={(e) => e.key === 'Enter' && commitMaxDocs()}
          />
          <span className="muted">per find / aggregate result (output is also capped at ~50 KB)</span>
        </div>
      </div>
      <div className="field">
        <label>Connections</label>
        <div className="col mcp-col">
          <label className="check">
            <input type="checkbox" checked={s.autoConnect} disabled={busy} onChange={(e) => void configure({ autoConnect: e.target.checked })} />
            Auto-connect exposed connections that aren't open in the app
          </label>
          <span className="muted">
            {exposed.length ? (
              <>
                Exposed: <b>{exposed.map((c) => c.name).join(', ')}</b>
              </>
            ) : (
              'No connection is exposed yet. Tick "Expose to MCP clients" in a connection\'s Advanced tab.'
            )}
          </span>
        </div>
      </div>
      <div className="field">
        <label>Writes</label>
        <div className="col mcp-col">
          <label className="check">
            <input type="checkbox" checked={s.allowWrites} disabled={busy} onChange={(e) => void configure({ allowWrites: e.target.checked })} />
            Allow writes (insert, update, delete, create index, $out / $merge)
          </label>
          {s.allowWrites && (
            <div className="mcp-danger">
              <Icon name="warn" /> Agents can modify data. Every write still asks for your approval here, and is denied after 60 seconds without an answer.
            </div>
          )}
        </div>
      </div>
      <div className="field">
        <label>Token</label>
        <div className="row">
          <input className="input grow mono" readOnly type={showToken ? 'text' : 'password'} value={st.token} onFocus={(e) => e.target.select()} />
          <button className="btn icon" title={showToken ? 'Hide token' : 'Show token'} onClick={() => setShowToken((v) => !v)}>
            <Icon name={showToken ? 'lock' : 'unlock'} />
          </button>
          <button
            className="btn icon"
            title="Copy token"
            onClick={async () => {
              await api.copyText(st.token)
              toast('MCP token copied', 'success')
            }}
          >
            <Icon name="copy" />
          </button>
          <button className="btn" onClick={regenerate}>
            <Icon name="refresh" /> Regenerate
          </button>
        </div>
      </div>

      <div className="mcp-section-title">Connect a client</div>
      <Snippet label="Claude Code" text={claudeCommand(url, st.token)} masked={mask(claudeCommand(url, st.token))} />
      <Snippet label="JSON config (Claude Desktop, IDEs)" text={jsonConfig(url, st.token)} masked={mask(jsonConfig(url, st.token))} />

      <div className="mcp-section-title row">
        <span className="grow">Activity</span>
        <button
          className="btn ghost small"
          disabled={!log.length}
          onClick={async () => {
            await mcpApi.mcpClearLog()
            setLog([])
          }}
        >
          <Icon name="trash" /> Clear
        </button>
      </div>
      <div className="mcp-log">
        {log.length ? log.map((e) => <LogRow key={`${e.id}-${new Date(e.time).getTime()}`} e={e} />) : <div className="mcp-log-empty muted">No MCP calls yet.</div>}
      </div>
    </div>
  )
}
