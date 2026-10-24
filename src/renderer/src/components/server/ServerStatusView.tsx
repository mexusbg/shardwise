import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { OP_TYPES } from '@shared/serverApi'
import type { DbStatsRow, ReplMember, ReplicationInfo, Section, ServerInfo, ServerSample, ShardingInfo } from '@shared/serverApi'
import { WINDOW_MS, appendPoint, approxDuration, bytesText, compactNumber, statPoint, uptimeText } from '@shared/serverStats'
import type { StatPoint } from '@shared/serverStats'
import { connName, errorText, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { LineChart } from './LineChart'
import type { ChartSeries } from './LineChart'
import { serverApi } from './serverClient'
import './server.css'
import { fmtDateTime } from '../../lib/datetime'

const INTERVALS = [1000, 2000, 5000, 10000]
const OP_LABEL: Record<(typeof OP_TYPES)[number], string> = { insert: 'Insert', query: 'Query', update: 'Update', delete: 'Delete', getmore: 'Getmore', command: 'Command' }
const MB = 1024 * 1024

const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const lsSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // ignore
  }
}

const rateText = (v: number): string => `${compactNumber(v)}/s`
const bytesRate = (v: number): string => `${bytesText(v)}/s`
const pctText = (v: number): string => `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`
const dateText = (d?: Date): string => (d ? fmtDateTime(d) : '—')

function Unavailable({ s, what }: { s: Extract<Section<unknown>, { ok: false }>; what?: string }): ReactElement {
  return (
    <div className="sv-na" title={s.error}>
      <Icon name={s.denied ? 'lock' : 'warn'} size={13} />
      {s.denied ? <>{what ? `${what} not` : 'Not'} available (needs clusterMonitor)</> : <span className="selectable">{s.error}</span>}
    </div>
  )
}

function Card({ label, value, sub, tone, meter, title }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'bad'; meter?: number | null; title?: string }): ReactElement {
  return (
    <div className={`sv-card ${tone ?? ''}`} title={title}>
      <div className="sv-card-label">
        {label}
        {tone && <Icon name="warn" size={11} />}
      </div>
      <div className="sv-card-value">{value}</div>
      {meter != null && (
        <div className="sv-meter">
          <div style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
        </div>
      )}
      {sub && <div className="sv-card-sub">{sub}</div>}
    </div>
  )
}

const STATE_TONE: Record<string, string> = {
  PRIMARY: 'ok',
  SECONDARY: 'info',
  ARBITER: 'neutral',
  STARTUP: 'warn',
  STARTUP2: 'warn',
  RECOVERING: 'warn',
  ROLLBACK: 'warn',
  DOWN: 'bad',
  UNKNOWN: 'bad',
  REMOVED: 'bad'
}

function StateBadge({ state }: { state: string }): ReactElement {
  return (
    <span className={`sv-state ${STATE_TONE[state] ?? 'neutral'}`}>
      <i />
      {state}
    </span>
  )
}

function lagCell(m: ReplMember): ReactElement {
  if (m.lagSec == null) return <span className="faint">—</span>
  const tone = m.lagSec >= 60 ? 'bad' : m.lagSec >= 10 ? 'warn' : ''
  return (
    <span className={`sv-lag ${tone}`}>
      {tone && <Icon name="warn" size={11} />}
      {m.lagSec < 1 ? '0 s' : m.lagSec < 120 ? `${Math.round(m.lagSec)} s` : uptimeText(m.lagSec)}
    </span>
  )
}

