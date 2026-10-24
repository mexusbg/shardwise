import type { ReactElement } from 'react'
import type { ShellConfirmRequest } from '@shared/shellOptions'
import { Modal } from '../Modal'
import { Icon } from '../Icon'

/**
 * Approve / deny dialog for a shell command that changes data (Settings → Shell & Playground → Confirm). The command waits
 * (its time limit paused) until the user answers; closing the dialog denies it.
 */
export function ShellConfirm({ req, connection, onAnswer }: { req: ShellConfirmRequest; connection: string; onAnswer: (approved: boolean) => void }): ReactElement {
  const destructive = req.level === 'destructive'
  return (
    <Modal
      title={destructive ? 'Run a destructive command?' : 'Run this write?'}
      icon="warn"
      width={560}
      onClose={() => onAnswer(false)}
      footer={
        <>
          <button className="btn" autoFocus onClick={() => onAnswer(false)} data-testid="shell-confirm-deny">
            Don&apos;t run
          </button>
          <button className={`btn ${destructive ? 'danger solid' : 'primary'}`} onClick={() => onAnswer(true)} data-testid="shell-confirm-approve">
            <Icon name="check" size={13} /> Run it
          </button>
        </>
      }
    >
      <div className="col sh-confirm" style={{ gap: 10 }}>
        <div className="selectable" style={{ lineHeight: 1.5 }}>
          <b>{req.summary}</b>
          <div className="faint" style={{ fontSize: 12 }}>
            on {connection}
          </div>
        </div>
        <pre className="sh-confirm-op selectable">{req.op}</pre>
        <div className="faint" style={{ fontSize: 12 }}>
          {destructive ? 'This cannot be undone from the shell.' : 'Asked because Settings → Shell & Playground asks before every write.'} Change when the shell asks in Settings → Shell & Playground.
        </div>
      </div>
    </Modal>
  )
}
