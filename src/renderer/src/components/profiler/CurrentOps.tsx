import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { Doc } from '@shared/api'
import { shellText } from '@shared/bsonValue'
import { commandOf, isPlainObject, num, opLabel, profileQueryParts } from '@shared/profile'
import { api } from '../../lib/api'
import { toast } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { showMenu } from '../ContextMenu'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { copyText, ErrorNotice, fmtMs, fmtNum, friendlyError, openEntryInTab, shellCommand, sortRows, Th, useInterval } from './ProfilerCommon'
import type { SortState } from './ProfilerCommon'

/** Running time in ms (microsecs_running is more precise than secs_running). */
const runningMs = (o: Doc): number | undefined => {
  const us = num(o.microsecs_running)
  if (us !== undefined) return us / 1000
  const s = num(o.secs_running)
  return s === undefined ? undefined : s * 1000
}

const opKey = (o: Doc): string => `${String(o.opid ?? '')}|${String(o.connectionId ?? '')}|${String(o.desc ?? '')}`

/** The $currentOp aggregation issued by this view. */
function isOwnOp(o: Doc): boolean {
  const cmd = commandOf(o)
  return !!cmd && cmd.aggregate === 1 && Array.isArray(cmd.pipeline) && isPlainObject(cmd.pipeline[0]) && '$currentOp' in cmd.pipeline[0]
}

const searchCache = new WeakMap<Doc, string>()
function searchText(o: Doc): string {
  let s = searchCache.get(o)
  if (s === undefined) {
    s = [o.opid, o.op, o.ns, o.desc, o.client, o.appName, o.planSummary, o.effectiveUsers ? shellText(o.effectiveUsers) : '', o.command ? shellText(o.command) : '']
      .filter((x) => x !== undefined && x !== null && x !== '')
      .map(String)
      .join('\n')
      .toLowerCase()
    searchCache.set(o, s)
  }
  return s
}

function value(o: Doc, col: string): unknown {
  switch (col) {
    case 'running':
      return runningMs(o)
    case 'op':
      return opLabel(o)
    case 'opid':
      return typeof o.opid === 'number' ? o.opid : String(o.opid ?? '')
    case 'client':
      return o.appName || o.client
    case 'lock':
      return o.waitingForLock === true ? 1 : 0
    default:
      return o[col] === undefined ? undefined : String(o[col])
  }
}

function tone(ms: number | undefined): string {
  if (ms === undefined) return ''
  return ms > 60_000 ? 'pf-long-danger' : ms > 5000 ? 'pf-long-warn' : ''
}

