import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ChangeHistorySettings as Settings, ChangeHistoryStats } from '@shared/changeHistoryApi'
import { errorText, toast } from '../../state/store'
import { Icon } from '../Icon'
import { changesApi } from './changesClient'
import { bytes, fullTime, num } from './format'
import './changes.css'

type NumKey = 'retentionDays' | 'maxSizeMB' | 'maxDocsPerOp'

const FIELDS: { key: NumKey; label: string; unit: string; hint: string; min: number }[] = [
  { key: 'retentionDays', label: 'Keep changes for', unit: 'days', hint: '0 keeps them until the size limit is reached', min: 0 },
  { key: 'maxSizeMB', label: 'Maximum size', unit: 'MB', hint: 'Oldest changes are removed first', min: 1 },
  { key: 'maxDocsPerOp', label: 'Per operation', unit: 'documents', hint: 'Larger multi-document writes ask before running without history', min: 1 }
]

/** Change History preferences (enable, retention, limits) with storage statistics. Changes apply immediately. */
export function ChangeHistorySettings({ compact = false, onChanged }: { compact?: boolean; onChanged?: (s: Settings) => void }): ReactElement {
  const [s, setS] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Record<NumKey, string>>({ retentionDays: '', maxSizeMB: '', maxDocsPerOp: '' })
  const [stats, setStats] = useState<ChangeHistoryStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = (next: Settings): void => {
    setS(next)
    setDraft({ retentionDays: String(next.retentionDays), maxSizeMB: String(next.maxSizeMB), maxDocsPerOp: String(next.maxDocsPerOp) })
  }

  const loadStats = useCallback(() => {
    changesApi.changesStats().then(setStats, () => setStats(null))
  }, [])

  useEffect(() => {
    changesApi.changesGetSettings().then(apply, (e) => setError(errorText(e)))
    loadStats()
  }, [loadStats])

  const save = async (p: Partial<Settings>): Promise<void> => {
    try {
      const next = await changesApi.changesSaveSettings(p)
      apply(next)
      onChanged?.(next)
      loadStats()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const commit = (key: NumKey): void => {
    if (!s) return
    const n = Math.floor(Number(draft[key]))
    if (!Number.isFinite(n) || draft[key].trim() === '') return setDraft((d) => ({ ...d, [key]: String(s[key]) }))
    if (n !== s[key]) void save({ [key]: n })
  }

  if (error) return <div className="notice error">{error}</div>
  if (!s) return <div className="muted">Loading…</div>

  return (
    <div className={`chs ${compact ? 'compact' : ''}`}>
      <label className="chs-enable">
        <input type="checkbox" checked={s.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        <span>
          <b>Record changes</b>
          <span className="muted"> — keep the previous version of every document edited, deleted or overwritten through Shardwise</span>
        </span>
      </label>
      <div className={`chs-fields ${s.enabled ? '' : 'off'}`}>
        {FIELDS.map((f) => (
          <div className="chs-field" key={f.key}>
            <label htmlFor={`chs-${f.key}`}>{f.label}</label>
            <div className="chs-input">
              <input
                id={`chs-${f.key}`}
                className="input small"
                type="number"
                min={f.min}
                value={draft[f.key]}
                disabled={!s.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                onBlur={() => commit(f.key)}
                onKeyDown={(e) => e.key === 'Enter' && commit(f.key)}
              />
              <span className="muted">{f.unit}</span>
            </div>
            {!compact && <div className="chs-hint faint">{f.hint}</div>}
          </div>
        ))}
      </div>
      <div className="chs-stats">
        <Icon name="database" size={13} />
        {stats ? (
          <span>
            {num(stats.count)} change{stats.count === 1 ? '' : 's'} · {bytes(stats.bytes)} of {bytes(s.maxSizeMB * 1024 * 1024)}
            {stats.oldest && <span className="faint"> · since {fullTime(stats.oldest)}</span>}
          </span>
        ) : (
          <span className="faint">No statistics</span>
        )}
        <span className="spacer" />
        <button className="btn ghost icon small" title="Refresh" onClick={loadStats}>
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {stats?.lastError && (
        <div className="notice chs-error">
          <b>Last capture problem</b> ({fullTime(stats.lastError.at)}): {stats.lastError.message}. The write itself went through.
        </div>
      )}
    </div>
  )
}
