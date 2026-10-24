import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { shellText } from '@shared/bsonValue'
import { upcomingRuns, validateSchedule } from '@shared/taskSchedule'
import { TASK_KIND_LABELS } from '@shared/tasksApi'
import type { CatchUpPolicy, TaskInfo, TaskJobInput, TaskKind, TaskNotify, TaskSchedule, TaskSettings } from '@shared/tasksApi'
import { errorText, toast } from '../../state/store'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'
import { tasksApi } from './tasksClient'
import './tasks.css'
import { fmtDateTime, getSystemDateFormat } from '../../lib/datetime'

export const TASK_KIND_ICONS: Record<TaskKind, string> = {
  export: 'export',
  import: 'import',
  compareSync: 'compare',
  sqlExport: 'sql',
  sqlImport: 'sql',
  mask: 'mask'
}

const pad = (n: number): string => String(n).padStart(2, '0')
const toLocalInput = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
function fromLocalInput(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null
}

export function formatWhen(d: Date): string {
  return `${weekday(d)} ${fmtDateTime(d, false)}`
}

const weekday = (d: Date): string => d.toLocaleDateString(getSystemDateFormat().locale, { weekday: 'short' })

/** Monday first. */
const WEEK: { day: number; label: string }[] = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' }
]

type ScheduleKind = TaskSchedule['kind']

const SCHEDULE_KINDS: { id: ScheduleKind; label: string }[] = [
  { id: 'none', label: 'Manual' },
  { id: 'once', label: 'Once' },
  { id: 'interval', label: 'Repeat' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' }
]

interface Draft {
  kind: ScheduleKind
  at: string
  every: string
  unit: 'minutes' | 'hours'
  time: string
  days: number[]
}

function draftOf(s: TaskSchedule): Draft {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const d: Draft = { kind: s.kind, at: toLocalInput(tomorrow), every: '60', unit: 'minutes', time: '09:00', days: [1, 2, 3, 4, 5] }
  if (s.kind === 'once') d.at = toLocalInput(s.at)
  if (s.kind === 'interval') Object.assign(d, { every: String(s.every), unit: s.unit })
  if (s.kind === 'daily') d.time = s.time
  if (s.kind === 'weekly') Object.assign(d, { time: s.time, days: s.days })
  return d
}

function scheduleOf(d: Draft): TaskSchedule {
  switch (d.kind) {
    case 'none':
      return { kind: 'none' }
    case 'once':
      return { kind: 'once', at: fromLocalInput(d.at) ?? new Date(NaN) }
    case 'interval':
      return { kind: 'interval', every: Number(d.every), unit: d.unit }
    case 'daily':
      return { kind: 'daily', time: d.time }
    case 'weekly':
      return { kind: 'weekly', days: d.days, time: d.time }
  }
}

function ScheduleEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }): ReactElement {
  const set = (p: Partial<Draft>): void => onChange({ ...draft, ...p })
  const schedule = scheduleOf(draft)
  const error = validateSchedule(schedule)
  const next = useMemo(() => (error ? [] : upcomingRuns(schedule, new Date(), 3)), [JSON.stringify(draft), error]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="tk-sched">
      <div className="segmented small tk-sched-kinds">
        {SCHEDULE_KINDS.map((k) => (
          <button key={k.id} className={draft.kind === k.id ? 'on' : ''} onClick={() => set({ kind: k.id })}>
            {k.label}
          </button>
        ))}
      </div>
      {draft.kind !== 'none' && (
        <div className="tk-sched-fields">
          {draft.kind === 'once' && (
            <label className="tk-inline">
              <span className="muted">At</span>
              <input className="input small" type="datetime-local" value={draft.at} onChange={(e) => set({ at: e.target.value })} />
            </label>
          )}
          {draft.kind === 'interval' && (
            <label className="tk-inline">
              <span className="muted">Every</span>
              <input className={`input small tk-num ${error ? 'invalid' : ''}`} type="number" min={1} step={1} value={draft.every} onChange={(e) => set({ every: e.target.value })} />
              <select className="select small" value={draft.unit} onChange={(e) => set({ unit: e.target.value as Draft['unit'] })}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </label>
          )}
          {draft.kind === 'weekly' && (
            <div className="tk-days" role="group" aria-label="Days of the week">
              {WEEK.map((w) => {
                const on = draft.days.includes(w.day)
                return (
                  <button
                    key={w.day}
                    className={`tk-day ${on ? 'on' : ''}`}
                    aria-pressed={on}
                    onClick={() => set({ days: on ? draft.days.filter((d) => d !== w.day) : [...draft.days, w.day] })}
                  >
                    {w.label}
                  </button>
                )
              })}
            </div>
          )}
          {(draft.kind === 'daily' || draft.kind === 'weekly') && (
            <label className="tk-inline">
              <span className="muted">at</span>
              <input className="input small" type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
            </label>
          )}
        </div>
      )}
      <div className="tk-sched-next">
        {draft.kind === 'none' ? (
          <span className="faint">Runs only when you click Run now in the Tasks tab.</span>
        ) : error ? (
          <span className="error-text">{error}</span>
        ) : next.length ? (
          <>
            <Icon name="history" size={12} />
            <span className="faint">Next:</span>
            {next.map((d, i) => (
              <span key={i} className="tk-chip">
                {formatWhen(d)}
              </span>
            ))}
          </>
        ) : (
          <span className="error-text">This time is in the past</span>
        )}
      </div>
    </div>
  )
}

interface FormProps {
  title: string
  kind: TaskKind
  initial: TaskSettings
  submitLabel: string
  /** Read-only job request shown in edit mode. */
  request?: unknown
  /** Compare & sync: dry-run toggle (create mode). */
  dryRun?: { value: boolean }
  onSubmit: (s: TaskSettings, dryRun: boolean) => Promise<void>
  onClose: () => void
}

