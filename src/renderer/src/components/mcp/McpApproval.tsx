import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ApprovalRequest } from '@shared/mcpApi'
import { errorText, toast } from '../../state/store'
import { Icon } from '../Icon'
import { Modal } from '../Modal'
import { mcpApi, onMcpEvent } from './mcpClient'
import './mcp.css'

const DESTRUCTIVE = new Set(['delete_documents', 'update_documents', 'aggregate'])

/** Shows MCP write-approval requests (one at a time, queued) with a countdown. Mount once in App. */
export function McpApprovalHost(): ReactElement | null {
  const [queue, setQueue] = useState<(ApprovalRequest & { receivedAt: number })[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(
    () =>
      onMcpEvent('mcp:approval', (r) => {
        setQueue((q) => [...q, { ...r, receivedAt: Date.now() }])
        setNow(Date.now())
      }),
    []
  )

  useEffect(() => {
    if (!queue.length) return
    const t = setInterval(() => {
      const n = Date.now()
      setNow(n)
      setQueue((q) => (q.some((r) => r.expiresAt <= n) ? q.filter((r) => r.expiresAt > n) : q))
    }, 250)
    return () => clearInterval(t)
  }, [queue.length])

  const current = queue[0]
  if (!current) return null

  const respond = (approved: boolean): void => {
    setQueue((q) => q.filter((r) => r.id !== current.id))
    mcpApi.mcpRespondApproval(current.id, approved).catch((e) => toast(errorText(e), 'error'))
  }

  const total = Math.max(1, current.expiresAt - current.receivedAt)
  const left = Math.max(0, current.expiresAt - now)
  const danger = DESTRUCTIVE.has(current.tool)

  return (
    <Modal
      key={current.id}
      title="MCP client wants to write data"
      icon="warn"
      width={640}
      onClose={() => respond(false)}
      footer={
        <>
          {queue.length > 1 && <span className="muted">+{queue.length - 1} more waiting</span>}
          <span className="spacer" />
          <button className="btn" autoFocus onClick={() => respond(false)}>
            Deny
          </button>
          <button className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={() => respond(true)}>
            <Icon name="check" /> Approve
          </button>
        </>
      }
    >
      <div className="mcp-approval">
        <div className="mcp-approval-lead">
          <b>{current.client || 'An MCP client'}</b> asks to <b>{current.summary.charAt(0).toLowerCase() + current.summary.slice(1)}</b>.
        </div>
        <div className="mcp-approval-grid">
          <span>Connection</span>
          <b className="ellipsis">{current.connection}</b>
          <span>Namespace</span>
          <span className="mono ellipsis selectable">
            {current.database}.{current.collection}
          </span>
          <span>Tool</span>
          <span className="mono">{current.tool}</span>
        </div>
        <pre className="mcp-approval-op mono selectable">{current.operation}</pre>
        <div className="mcp-countdown">
          <div className="mcp-countdown-bar">
            <span style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
          </div>
          <span className="muted">Denied automatically in {Math.ceil(left / 1000)} s</span>
        </div>
      </div>
    </Modal>
  )
}
