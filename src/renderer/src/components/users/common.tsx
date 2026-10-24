import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { Doc, RoleRef } from '@shared/api'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'

export const DB_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin']
export const ADMIN_ROLES = [
  'clusterMonitor',
  'readAnyDatabase',
  'readWriteAnyDatabase',
  'userAdminAnyDatabase',
  'dbAdminAnyDatabase',
  'root',
  'backup',
  'restore',
  'clusterManager',
  'hostManager',
  'clusterAdmin'
]

export const ROLE_HINTS: Record<string, string> = {
  read: 'Read data in all non-system collections',
  readWrite: 'Read and modify data in all non-system collections',
  dbAdmin: 'Schema, indexing and statistics tasks; no user management or data access',
  dbOwner: 'readWrite + dbAdmin + userAdmin on the database',
  userAdmin: 'Create and modify users and roles on the database',
  clusterMonitor: 'Read-only access to monitoring tools',
  readAnyDatabase: 'read on every database except local and config',
  readWriteAnyDatabase: 'readWrite on every database except local and config',
  userAdminAnyDatabase: 'userAdmin on every database',
  dbAdminAnyDatabase: 'dbAdmin on every database',
  root: 'Full access to every resource',
  backup: 'Privileges needed to back up data',
  restore: 'Privileges needed to restore data from backups',
  clusterManager: 'Cluster management and monitoring',
  hostManager: 'Monitor and manage servers',
  clusterAdmin: 'Greatest cluster-management access'
}

export const sameRef = (a: RoleRef, b: RoleRef): boolean => a.role === b.role && a.db === b.db
export const refKey = (r: RoleRef): string => `${r.role}@${r.db}`

export const isUnauthorized = (msg: string): boolean => /not authorized|unauthorized|requires authentication/i.test(msg)

export function ErrorNotice({ message, db }: { message: string; db: string }): ReactElement {
  if (!isUnauthorized(message)) {
    return (
      <div className="notice error ur-notice selectable">
        <Icon name="warn" size={15} />
        <span>{message}</span>
      </div>
    )
  }
  return (
    <div className="notice error ur-notice selectable">
      <Icon name="lock" size={15} />
      <div className="col" style={{ gap: 3 }}>
        <b>Permission denied</b>
        <span>
          The connected user isn't allowed to manage users and roles on <b className="mono">{db}</b>. Grant it <span className="mono">userAdmin</span> on this
          database, or <span className="mono">userAdminAnyDatabase</span> / <span className="mono">root</span> on <span className="mono">admin</span>.
        </span>
        <span className="faint ur-raw">{message.replace(/^Not authorized on "[^"]*": .*?\((.*)\)$/s, '$1')}</span>
      </div>
    </div>
  )
}

export function RoleChip({ r, onRemove, current }: { r: RoleRef; onRemove?: () => void; current?: string }): ReactElement {
  const admin = ADMIN_ROLES.includes(r.role) || r.role === 'root'
  return (
    <span className={`ur-chip ${admin ? 'admin' : ''}`} title={ROLE_HINTS[r.role] ?? `${r.role} on ${r.db}`}>
      <span className="ur-chip-role">{r.role}</span>
      {r.db !== current && <span className="ur-chip-db">@{r.db}</span>}
      {onRemove && (
        <button className="ur-chip-x" onClick={onRemove} title="Remove">
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  )
}

export function resourceLabel(res: Doc): string {
  if (res.cluster === true) return 'cluster'
  if (res.anyResource === true) return 'any resource'
  if ('db' in res || 'collection' in res) {
    const db = String(res.db ?? '') || '*'
    const coll = String(res.collection ?? '') || '*'
    return `${db}.${coll}`
  }
  return JSON.stringify(res)
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGITS = '23456789'
const SYMBOLS = '!#$*+-.=?^_~'

function randInt(n: number): number {
  const buf = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / n) * n
  do {
    crypto.getRandomValues(buf)
  } while (buf[0] >= limit)
  return buf[0] % n
}

const pick = (set: string): string => set[randInt(set.length)]

/** Strong random password; avoids look-alike characters and URI-reserved symbols. */
export function generatePassword(len = 24): string {
  const all = UPPER + LOWER + DIGITS + SYMBOLS
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)]
  while (chars.length < len) chars.push(pick(all))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1)
    const t = chars[i]
    chars[i] = chars[j]
    chars[j] = t
  }
  return chars.join('')
}

export function passwordStrength(p: string): { score: number; label: string } {
  if (!p) return { score: 0, label: '' }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length
  let score = 0
  if (p.length >= 8) score++
  if (p.length >= 12) score++
  if (p.length >= 16 && classes >= 3) score++
  if (classes >= 3) score++
  if (p.length < 8) score = Math.min(score, 1)
  return { score, label: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][score] }
}

