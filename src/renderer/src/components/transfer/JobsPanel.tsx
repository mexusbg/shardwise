import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { JobProgress } from '@shared/api'
import { api } from '../../lib/api'
import { dismissJob, errorText, refreshCollections, refreshDatabases, toast, useStore } from '../../state/store'
import { Icon } from '../Icon'
import { jobMeta, Spinner } from './TransferDialogs'
import './transfer.css'

const refreshed = new Set<string>()
const fmt = (n: number): string => n.toLocaleString()

const STATE_LABEL: Record<JobProgress['state'], string> = { running: 'Running', done: 'Finished', error: 'Failed', cancelled: 'Cancelled' }

function StateIcon({ state }: { state: JobProgress['state'] }): ReactElement {
  if (state === 'running') return <Spinner size={14} />
  const name = state === 'done' ? 'check' : state === 'error' ? 'warn' : 'close'
  return <Icon name={name} size={14} className={`tr-state-${state}`} />
}

function Job({ j }: { j: JobProgress }): ReactElement {
  const [open, setOpen] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const m = jobMeta.get(j.jobId)
  const running = j.state === 'running'
  const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : running ? 0 : 100
  const logCount = j.log?.length ?? 0
  const canReveal = !!m?.target && m.kind === 'export' && j.state === 'done'

  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [open, logCount])

  const cancel = (): void => {
    api.cancelJob(j.jobId).catch((e) => toast(`Could not cancel: ${errorText(e)}`, 'error'))
  }

  return (
    <div className={`job tr-job tr-job-${j.state}`}>
      <div className="row">
        <StateIcon state={j.state} />
        <b className="grow ellipsis" title={j.title}>
          {j.title}
        </b>
        {running ? (
          <button className="btn small" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button className="btn ghost icon small" title="Dismiss" onClick={() => dismissJob(j.jobId)}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      <div className={`progress tr-${j.state} ${running && !j.total ? 'indeterminate' : ''}`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="row tr-small">
        <span className="grow ellipsis muted" title={j.message}>
          {j.message ?? STATE_LABEL[j.state]}
        </span>
        <span className="faint mono tr-nums">
          {j.total ? `${fmt(j.done)} / ${fmt(j.total)} · ${Math.floor(pct)}%` : j.done ? fmt(j.done) : ''}
        </span>
      </div>
      {j.state === 'error' && j.error && <div className="error-text selectable tr-small tr-job-errmsg">{j.error}</div>}
      {(logCount > 0 || canReveal) && (
        <div className="row tr-job-actions">
          {logCount > 0 && (
            <button className="btn ghost small" onClick={() => setOpen(!open)}>
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
              Log ({logCount})
            </button>
          )}
          <span className="spacer" />
          {canReveal && (
            <button className="btn small" onClick={() => void api.revealPath(m.target!).catch((e) => toast(errorText(e), 'error'))}>
              <Icon name="folder" size={13} />
              Show in folder
            </button>
          )}
        </div>
      )}
      {open && logCount > 0 && (
        <div className="job-log" ref={logRef}>
          {j.log!.join('\n')}
        </div>
      )}
    </div>
  )
}

export function JobsPanel(): ReactElement {
  const jobs = useStore((s) => s.jobs)
  const list = Object.values(jobs)

  useEffect(() => {
    for (const j of Object.values(jobs)) {
      const m = jobMeta.get(j.jobId)
      if (m?.kind !== 'import' || j.state === 'running' || refreshed.has(j.jobId)) continue
      refreshed.add(j.jobId)
      if (!useStore.getState().live[m.connId]) continue
      void refreshDatabases(m.connId)
      void refreshCollections(m.connId, m.db)
    }
  }, [jobs])

  if (!list.length) return <></>
  const finished = list.filter((j) => j.state !== 'running')
  return (
    <div className="jobs tr-jobs">
      {finished.length > 1 && (
        <div className="tr-jobs-head">
          <button className="btn small" onClick={() => finished.forEach((j) => dismissJob(j.jobId))}>
            Clear {finished.length} finished
          </button>
        </div>
      )}
      {list.map((j) => (
        <Job key={j.jobId} j={j} />
      ))}
    </div>
  )
}
