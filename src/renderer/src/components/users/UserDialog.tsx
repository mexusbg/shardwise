import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { Doc, RoleRef, UserInfo } from '@shared/api'
import { isPlainDoc, parseShellValue, shellText } from '@shared/bsonValue'
import { api } from '../../lib/api'
import { errorText, toast } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { ErrorNotice, RolePicker, generatePassword, passwordStrength } from './common'

export interface UserDialogOpts {
  connId: string
  db: string
  user?: UserInfo
  dbs: string[]
  customRoles: RoleRef[]
  isSelf: boolean
}

function parseCustom(text: string): { value?: Doc; error?: string } {
  if (!text.trim()) return {}
  try {
    const v = parseShellValue(text)
    return isPlainDoc(v) ? { value: v } : { error: 'customData must be a document ({ … })' }
  } catch (e) {
    return { error: errorText(e) }
  }
}

function UserDialogBody({ o, done }: { o: UserDialogOpts; done: (saved: boolean) => void }): ReactElement {
  const editing = !!o.user
  const [name, setName] = useState(o.user?.user ?? '')
  const [changePw, setChangePw] = useState(!editing)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [show, setShow] = useState(false)
  const [roles, setRoles] = useState<RoleRef[]>(o.user?.roles ?? [])
  const [custom, setCustom] = useState(o.user?.customData ? shellText(o.user.customData, 2) : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const parsed = useMemo(() => parseCustom(custom), [custom])
  const strength = passwordStrength(pw)
  const mismatch = changePw && !!pw2 && pw !== pw2
  const problems = [
    !name.trim() && 'Enter a username',
    changePw && !pw && 'Enter a password',
    changePw && pw && pw !== pw2 && 'Passwords do not match',
    parsed.error && 'Fix the custom data'
  ].filter(Boolean) as string[]

  const generate = (): void => {
    const p = generatePassword()
    setPw(p)
    setPw2(p)
    setShow(true)
  }
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(pw)
      toast('Password copied to clipboard', 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const save = async (): Promise<void> => {
    if (problems.length || busy) return
    setBusy(true)
    setError(null)
    try {
      if (editing) {
        const customData = parsed.value ?? (o.user?.customData ? {} : undefined)
        await api.updateUser(o.connId, o.db, name, { roles, password: changePw ? pw : undefined, customData })
        toast(`User ${name} updated`, 'success')
      } else {
        await api.createUser(o.connId, o.db, name.trim(), pw, roles, parsed.value)
        toast(`User ${name.trim()} created`, 'success')
      }
      done(true)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={editing ? `Edit user ${o.user?.user}` : 'Add user'}
      icon="users"
      width={720}
      onClose={() => done(false)}
      escape={!busy}
      footer={
        <>
          {problems[0] && <span className="faint ur-foot-hint">{problems[0]}</span>}
          <span className="spacer" />
          <button className="btn" onClick={() => done(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!problems.length || busy} onClick={() => void save()}>
            <Icon name="check" size={13} /> {editing ? 'Save changes' : 'Create user'}
          </button>
        </>
      }
    >
      <div className="ur-form">
        {o.isSelf && (
          <div className="notice ur-notice">
            <Icon name="warn" size={15} />
            <span>
              You are connected as this user. Removing roles it relies on (such as <span className="mono">userAdmin</span>) can lock this connection out, and a new password
              must also be saved in the connection settings.
            </span>
          </div>
        )}
        {error && <ErrorNotice message={error} db={o.db} />}

        <div className="field">
          <label>Username</label>
          <div className="row">
            <input
              className="input mono grow"
              value={name}
              onChange={(e) => setName(e.target.value)}
              readOnly={editing}
              autoFocus={!editing}
              spellCheck={false}
              placeholder="e.g. app_reader"
            />
            <span className="badge" title="Users are defined on (and authenticate against) this database">
              <Icon name="database" size={11} /> {o.db}
            </span>
          </div>
        </div>

        {editing && (
          <div className="field">
            <label>Password</label>
            <label className="check">
              <input type="checkbox" checked={changePw} onChange={(e) => setChangePw(e.target.checked)} />
              Change password
            </label>
          </div>
        )}
        {changePw && (
          <>
            <div className="field">
              <label>{editing ? 'New password' : 'Password'}</label>
              <div className="row">
                <div className="ur-pw grow">
                  <input
                    className="input mono"
                    type={show ? 'text' : 'password'}
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button className={`btn ghost icon small ${show ? 'active' : ''}`} type="button" title={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)}>
                    <Icon name="view" size={13} />
                  </button>
                </div>
                <button className="btn small" type="button" onClick={generate} title="Generate a strong random password">
                  <Icon name="key" size={13} /> Generate
                </button>
                <button className="btn small icon" type="button" onClick={() => void copy()} disabled={!pw} title="Copy password">
                  <Icon name="copy" size={13} />
                </button>
              </div>
            </div>
            <div className="field">
              <label>Confirm</label>
              <input
                className={`input mono ${mismatch ? 'invalid' : ''}`}
                type={show ? 'text' : 'password'}
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
            {pw && (
              <div className="field">
                <span />
                <div className="ur-strength" data-score={strength.score}>
                  <div className="ur-strength-bar">
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} className={i < strength.score ? 'on' : ''} />
                    ))}
                  </div>
                  <span>{strength.label}</span>
                  {mismatch && <span className="error-text">· passwords do not match</span>}
                </div>
              </div>
            )}
          </>
        )}

        <div className="field top">
          <label>Roles</label>
          <div className="col">
            <RolePicker value={roles} onChange={setRoles} dbs={o.dbs} defaultDb={o.db} customRoles={o.customRoles} />
            {!roles.length && <span className="faint ur-hint">Without roles the user can authenticate but cannot read or change anything.</span>}
          </div>
        </div>

        <div className="field top">
          <label>
            Custom data
            <div className="faint ur-sublabel">optional document</div>
          </label>
          <div className="col">
            <CodeEditor value={custom} onChange={setCustom} placeholder="{ team: 'analytics' }" minHeight={70} maxHeight={180} invalid={!!parsed.error} />
            {parsed.error && <span className="error-text ur-hint">{parsed.error}</span>}
          </div>
        </div>
      </div>
    </Modal>
  )
}

export const userDialog = (o: UserDialogOpts): Promise<boolean> => openModal<boolean>((close) => <UserDialogBody o={o} done={close} />)