function TypeConfirmBody(p: { title: string; message: ReactNode; expected: string; confirmLabel: string; done: (ok: boolean) => void }): ReactElement {
  const [v, setV] = useState('')
  const ok = v === p.expected
  return (
    <Modal
      title={p.title}
      icon="warn"
      width={480}
      onClose={() => p.done(false)}
      footer={
        <>
          <button className="btn" onClick={() => p.done(false)}>
            Cancel
          </button>
          <button className="btn danger solid" disabled={!ok} onClick={() => p.done(true)}>
            {p.confirmLabel}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12, lineHeight: 1.55 }}>
        <div className="selectable">{p.message}</div>
        <label className="col" style={{ gap: 5 }}>
          <span className="muted">
            Type <b className="mono ur-expect">{p.expected}</b> to confirm
          </span>
          <input className="input mono" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok && p.done(true)} spellCheck={false} />
        </label>
      </div>
    </Modal>
  )
}

export const typeToConfirm = (o: { title: string; message: ReactNode; expected: string; confirmLabel: string }): Promise<boolean> =>
  openModal<boolean>((close) => <TypeConfirmBody {...o} done={close} />)

interface PickerProps {
  value: RoleRef[]
  onChange: (v: RoleRef[]) => void
  dbs: string[]
  defaultDb: string
  customRoles: RoleRef[]
  exclude?: RoleRef
}

/** Multi-picker for role grants: built-in roles on a chosen database, admin-only roles, custom roles, or any role by name. */
export function RolePicker({ value, onChange, dbs, defaultDb, customRoles, exclude }: PickerProps): ReactElement {
  const [target, setTarget] = useState(defaultDb)
  const [otherRole, setOtherRole] = useState('')
  const [otherDb, setOtherDb] = useState(defaultDb)
  const has = (r: RoleRef): boolean => value.some((x) => sameRef(x, r))
  const toggle = (r: RoleRef): void => onChange(has(r) ? value.filter((x) => !sameRef(x, r)) : [...value, r])
  const addOther = (): void => {
    const r = { role: otherRole.trim(), db: otherDb.trim() || defaultDb }
    if (!r.role) return
    if (!has(r)) onChange([...value, r])
    setOtherRole('')
  }
  const opt = (r: RoleRef, hint?: string): ReactElement => (
    <button key={refKey(r)} type="button" className={`ur-opt ${has(r) ? 'on' : ''}`} onClick={() => toggle(r)} title={hint ?? ROLE_HINTS[r.role]}>
      {has(r) && <Icon name="check" size={11} />}
      {r.role}
    </button>
  )
  const custom = customRoles.filter((r) => !exclude || !sameRef(r, exclude))
  const allDbs = [...new Set([target, ...dbs])]
  return (
    <div className="ur-picker">
      <div className="ur-picker-sel">
        {value.length ? (
          value.map((r) => <RoleChip key={refKey(r)} r={r} onRemove={() => toggle(r)} />)
        ) : (
          <span className="faint">No roles selected</span>
        )}
      </div>
      <div className="ur-picker-groups">
        <div className="ur-picker-group">
          <div className="ur-picker-label">
            Database roles on
            <select className="select small" value={target} onChange={(e) => setTarget(e.target.value)}>
              {allDbs.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="ur-opts">{DB_ROLES.map((role) => opt({ role, db: target }))}</div>
        </div>
        <div className="ur-picker-group">
          <div className="ur-picker-label">
            Cluster &amp; all-database roles <span className="faint">· granted on admin</span>
          </div>
          <div className="ur-opts">{ADMIN_ROLES.map((role) => opt({ role, db: 'admin' }))}</div>
        </div>
        {custom.length > 0 && (
          <div className="ur-picker-group">
            <div className="ur-picker-label">Custom roles</div>
            <div className="ur-opts">{custom.map((r) => opt(r, `Custom role ${r.role}@${r.db}`))}</div>
          </div>
        )}
        <div className="ur-picker-group">
          <div className="ur-picker-label">Other role</div>
          <div className="row">
            <input
              className="input small mono grow"
              placeholder="role name"
              value={otherRole}
              onChange={(e) => setOtherRole(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addOther())}
            />
            <span className="faint">@</span>
            <input className="input small mono" style={{ width: 140 }} list="ur-picker-dbs" value={otherDb} onChange={(e) => setOtherDb(e.target.value)} />
            <datalist id="ur-picker-dbs">
              {dbs.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            <button type="button" className="btn small" disabled={!otherRole.trim()} onClick={addOther}>
              <Icon name="plus" size={12} /> Add
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
