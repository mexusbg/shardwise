import { useState } from 'react'
import type { ReactElement } from 'react'
import type { Doc, Privilege, RoleInfo, RoleRef } from '@shared/api'
import { shellText } from '@shared/bsonValue'
import { api } from '../../lib/api'
import { errorText, toast } from '../../state/store'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { ErrorNotice, RolePicker, resourceLabel } from './common'

const NS_ACTIONS: [string, string[]][] = [
  ['Read & write', ['find', 'insert', 'update', 'remove', 'bypassDocumentValidation', 'changeStream']],
  ['Collections & indexes', ['createCollection', 'dropCollection', 'renameCollectionSameDB', 'collMod', 'createIndex', 'dropIndex', 'convertToCapped', 'compact']],
  ['Inspection', ['listCollections', 'listIndexes', 'collStats', 'dbStats', 'dbHash', 'indexStats', 'validate', 'planCacheRead', 'killCursors']],
  ['Administration', ['enableProfiler', 'createUser', 'dropUser', 'grantRole', 'revokeRole', 'viewUser', 'viewRole', 'dropDatabase']]
]
const CLUSTER_ACTIONS: [string, string[]][] = [
  ['Monitoring', ['serverStatus', 'listDatabases', 'hostInfo', 'getCmdLineOpts', 'getLog', 'top', 'inprog', 'connPoolStats', 'replSetGetStatus', 'replSetGetConfig']],
  ['Management', ['killop', 'killAnyCursor', 'fsync', 'logRotate', 'setParameter', 'getParameter', 'shutdown', 'replSetConfigure', 'addShard', 'listShards', 'flushRouterConfig']]
]

type Kind = 'ns' | 'cluster' | 'raw'

interface Draft {
  id: number
  kind: Kind
  db: string
  coll: string
  raw: Doc
  actions: string[]
}

let seq = 0

function toDraft(p: Privilege): Draft {
  const r = p.resource
  const base = { id: ++seq, db: '', coll: '', raw: r, actions: [...p.actions] }
  if (r.cluster === true) return { ...base, kind: 'cluster' }
  const keys = Object.keys(r)
  if (keys.every((k) => k === 'db' || k === 'collection') && typeof (r.db ?? '') === 'string' && typeof (r.collection ?? '') === 'string')
    return { ...base, kind: 'ns', db: String(r.db ?? ''), coll: String(r.collection ?? '') }
  return { ...base, kind: 'raw' }
}

function toPrivilege(d: Draft): Privilege {
  const resource = d.kind === 'cluster' ? { cluster: true } : d.kind === 'ns' ? { db: d.db.trim(), collection: d.coll.trim() } : d.raw
  return { resource, actions: d.actions }
}

