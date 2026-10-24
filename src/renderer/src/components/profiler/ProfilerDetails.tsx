import { useMemo } from 'react'
import type { ReactElement } from 'react'
import type { Doc } from '@shared/api'
import { shellText } from '@shared/bsonValue'
import { num, opLabel, profileQueryParts, profileWarnings } from '@shared/profile'
import { CodeEditor } from '../CodeEditor'
import { Icon } from '../Icon'
import { copyText, fmtMs, fmtNum, fmtTime, openEntryInTab, shellCommand } from './ProfilerCommon'

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'danger' }): ReactElement {
  return (
    <div className={`pf-metric ${tone ?? ''}`}>
      <div className="pf-metric-label">{label}</div>
      <div className="pf-metric-value">{value}</div>
    </div>
  )
}

export function ProfilerDetails({ connId, entry, onClose }: { connId: string; entry: Doc; onClose: () => void }): ReactElement {
  const warnings = useMemo(() => profileWarnings(entry), [entry])
  const shell = useMemo(() => shellCommand(entry), [entry])
  const json = useMemo(() => shellText(entry, 2), [entry])
  const parts = useMemo(() => profileQueryParts(entry), [entry])
  const examined = num(entry.docsExamined)
  const keys = num(entry.keysExamined)
  const returned = num(entry.nreturned)
  const ratio = Math.max(examined ?? 0, keys ?? 0) / Math.max(returned ?? 0, 1)
  const plan = typeof entry.planSummary === 'string' ? entry.planSummary : ''
  const app = [entry.appName, entry.client, entry.user].filter((x) => typeof x === 'string' && x).join(' · ')

  return (
    <div className="pf-details">
      <div className="pf-d-head">
        <span className="pf-op">{opLabel(entry)}</span>
        <span className="mono ellipsis grow selectable" title={String(entry.ns ?? '')}>
          {String(entry.ns ?? '')}
        </span>
        <button className="btn ghost icon small" title="Close details" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="pf-d-sub muted">
        {fmtTime(entry.ts)}
        {app && <> · {app}</>}
      </div>

      <div className="pf-metrics">
        <Metric label="Duration" value={fmtMs(num(entry.millis))} tone={(num(entry.millis) ?? 0) >= 1000 ? 'danger' : undefined} />
        <Metric label="Docs examined" value={fmtNum(examined)} tone={ratio > 10 && (examined ?? 0) > (keys ?? 0) ? 'warn' : undefined} />
        <Metric label="Keys examined" value={fmtNum(keys)} />
        <Metric label="Returned" value={fmtNum(returned ?? entry.nMatched ?? entry.ndeleted ?? entry.ninserted)} />
        <Metric label="Examined : returned" value={examined !== undefined || keys !== undefined ? `${fmtNum(Math.round(ratio))} : 1` : '—'} tone={ratio > 10 ? 'warn' : undefined} />
        <Metric label="Yields" value={fmtNum(entry.numYield)} />
        <Metric label="Response" value={entry.responseLength !== undefined ? `${fmtNum(entry.responseLength)} B` : '—'} />
        {entry.nModified !== undefined && <Metric label="Modified" value={fmtNum(entry.nModified)} />}
      </div>

      {plan && (
        <div className="pf-d-plan">
          <span className="muted">Plan</span>
          <span className={`mono selectable ${plan.includes('COLLSCAN') ? 'pf-bad' : ''}`}>{plan}</span>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="pf-warnings">
          {warnings.map((w) => (
            <div key={w.text} className={`pf-warning ${w.level}`}>
              <Icon name="warn" size={13} />
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="pf-d-section">
        <div className="pf-d-label">
          <span>Query</span>
          <span className="spacer" />
          <button
            className="btn small"
            disabled={!parts?.coll}
            title={parts?.coll ? `Open in a new ${parts.coll} tab` : 'Only queries (find, count, aggregate with a leading $match, update / delete filters) can be opened'}
            onClick={() => openEntryInTab(connId, entry)}
          >
            <Icon name="play" size={11} /> Open query in new tab
          </button>
          <button className="btn small" title="Copy in shell syntax" onClick={() => void copyText(shell)}>
            <Icon name="copy" size={13} /> Copy command
          </button>
        </div>
        <CodeEditor value={shell} readOnly maxHeight={220} />
      </div>

      <div className="pf-d-section pf-d-json">
        <div className="pf-d-label">
          <span>Profile document</span>
          <span className="spacer" />
          <button className="btn ghost small" onClick={() => void copyText(json, 'Document')}>
            <Icon name="copy" size={13} /> Copy
          </button>
        </div>
        <CodeEditor value={json} readOnly full className="pf-json" />
      </div>
    </div>
  )
}
