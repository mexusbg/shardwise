import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { Doc, IndexDetail } from '@shared/api'
import { humanBytes, isSpecialKey, keyLabel, logicalKeys, shellLiteral, specCommand } from '@shared/indexForm'
import { api } from '../../lib/api'
import { errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { showMenu } from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { openCreateIndexDialog } from './CreateIndexDialog'
import './indexes.css'
import { fmtDate, fmtDateTime } from '../../lib/datetime'

const TYPE_LABEL: Record<string, string> = {
  regular: 'Regular',
  compound: 'Compound',
  text: 'Text',
  '2dsphere': '2dsphere',
  '2d': '2d',
  hashed: 'Hashed',
  wildcard: 'Wildcard',
  ttl: 'TTL'
}

function ago(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 86400 * 60) return `${Math.round(s / 86400)} d ago`
  return fmtDate(d)
}

function ttlText(sec: number): string {
  if (sec === 0) return 'at date'
  if (sec % 86400 === 0) return `${sec / 86400} d`
  if (sec % 3600 === 0) return `${sec / 3600} h`
  if (sec % 60 === 0) return `${sec / 60} min`
  return `${sec} s`
}

const asDoc = (ix: IndexDetail): Doc => ix as unknown as Doc

function KeyChips({ ix }: { ix: IndexDetail }): ReactElement {
  const keys = logicalKeys(ix as unknown as { key: Doc; weights?: Doc })
  return (
    <span className="ixm-keys">
      {keys.map(([f, v]) => (
        <span key={f} className={`ixm-key mono ${isSpecialKey(v) ? 'special' : ''}`} title={`${f}: ${shellLiteral(v)}`}>
          <span className="ixm-key-f">{f}</span>
          <b>{keyLabel(v)}</b>
        </span>
      ))}
    </span>
  )
}

function PropChips({ ix }: { ix: IndexDetail }): ReactElement {
  const d = asDoc(ix)
  const col = d.collation as { locale?: string; strength?: number } | undefined
  const chips: ReactElement[] = []
  if (ix.unique) chips.push(<span key="u" className="ixm-prop accent" title="Rejects duplicate values">unique</span>)
  if (ix.sparse) chips.push(<span key="s" className="ixm-prop" title="Only documents containing the field are indexed">sparse</span>)
  if (ix.partialFilterExpression)
    chips.push(
      <span key="p" className="ixm-prop" title={`partialFilterExpression: ${shellLiteral(ix.partialFilterExpression)}`}>
        <Icon name="filter" size={11} /> partial
      </span>
    )
  if (ix.expireAfterSeconds != null) {
    const sec = Number(ix.expireAfterSeconds)
    chips.push(
      <span key="t" className="ixm-prop ttl" title={`expireAfterSeconds: ${sec}`}>
        TTL {ttlText(sec)}
      </span>
    )
  }
  if (col?.locale && col.locale !== 'simple')
    chips.push(
      <span key="c" className="ixm-prop" title={`collation: ${shellLiteral(col)}`}>
        {col.locale}
        {col.strength != null && Number(col.strength) !== 3 ? ` · s${Number(col.strength)}` : ''}
      </span>
    )
  if (typeof d.default_language === 'string' && d.default_language !== 'english')
    chips.push(
      <span key="l" className="ixm-prop" title="Default language of the text index">
        {d.default_language}
      </span>
    )
  if (ix.hidden)
    chips.push(
      <span key="h" className="ixm-prop hidden" title="Hidden from the query planner (still maintained)">
        <Icon name="view" size={11} /> hidden
      </span>
    )
  return <span className="ixm-props">{chips.length ? chips : <span className="faint">—</span>}</span>
}

function Usage({ ix }: { ix: IndexDetail }): ReactElement {
  if (ix.building !== undefined) {
    const known = ix.building > 0
    return (
      <div className="ixm-build" title="Index build in progress">
        <div className={`progress ${known ? '' : 'indeterminate'}`}>
          <div style={{ width: `${known ? ix.building : 30}%` }} />
        </div>
        <span className="mono">{known ? `${ix.building}%` : 'building…'}</span>
      </div>
    )
  }
  if (ix.ops == null) return <span className="faint">—</span>
  const since = ix.since ? new Date(ix.since) : null
  const sinceText = since ? `since ${fmtDateTime(since)} (statistics reset when the server restarts)` : ''
  if (ix.ops === 0 && ix.name !== '_id_')
    return (
      <span className="ixm-unused" title={`No operations used this index ${sinceText}. Hide it first to check nothing depends on it, then drop it.`}>
        <Icon name="warn" size={12} /> unused — candidate to drop
      </span>
    )
  return (
    <span className="ixm-usage" title={`${ix.ops.toLocaleString()} operations ${sinceText}`}>
      <b className="mono">{ix.ops.toLocaleString()}</b> ops
      {since && <span className="faint"> · since {ago(since)}</span>}
    </span>
  )
}

