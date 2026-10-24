import { useState } from 'react'
import type { ReactElement } from 'react'
import { shellText } from '@shared/bsonValue'
import type { CompareSummary, SyncDirection, SyncPlan, SyncRequest } from '@shared/compareApi'
import { connName, errorText } from '../../state/store'
import { Icon } from '../Icon'
import { confirmDialog, Modal, openModal } from '../Modal'
import { openSaveTaskDialog } from '../tasks/SaveTaskDialog'
import { compareApi } from './compareClient'

const fmt = (n: number): string => n.toLocaleString()
const docs = (n: number): string => `${fmt(n)} document${n === 1 ? '' : 's'}`

function Ns({ side }: { side: { connId: string; db: string; coll: string } }): ReactElement {
  return (
    <span className="cmp-ns">
      <span className="faint">{connName(side.connId)} · </span>
      <span className="mono">
        {side.db}.{side.coll}
      </span>
    </span>
  )
}

function SyncBody({ summary, close }: { summary: CompareSummary; close: (jobId: string | null) => void }): ReactElement {
  const r = summary.request
  const [direction, setDirection] = useState<SyncDirection>('sourceToTarget')
  const s2t = direction === 'sourceToTarget'
  const missing = s2t ? summary.onlySource : summary.onlyTarget
  const extra = s2t ? summary.onlyTarget : summary.onlySource
  const listed = (n: number): number => Math.min(n, summary.cap)
  const [insert, setInsert] = useState(summary.onlySource > 0)
  const [del, setDel] = useState(false)
  const [overwriteOn, setOverwriteOn] = useState(summary.different > 0 && summary.onlySource === 0)
  const [mode, setMode] = useState<'set' | 'replace'>('set')
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = s2t ? r.source : r.target
  const into = s2t ? r.target : r.source
  const request: SyncRequest = {
    compareJobId: summary.jobId,
    direction,
    insertMissing: insert && missing > 0,
    deleteExtra: del && extra > 0,
    overwrite: overwriteOn && summary.different > 0 ? mode : 'none'
  }
  const nothing = !request.insertMissing && !request.deleteExtra && request.overwrite === 'none'
  const changed = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v)
    setPlan(null)
    setError(null)
  }

  const dryRun = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setPlan(await compareApi.compareSyncPlan(request))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const saveTask = async (): Promise<void> => {
    const sync = { direction, insertMissing: request.insertMissing, deleteExtra: request.deleteExtra, overwrite: request.overwrite }
    const saved = await openSaveTaskDialog({ kind: 'compareSync', request: { compare: r, sync, dryRun: false } }, `Sync ${from.db}.${from.coll} → ${into.db}.${into.coll}`)
    if (saved) close(null)
  }

  const run = async (): Promise<void> => {
    let p = plan
    if (!p) {
      setBusy(true)
      try {
        p = await compareApi.compareSyncPlan(request)
        setPlan(p)
      } catch (e) {
        setError(errorText(e))
        return
      } finally {
        setBusy(false)
      }
    }
    const ok = await confirmDialog({
      title: 'Confirm sync',
      danger: p.deletes > 0,
      confirmLabel: 'Sync now',
      message: (
        <div className="col" style={{ gap: 10 }}>
          <div>
            Write to <Ns side={p.into} /> using <Ns side={p.from} />:
          </div>
          <ul className="cmp-confirm-list">
            {p.inserts > 0 && (
              <li>
                <b>Insert</b> {docs(p.inserts)} that are missing
              </li>
            )}
            {p.updates > 0 && (
              <li>
                <b>Overwrite</b> {docs(p.updates)} that differ ({request.overwrite === 'set' ? '$set / $unset the differing fields' : 'replace the whole document'})
              </li>
            )}
            {p.deletes > 0 && (
              <li className="error-text">
                <b>Delete</b> {docs(p.deletes)} that exist only there
              </li>
            )}
          </ul>
          {p.truncated && <div className="notice">Only the first {fmt(p.cap)} documents of each listed category are synced. Compare again afterwards for the rest.</div>}
          <div className="faint">Documents are read again before writing; those that changed meanwhile are skipped and logged. This cannot be undone.</div>
        </div>
      )
    })
    if (!ok) return
    setBusy(true)
    try {
      close(await compareApi.compareSyncStart(request))
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Sync collections"
      icon="compare"
      width={640}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" onClick={() => void dryRun()} disabled={busy || nothing} title="Show what would change without writing anything">
            <Icon name="view" size={13} /> Dry run
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => void saveTask()} disabled={busy || nothing} title="Compare and sync again later, on demand or on a schedule">
            <Icon name="tasks" size={13} /> Save as task…
          </button>
          <button className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className={`btn ${request.deleteExtra ? 'danger solid' : 'primary'}`} disabled={busy || nothing} onClick={() => void run()}>
            Sync…
          </button>
        </>
      }
    >
      <div className="cmp-sync">
        <div className="cmp-sync-dir">
          <div className="segmented">
            <button className={s2t ? 'on' : ''} onClick={() => changed(setDirection)('sourceToTarget')}>
              Source → Target
            </button>
            <button className={!s2t ? 'on' : ''} onClick={() => changed(setDirection)('targetToSource')}>
              Target → Source
            </button>
          </div>
          <div className="cmp-sync-flow">
            <Ns side={from} />
            <Icon name="chevronRight" size={14} />
            <span className="cmp-sync-into">
              <Ns side={into} />
            </span>
          </div>
        </div>

        <div className="cmp-sync-actions">
          <label className={`cmp-sync-action ${missing ? '' : 'disabled'}`}>
            <input type="checkbox" checked={insert && missing > 0} disabled={!missing} onChange={(e) => changed(setInsert)(e.target.checked)} />
            <span className="grow">
              <b>Insert missing</b>
              <span className="muted"> — copy {docs(listed(missing))} that exist only in {s2t ? 'the source' : 'the target'}</span>
            </span>
          </label>
          <label className={`cmp-sync-action ${summary.different ? '' : 'disabled'}`}>
            <input type="checkbox" checked={overwriteOn && summary.different > 0} disabled={!summary.different} onChange={(e) => changed(setOverwriteOn)(e.target.checked)} />
            <span className="grow">
              <b>Overwrite different</b>
              <span className="muted"> — {docs(listed(summary.different))}</span>
            </span>
            <select className="select small" value={mode} disabled={!overwriteOn || !summary.different} onChange={(e) => changed(setMode)(e.target.value as 'set' | 'replace')}>
              <option value="set">Update differing fields ($set)</option>
              <option value="replace">Replace whole document</option>
            </select>
          </label>
          <label className={`cmp-sync-action danger ${extra ? '' : 'disabled'}`}>
            <input type="checkbox" checked={del && extra > 0} disabled={!extra} onChange={(e) => changed(setDel)(e.target.checked)} />
            <span className="grow">
              <b>Delete extra</b>
              <span className="muted"> — remove {docs(listed(extra))} that exist only in {s2t ? 'the target' : 'the source'}</span>
            </span>
            <Icon name="warn" size={14} className="cmp-danger-icon" />
          </label>
        </div>

        {request.overwrite === 'set' && (
          <div className="faint cmp-sync-note">
            Ignored and excluded fields are left untouched; a change inside an array sets the whole array.
          </div>
        )}
        {request.overwrite === 'replace' && <div className="faint cmp-sync-note">The whole document is replaced, including ignored fields; the target's _id is kept.</div>}
        {summary.truncated.length > 0 && (
          <div className="notice cmp-sync-note">Lists were capped at {fmt(summary.cap)} documents per category: only listed documents are synced.</div>
        )}
        {error && <div className="notice error">{error}</div>}

        {plan && (
          <div className="cmp-plan">
            <div className="cmp-plan-head">
              <Icon name="view" size={13} /> Dry run — nothing was written
            </div>
            <div className="cmp-plan-counts">
              <span>
                <b>{fmt(plan.inserts)}</b> inserts
              </span>
              <span>
                <b>{fmt(plan.updates)}</b> overwrites
              </span>
              <span className={plan.deletes ? 'error-text' : ''}>
                <b>{fmt(plan.deletes)}</b> deletes
              </span>
            </div>
            {plan.sample.length > 0 && (
              <div className="cmp-plan-ops selectable">
                {plan.sample.map((o, i) => (
                  <div key={i} className={`cmp-op op-${o.op}`}>
                    <span className="cmp-op-kind">{o.op}</span>
                    <span className="mono ellipsis">{shellText(o.key)}</span>
                    {o.update && <span className="mono faint ellipsis cmp-op-upd">{shellText(o.update)}</span>}
                  </div>
                ))}
                {plan.inserts + plan.deletes + plan.updates > plan.sample.length && (
                  <div className="faint cmp-op-more">first {plan.sample.length} operations shown</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Choose direction and actions, preview with a dry run, confirm, start. Resolves with the sync job id. */
export function openSyncDialog(summary: CompareSummary): Promise<string | null> {
  return openModal<string | null>((close) => <SyncBody summary={summary} close={close} />)
}
