import type { ReactElement, ReactNode } from 'react'
import type { JobProgress } from '@shared/api'
import { Icon } from '../Icon'
import { Modal, openModal } from '../Modal'

export function PreviewTable({ columns, rows }: { columns: string[]; rows: (string | null)[][] }): ReactElement {
  return (
    <div className="mig-grid-wrap">
      <table className="mig-grid">
        <thead>
          <tr>
            <th className="rownum">#</th>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="rownum">{i + 1}</td>
              {r.map((v, j) => (
                <td key={j} className={v === null ? 'null' : ''} title={v ?? 'NULL'}>
                  {v ?? 'NULL'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="faint mig-pad">No rows</div>}
    </div>
  )
}

function showLog(job: JobProgress): void {
  void openModal<void>((close) => (
    <Modal title={job.title} icon="history" width={720} onClose={() => close()} footer={<button className="btn" onClick={() => close()}>Close</button>}>
      <pre className="mig-log selectable">{(job.log ?? []).join('\n') || 'No log lines'}</pre>
    </Modal>
  ))
}

/** Inline progress / result of the last migration job of a panel. */
export function JobStatus({ job, onCancel, extra }: { job?: JobProgress; onCancel: () => void; extra?: ReactNode }): ReactElement | null {
  if (!job) return null
  const pct = job.total ? Math.min(100, (job.done / job.total) * 100) : 0
  const logButton = (job.log?.length ?? 0) > 0 && (
    <button className="btn ghost small" onClick={() => showLog(job)} title="Show the job log">
      Log
    </button>
  )
  if (job.state === 'running')
    return (
      <div className="mig-job">
        <div className="mig-job-text">
          <span className="ellipsis faint mig-small">{job.message ?? 'Working…'}</span>
          <div className={`progress ${job.total ? '' : 'indeterminate'}`}>
            <div style={{ width: `${pct}%` }} />
          </div>
        </div>
        <button className="btn small" onClick={onCancel}>
          <Icon name="close" size={12} /> Cancel
        </button>
      </div>
    )
  return (
    <div className={`mig-job done s-${job.state}`}>
      <Icon name={job.state === 'done' ? 'check' : 'warn'} size={13} />
      <span className="ellipsis mig-small" title={job.error ?? job.message}>
        {job.state === 'done' ? job.message : job.state === 'cancelled' ? `Cancelled${job.message && job.message !== 'Cancelled' ? ` — ${job.message}` : ''}` : (job.error ?? 'Failed')}
      </span>
      {logButton}
      {extra}
    </div>
  )
}