/** Indexes of one collection: list, usage, create, hide / unhide, drop. */
export function IndexManagerView({ tab }: { tab: ToolTab }): ReactElement {
  const { connId, db } = tab
  const coll = tab.coll ?? ''
  const live = useStore((s) => s.live[connId])
  const connected = !!live
  const [list, setList] = useState<IndexDetail[] | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(
    async (quiet = false) => {
      const my = ++seq.current
      if (!quiet) setLoading(true)
      try {
        const [l, c] = await Promise.all([api.indexDetails(connId, db, coll), api.estimatedCount(connId, db, coll).catch(() => -1)])
        if (my !== seq.current) return
        setList(l)
        setCount(c)
        setError(null)
      } catch (e) {
        if (my === seq.current) setError(errorText(e))
      } finally {
        if (my === seq.current) setLoading(false)
      }
    },
    [connId, db, coll]
  )

  useEffect(() => {
    if (connected) void load()
  }, [load, connected])

  const building = pending > 0 || !!list?.some((i) => i.building !== undefined)
  useEffect(() => {
    if (!building || !connected) return
    const t = setInterval(() => void load(true), 2000)
    return () => clearInterval(t)
  }, [building, connected, load])

  const totalSize = useMemo(() => (list ?? []).reduce((n, i) => n + (i.size ?? 0), 0), [list])
  const maxSize = useMemo(() => Math.max(1, ...(list ?? []).map((i) => i.size ?? 0)), [list])
  const unused = (list ?? []).filter((i) => i.ops === 0 && i.name !== '_id_' && i.building === undefined).length

  const create = async (): Promise<void> => {
    await openCreateIndexDialog({
      connId,
      db,
      coll,
      existing: list ?? undefined,
      docCount: count,
      onStart: () => {
        setPending((p) => p + 1)
        setTimeout(() => void load(true), 400)
      },
      onDone: () => {
        setPending((p) => p - 1)
        void load(true)
      }
    })
  }

  const setHidden = async (ix: IndexDetail, hidden: boolean): Promise<void> => {
    setBusy(ix.name)
    try {
      await api.setIndexHidden(connId, db, coll, ix.name, hidden)
      toast(hidden ? `Index ${ix.name} is now hidden from the query planner` : `Index ${ix.name} is visible again`, 'success')
      await load(true)
    } catch (e) {
      toast(`Could not ${hidden ? 'hide' : 'unhide'} ${ix.name}: ${errorText(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const drop = async (ix: IndexDetail): Promise<void> => {
    if (ix.name === '_id_') return
    const ok = await confirmDialog({
      title: 'Drop index',
      danger: true,
      confirmLabel: 'Drop index',
      message: (
        <div className="col" style={{ gap: 10 }}>
          <div>
            Drop index <b className="mono">{ix.name}</b> from{' '}
            <span className="mono">
              {db}.{coll}
            </span>
            ?
          </div>
          <div className="muted">
            Queries that rely on it fall back to other indexes or a full collection scan
            {ix.unique ? ', and uniqueness will no longer be enforced' : ''}. Rebuilding it later scans the whole collection.
          </div>
          {!ix.hidden && <div className="faint">Tip: hide the index first to test the impact safely; unhiding is instant.</div>}
        </div>
      )
    })
    if (!ok) return
    setBusy(ix.name)
    try {
      await api.dropIndex(connId, db, coll, ix.name)
      toast(`Index ${ix.name} dropped`, 'success')
      await load(true)
    } catch (e) {
      toast(`Could not drop ${ix.name}: ${errorText(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const copy = async (ix: IndexDetail): Promise<void> => {
    await api.copyText(specCommand(coll, asDoc(ix)))
    toast('createIndex command copied', 'success')
  }

  const menu = (e: ReactMouseEvent, ix: IndexDetail): void => {
    setSelected(ix.name)
    const isId = ix.name === '_id_'
    const items: MenuItem[] = [
      { label: 'Copy createIndex command', icon: 'copy', onClick: () => void copy(ix) },
      { label: 'Copy name', icon: 'copy', onClick: () => void api.copyText(ix.name).then(() => toast('Name copied', 'success')) },
      { separator: true },
      ix.hidden
        ? { label: 'Unhide index', icon: 'view', disabled: isId || ix.building !== undefined, onClick: () => void setHidden(ix, false) }
        : { label: 'Hide index', icon: 'view', disabled: isId || ix.building !== undefined, onClick: () => void setHidden(ix, true) },
      { label: isId ? 'Drop index (the _id index is required)' : 'Drop index…', icon: 'trash', danger: true, disabled: isId, onClick: () => void drop(ix) },
      { separator: true },
      { label: 'Create index…', icon: 'plus', onClick: () => void create() },
      { label: 'Refresh', icon: 'refresh', onClick: () => void load() }
    ]
    showMenu(e, items)
  }

  if (!live)
    return (
      <div className="ixm">
        <div className="ixm-empty">
          <Icon name="unplug" size={36} />
          <h3>Disconnected</h3>
          <p className="muted">Reconnect to manage the indexes of {coll}.</p>
        </div>
      </div>
    )

  return (
    <div className="ixm">
      <div className="ixm-head">
        <Icon name="key" size={16} className="ixm-head-icon" />
        <span className="ixm-title ellipsis" title={`${db}.${coll}`}>
          <span className="faint">{db}.</span>
          {coll}
        </span>
        <span className="ixm-stats">
          <span>
            <b>{list?.length ?? '–'}</b> {list?.length === 1 ? 'index' : 'indexes'}
          </span>
          <span title="Total size of all indexes">
            <b>{list ? humanBytes(totalSize) : '–'}</b> total
          </span>
          <span title="Estimated document count">
            <b>{count == null ? '–' : count < 0 ? '?' : count.toLocaleString()}</b> docs
          </span>
          {unused > 0 && (
            <span className="ixm-stat-warn" title="Indexes with no recorded use since the statistics were last reset">
              <Icon name="warn" size={12} /> {unused} unused
            </span>
          )}
          {building && (
            <span className="ixm-stat-build">
              <span className="ixf-spinner" /> building
            </span>
          )}
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={() => void load()} disabled={loading} title="Refresh">
          <Icon name="refresh" size={13} className={loading ? 'ixm-spin' : undefined} /> Refresh
        </button>
        <button className="btn small primary" onClick={() => void create()}>
          <Icon name="plus" size={13} /> Create index…
        </button>
      </div>

      {error && (
        <div className="notice error ixm-error selectable">
          <b>Could not load indexes:</b> {error}
        </div>
      )}

      <div className="ixm-body">
        {list && list.length > 0 && (
          <table className="ixm-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Keys</th>
                <th>Type</th>
                <th>Properties</th>
                <th className="num">Size</th>
                <th>Usage</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((ix) => {
                const isId = ix.name === '_id_'
                const unusedRow = ix.ops === 0 && !isId && ix.building === undefined
                return (
                  <tr
                    key={ix.name}
                    className={`${selected === ix.name ? 'sel' : ''} ${ix.hidden ? 'is-hidden' : ''} ${unusedRow ? 'is-unused' : ''} ${ix.building !== undefined ? 'is-building' : ''} ${busy === ix.name ? 'is-busy' : ''}`}
                    onMouseDown={() => setSelected(ix.name)}
                    onContextMenu={(e) => menu(e, ix)}
                  >
                    <td className="ixm-name">
                      <span className="mono selectable" title={ix.name}>
                        {ix.name}
                      </span>
                    </td>
                    <td>
                      <KeyChips ix={ix} />
                    </td>
                    <td>
                      <span className={`ixm-type ty-${ix.type}`}>{TYPE_LABEL[ix.type] ?? ix.type}</span>
                    </td>
                    <td>
                      <PropChips ix={ix} />
                    </td>
                    <td className="num">
                      <div className="ixm-size" title={ix.size != null ? `${ix.size.toLocaleString()} bytes` : undefined}>
                        <span className="mono">{humanBytes(ix.size)}</span>
                        {ix.size != null && (
                          <span className="ixm-size-bar">
                            <span style={{ width: `${Math.max(2, (ix.size / maxSize) * 100)}%` }} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <Usage ix={ix} />
                    </td>
                    <td className="ixm-actions">
                      <button
                        className={`btn ghost icon small ${ix.hidden ? 'on' : ''}`}
                        title={isId ? 'The _id index cannot be hidden' : ix.hidden ? 'Unhide: let the query planner use it again' : 'Hide from the query planner (reversible)'}
                        disabled={isId || busy === ix.name || ix.building !== undefined}
                        onClick={() => void setHidden(ix, !ix.hidden)}
                      >
                        <Icon name="view" size={14} />
                      </button>
                      <button className="btn ghost icon small" title="Copy createIndex command" onClick={() => void copy(ix)}>
                        <Icon name="copy" size={14} />
                      </button>
                      <button
                        className="btn ghost icon small ixm-drop"
                        title={isId ? 'The _id index cannot be dropped' : 'Drop index'}
                        disabled={isId || busy === ix.name}
                        onClick={() => void drop(ix)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                      <button className="btn ghost icon small" title="More" onClick={(e) => menu(e, ix)}>
                        <Icon name="more" size={14} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {list && list.length === 0 && !error && (
          <div className="ixm-empty">
            <Icon name="key" size={32} />
            <h3>No indexes</h3>
            <p className="muted">The collection does not exist yet or is a view. Views use the indexes of their source collection.</p>
          </div>
        )}
        {!list && !error && (
          <div className="ixm-empty">
            <span className="ixf-spinner big" />
            <p className="muted">Loading indexes…</p>
          </div>
        )}
      </div>

      {list && list.length > 0 && (
        <div className="ixm-foot faint">
          Usage counts come from $indexStats and reset when the server restarts. Hide an index before dropping it to check that no query depends on it.
        </div>
      )}
    </div>
  )
}