function TaskForm(p: FormProps): ReactElement {
  const [name, setName] = useState(p.initial.name)
  const [draft, setDraft] = useState(() => draftOf(p.initial.schedule))
  const [enabled, setEnabled] = useState(p.initial.enabled)
  const [catchUp, setCatchUp] = useState<CatchUpPolicy>(p.initial.catchUp)
  const [notify, setNotify] = useState<TaskNotify>(p.initial.notify)
  const [dryRun, setDryRun] = useState(p.dryRun?.value ?? false)
  const [showRequest, setShowRequest] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const schedule = scheduleOf(draft)
  const problem = !name.trim() ? 'Enter a name' : validateSchedule(schedule)
  const requestText = useMemo(() => (p.request === undefined ? '' : shellText(p.request, 2)), [p.request])

  const submit = async (): Promise<void> => {
    if (problem || busy) return
    setBusy(true)
    setError(null)
    try {
      await p.onSubmit({ name: name.trim(), schedule, enabled, catchUp, notify }, dryRun)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={p.title}
      icon="tasks"
      width={600}
      onClose={p.onClose}
      footer={
        <>
          {(error || problem) && <span className={`grow ellipsis tk-foot-msg ${error ? 'error-text' : 'faint'}`}>{error ?? problem}</span>}
          {!error && !problem && <span className="grow" />}
          <button className="btn" onClick={p.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!problem || busy} onClick={() => void submit()}>
            <Icon name="check" size={13} /> {p.submitLabel}
          </button>
        </>
      }
    >
      <div className="tk-form">
        <div className="tk-form-kind">
          <span className={`tk-kind-ico k-${p.kind}`}>
            <Icon name={TASK_KIND_ICONS[p.kind]} size={15} />
          </span>
          <span className="muted">{TASK_KIND_LABELS[p.kind]} task</span>
        </div>

        <label className="tk-label" htmlFor="tk-name">
          Name
        </label>
        <input id="tk-name" className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />

        <div className="tk-label">Schedule</div>
        <ScheduleEditor draft={draft} onChange={setDraft} />

        {draft.kind !== 'none' && (
          <>
            <div className="tk-label">Missed runs</div>
            <select className="select small tk-wide" value={catchUp} onChange={(e) => setCatchUp(e.target.value as CatchUpPolicy)}>
              <option value="skip">Skip runs missed while Shardwise was closed</option>
              <option value="runOnce">Run once when Shardwise starts</option>
            </select>
            <div className="tk-label">Status</div>
            <label className="check">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled <span className="faint">— uncheck to pause the schedule</span>
            </label>
          </>
        )}

        <div className="tk-label">Notify me</div>
        <div className="row tk-gap12">
          <label className="check">
            <input type="checkbox" checked={notify.success} onChange={(e) => setNotify({ ...notify, success: e.target.checked })} /> On success
          </label>
          <label className="check">
            <input type="checkbox" checked={notify.failure} onChange={(e) => setNotify({ ...notify, failure: e.target.checked })} /> On failure
          </label>
        </div>

        {p.dryRun && (
          <>
            <div className="tk-label">Sync</div>
            <label className="check">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run only — compare and plan, never write
            </label>
          </>
        )}
      </div>

      <div className="tk-form-note faint">
        Scheduled tasks run while Shardwise is open. Connections that are not open are connected for the run and closed afterwards.
      </div>

      {p.request !== undefined && (
        <div className="tk-request">
          <button className="btn ghost small" onClick={() => setShowRequest((v) => !v)}>
            <Icon name={showRequest ? 'chevronDown' : 'chevronRight'} size={12} /> Job request (read-only)
          </button>
          {showRequest && <CodeEditor value={requestText} readOnly full maxHeight={260} />}
        </div>
      )}
    </Modal>
  )
}

const DEFAULT_SETTINGS: Omit<TaskSettings, 'name'> = {
  schedule: { kind: 'none' },
  enabled: true,
  catchUp: 'skip',
  notify: { success: false, failure: true }
}

/** "Save as task…" from a job dialog: name, schedule and notifications for the request, then saved. */
export function openSaveTaskDialog(job: TaskJobInput, defaultName: string): Promise<TaskInfo | null> {
  return openModal<TaskInfo | null>((close) => (
    <TaskForm
      title="Save as task"
      kind={job.kind}
      initial={{ ...DEFAULT_SETTINGS, name: defaultName }}
      submitLabel="Save task"
      dryRun={job.kind === 'compareSync' ? { value: job.request.dryRun } : undefined}
      onClose={() => close(null)}
      onSubmit={async (s, dryRun) => {
        const j: TaskJobInput = job.kind === 'compareSync' ? { ...job, request: { ...job.request, dryRun } } : job
        const t = await tasksApi.tasksCreate({ ...s, job: j })
        toast(`Task “${t.name}” saved${t.nextRunAt ? ` — next run ${formatWhen(t.nextRunAt)}` : ''}. Open it from the connection menu → Tasks.`, 'success')
        close(t)
      }}
    />
  ))
}

/** Edit name, schedule and notifications of a saved task; the job request is shown read-only. */
export function openEditTaskDialog(task: TaskInfo): Promise<TaskInfo | null> {
  return openModal<TaskInfo | null>((close) => (
    <TaskForm
      title={`Edit task — ${task.name}`}
      kind={task.kind}
      initial={task}
      submitLabel="Save"
      request={task.request}
      onClose={() => close(null)}
      onSubmit={async (s) => close(await tasksApi.tasksUpdate(task.id, s))}
    />
  ))
}
