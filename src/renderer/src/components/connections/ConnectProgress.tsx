import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnectStep } from '@shared/api'
import { Icon } from '../Icon'
import { endAttempt, useConnectAttempts } from '../../state/connectProgress'
import type { ConnectAttempt } from '../../state/connectProgress'
import { cancelConnect, connect, reloadConnections, useStore } from '../../state/store'
import { editConnection } from './ConnectionEditor'

const LABELS: Record<string, string> = {
  Proxy: 'Reach the proxy',
  'SSH tunnel': 'Open the SSH tunnel',
  Connect: 'Connect to the server',
  'Server info': 'Read the server version',
  Databases: 'Load the databases'
}

const DEFAULT_SELECTION_TIMEOUT = 15000

/** Stages reported so far, then the ones still to come (greyed). */
function stagesOf(a: ConnectAttempt, ssh: boolean): (ConnectStep | { name: string; state: 'pending'; detail?: string })[] {
  const planned = [...(ssh ? ['SSH tunnel'] : []), 'Connect', 'Server info', 'Databases']
  const seen = new Set(a.steps.map((s) => s.name))
  return [...a.steps, ...planned.filter((n) => !seen.has(n)).map((name) => ({ name, state: 'pending' as const }))]
}

const elapsedText = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function StageIcon({ state }: { state: ConnectStep['state'] | 'pending' }): ReactElement {
  if (state === 'running') return <span className="cnp-spinner" aria-hidden />
  if (state === 'ok') return <Icon name="check" size={14} />
  if (state === 'failed') return <Icon name="close" size={14} />
  return <span className="cnp-pending" aria-hidden />
}

function AttemptCard({ a }: { a: ConnectAttempt }): ReactElement {
  const cfg = useStore((s) => s.connections.find((c) => c.id === a.configId))
  const [now, setNow] = useState(Date.now())
  const running = a.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const stages = stagesOf(a, !!cfg?.ssh.enabled)
  const done = stages.filter((s) => s.state === 'ok').length
  const current = stages.find((s) => s.state === 'running')
  const elapsed = now - a.startedAt
  const timeout = cfg?.options.serverSelectionTimeoutMS || DEFAULT_SELECTION_TIMEOUT
  const slow = running && current?.name === 'Connect' && elapsed > 4000

  const retry = (): void => {
    endAttempt(a.id)
    void connect(a.configId)
  }
  const edit = async (): Promise<void> => {
    endAttempt(a.id)
    if (!cfg) return
    if (await editConnection(cfg)) {
      await reloadConnections()
      void connect(a.configId)
    }
  }
  const titleId = `${a.id}-title`

  return (
    <section className={`cnp-card${running ? '' : ' failed'}`} role={running ? 'dialog' : 'alertdialog'} aria-modal aria-labelledby={titleId} aria-busy={running}>
      <div className="cnp-head">
        <span className="cnp-icon" style={a.color ? { color: a.color } : undefined}>
          <Icon name="server" size={18} />
        </span>
        <div className="cnp-heading">
          <div className="cnp-title ellipsis" id={titleId} title={a.name}>
            {running ? `Connecting to ${a.name}` : `Could not connect to ${a.name}`}
          </div>
          {a.servers && (
            <div className="cnp-sub faint mono ellipsis" title={a.servers}>
              {a.servers}
            </div>
          )}
        </div>
      </div>
      <div className="progress cnp-bar" role="progressbar" aria-label="Connection progress" aria-valuemin={0} aria-valuemax={stages.length} aria-valuenow={done}>
        <div style={{ width: `${Math.max(6, ((done + (current || !running ? 0.5 : 0)) / stages.length) * 100)}%` }} />
      </div>
      <ol className="cnp-steps" aria-live="polite">
        {/* After a failure nothing else runs: the stages that never started are not listed. */}
        {stages.filter((s) => running || s.state !== 'pending').map((s) => (
          <li key={s.name} className={`cnp-step ${s.state}`}>
            <StageIcon state={s.state} />
            <span className="cnp-label">{LABELS[s.name] ?? s.name}</span>
            {s.detail && s.state !== 'failed' && s.name !== 'Connect' && (
              <span className="cnp-detail faint ellipsis" title={s.detail}>
                {s.detail}
              </span>
            )}
          </li>
        ))}
      </ol>
      {slow && <div className="cnp-hint faint">Waiting for the server to answer. Gives up after {Math.round(timeout / 1000)} s.</div>}
      {!running && a.error && <div className="notice error cnp-error selectable">{a.error}</div>}
      <div className="cnp-foot">
        <span className="faint cnp-elapsed">{running ? elapsedText(elapsed) : ''}</span>
        <span className="spacer" />
        {running ? (
          <button className="btn" data-autofocus onClick={() => cancelConnect(a.id)}>
            Cancel
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => endAttempt(a.id)}>
              Close
            </button>
            {cfg && (
              <button className="btn" onClick={() => void edit()}>
                <Icon name="edit" size={13} /> Edit connection
              </button>
            )}
            <button className="btn primary" data-autofocus onClick={retry}>
              <Icon name="refresh" size={13} /> Retry
            </button>
          </>
        )}
      </div>
    </section>
  )
}

/** "Connecting to …" dialog: each stage of opening a connection, Cancel while it runs, Retry / Edit when it fails. */
export function ConnectProgressHost(): ReactElement | null {
  const all = useConnectAttempts((s) => s.list)
  const list = useMemo(() => all.filter((a) => a.visible), [all])
  const ref = useRef<HTMLDivElement>(null)
  const key = list.map((a) => `${a.id}:${a.status}`).join(',')
  // Focus the newest card's main button (Cancel, or Retry after a failure).
  useEffect(() => {
    const btns = ref.current?.querySelectorAll<HTMLElement>('[data-autofocus]')
    btns?.[btns.length - 1]?.focus()
  }, [key])
  useEffect(() => {
    if (!list.length) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('.modal')) return
      const top = list[list.length - 1]
      e.stopPropagation()
      if (top.status === 'running') cancelConnect(top.id)
      else endAttempt(top.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [list])
  if (!list.length) return null
  return (
    <div className="cnp-backdrop" ref={ref}>
      <div className="cnp-stack">
        {list.map((a) => (
          <AttemptCard key={a.id} a={a} />
        ))}
      </div>
    </div>
  )
}