function ReplicaSet({ info, onRefresh }: { info: ReplicationInfo; onRefresh: () => void }): ReactElement {
  const st = info.status
  return (
    <section className="sv-section">
      <div className="sv-section-head">
        <h3>Replica set{st.ok && st.value.set ? <span className="mono"> {st.value.set}</span> : null}</h3>
        {info.oplog.ok ? (
          <span className="sv-oplog" title={`First entry ${dateText(info.oplog.value.first)} · last entry ${dateText(info.oplog.value.last)}`}>
            Oplog window <b>{info.oplog.value.windowSec != null ? approxDuration(info.oplog.value.windowSec) : '—'}</b>
            <span className="faint">
              {' '}
              · {bytesText(info.oplog.value.sizeBytes)} of {bytesText(info.oplog.value.maxBytes)} · {info.oplog.value.count.toLocaleString()} entries
            </span>
          </span>
        ) : (
          <Unavailable s={info.oplog} what="Oplog" />
        )}
        <span className="spacer" />
        <button className="btn ghost icon small" title="Refresh replica set status" onClick={onRefresh}>
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {st.ok ? (
        <div className="sv-table-wrap">
          <table className="sv-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>State</th>
                <th>Health</th>
                <th className="num">Uptime</th>
                <th>Last optime</th>
                <th className="num">Lag</th>
                <th className="num">Ping</th>
                <th>Sync source</th>
              </tr>
            </thead>
            <tbody>
              {st.value.members.map((m) => (
                <tr key={m.name}>
                  <td className="mono">
                    {m.name}
                    {m.self && <span className="sv-self">this node</span>}
                  </td>
                  <td>
                    <StateBadge state={m.stateStr} />
                  </td>
                  <td>{m.health === 1 ? <span className="sv-ok-text">healthy</span> : <span className="sv-bad-text">unreachable</span>}</td>
                  <td className="num">{uptimeText(m.uptime)}</td>
                  <td className="mono small">{dateText(m.optimeDate)}</td>
                  <td className="num">{lagCell(m)}</td>
                  <td className="num">{m.pingMs != null ? `${m.pingMs} ms` : <span className="faint">—</span>}</td>
                  <td className="mono small">{m.syncSourceHost || <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Unavailable s={st} what="Replica set status" />
      )}
    </section>
  )
}

function Sharding({ info }: { info: ShardingInfo }): ReactElement {
  return (
    <section className="sv-section">
      <div className="sv-section-head">
        <h3>Sharding</h3>
        {info.balancer.ok ? (
          <span className="sv-oplog">
            Balancer <b>{info.balancer.value.mode}</b>
            <span className="faint">
              {' '}
              · {info.balancer.value.inBalancerRound ? 'balancing now' : 'idle'} · {info.balancer.value.numBalancerRounds.toLocaleString()} rounds
            </span>
          </span>
        ) : (
          <Unavailable s={info.balancer} what="Balancer status" />
        )}
      </div>
      {info.shards.ok ? (
        <div className="sv-table-wrap">
          <table className="sv-table">
            <thead>
              <tr>
                <th>Shard</th>
                <th>Host</th>
                <th>State</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {info.shards.value.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td>
                  <td className="mono small">{s.host}</td>
                  <td>{s.draining ? <span className="sv-state warn"><i />draining</span> : <span className="sv-state ok"><i />active</span>}</td>
                  <td>{s.tags?.join(', ') || <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Unavailable s={info.shards} what="Shard list" />
      )}
    </section>
  )
}

type DbSortKey = 'name' | 'collections' | 'objects' | 'dataSize' | 'storageSize' | 'indexSize' | 'total'

function Databases({ connId, active }: { connId: string; active: boolean }): ReactElement {
  const [data, setData] = useState<Section<DbStatsRow[]> | null>(null)
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState<{ key: DbSortKey; desc: boolean }>({ key: 'total', desc: true })
  const loaded = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await serverApi.serverDbStats(connId))
    } catch (e) {
      setData({ ok: false, error: errorText(e), denied: false })
    } finally {
      setLoading(false)
    }
  }, [connId])

  useEffect(() => {
    if (active && !loaded.current) {
      loaded.current = true
      void load()
    }
  }, [active, load])

  const rows = useMemo(() => {
    if (!data?.ok) return []
    const val = (r: DbStatsRow): number | string => (sort.key === 'name' ? r.name : sort.key === 'total' ? r.storageSize + r.indexSize : r[sort.key])
    return [...data.value].sort((a, b) => {
      const va = val(a)
      const vb = val(b)
      const c = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number)
      return sort.desc ? -c : c
    })
  }, [data, sort])
  const biggest = Math.max(1, ...rows.map((r) => r.storageSize + r.indexSize))
  const totals = rows.reduce((t, r) => ({ data: t.data + r.dataSize, storage: t.storage + r.storageSize, index: t.index + r.indexSize }), { data: 0, storage: 0, index: 0 })

  const th = (key: DbSortKey, label: string, num = true): ReactElement => (
    <th className={`${num ? 'num' : ''} sortable ${sort.key === key ? 'sorted' : ''}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
      {label}
      {sort.key === key && <span className="sv-sort">{sort.desc ? '▼' : '▲'}</span>}
    </th>
  )

  return (
    <section className="sv-section">
      <div className="sv-section-head">
        <h3>Databases</h3>
        {data?.ok && (
          <span className="faint">
            {rows.length} databases · {bytesText(totals.data)} data · {bytesText(totals.storage)} on disk · {bytesText(totals.index)} indexes
          </span>
        )}
        <span className="spacer" />
        {loading && <span className="sv-spin" />}
        <button className="btn ghost small" onClick={() => void load()} disabled={loading} title="Run dbStats on every database">
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>
      {!data ? (
        <div className="sv-na">{loading ? 'Loading database statistics…' : ''}</div>
      ) : !data.ok ? (
        <Unavailable s={data} what="Database statistics" />
      ) : (
        <div className="sv-table-wrap">
          <table className="sv-table">
            <thead>
              <tr>
                {th('name', 'Database', false)}
                {th('collections', 'Collections')}
                {th('objects', 'Documents')}
                {th('dataSize', 'Data size')}
                {th('storageSize', 'Storage')}
                {th('indexSize', 'Indexes')}
                {th('total', 'On disk')}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="mono">
                    <Icon name="database" size={12} className="sv-db-icon" /> {r.name}
                  </td>
                  {r.error ? (
                    <td colSpan={6} className="sv-bad-text small" title={r.error}>
                      {r.error}
                    </td>
                  ) : (
                    <>
                      <td className="num">
                        {r.collections.toLocaleString()}
                        {r.views > 0 && <span className="faint"> + {r.views} views</span>}
                      </td>
                      <td className="num">{r.objects.toLocaleString()}</td>
                      <td className="num">{bytesText(r.dataSize)}</td>
                      <td className="num">{bytesText(r.storageSize)}</td>
                      <td className="num">{bytesText(r.indexSize)}</td>
                      <td className="num sv-share-cell">
                        <span className="sv-share">
                          <i style={{ width: `${((r.storageSize + r.indexSize) / biggest) * 100}%` }} />
                        </span>
                        {bytesText(r.storageSize + r.indexSize)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** Live server metrics, replica set / sharding state and database sizes. */
export function ServerStatusView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId } = tab
  const live = useStore((s) => s.live[connId])
  const isActive = useStore((s) => s.activeTab === tab.id)
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [latest, setLatest] = useState<ServerSample | null>(null)
  const [points, setPoints] = useState<StatPoint[]>([])
  const [sampleError, setSampleError] = useState<Extract<Section<unknown>, { ok: false }> | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(() => {
    const v = Number(lsGet('server.interval'))
    return INTERVALS.includes(v) ? v : 2000
  })
  const [visible, setVisible] = useState(() => !document.hidden)
  const [repl, setRepl] = useState<ReplicationInfo | null | undefined>(undefined)
  const [sharding, setSharding] = useState<ShardingInfo | null>(null)
  const prev = useRef<ServerSample | undefined>(undefined)
  const connected = !!live
  const running = connected && isActive && visible && !paused

  useEffect(() => {
    const on = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  useEffect(() => {
    if (!connected) return
    let off = false
    serverApi.serverInfo(connId).then(
      (i) => {
        if (off) return
        setInfo(i)
        setInfoError(null)
        if (i.topology === 'sharded') serverApi.serverSharding(connId).then((s) => !off && setSharding(s), () => {})
      },
      (e) => !off && setInfoError(errorText(e))
    )
    return () => {
      off = true
    }
  }, [connId, connected])

  useEffect(() => {
    if (!running) return
    let off = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const gap = Math.max(3 * intervalMs, 15000)
    const tick = async (): Promise<void> => {
      try {
        const r = await serverApi.serverSample(connId)
        if (off) return
        if (r.ok) {
          const before = prev.current && r.value.at - prev.current.at <= gap ? prev.current : undefined
          const p = statPoint(before, r.value)
          prev.current = r.value
          setLatest(r.value)
          setPoints((ps) => appendPoint(ps, p, WINDOW_MS))
          setSampleError(null)
        } else setSampleError(r)
      } catch (e) {
        if (!off) setSampleError({ ok: false, error: errorText(e), denied: false })
      }
      if (!off) timer = setTimeout(() => void tick(), intervalMs)
    }
    void tick()
    return () => {
      off = true
      clearTimeout(timer)
    }
  }, [running, intervalMs, connId])

  const loadRepl = useCallback(() => {
    serverApi.serverReplication(connId).then(setRepl, (e) =>
      setRepl({ status: { ok: false, error: errorText(e), denied: false }, oplog: { ok: false, error: errorText(e), denied: false } })
    )
  }, [connId])

  useEffect(() => {
    if (!running || (info && info.topology !== 'replicaSet')) return
    loadRepl()
    const id = setInterval(loadRepl, Math.max(10000, intervalMs))
    return () => clearInterval(id)
  }, [running, info, intervalMs, loadRepl])

  const now = points.length ? points[points.length - 1].t : Date.now()
  const times = useMemo(() => points.map((p) => p.t), [points])
  const gapMs = Math.max(2.5 * intervalMs, intervalMs + 2000)
  const last = points[points.length - 1]

  const charts = useMemo(() => {
    const col = (i: number): string => `var(--sv-${i})`
    const ser = (key: string, label: string, i: number, pick: (p: StatPoint) => number | null): ChartSeries => ({ key, label, color: col(i), values: points.map(pick) })
    return {
      ops: OP_TYPES.map((k, i) => ser(k, OP_LABEL[k], i + 1, (p) => p.ops[k])),
      conns: [ser('conn', 'Current', 1, (p) => p.connections)],
      net: [ser('in', 'In', 1, (p) => p.netIn), ser('out', 'Out', 2, (p) => p.netOut)],
      mem: [ser('res', 'Resident', 1, (p) => p.resident * MB)],
      cache: [ser('used', 'Used', 1, (p) => p.cacheUsedPct), ser('dirty', 'Dirty', 2, (p) => p.cacheDirtyPct)],
      clients: [ser('active', 'Active clients', 1, (p) => p.activeClients), ser('queued', 'Queued', 2, (p) => p.queued)]
    }
  }, [points])

  const s = latest
  const cachePct = last?.cacheUsedPct ?? null
  const dirtyPct = last?.cacheDirtyPct ?? null
  const connPct = s ? (s.connections.current / Math.max(1, s.connections.current + s.connections.available)) * 100 : null
  const targeting = last?.scannedObjects != null && last.docs.returned ? last.scannedObjects / last.docs.returned : null
  const topology = info
    ? info.topology === 'replicaSet'
      ? `Replica set ${info.setName ?? ''}${info.isPrimary ? ' · primary' : ' · secondary'}`
      : info.topology === 'sharded'
        ? 'Sharded cluster (mongos)'
        : 'Standalone'
    : (live?.topology ?? '')
  const status = !connected ? 'Disconnected' : paused ? 'Paused' : !isActive || !visible ? 'Paused while hidden' : sampleError ? 'No data' : 'Live'

  return (
    <div className="sv">
      <div className="sv-head">
        <Icon name="activity" size={16} className="sv-head-icon" />
        <div className="sv-title">
          <b className="ellipsis">{s?.host || info?.host || connName(connId)}</b>
          <span className="sv-meta">
            {(s?.version || info?.version) && <span className="badge">MongoDB {s?.version || info?.version}</span>}
            {topology && <span className="badge">{topology}</span>}
            {s && <span className="faint">up {uptimeText(s.uptime)}</span>}
            {s?.process && <span className="faint mono">{s.process}</span>}
          </span>
        </div>
        <span className="spacer" />
        <span className={`sv-live ${status === 'Live' ? 'on' : ''}`} title="Polling stops while the tab is hidden">
          <i />
          {status}
        </span>
        <div className="segmented small" title="Polling interval">
          {INTERVALS.map((ms) => (
            <button
              key={ms}
              className={ms === intervalMs ? 'on' : ''}
              onClick={() => {
                setIntervalMs(ms)
                lsSet('server.interval', String(ms))
              }}
            >
              {ms / 1000} s
            </button>
          ))}
        </div>
        <button className={`btn small ${paused ? 'primary' : ''}`} onClick={() => setPaused(!paused)} disabled={!connected} title={paused ? 'Resume live updates' : 'Pause live updates'}>
          {paused ? <Icon name="play" size={12} /> : <PauseIcon />}
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      <div className="sv-body">
        {!connected && <div className="notice error sv-notice">Not connected.</div>}
        {infoError && <div className="notice error sv-notice selectable">{infoError}</div>}
        {sampleError && (sampleError.denied ? <Unavailable s={sampleError} what="Server metrics" /> : <div className="notice error sv-notice selectable">{sampleError.error}</div>)}

        <div className="sv-cards">
          <Card
            label="Operations"
            value={last?.opsTotal != null ? rateText(last.opsTotal) : '—'}
            sub={last?.requests != null ? `${rateText(last.requests)} requests` : 'per second, all types'}
          />
          <Card
            label="Connections"
            value={s ? s.connections.current.toLocaleString() : '—'}
            meter={connPct}
            sub={s ? `${s.connections.available.toLocaleString()} available · ${compactNumber(s.connections.totalCreated)} created` : undefined}
            tone={connPct != null && connPct > 80 ? 'warn' : undefined}
          />
          <Card label="Network in" value={last?.netIn != null ? bytesRate(last.netIn) : '—'} sub={last?.netOut != null ? `${bytesRate(last.netOut)} out` : undefined} />
          <Card label="Memory" value={s ? bytesText(s.mem.resident * MB) : '—'} sub={s ? `${bytesText(s.mem.virtual * MB)} virtual` : undefined} />
          <Card
            label="WiredTiger cache"
            value={cachePct != null ? pctText(cachePct) : '—'}
            meter={cachePct}
            tone={(cachePct ?? 0) > 95 || (dirtyPct ?? 0) > 20 ? 'warn' : undefined}
            sub={s?.cache ? `${dirtyPct != null ? pctText(dirtyPct) : '—'} dirty · ${bytesText(s.cache.max)} max` : 'not available'}
            title="Cache used and dirty, as a share of the configured maximum. Above ~95 % used or ~20 % dirty, application threads help evict."
          />
          <Card
            label="Active clients"
            value={s?.globalLock ? s.globalLock.activeClients.toLocaleString() : '—'}
            tone={(s?.globalLock?.currentQueue ?? 0) > 10 ? 'bad' : (s?.globalLock?.currentQueue ?? 0) > 0 ? 'warn' : undefined}
            sub={s?.globalLock ? `${s.globalLock.currentQueue} queued (${s.globalLock.queueReaders} r / ${s.globalLock.queueWriters} w)` : undefined}
          />
          <Card
            label="Docs returned"
            value={last?.docs.returned != null ? `${rateText(last.docs.returned)}` : '—'}
            sub={
              last?.docs.inserted != null
                ? `${compactNumber(last.docs.inserted)} ins · ${compactNumber(last.docs.updated)} upd · ${compactNumber(last.docs.deleted)} del /s`
                : 'per second'
            }
          />
          <Card
            label="Query targeting"
            value={targeting != null ? `${compactNumber(targeting)} : 1` : '—'}
            tone={targeting != null && targeting > 1000 ? 'warn' : undefined}
            title="Documents scanned per document returned. High values mean queries are not well served by indexes."
            sub={s?.scanAndOrder != null ? `${compactNumber(s.scanAndOrder)} in-memory sorts` : 'scanned per returned'}
          />
          {s?.transactions && (
            <Card
              label="Transactions"
              value={`${s.transactions.currentActive} active`}
              title={`${s.transactions.totalCommitted.toLocaleString()} committed, ${s.transactions.totalAborted.toLocaleString()} aborted since start`}
              sub={`${s.transactions.currentOpen} open · ${compactNumber(s.transactions.totalCommitted)} committed`}
            />
          )}
          {s?.asserts && (
            <Card
              label="Asserts"
              value={compactNumber(s.asserts.regular + s.asserts.warning + s.asserts.msg + s.asserts.user)}
              tone={s.asserts.regular > 0 ? 'warn' : undefined}
              sub={`${compactNumber(s.asserts.user)} user · ${compactNumber(s.asserts.warning)} warn`}
            />
          )}
        </div>

        <div className="sv-charts">
          <LineChart title="Operations / s" times={times} series={charts.ops} format={rateText} axisFormat={compactNumber} windowMs={WINDOW_MS} now={now} gapMs={gapMs} />
          <LineChart title="Connections" times={times} series={charts.conns} format={(v) => Math.round(v).toLocaleString()} axisFormat={compactNumber} windowMs={WINDOW_MS} now={now} gapMs={gapMs} area />
          <LineChart title="Network / s" times={times} series={charts.net} format={bytesRate} axisFormat={(v) => bytesText(v)} bytes windowMs={WINDOW_MS} now={now} gapMs={gapMs} />
          <LineChart title="Resident memory" times={times} series={charts.mem} format={(v) => bytesText(v)} bytes windowMs={WINDOW_MS} now={now} gapMs={gapMs} area />
          <LineChart title="WiredTiger cache" times={times} series={charts.cache} format={pctText} windowMs={WINDOW_MS} now={now} gapMs={gapMs} max={100} />
          <LineChart title="Active clients & queues" times={times} series={charts.clients} format={(v) => Math.round(v).toLocaleString()} axisFormat={compactNumber} windowMs={WINDOW_MS} now={now} gapMs={gapMs} />
        </div>

        {info && (
          <section className="sv-section">
            <div className="sv-section-head">
              <h3>Host</h3>
            </div>
            {info.hostInfo.ok ? (
              <div className="sv-host">
                <span>
                  <span className="faint">Host</span> <b className="mono">{info.hostInfo.value.hostname}</b>
                </span>
                <span>
                  <span className="faint">OS</span> <b>{info.hostInfo.value.os || '—'}</b>
                </span>
                <span>
                  <span className="faint">CPU</span> <b>{info.hostInfo.value.cpuCores} cores</b> <span className="faint">{info.hostInfo.value.cpuArch}</span>
                </span>
                <span>
                  <span className="faint">Memory</span> <b>{bytesText(info.hostInfo.value.memSizeMB * MB)}</b>
                </span>
                {info.storageEngine && (
                  <span>
                    <span className="faint">Storage engine</span> <b>{info.storageEngine}</b>
                  </span>
                )}
              </div>
            ) : (
              <Unavailable s={info.hostInfo} what="Host information" />
            )}
          </section>
        )}

        {repl && <ReplicaSet info={repl} onRefresh={loadRepl} />}
        {sharding && <Sharding info={sharding} />}
        {connected && <Databases connId={connId} active={isActive} />}

        {s && <div className="sv-foot faint">Sampled every {intervalMs / 1000} s · charts show the last 5 minutes · rates are computed from counter differences</div>}
      </div>
    </div>
  )
}

function PauseIcon(): ReactElement {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ flex: 'none' }}>
      <rect x="6" y="4.5" width="4" height="15" rx="1" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" />
    </svg>
  )
}
