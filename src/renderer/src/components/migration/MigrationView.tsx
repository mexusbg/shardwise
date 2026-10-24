import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { FromSqlSource, SqlConnectionConfig } from '@shared/migrationApi'
import { connName, errorText, patchToolTab, toast } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { migrationApi } from './migrationClient'
import { DialectBadge, openSqlConnections } from './SqlConnectionsDialog'
import { SchemaBrowser } from './SchemaBrowser'
import { ToSqlPanel } from './ToSqlPanel'
import { FromSqlPanel } from './FromSqlPanel'
import './migration.css'

type Direction = 'toSql' | 'fromSql'
const LAST_KEY = 'shardwise.migration.sqlConn'

const remembered = (): string | null => {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}
const remember = (id: string | null): void => {
  try {
    if (id) localStorage.setItem(LAST_KEY, id)
    else localStorage.removeItem(LAST_KEY)
  } catch {
    /* storage unavailable */
  }
}

/** SQL ⇄ MongoDB migration in both directions. */
export function MigrationView({ tab }: { tab: ToolTab }): ReactElement {
  const init = tab.init as { direction?: Direction } | undefined
  const [direction, setDir] = useState<Direction>(init?.direction ?? 'toSql')
  const setDirection = (d: Direction): void => {
    setDir(d)
    patchToolTab(tab.id, { title: d === 'fromSql' ? 'Import from SQL' : 'Migrate to SQL' })
  }
  const [conns, setConns] = useState<SqlConnectionConfig[] | null>(null)
  const [sqlConnId, setSqlConnId] = useState<string | null>(remembered())
  const [browserVersion, setBrowserVersion] = useState(0)
  const [sources, setSources] = useState<FromSqlSource[]>([])
  const [selectedSource, setSelectedSource] = useState<string | null>(null)

  const loadConns = useCallback(async (select?: string | null): Promise<void> => {
    try {
      const l = await migrationApi.sqlListConnections()
      setConns(l)
      setSqlConnId((cur) => {
        const want = select === undefined ? cur : select
        return want && l.some((c) => c.id === want) ? want : null
      })
    } catch (e) {
      toast(errorText(e), 'error')
      setConns([])
    }
  }, [])

  useEffect(() => {
    void loadConns()
  }, [loadConns])

  const sqlConn = useMemo(() => conns?.find((c) => c.id === sqlConnId) ?? null, [conns, sqlConnId])

  const choose = async (id: string | null): Promise<void> => {
    if (id === sqlConnId) return
    if (sources.length && !(await confirmDialog({ title: 'Change SQL connection', message: 'The tables and queries chosen for import belong to the current connection and will be removed.', confirmLabel: 'Change' }))) return
    setSources([])
    setSelectedSource(null)
    setSqlConnId(id)
    remember(id)
  }

  const manage = async (): Promise<void> => {
    const id = await openSqlConnections(sqlConnId ?? undefined)
    await loadConns(id ?? undefined)
    if (id) {
      if (id !== sqlConnId) await choose(id)
      setBrowserVersion((v) => v + 1)
    }
  }

  const addTable = async (schema: string, table: string): Promise<void> => {
    if (!sqlConnId) return
    const existing = sources.find((s) => s.kind === 'table' && s.schema === schema && s.table === table)
    if (existing) {
      setSelectedSource(existing.id)
      return
    }
    try {
      const src = await migrationApi.migrationDefaultSource(sqlConnId, { schema, table })
      setSources((l) => [...l, src])
      setSelectedSource(src.id)
    } catch (e) {
      toast(`Could not read ${table}: ${errorText(e)}`, 'error')
    }
  }

  const added = useMemo(() => new Set(sources.filter((s) => s.kind === 'table').map((s) => `${s.schema}.${s.table}`)), [sources])
  const refreshBrowser = useCallback(() => setBrowserVersion((v) => v + 1), [])

  return (
    <div className="mig">
      <div className="mig-head">
        <Icon name="sql" size={16} className="mig-accent" />
        <span className="mig-title">SQL Migration</span>
        <div className="segmented mig-dir">
          <button className={direction === 'toSql' ? 'on' : ''} onClick={() => setDirection('toSql')}>
            <Icon name="leaf" size={12} /> MongoDB <Icon name="chevronRight" size={11} /> SQL
          </button>
          <button className={direction === 'fromSql' ? 'on' : ''} onClick={() => setDirection('fromSql')}>
            <Icon name="sql" size={12} /> SQL <Icon name="chevronRight" size={11} /> MongoDB
          </button>
        </div>
        <span className="spacer" />
        <span className="mig-ns faint ellipsis" title={`${connName(tab.connId)} · ${tab.db}`}>
          <Icon name="database" size={12} /> {connName(tab.connId)} · <b>{tab.db}</b>
        </span>
      </div>
      <div className="mig-body">
        <aside className="mig-left">
          <div className="mig-sec-head">
            <span className="mig-label">SQL connection</span>
            <span className="spacer" />
            <button className="btn ghost icon small" onClick={() => void manage()} title="Manage SQL connections">
              <Icon name="settings" size={13} />
            </button>
          </div>
          <div className="mig-conn-pick">
            {sqlConn && <DialectBadge dialect={sqlConn.dialect} />}
            <select className="select small grow" value={sqlConnId ?? ''} onChange={(e) => void choose(e.target.value || null)}>
              <option value="">{conns?.length ? 'Choose a connection…' : 'No SQL connections'}</option>
              {conns?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="btn small" onClick={() => void manage()} title="Add or edit SQL connections">
              <Icon name="plus" size={12} />
            </button>
          </div>
          {sqlConn ? (
            <SchemaBrowser
              key={sqlConn.id}
              sqlConnId={sqlConn.id}
              version={browserVersion}
              onAdd={direction === 'fromSql' ? (s, t) => void addTable(s, t) : undefined}
              added={direction === 'fromSql' ? added : undefined}
            />
          ) : (
            <div className="mig-left-empty">
              <Icon name="sql" size={28} />
              <p className="faint">Connect to PostgreSQL, MySQL / MariaDB, SQL Server or a SQLite file.</p>
              <button className="btn small primary" onClick={() => void manage()}>
                <Icon name="plus" size={12} /> Add SQL connection
              </button>
            </div>
          )}
        </aside>
        <ToSqlPanel tab={tab} sqlConn={sqlConn} hidden={direction !== 'toSql'} onFinished={refreshBrowser} />
        <FromSqlPanel tab={tab} sqlConn={sqlConn} hidden={direction !== 'fromSql'} sources={sources} setSources={setSources} selected={selectedSource} setSelected={setSelectedSource} />
      </div>
    </div>
  )
}
