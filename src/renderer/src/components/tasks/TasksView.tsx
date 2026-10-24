import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { JobProgress, TransferFormat } from '@shared/api'
import { scheduleText } from '@shared/taskSchedule'
import { TASK_KIND_LABELS } from '@shared/tasksApi'
import type { TaskInfo, TaskRun, TaskRunStatus, TaskTrigger } from '@shared/tasksApi'
import { onEvent } from '../../lib/api'
import { errorText, toast, useStore } from '../../state/store'
import type { ToolTab } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog } from '../Modal'
import { formatWhen, openEditTaskDialog, TASK_KIND_ICONS } from './SaveTaskDialog'
import { onTasksChanged, tasksApi } from './tasksClient'
import './tasks.css'
import { fmtDateTime } from '../../lib/datetime'

const onceText = (d: Date): string => fmtDateTime(d, false)

const fileName = (p: string): string => p.split(/[\\/]/).pop() || p
const fmt = (n: number): string => n.toLocaleString()

const FORMAT: Record<TransferFormat, string> = { json: 'JSON', csv: 'CSV', xlsx: 'Excel', 'bson-folder': 'BSON', 'bson-archive': 'BSON archive' }

const STATUS_LABEL: Record<TaskRunStatus, string> = { running: 'Running', success: 'Succeeded', error: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' }
const STATUS_ICON: Record<TaskRunStatus, string> = { running: 'play', success: 'check', error: 'warn', cancelled: 'close', skipped: 'chevronRight' }
const TRIGGER_LABEL: Record<TaskTrigger, string> = { manual: 'Manual', schedule: 'Scheduled', catchUp: 'Catch-up' }

function relTime(d: Date, now: number): string {
  const diff = d.getTime() - now
  const abs = Math.abs(diff)
  const m = Math.round(abs / 60_000)
  if (abs < 45_000) return diff >= 0 ? 'in a moment' : 'just now'
  const s = m < 60 ? `${m} min` : m < 60 * 24 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
  return diff >= 0 ? `in ${s}` : `${s} ago`
}

function duration(r: TaskRun): string {
  if (!r.endedAt) return ''
  const ms = r.endedAt.getTime() - r.startedAt.getTime()
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** One line describing what the task does. */
function describe(t: TaskInfo): string {
  switch (t.kind) {
    case 'export': {
      const r = t.request
      const what = r.collections.length === 1 ? `${r.db}.${r.collections[0]}` : `${r.db} (${r.collections.length} collections)`
      return `${what} → ${FORMAT[r.format]} ${fileName(r.target)}${r.query ? ' · with query' : ''}`
    }
    case 'import': {
      const r = t.request
      return `${fileName(r.source)} → ${r.db}${r.collection ? `.${r.collection}` : ''}${r.dropFirst ? ' · drop first' : ''}`
    }
    case 'compareSync': {
      const { compare: c, sync, dryRun } = t.request
      const s2t = sync.direction === 'sourceToTarget'
      const actions = [sync.insertMissing && 'insert', sync.overwrite !== 'none' && 'overwrite', sync.deleteExtra && 'delete'].filter(Boolean).join(' + ')
      return `${c.source.db}.${c.source.coll} ${s2t ? '→' : '←'} ${c.target.db}.${c.target.coll} · ${dryRun ? 'dry run' : actions || 'compare only'}`
    }
    case 'sqlExport': {
      const r = t.request
      const n = r.collections.filter((c) => c.include).length
      return `${r.db} (${n} collection${n === 1 ? '' : 's'}) → ${r.target.kind === 'file' ? fileName(r.target.path) : 'SQL database'}`
    }
    case 'sqlImport': {
      const r = t.request
      const n = r.sources.filter((s) => s.include).length
      return `${n} SQL source${n === 1 ? '' : 's'} → ${r.db}`
    }
    case 'mask': {
      const r = t.request
      const to = r.target.kind === 'collection' ? `${r.target.db}.${r.target.coll}` : r.target.kind === 'file' ? fileName(r.target.path) : 'in place'
      return `${r.source.db}.${r.source.coll} → ${to}`
    }
  }
}

function StatusBadge({ status, title }: { status: TaskRunStatus; title?: string }): ReactElement {
  return (
    <span className={`tk-badge tks-${status}`} title={title}>
      <Icon name={STATUS_ICON[status]} size={10} />
      {STATUS_LABEL[status]}
    </span>
  )
}

function Switch({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title: string }): ReactElement {
  return (
    <button
      className={`tk-switch ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!on)
      }}
    >
      <span />
    </button>
  )
}

function Progress({ job, step }: { job?: JobProgress; step: string }): ReactElement {
  const pct = job?.total ? Math.min(100, (job.done / job.total) * 100) : 0
  return (
    <div className="tk-progress">
      <div className={`progress ${job?.total ? '' : 'indeterminate'}`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <span className="ellipsis faint tk-small">
        {job?.message ?? step}
        {job?.total ? ` · ${fmt(job.done)} / ${fmt(job.total)}` : ''}
      </span>
    </div>
  )
}

export function TasksView({ tab }: { tab: ToolTab }): ReactElement {
  const connections = useStore((s) => s.connections)
  const live = useStore((s) => s.live)
  const thisConfig = live[tab.connId]?.configId
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [onlyThis, setOnlyThis] = useState(false)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({})
  const [now, setNow] = useState(() => Date.now())
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  const names = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections])

  const load = useCallback(async (): Promise<void> => {
    try {
      setTasks(await tasksApi.tasksList())
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  const loadRuns = useCallback(async (id: string | null): Promise<void> => {
    if (!id) return setRuns([])
    try {
      const list = await tasksApi.tasksRuns(id)
      if (selectedRef.current === id) setRuns(list)
    } catch {
      if (selectedRef.current === id) setRuns([])
    }
  }, [])

  useEffect(() => {
    void load()
    let timer: ReturnType<typeof setTimeout> | null = null
    // Events are coalesced; remember whether any of them touched the selected task's runs.
    let runsChanged = false
    const off = onTasksChanged((e) => {
      if (!e.taskId || e.taskId === selectedRef.current) runsChanged = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void load()
        if (runsChanged) void loadRuns(selectedRef.current)
        runsChanged = false
      }, 120)
    })
    const offJob = onEvent('job:progress', (p) => setJobs((j) => ({ ...j, [p.jobId]: p })))
    const clock = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      off()
      offJob()
      clearInterval(clock)
      if (timer) clearTimeout(timer)
    }
  }, [load, loadRuns])

  const shown = useMemo(() => (tasks ?? []).filter((t) => !onlyThis || (thisConfig && t.configIds.includes(thisConfig))), [tasks, onlyThis, thisConfig])

  useEffect(() => {
    if (!tasks) return
    if (!selectedId || !shown.some((t) => t.id === selectedId)) setSelectedId(shown[0]?.id ?? null)
  }, [tasks, shown, selectedId])

  useEffect(() => {
    setOpenRun(null)
    void loadRuns(selectedId)
  }, [selectedId, loadRuns])

  const selected = shown.find((t) => t.id === selectedId) ?? null

  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn()
      if (ok) toast(ok, 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const runNow = (t: TaskInfo): Promise<void> => act(() => tasksApi.tasksRunNow(t.id))
  const cancel = (t: TaskInfo): Promise<void> => act(() => tasksApi.tasksCancel(t.id))
  const toggle = (t: TaskInfo, enabled: boolean): Promise<void> => act(() => tasksApi.tasksUpdate(t.id, { enabled }))
  const edit = async (t: TaskInfo): Promise<void> => {
    if (await openEditTaskDialog(t)) void load()
  }
  const duplicate = (t: TaskInfo): Promise<void> =>
    act(async () => {
      const copy = await tasksApi.tasksDuplicate(t.id)
      setSelectedId(copy.id)
    }, 'Task duplicated (disabled until you enable it)')
  const remove = async (t: TaskInfo): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Delete task',
      danger: true,
      confirmLabel: 'Delete',
      message: (
        <>
          Delete <b>{t.name}</b> and its run history?{t.running ? ' The current run is cancelled.' : ''} Files and data it produced are kept.
        </>
      )
    })
    if (ok) await act(() => tasksApi.tasksDelete(t.id))
  }

  const connLabel = (ids: string[]): ReactNode =>
    ids.map((id, i) => {
      const c = names.get(id)
      return (
        <span key={id} className={`tk-conn ${c ? '' : 'missing'}`} title={c ? c.name : 'This saved connection was deleted'}>
          {i > 0 && <span className="faint"> · </span>}
          {c?.color && <span className="tk-conn-dot" style={{ background: c.color }} />}
          {c ? c.name : 'Deleted connection'}
        </span>
      )
    })

  const header = (
    <div className="tk-head">
      <Icon name="tasks" size={16} className="tk-head-icon" />
      <span className="tk-title">Tasks</span>
      {tasks && <span className="badge">{shown.length}</span>}
      <span className="spacer" />
      {thisConfig && (tasks?.length ?? 0) > 0 && (
        <div className="segmented small">
          <button className={!onlyThis ? 'on' : ''} onClick={() => setOnlyThis(false)}>
            All
          </button>
          <button className={onlyThis ? 'on' : ''} onClick={() => setOnlyThis(true)}>
            This connection
          </button>
        </div>
      )}
      <button className="btn ghost icon small" title="Refresh" onClick={() => void load()}>
        <Icon name="refresh" size={14} />
      </button>
    </div>
  )

  if (error && !tasks)
    return (
      <div className="tk">
        {header}
        <div className="tk-empty">
          <div className="notice error">{error}</div>
        </div>
      </div>
    )

  if (tasks && !tasks.length)
    return (
      <div className="tk">
        {header}
        <div className="tk-empty">
          <div className="tk-empty-icon">
            <Icon name="tasks" size={30} />
          </div>
          <h3>No tasks yet</h3>
          <p className="muted">
            A task is a saved job you can run again with one click or on a schedule. Set a job up as usual, then click <b>Save as task…</b> instead of starting it:
          </p>
          <ul className="tk-empty-list">
            <li>
              <Icon name="export" size={13} />
              <span>
                <b>Export</b> and <b>Import</b> dialogs
              </span>
            </li>
            <li>
              <Icon name="compare" size={13} />
              <span>
                <b>Compare &amp; sync</b>, from the Sync dialog
              </span>
            </li>
            <li>
              <Icon name="sql" size={13} />
              <span>
                <b>Migrate to SQL</b> and <b>Import from SQL</b>
              </span>
            </li>
            <li>
              <Icon name="mask" size={13} />
              <span>
                <b>Data masking</b>, from the run dialog
              </span>
            </li>
          </ul>
          <p className="faint tk-small">Scheduled tasks run while Shardwise is open; connections are opened for the run when needed.</p>
        </div>
      </div>
    )

  return (
    <div className="tk">
      {header}
      <div className="tk-body">
        <div className="tk-list" role="listbox" aria-label="Tasks">
          {!tasks && <div className="tk-list-msg faint">Loading…</div>}
          {tasks && !shown.length && <div className="tk-list-msg faint">No task uses this connection.</div>}
          {shown.map((t) => {
            const job = t.running?.jobId ? jobs[t.running.jobId] : undefined
            return (
              <div
                key={t.id}
                role="option"
                aria-selected={t.id === selectedId}
                className={`tk-row ${t.id === selectedId ? 'sel' : ''} ${t.enabled ? '' : 'off'}`}
                onClick={() => setSelectedId(t.id)}
                onDoubleClick={() => void edit(t)}
              >
                <span className={`tk-kind-ico k-${t.kind}`} title={TASK_KIND_LABELS[t.kind]}>
                  <Icon name={TASK_KIND_ICONS[t.kind]} size={15} />
                </span>
                <div className="tk-row-main">
                  <div className="tk-row-name ellipsis">{t.name}</div>
                  <div className="tk-row-sub ellipsis faint">{describe(t)}</div>
                  <div className="tk-row-conns ellipsis">{connLabel(t.configIds)}</div>
                </div>
                <div className="tk-row-sched">
                  <div className="ellipsis">{scheduleText(t.schedule, onceText)}</div>
                  <div className="faint ellipsis tk-small">
                    {t.schedule.kind === 'none' ? 'On demand' : !t.enabled ? 'Paused' : t.nextRunAt ? `Next ${relTime(t.nextRunAt, now)}` : 'No upcoming run'}
                  </div>
                </div>
                <div className="tk-row-status">
                  {t.running ? (
                    <Progress job={job} step={t.running.step} />
                  ) : t.lastRun ? (
                    <>
                      <StatusBadge status={t.lastRun.status} title={t.lastRun.summary} />
                      <span className="faint tk-small">{relTime(t.lastRun.endedAt ?? t.lastRun.startedAt, now)}</span>
                    </>
                  ) : (
                    <span className="faint tk-small">Never run</span>
                  )}
                </div>
                {t.schedule.kind !== 'none' ? <Switch on={t.enabled} onChange={(v) => void toggle(t, v)} title={t.enabled ? 'Scheduled — click to pause' : 'Paused — click to enable'} /> : <span className="tk-switch-gap" />}
                {t.running ? (
                  <button
                    className="btn icon small"
                    title="Cancel the run"
                    onClick={(e) => {
                      e.stopPropagation()
                      void cancel(t)
                    }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                ) : (
                  <button
                    className="btn icon small tk-run"
                    title="Run now"
                    onClick={(e) => {
                      e.stopPropagation()
                      void runNow(t)
                    }}
                  >
                    <Icon name="play" size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {selected && (
          <div className="tk-detail">
            <div className="tk-detail-head">
              <span className={`tk-kind-ico big k-${selected.kind}`}>
                <Icon name={TASK_KIND_ICONS[selected.kind]} size={18} />
              </span>
              <div className="grow">
                <div className="tk-detail-name ellipsis selectable">{selected.name}</div>
                <div className="faint tk-small">{TASK_KIND_LABELS[selected.kind]}</div>
              </div>
              {selected.running ? (
                <button className="btn small" onClick={() => void cancel(selected)}>
                  <Icon name="close" size={12} /> Cancel run
                </button>
              ) : (
                <button className="btn small primary" onClick={() => void runNow(selected)}>
                  <Icon name="play" size={11} /> Run now
                </button>
              )}
              <button className="btn small" onClick={() => void edit(selected)}>
                <Icon name="edit" size={12} /> Edit
              </button>
              <button className="btn ghost icon small" title="Duplicate" onClick={() => void duplicate(selected)}>
                <Icon name="duplicate" size={13} />
              </button>
              <button className="btn ghost icon small tk-danger" title="Delete" onClick={() => void remove(selected)}>
                <Icon name="trash" size={13} />
              </button>
            </div>

            {selected.running && (
              <div className="tk-live">
                <div className="row">
                  <StatusBadge status="running" />
                  <span className="faint tk-small">started {relTime(selected.running.startedAt, now)}</span>
                </div>
                <Progress job={selected.running.jobId ? jobs[selected.running.jobId] : undefined} step={selected.running.step} />
              </div>
            )}

            <dl className="tk-facts">
              <dt>Job</dt>
              <dd className="selectable">{describe(selected)}</dd>
              <dt>Connections</dt>
              <dd>{connLabel(selected.configIds)}</dd>
              <dt>Schedule</dt>
              <dd>
                {scheduleText(selected.schedule, onceText)}
                {selected.schedule.kind !== 'none' && !selected.enabled && <span className="tk-paused">paused</span>}
              </dd>
              {selected.schedule.kind !== 'none' && (
                <>
                  <dt>Next run</dt>
                  <dd>{selected.enabled && selected.nextRunAt ? `${formatWhen(selected.nextRunAt)} (${relTime(selected.nextRunAt, now)})` : '—'}</dd>
                  <dt>Missed runs</dt>
                  <dd>{selected.catchUp === 'runOnce' ? 'Run once at startup' : 'Skipped'}</dd>
                </>
              )}
              <dt>Notifications</dt>
              <dd>{[selected.notify.success && 'success', selected.notify.failure && 'failure'].filter(Boolean).join(' and ') || 'off'}</dd>
            </dl>

            <div className="tk-runs-head">
              <span className="tk-section">Run history</span>
              <span className="faint tk-small">last {runs.filter((r) => r.status !== 'running').length} of up to 50</span>
              <span className="spacer" />
              {runs.length > 0 && (
                <button className="btn ghost small" onClick={() => void act(() => tasksApi.tasksClearRuns(selected.id))}>
                  Clear
                </button>
              )}
            </div>
            <div className="tk-runs">
              {!runs.length && <div className="tk-list-msg faint">No runs yet.</div>}
              {runs.map((r) => {
                const open = openRun === r.id
                return (
                  <div key={r.id} className={`tk-run-item ${open ? 'open' : ''}`}>
                    <button className="tk-run-line" onClick={() => setOpenRun(open ? null : r.id)} aria-expanded={open}>
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="faint" />
                      <StatusBadge status={r.status} />
                      <span className="tk-run-when" title={fmtDateTime(r.startedAt)}>
                        {formatWhen(r.startedAt)}
                      </span>
                      <span className="faint tk-small tk-run-trig">{TRIGGER_LABEL[r.trigger]}</span>
                      <span className="faint tk-small tk-run-dur">{duration(r)}</span>
                      <span className="ellipsis tk-run-sum" title={r.summary}>
                        {r.summary}
                      </span>
                    </button>
                    {open && (
                      <div className="tk-log selectable">
                        {r.summary && <div className={`tk-log-sum tks-${r.status}`}>{r.summary}</div>}
                        {r.log.length ? r.log.join('\n') : <span className="faint">No log lines.</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