export function CurrentOps({ connId, topology, active }: { connId: string; topology?: string; active: boolean }): ReactElement {
  const [ops, setOps] = useState<Doc[]>([])
  const [allUsers, setAllUsers] = useState(true)
  const [idle, setIdle] = useState(false)
  const [auto, setAuto] = useState(true)
  const [minMs, setMinMs] = useState('')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<{ title: string; detail?: string } | null>(null)
  const [sort, setSort] = useState<SortState>({ col: 'running', dir: -1 })
  const [selKey, setSelKey] = useState<string | null>(null)
  const [lastSel, setLastSel] = useState<Doc | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    try {
      const docs = await api.currentOps(connId, { allUsers, idle })
      if (my !== seq.current) return
      setOps(docs.filter((o) => !isOwnOp(o)))
      setErr(null)
    } catch (e) {
      if (my === seq.current) setErr(friendlyError(e, undefined, 'admin'))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [connId, allUsers, idle])

  useEffect(() => {
    if (active) void load()
  }, [load, active])
  useInterval(() => void load(), auto && active ? 2000 : null)

  const visible = useMemo(() => {
    const min = parseFloat(minMs) || 0
    const t = text.trim().toLowerCase()
    const rows = ops.filter((o) => (!min || (runningMs(o) ?? 0) >= min) && (!t || searchText(o).includes(t)))
    return sortRows(rows, sort, value)
  }, [ops, minMs, text, sort])

  const live = selKey ? ops.find((o) => opKey(o) === selKey) : undefined
  const selected = live ?? (selKey ? lastSel : null)
  useEffect(() => {
    if (live) setLastSel(live)
  }, [live])

  const kill = async (o: Doc): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Kill operation',
      message: (
        <>
          Kill operation <b className="mono">{String(o.opid)}</b> ({opLabel(o)}
          {o.ns ? ` on ${String(o.ns)}` : ''}, running {fmtMs(runningMs(o))})? The operation is interrupted at its next yield point; writes already done are not
          rolled back.
        </>
      ),
      confirmLabel: 'Kill operation',
      danger: true
    })
    if (!ok) return
    try {
      await api.killOp(connId, o.opid)
      toast(`Kill requested for operation ${String(o.opid)}`, 'success')
      void load()
    } catch (e) {
      toast(friendlyError(e, topology, 'admin').title, 'error')
    }
  }

  const rowMenu = (e: ReactMouseEvent, o: Doc): void => {
    setSelKey(opKey(o))
    setLastSel(o)
    showMenu(e, [
      { label: 'Kill operation…', icon: 'close', danger: true, disabled: o.opid === undefined, onClick: () => void kill(o) },
      { separator: true },
      { label: 'Open query in new tab', icon: 'play', disabled: !profileQueryParts(o)?.coll, onClick: () => openEntryInTab(connId, o) },
      { label: 'Copy command', icon: 'copy', disabled: !o.command, onClick: () => void copyText(shellCommand(o)) },
      { label: 'Copy operation document', icon: 'json', onClick: () => void copyText(shellText(o, 2), 'Document') }
    ])
  }

  const stillRunning = !!selected && !!live

  return (
    <div className="pf-body">
      <div className="pf-strip">
        <label className="check pf-lbl" title="Include operations of all users (requires the inprog privilege)">
          <input type="checkbox" checked={allUsers} onChange={(e) => setAllUsers(e.target.checked)} /> All users
        </label>
        <label className="check pf-lbl" title="Include idle connections and sessions">
          <input type="checkbox" checked={idle} onChange={(e) => setIdle(e.target.checked)} /> Include idle
        </label>
        <label className="pf-field" title="Only operations running at least this long">
          <span className="pf-lbl">Running ≥</span>
          <input className="input small pf-w60" placeholder="0" value={minMs} onChange={(e) => setMinMs(e.target.value.replace(/[^\d.]/g, ''))} />
          <span className="faint">ms</span>
        </label>
        <div className="pf-search">
          <Icon name="search" size={12} />
          <input className="input small" placeholder="Filter namespace, client, command…" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <span className="spacer" />
        <label className="check pf-lbl" title="Refresh every 2 seconds">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto refresh
        </label>
        <button className="btn small" onClick={() => void load()}>
          <Icon name="refresh" size={13} className={loading ? 'pf-spin' : ''} /> Refresh
        </button>
      </div>
      {err && (
        <div className="pf-strip">
          <ErrorNotice error={err} />
        </div>
      )}
      <div className="pf-split">
        <div className="pf-main">
          <div className="grid pf-grid">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <Th col="opid" sort={sort} onSort={setSort} width={110}>
                    Op ID
                  </Th>
                  <Th col="running" sort={sort} onSort={setSort} width={96} num descFirst>
                    Running
                  </Th>
                  <Th col="op" sort={sort} onSort={setSort} width={92}>
                    Op
                  </Th>
                  <Th col="ns" sort={sort} onSort={setSort} width={180}>
                    Namespace
                  </Th>
                  <Th col="client" sort={sort} onSort={setSort} width={180}>
                    App / client
                  </Th>
                  <Th col="planSummary" sort={sort} onSort={setSort} width={170}>
                    Plan
                  </Th>
                  <Th col="lock" sort={sort} onSort={setSort} width={70} descFirst title="Waiting for a lock">
                    Lock
                  </Th>
                  <Th col="desc" sort={sort} onSort={setSort}>
                    Description
                  </Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((o, i) => {
                  const ms = runningMs(o)
                  const key = opKey(o)
                  const plan = typeof o.planSummary === 'string' ? o.planSummary : ''
                  return (
                    <tr
                      key={`${key}#${i}`}
                      className={`${key === selKey ? 'sel' : ''} ${tone(ms)}`}
                      onClick={() => {
                        setSelKey(key)
                        setLastSel(o)
                      }}
                      onContextMenu={(e) => rowMenu(e, o)}
                    >
                      <td className="pf-killcell">
                        {o.opid !== undefined && (
                          <button
                            className="btn ghost icon small pf-kill"
                            title="Kill operation"
                            onClick={(e) => {
                              e.stopPropagation()
                              void kill(o)
                            }}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        )}
                      </td>
                      <td className="mono">{o.opid === undefined ? '—' : String(o.opid)}</td>
                      <td className="pf-num pf-running">{o.active === false ? <span className="faint">idle</span> : fmtMs(ms)}</td>
                      <td>
                        <span className="pf-op">{opLabel(o)}</span>
                      </td>
                      <td title={String(o.ns ?? '')}>{o.ns ? String(o.ns) : <span className="faint">—</span>}</td>
                      <td className="faint" title={[o.appName, o.client, o.effectiveUsers ? shellText(o.effectiveUsers) : ''].filter(Boolean).join('\n')}>
                        {[o.appName, o.client].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td title={plan}>{plan ? <span className={plan.includes('COLLSCAN') ? 'pf-bad' : ''}>{plan}</span> : <span className="faint">—</span>}</td>
                      <td>{o.waitingForLock === true ? <span className="pf-lock">waiting</span> : <span className="faint">no</span>}</td>
                      <td className="faint">{o.desc ? String(o.desc) : ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!loading && visible.length === 0 && !err && (
              <div className="pf-none muted">{ops.length ? 'No operations match the filters.' : 'No operations are running right now.'}</div>
            )}
          </div>
        </div>
        {selected && (
          <div className="pf-details">
            <div className="pf-d-head">
              <span className="pf-op">{opLabel(selected)}</span>
              <span className="mono ellipsis grow selectable">{selected.ns ? String(selected.ns) : `opid ${String(selected.opid ?? '—')}`}</span>
              <button className="btn ghost icon small" title="Close details" onClick={() => setSelKey(null)}>
                <Icon name="close" size={13} />
              </button>
            </div>
            <div className="pf-d-sub muted">
              {stillRunning ? (
                <>
                  opid <span className="mono">{String(selected.opid ?? '—')}</span> · running {fmtMs(runningMs(selected))}
                  {selected.numYields !== undefined && <> · {fmtNum(selected.numYields)} yields</>}
                </>
              ) : (
                <span className="pf-gone">Operation finished — showing its last state</span>
              )}
            </div>
            {selected.waitingForLock === true && (
              <div className="pf-warnings">
                <div className="pf-warning warn">
                  <Icon name="warn" size={13} /> Waiting for a lock
                </div>
              </div>
            )}
            <div className="pf-d-actions">
              <button className="btn small danger" disabled={!stillRunning || selected.opid === undefined} onClick={() => void kill(selected)}>
                <Icon name="close" size={12} /> Kill operation
              </button>
              <button className="btn small" disabled={!profileQueryParts(selected)?.coll} onClick={() => openEntryInTab(connId, selected)}>
                <Icon name="play" size={11} /> Open query
              </button>
              <button className="btn small" disabled={!selected.command} onClick={() => void copyText(shellCommand(selected))}>
                <Icon name="copy" size={13} /> Copy command
              </button>
            </div>
            {!!selected.command && (
              <div className="pf-d-section">
                <div className="pf-d-label">Command</div>
                <CodeEditor value={shellText(selected.command, 2)} readOnly maxHeight={260} />
              </div>
            )}
            <div className="pf-d-section pf-d-json">
              <div className="pf-d-label">Operation document</div>
              <CodeEditor value={shellText(selected, 2)} readOnly full className="pf-json" />
            </div>
          </div>
        )}
      </div>
      <div className="pf-foot faint">
        {visible.length === ops.length ? ops.length : `${visible.length} of ${ops.length}`} operation{ops.length === 1 ? '' : 's'}
        {visible.some((o) => (runningMs(o) ?? 0) > 5000 && o.active !== false) && (
          <span className="pf-foot-warn"> · {visible.filter((o) => (runningMs(o) ?? 0) > 5000 && o.active !== false).length} running longer than 5 s</span>
        )}
        <span className="spacer" />
        {auto && active ? 'Auto refresh 2 s' : 'Auto refresh off'}
      </div>
    </div>
  )
}