function PrivilegeCard(p: { d: Draft; roleDb: string; onChange: (d: Draft) => void; onRemove: () => void; index: number }): ReactElement {
  const { d } = p
  const [extra, setExtra] = useState('')
  const groups = d.kind === 'cluster' ? CLUSTER_ACTIONS : NS_ACTIONS
  const known = new Set(groups.flatMap(([, a]) => a))
  const others = d.actions.filter((a) => !known.has(a))
  const set = (patch: Partial<Draft>): void => p.onChange({ ...d, ...patch })
  const toggle = (a: string): void => set({ actions: d.actions.includes(a) ? d.actions.filter((x) => x !== a) : [...d.actions, a] })
  const addExtra = (): void => {
    const add = extra
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s && !d.actions.includes(s))
    if (add.length) set({ actions: [...d.actions, ...add] })
    setExtra('')
  }
  const clusterAllowed = p.roleDb === 'admin'
  return (
    <div className={`ur-priv ${d.actions.length ? '' : 'invalid'}`}>
      <div className="ur-priv-head">
        <span className="ur-priv-num">{p.index + 1}</span>
        <div className="segmented small">
          <button className={d.kind === 'ns' ? 'on' : ''} onClick={() => set({ kind: 'ns', db: d.db || p.roleDb })}>
            <Icon name="collection" size={12} /> Database / collection
          </button>
          <button
            className={d.kind === 'cluster' ? 'on' : ''}
            onClick={() => clusterAllowed && set({ kind: 'cluster' })}
            disabled={!clusterAllowed && d.kind !== 'cluster'}
            title={clusterAllowed ? 'Cluster-wide actions' : 'Only roles defined on the admin database can grant cluster privileges'}
          >
            <Icon name="server" size={12} /> Cluster
          </button>
          {d.kind === 'raw' && (
            <button className="on">
              <Icon name="json" size={12} /> Other
            </button>
          )}
        </div>
        {d.kind === 'ns' && (
          <div className="row ur-priv-ns">
            <input
              className="input small mono"
              list="ur-role-dbs"
              value={d.db}
              placeholder="all databases"
              onChange={(e) => set({ db: e.target.value })}
              disabled={!clusterAllowed}
              title={clusterAllowed ? 'Empty = every database' : 'Roles outside admin can only grant privileges on their own database'}
            />
            <span className="faint">.</span>
            <input className="input small mono" value={d.coll} placeholder="all collections" onChange={(e) => set({ coll: e.target.value })} />
          </div>
        )}
        {d.kind === 'raw' && <span className="mono muted ellipsis">{resourceLabel(d.raw)}</span>}
        <span className="spacer" />
        <span className="faint ur-priv-count">
          {d.actions.length} action{d.actions.length === 1 ? '' : 's'}
        </span>
        <button className="btn ghost icon small" title="Remove privilege" onClick={p.onRemove}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      <div className="ur-priv-body">
        {groups.map(([label, actions]) => (
          <div key={label} className="ur-priv-group">
            <span className="ur-priv-glabel">{label}</span>
            <div className="ur-opts">
              {actions.map((a) => (
                <button key={a} type="button" className={`ur-opt small ${d.actions.includes(a) ? 'on' : ''}`} onClick={() => toggle(a)}>
                  {d.actions.includes(a) && <Icon name="check" size={10} />}
                  {a}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="ur-priv-group">
          <span className="ur-priv-glabel">Other</span>
          <div className="ur-opts">
            {others.map((a) => (
              <button key={a} type="button" className="ur-opt small on" onClick={() => toggle(a)} title="Remove">
                {a}
                <Icon name="close" size={9} />
              </button>
            ))}
            <input
              className="input small mono ur-extra"
              value={extra}
              placeholder="action name, Enter to add"
              onChange={(e) => setExtra(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addExtra())}
              onBlur={addExtra}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export interface RoleDialogOpts {
  connId: string
  db: string
  role?: RoleInfo
  dbs: string[]
  customRoles: RoleRef[]
}

function RoleDialogBody({ o, done }: { o: RoleDialogOpts; done: (saved: boolean) => void }): ReactElement {
  const editing = !!o.role
  const [name, setName] = useState(o.role?.role ?? '')
  const [privs, setPrivs] = useState<Draft[]>(() => (o.role?.privileges ?? []).map(toDraft))
  const [inherits, setInherits] = useState<RoleRef[]>(o.role?.roles ?? [])
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const problems = [!name.trim() && 'Enter a role name', privs.some((p) => !p.actions.length) && 'Every privilege needs at least one action'].filter(Boolean) as string[]
  const privileges = privs.map(toPrivilege)
  const command = { [editing ? 'updateRole' : 'createRole']: name.trim(), privileges, roles: inherits }

  const addPriv = (): void => setPrivs([...privs, { id: ++seq, kind: 'ns', db: o.db === 'admin' ? '' : o.db, coll: '', raw: {}, actions: [] }])

  const save = async (): Promise<void> => {
    if (problems.length || busy) return
    setBusy(true)
    setError(null)
    try {
      if (editing) await api.updateRole(o.connId, o.db, name, privileges, inherits)
      else await api.createRole(o.connId, o.db, name.trim(), privileges, inherits)
      toast(`Role ${name.trim()} ${editing ? 'updated' : 'created'}`, 'success')
      done(true)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={editing ? `Edit role ${o.role?.role}` : 'Add custom role'}
      icon="key"
      width={820}
      onClose={() => done(false)}
      escape={!busy}
      footer={
        <>
          <button className={`btn small ghost ${preview ? 'active' : ''}`} onClick={() => setPreview(!preview)}>
            <Icon name="code" size={13} /> Command
          </button>
          {problems[0] && <span className="faint ur-foot-hint">{problems[0]}</span>}
          <span className="spacer" />
          <button className="btn" onClick={() => done(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!problems.length || busy} onClick={() => void save()}>
            <Icon name="check" size={13} /> {editing ? 'Save changes' : 'Create role'}
          </button>
        </>
      }
    >
      <datalist id="ur-role-dbs">
        {o.dbs.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <div className="ur-form">
        {error && <ErrorNotice message={error} db={o.db} />}
        <div className="field">
          <label>Role name</label>
          <div className="row">
            <input className="input mono grow" value={name} onChange={(e) => setName(e.target.value)} readOnly={editing} autoFocus={!editing} spellCheck={false} placeholder="e.g. reportReader" />
            <span className="badge">
              <Icon name="database" size={11} /> {o.db}
            </span>
          </div>
        </div>

        <div className="field top">
          <label>
            Privileges
            <div className="faint ur-sublabel">resource + actions</div>
          </label>
          <div className="col" style={{ gap: 8 }}>
            {privs.length === 0 && <div className="ur-empty-box faint">No direct privileges — the role only grants what it inherits.</div>}
            {privs.map((d, i) => (
              <PrivilegeCard
                key={d.id}
                d={d}
                index={i}
                roleDb={o.db}
                onChange={(n) => setPrivs(privs.map((x) => (x.id === d.id ? n : x)))}
                onRemove={() => setPrivs(privs.filter((x) => x.id !== d.id))}
              />
            ))}
            <div>
              <button className="btn small" onClick={addPriv}>
                <Icon name="plus" size={12} /> Add privilege
              </button>
            </div>
          </div>
        </div>

        <div className="field top">
          <label>
            Inherits roles
            <div className="faint ur-sublabel">{o.db === 'admin' ? 'from any database' : `from ${o.db}`}</div>
          </label>
          <RolePicker value={inherits} onChange={setInherits} dbs={o.dbs} defaultDb={o.db} customRoles={o.customRoles} exclude={o.role ? { role: o.role.role, db: o.role.db } : undefined} />
        </div>

        {preview && (
          <div className="field top">
            <label>Command</label>
            <pre className="mono selectable ur-preview">{`db.getSiblingDB(${JSON.stringify(o.db)}).runCommand(${shellText(command, 2)})`}</pre>
          </div>
        )}
      </div>
    </Modal>
  )
}

export const roleDialog = (o: RoleDialogOpts): Promise<boolean> => openModal<boolean>((close) => <RoleDialogBody o={o} done={close} />)
