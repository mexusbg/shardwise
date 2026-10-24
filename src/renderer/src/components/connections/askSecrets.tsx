import { useState } from 'react'
import type { ReactElement } from 'react'
import { secretsToAsk } from '@shared/connection'
import type { ConnectionConfig, PromptedSecrets } from '@shared/connection'
import { Modal, openModal } from '../Modal'

function SecretsBody({ cfg, onDone }: { cfg: ConnectionConfig; onDone: (s: PromptedSecrets | null) => void }): ReactElement {
  const ask = secretsToAsk(cfg)
  const [password, setPassword] = useState('')
  const [ssh, setSsh] = useState('')
  const submit = (): void => {
    const s: PromptedSecrets = {}
    if (ask.password) s.password = password
    if (ask.ssh === 'password') s.sshPassword = ssh
    if (ask.ssh === 'passphrase') s.sshPassphrase = ssh
    onDone(s)
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') submit()
  }
  return (
    <Modal
      title={`Connect to ${cfg.name}`}
      icon="lock"
      width={420}
      onClose={() => onDone(null)}
      footer={
        <>
          <button className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            Connect
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <div className="muted">This connection asks for its credentials every time. They are used for this session only and are not saved.</div>
        {ask.password && (
          <label className="col" style={{ gap: 4 }}>
            <span>
              Password{cfg.auth.username ? <span className="faint"> for {cfg.auth.username}</span> : null}
            </span>
            <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={onKey} data-secret="password" />
          </label>
        )}
        {ask.ssh && (
          <label className="col" style={{ gap: 4 }}>
            <span>
              {ask.ssh === 'password' ? 'SSH password' : 'SSH key passphrase'}
              {cfg.ssh.username || cfg.ssh.host ? (
                <span className="faint">
                  {' '}
                  for {cfg.ssh.username ? `${cfg.ssh.username}@` : ''}
                  {cfg.ssh.host ?? ''}
                </span>
              ) : null}
            </span>
            <input className="input" type="password" autoFocus={!ask.password} value={ssh} onChange={(e) => setSsh(e.target.value)} onKeyDown={onKey} data-secret="ssh" />
          </label>
        )}
      </div>
    </Modal>
  )
}

/**
 * Asks for the secrets a connection does not save. Resolves with nothing to add ({}) when it asks for none, or
 * null when the user cancels.
 */
export function askSecrets(cfg: ConnectionConfig): Promise<PromptedSecrets | null> {
  const ask = secretsToAsk(cfg)
  if (!ask.password && !ask.ssh) return Promise.resolve({})
  return openModal<PromptedSecrets | null>((close) => <SecretsBody cfg={cfg} onDone={close} />)
}
