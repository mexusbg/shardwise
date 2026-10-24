import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppSettings } from '@shared/api'
import { formatPattern, isoInZone, isValidZone, resolveZone, systemZone, timeZoneNames } from '@shared/dateFormat'
import { getSystemDateFormat, systemPatterns } from '../lib/datetime'

const DATE_PRESETS = ['dd.MM.yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'd MMM yyyy']
const TIME_PRESETS: [string, string][] = [
  ['HH:mm:ss', '24-hour'],
  ['h:mm:ss tt', '12-hour']
]

function PatternPicker({
  value,
  presets,
  systemPattern,
  sample,
  onChange
}: {
  value: string
  presets: [string, string][]
  systemPattern: string
  sample: (pattern: string) => string
  onChange: (v: string) => void
}): ReactElement {
  const isPreset = value === 'system' || presets.some(([p]) => p === value)
  const [custom, setCustom] = useState(!isPreset)
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <select
        className="select"
        value={custom ? 'custom' : value}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true)
            onChange(value === 'system' ? systemPattern : value)
          } else {
            setCustom(false)
            onChange(e.target.value)
          }
        }}
      >
        <option value="system">Follow system ({sample(systemPattern)})</option>
        {presets.map(([p, label]) => (
          <option key={p} value={p}>
            {label} ({sample(p)})
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom && <input className="input mono" style={{ width: 170 }} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />}
    </div>
  )
}

export function DateSettings({ s, setS }: { s: AppSettings; setS: (s: AppSettings) => void }): ReactElement {
  const sys = getSystemDateFormat()
  const sysPatterns = systemPatterns(sys)
  const now = useMemo(() => new Date(), [])
  const local = systemZone()
  const zones = useMemo(() => timeZoneNames(), [])
  const zoneMode = s.dataTimeZone === 'UTC' || s.dataTimeZone === 'local' ? s.dataTimeZone : 'zone'
  const [zoneText, setZoneText] = useState(zoneMode === 'zone' ? s.dataTimeZone : '')
  const zoneBad = zoneMode === 'zone' && !isValidZone(s.dataTimeZone)

  const datePattern = s.dateFormat === 'system' ? sysPatterns.date : s.dateFormat
  const timePattern = s.timeFormat === 'system' ? sysPatterns.time : s.timeFormat
  const sampleLocal = (p: string): string => formatPattern(now, p, resolveZone('local'), sys.locale)
  const dataZone = resolveZone(zoneBad ? 'UTC' : s.dataTimeZone)
  const dataSample = s.dataDateStyle === 'interface' ? formatPattern(now, `${datePattern} ${timePattern}`, dataZone, sys.locale) : isoInZone(now, dataZone)

  return (
    <>
      <div className="section-title">Interface</div>
      <div className="field">
        <label>Date format</label>
        <PatternPicker value={s.dateFormat} presets={DATE_PRESETS.map((p) => [p, p])} systemPattern={sysPatterns.date} sample={sampleLocal} onChange={(v) => setS({ ...s, dateFormat: v || 'system' })} />
      </div>
      <div className="field">
        <label>Time format</label>
        <PatternPicker value={s.timeFormat} presets={TIME_PRESETS} systemPattern={sysPatterns.time} sample={sampleLocal} onChange={(v) => setS({ ...s, timeFormat: v || 'system' })} />
      </div>
      <div className="field">
        <label />
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Used for query history, tasks, files and other app dates, in this computer's time zone ({local}). System format: {sys.locale}
          {sys.datePattern ? ` · ${sys.datePattern} ${sys.timePattern ?? ''}` : ''}. Custom patterns: <span className="mono">yyyy MM M MMM dd d HH H hh h mm ss fff tt</span>,{' '}
          text in <span className="mono">'quotes'</span>.
        </div>
      </div>

      <div className="section-title">Dates stored in the database</div>
      <div className="field">
        <label>Time zone</label>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="segmented">
            <button className={zoneMode === 'UTC' ? 'on' : ''} onClick={() => setS({ ...s, dataTimeZone: 'UTC' })}>
              UTC
            </button>
            <button className={zoneMode === 'local' ? 'on' : ''} onClick={() => setS({ ...s, dataTimeZone: 'local' })} title={local}>
              Local ({local})
            </button>
            <button className={zoneMode === 'zone' ? 'on' : ''} onClick={() => setS({ ...s, dataTimeZone: zoneText && isValidZone(zoneText) ? zoneText : local })}>
              Time zone…
            </button>
          </div>
          {zoneMode === 'zone' && (
            <>
              <input
                className={`input mono ${zoneBad ? 'invalid' : ''}`}
                style={{ width: 210 }}
                list="tz-names"
                value={zoneText || s.dataTimeZone}
                placeholder="Europe/Sofia"
                onChange={(e) => {
                  setZoneText(e.target.value)
                  setS({ ...s, dataTimeZone: e.target.value.trim() })
                }}
                spellCheck={false}
              />
              <datalist id="tz-names">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </>
          )}
        </div>
      </div>
      {zoneBad && (
        <div className="field">
          <label />
          <span className="error-text">Unknown time zone; UTC is used until it is fixed.</span>
        </div>
      )}
      <div className="field">
        <label>Show as</label>
        <div className="segmented">
          <button className={s.dataDateStyle === 'iso' ? 'on' : ''} onClick={() => setS({ ...s, dataDateStyle: 'iso' })}>
            ISO 8601
          </button>
          <button className={s.dataDateStyle === 'interface' ? 'on' : ''} onClick={() => setS({ ...s, dataDateStyle: 'interface' })}>
            Interface format
          </button>
        </div>
      </div>
      <div className="field">
        <label>Preview</label>
        <span className="mono">{dataSample}</span>
      </div>
      <div className="field">
        <label />
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Applies to table and tree cells and to value editors. Editors always show ISO 8601 with the zone's offset, and dates typed without an
          offset (in editors, the filter builder and auto-cast queries) are read in this zone. The JSON view, <span className="mono">ISODate()</span>{' '}
          in queries and exports stay in UTC.
        </div>
      </div>
    </>
  )
}
