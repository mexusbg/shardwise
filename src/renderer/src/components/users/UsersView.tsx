import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { RoleInfo, RoleRef, UserInfo } from '@shared/api'
import { shellText } from '@shared/bsonValue'
import { api } from '../../lib/api'
import { errorText, refreshDatabases, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog, promptDialog } from '../Modal'
import { ErrorNotice, RoleChip, refKey, resourceLabel, typeToConfirm } from './common'
import { userDialog } from './UserDialog'
import { roleDialog } from './RoleDialog'
import './users.css'

type Section = 'users' | 'roles'

const OTHER_DB = '\u0000other'

export function UsersView({ tab }: { tab: ToolTab }): ReactElement {
  const live = useStore((s) => s.live[tab.connId])
  const connections = useStore((s) => s.connections)
  const active = useStore((s) => s.activeTab === tab.id)
  const [db, setDb] = useState(tab.db || 'admin')
  const [extraDbs, setExtraDbs] = useState<string[]>([])
  const [section, setSection] = useState<Section>('users')
  const [showBuiltin, setShowBuiltin] = useState(false)
  const [users, setUsers] = useState<UserInfo[] | null>(null)
  const [roles, setRoles] = useState<RoleInfo[] | null>(null)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const loadSeq = useRef(0)

  const connected = !!live
  useEffect(() => {
    if (live && !live.databases && !live.loading) void refreshDatabases(tab.connId)
  }, [live, tab.connId])

  const dbs = useMemo(() => {
    const names = new Set(['admin', db, ...extraDbs, ...(live?.databases ?? []).map((d) => d.name)])
    return [...names].sort((a, b) => (a === 'admin' ? -1 : b === 'admin' ? 1 : a.localeCompare(b)))
  }, [live?.databases, db, extraDbs])

  const me = useMemo(() => {
    const cfg = connections.find((c) => c.id === live?.configId)
    const a = cfg?.auth
    if (!a || a.mechanism === 'none' || !a.username) return null
    return { user: a.username, db: a.mechanism === 'MONGODB-X509' || a.mechanism === 'MONGODB-AWS' || a.mechanism === 'PLAIN' || a.mechanism === 'GSSAPI' ? '$external' : a.authSource || 'admin' }
  }, [connections, live?.configId])
  const isMe = (u: UserInfo): boolean => !!me && me.user === u.user && me.db === u.db

  const load = useCallback(async (): Promise<void> => {
    if (!connected) return
    const n = ++loadSeq.current
    setLoading(true)
    const [u, r] = await Promise.allSettled([api.listUsers(tab.connId, db), api.listRoles(tab.connId, db, showBuiltin)])
    if (n !== loadSeq.current) return
    setUsers(u.status === 'fulfilled' ? u.value : null)
    setUsersError(u.status === 'rejected' ? errorText(u.reason) : null)
    setRoles(r.status === 'fulfilled' ? r.value : null)
    setRolesError(r.status === 'rejected' ? errorText(r.reason) : null)
    setLoading(false)
  }, [connected, tab.connId, db, showBuiltin])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const customRoles: RoleRef[] = useMemo(() => (roles ?? []).filter((r) => !r.isBuiltin).map((r) => ({ role: r.role, db: r.db })), [roles])

  const q = filter.trim().toLowerCase()
  const shownUsers = useMemo(
    () => (users ?? []).filter((u) => !q || u.user.toLowerCase().includes(q) || u.roles.some((r) => refKey(r).toLowerCase().includes(q))),
    [users, q]
  )
  const shownRoles = useMemo(
    () => (roles ?? []).filter((r) => !q || r.role.toLowerCase().includes(q) || r.roles.some((x) => refKey(x).toLowerCase().includes(q))),
    [roles, q]
  )

  const chooseDb = async (v: string): Promise<void> => {
    if (v !== OTHER_DB) {
      setDb(v)
      setOpen(null)
      return
    }
    const name = await promptDialog({
      title: 'Other database',
      label: 'Database name',
      placeholder: 'e.g. $external',
      validate: (s) => (!s.trim() ? 'Enter a name' : /[/\\. "]/.test(s.trim()) && s.trim() !== '$external' ? 'Invalid database name' : null)
    })
    if (!name) return
    setExtraDbs((x) => [...new Set([...x, name.trim()])])
    setDb(name.trim())
  }

  const addUser = async (): Promise<void> => {
    if (await userDialog({ connId: tab.connId, db, dbs, customRoles, isSelf: false })) void load()
  }
  const editUser = async (u: UserInfo): Promise<void> => {
    if (await userDialog({ connId: tab.connId, db, user: u, dbs, customRoles, isSelf: isMe(u) })) void load()
  }
  const dropUser = async (u: UserInfo): Promise<void> => {
    const ok = await typeToConfirm({
      title: 'Drop user',
      expected: u.user,
      confirmLabel: 'Drop user',
      message: (
        <>
          Permanently remove <b className="mono">{u.user}</b> from <b className="mono">{u.db}</b>? Applications using it will no longer be able to authenticate.
          {isMe(u) && (
            <div className="notice ur-notice" style={{ marginTop: 10 }}>
              <Icon name="warn" size={15} />
              <span>This is the user this connection is logged in as — you will lose access as soon as the session ends.</span>
            </div>
          )}
        </>
      )
    })
    if (!ok) return
    try {
      await api.dropUser(tab.connId, db, u.user)
      toast(`User ${u.user} dropped`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
    void load()
  }

  const addRole = async (): Promise<void> => {
    if (await roleDialog({ connId: tab.connId, db, dbs, customRoles })) void load()
  }
  const editRole = async (r: RoleInfo): Promise<void> => {
    if (await roleDialog({ connId: tab.connId, db, role: r, dbs, customRoles })) void load()
  }
  const dropRole = async (r: RoleInfo): Promise<void> => {
    const holders = (users ?? []).filter((u) => u.roles.some((x) => x.role === r.role && x.db === r.db)).length
    const ok = await confirmDialog({
      title: 'Drop role',
      danger: true,
      confirmLabel: 'Drop role',
      message: (
        <>
          Drop the custom role <b className="mono">{r.role}</b> from <b className="mono">{r.db}</b>? Users and roles that were granted it lose its privileges.
          {holders > 0 && (
            <div className="faint" style={{ marginTop: 6 }}>
              {holders} user{holders === 1 ? '' : 's'} in {db} currently hold{holders === 1 ? 's' : ''} this role.
            </div>
          )}
        </>
      )
    })
    if (!ok) return
    try {
      await api.dropRole(tab.connId, db, r.role)
      toast(`Role ${r.role} dropped`, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
    void load()
  }

  const error = section === 'users' ? usersError : rolesError
  const list = section === 'users' ? users : roles
  const toggleOpen = (k: string): void => setOpen(open === k ? null : k)

  const renderUsers = (): ReactElement => (
    <table className="ur-table">
      <thead>
        <tr>
          <th className="ur-c-expand" />
          <th>User</th>
          <th>Database</th>
          <th>Roles</th>
          <th>Mechanisms</th>
          <th>Custom data</th>
          <th className="ur-c-actions" />
        </tr>
      </thead>
      <tbody>
        {shownUsers.map((u) => {
          const k = `u:${u.user}`
          const expanded = open === k
          return (
            <Fragment key={k}>
              <tr className={expanded ? 'open' : ''} onClick={() => toggleOpen(k)} onDoubleClick={() => void editUser(u)}>
                <td className="ur-c-expand">
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                </td>
                <td>
                  <div className="ur-name">
                    <span className="ur-avatar">{u.user.slice(0, 1).toUpperCase()}</span>
                    <span className="mono ellipsis selectable">{u.user}</span>
                    {isMe(u) && (
                      <span className="ur-you" title="The user this connection is logged in as">
                        you
                      </span>
                    )}
                  </div>
                </td>
                <td className="mono muted">{u.db}</td>
                <td>
                  <div className="ur-chips">
                    {u.roles.length ? u.roles.map((r) => <RoleChip key={refKey(r)} r={r} current={u.db} />) : <span className="faint">no roles</span>}
                  </div>
                </td>
                <td>
                  <div className="ur-chips">
                    {(u.mechanisms ?? []).map((m) => (
                      <span key={m} className="ur-mech">
                        {m.replace(/^SCRAM-/, '')}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="ur-c-custom">
                  {u.customData && Object.keys(u.customData).length ? <span className="mono muted ellipsis">{shellText(u.customData)}</span> : <span className="faint">—</span>}
                </td>
                <td className="ur-c-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="btn ghost icon small" title="Edit user" onClick={() => void editUser(u)}>
                    <Icon name="edit" size={13} />
                  </button>
                  <button className="btn ghost icon small ur-danger" title="Drop user" onClick={() => void dropUser(u)}>
                    <Icon name="trash" size={13} />
                  </button>
                </td>
              </tr>
              {expanded && (
                <tr className="ur-detail">
                  <td />
                  <td colSpan={6}>
                    <div className="ur-detail-grid">
                      <span className="faint">Roles</span>
                      <div className="ur-chips">
                        {u.roles.length ? u.roles.map((r) => <RoleChip key={refKey(r)} r={r} />) : <span className="faint">none</span>}
                      </div>
                      <span className="faint">Custom data</span>
                      <pre className="mono selectable ur-pre">{u.customData ? shellText(u.customData, 2) : '—'}</pre>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )

  const renderRoles = (): ReactElement => (
    <table className="ur-table">
      <thead>
        <tr>
          <th className="ur-c-expand" />
          <th>Role</th>
          <th>Database</th>
          <th>Inherits</th>
          <th className="ur-c-num">Privileges</th>
          <th className="ur-c-actions" />
        </tr>
      </thead>
      <tbody>
        {shownRoles.map((r) => {
          const k = `r:${r.db}.${r.role}`
          const expanded = open === k
          return (
            <Fragment key={k}>
              <tr className={`${expanded ? 'open' : ''} ${r.isBuiltin ? 'builtin' : ''}`} onClick={() => toggleOpen(k)} onDoubleClick={() => !r.isBuiltin && void editRole(r)}>
                <td className="ur-c-expand">
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                </td>
                <td>
                  <div className="ur-name">
                    <Icon name={r.isBuiltin ? 'lock' : 'key'} size={13} className="ur-role-icon" />
                    <span className="mono ellipsis selectable">{r.role}</span>
                    {r.isBuiltin ? <span className="ur-builtin">built-in</span> : <span className="ur-custom">custom</span>}
                  </div>
                </td>
                <td className="mono muted">{r.db}</td>
                <td>
                  <div className="ur-chips">{r.roles.length ? r.roles.map((x) => <RoleChip key={refKey(x)} r={x} current={r.db} />) : <span className="faint">—</span>}</div>
                </td>
                <td className="ur-c-num">{r.privileges?.length ?? 0}</td>
                <td className="ur-c-actions" onClick={(e) => e.stopPropagation()}>
                  {!r.isBuiltin && (
                    <>
                      <button className="btn ghost icon small" title="Edit role" onClick={() => void editRole(r)}>
                        <Icon name="edit" size={13} />
                      </button>
                      <button className="btn ghost icon small ur-danger" title="Drop role" onClick={() => void dropRole(r)}>
                        <Icon name="trash" size={13} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
              {expanded && (
                <tr className="ur-detail">
                  <td />
                  <td colSpan={5}>
                    <div className="ur-detail-grid">
                      {(r.inheritedRoles?.length ?? 0) > r.roles.length && (
                        <>
                          <span className="faint">All inherited</span>
                          <div className="ur-chips">
                            {r.inheritedRoles!.map((x) => (
                              <RoleChip key={refKey(x)} r={x} />
                            ))}
                          </div>
                        </>
                      )}
                      <span className="faint">Privileges</span>
                      {r.privileges?.length ? (
                        <div className="ur-privlist">
                          {r.privileges.map((p, i) => (
                            <div key={i} className="ur-privrow">
                              <span className="mono ur-res">{resourceLabel(p.resource)}</span>
                              <div className="ur-chips">
                                {p.actions.map((a) => (
                                  <span key={a} className="ur-action">
                                    {a}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="faint">No direct privileges</span>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )

  const empty = (): ReactElement =>
    section === 'users' ? (
      <div className="ur-empty">
        <Icon name="users" size={30} />
        <b>{q ? 'No matching users' : `No users in ${db}`}</b>
        {!q && <span className="faint">Users belong to the database they authenticate against — most deployments keep them in admin.</span>}
        {!q && (
          <button className="btn primary" onClick={() => void addUser()}>
            <Icon name="plus" size={13} /> Add user
          </button>
        )}
      </div>
    ) : (
      <div className="ur-empty">
        <Icon name="key" size={30} />
        <b>{q ? 'No matching roles' : `No custom roles in ${db}`}</b>
        {!q && <span className="faint">Custom roles bundle privileges and other roles; turn on “Show built-in” to browse MongoDB's own roles.</span>}
        {!q && (
          <button className="btn primary" onClick={() => void addRole()}>
            <Icon name="plus" size={13} /> Add role
          </button>
        )}
      </div>
    )

  const customCount = roles?.filter((r) => !r.isBuiltin).length

  return (
    <div className="ur">
      <div className="ur-head">
        <Icon name="users" size={16} className="ur-head-icon" />
        <span className="ur-title">Users &amp; Roles</span>
        <label className="ur-db">
          <Icon name="database" size={13} />
          <select className="select small" value={db} onChange={(e) => void chooseDb(e.target.value)}>
            {dbs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            <option value={OTHER_DB}>Other…</option>
          </select>
        </label>
        <div className="segmented">
          <button className={section === 'users' ? 'on' : ''} onClick={() => (setSection('users'), setOpen(null))}>
            <Icon name="users" size={13} /> Users <span className="ur-count">{users?.length ?? ''}</span>
          </button>
          <button className={section === 'roles' ? 'on' : ''} onClick={() => (setSection('roles'), setOpen(null))}>
            <Icon name="key" size={13} /> Roles <span className="ur-count">{customCount ?? ''}</span>
          </button>
        </div>
        <span className="spacer" />
        <div className="ur-search">
          <Icon name="search" size={13} />
          <input className="input small" value={filter} placeholder={section === 'users' ? 'Filter users or roles…' : 'Filter roles…'} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {section === 'roles' && (
          <label className="check ur-builtin-toggle">
            <input type="checkbox" checked={showBuiltin} onChange={(e) => setShowBuiltin(e.target.checked)} />
            Show built-in
          </label>
        )}
        <button className="btn ghost icon small" title="Refresh" onClick={() => void load()} disabled={!connected}>
          <Icon name="refresh" size={14} className={loading ? 'ur-spin' : undefined} />
        </button>
        <button className="btn small primary" disabled={!connected} onClick={() => void (section === 'users' ? addUser() : addRole())}>
          <Icon name="plus" size={13} /> {section === 'users' ? 'Add user' : 'Add role'}
        </button>
        {loading && <div className="loading-bar" />}
      </div>
      <div className="ur-body">
        {!connected ? (
          <div className="ur-empty">
            <Icon name="unplug" size={30} />
            <b>Not connected</b>
            <span className="faint">Reconnect to manage users and roles.</span>
          </div>
        ) : error ? (
          <div className="ur-error">
            <ErrorNotice message={error} db={db} />
          </div>
        ) : list === null ? null : (section === 'users' ? shownUsers.length : shownRoles.length) === 0 ? (
          empty()
        ) : section === 'users' ? (
          renderUsers()
        ) : (
          renderRoles()
        )}
      </div>
    </div>
  )
}
