import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ProfilerTab } from '../../state/store'
import { refreshDatabases, useStore } from '../../state/store'
import { Icon } from '../Icon'
import { CurrentOps } from './CurrentOps'
import { ProfilerPanel } from './ProfilerPanel'
import './profiler2.css'

type SubView = 'profiler' | 'ops'

export function ProfilerView({ tab }: { tab: ProfilerTab }): ReactElement {
  const live = useStore((s) => s.live[tab.connId])
  const active = useStore((s) => s.activeTab === tab.id)
  const [db, setDb] = useState(tab.db)
  // Opened from the connection (admin): current operations are what matters most there.
  const [view, setView] = useState<SubView>(tab.db === 'admin' ? 'ops' : 'profiler')
  const [opsSeen, setOpsSeen] = useState(view === 'ops')
  const [profSeen, setProfSeen] = useState(view === 'profiler')

  useEffect(() => {
    if (live && !live.databases && !live.loading) void refreshDatabases(tab.connId)
  }, [live, tab.connId])

  const pick = (v: SubView): void => {
    setView(v)
    if (v === 'ops') setOpsSeen(true)
    else setProfSeen(true)
  }

  if (!live) {
    return (
      <div className="pf">
        <div className="pf-empty">
          <Icon name="unplug" size={36} />
          <h3>Disconnected</h3>
          <p className="muted">Reconnect to use the Query Profiler.</p>
        </div>
      </div>
    )
  }

  const dbs = (live.databases ?? []).map((d) => d.name)
  const options = dbs.includes(db) ? dbs : [db, ...dbs]
  const sharded = live.topology.startsWith('Sharded')

  return (
    <div className="pf">
      <div className="pf-head">
        <Icon name={view === 'ops' ? 'activity' : 'gauge'} size={16} className="pf-head-icon" />
        <span className="pf-title">{view === 'ops' ? 'Current Operations' : 'Query Profiler'}</span>
        {view === 'profiler' && (
          <>
            <span className="faint">—</span>
            <select className="select small pf-dbsel" value={db} onChange={(e) => setDb(e.target.value)} title="Database to profile">
              {options.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </>
        )}
        {view === 'ops' && <span className="faint">— all databases</span>}
        <div className="segmented small pf-views">
          <button className={view === 'profiler' ? 'on' : ''} onClick={() => pick('profiler')}>
            <Icon name="gauge" size={12} /> Profiler
          </button>
          <button className={view === 'ops' ? 'on' : ''} onClick={() => pick('ops')}>
            <Icon name="activity" size={12} /> Current Operations
          </button>
        </div>
        <span className="spacer" />
        <span className="pf-conn muted">
          <Icon name="server" size={13} style={{ color: live.color ?? 'var(--leaf)' }} />
          {live.name}
          <span className="badge">{live.topology}</span>
          {live.serverVersion && <span className="badge">v{live.serverVersion}</span>}
        </span>
      </div>
      {sharded && view === 'profiler' && (
        <div className="notice pf-banner">
          <Icon name="warn" size={13} /> Connected through mongos: the profiler runs on each shard&apos;s mongod. Connect to a shard member directly to read its
          profile.
        </div>
      )}
      {profSeen && (
        <div className="pf-pane" style={{ display: view === 'profiler' ? 'flex' : 'none' }}>
          <ProfilerPanel key={db} connId={tab.connId} db={db} topology={live.topology} active={active && view === 'profiler'} />
        </div>
      )}
      {opsSeen && (
        <div className="pf-pane" style={{ display: view === 'ops' ? 'flex' : 'none' }}>
          <CurrentOps connId={tab.connId} topology={live.topology} active={active && view === 'ops'} />
        </div>
      )}
    </div>
  )
}
