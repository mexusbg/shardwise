import type { AppSettings, SystemDateFormat } from '@shared/api'
import { formatPattern, localePattern, resolveZone, setDataDateDisplay } from '@shared/dateFormat'
import { useStore } from '../state/store'

/** Interface dates (history, tasks, files…) are always shown in the computer's own time zone. */

let system: SystemDateFormat = { locale: navigator.language }
let datePattern = 'yyyy-MM-dd'
let timePattern = 'HH:mm:ss'

export function systemPatterns(sys: SystemDateFormat): { date: string; time: string } {
  return { date: sys.datePattern || localePattern(sys.locale, 'date'), time: sys.timePattern || localePattern(sys.locale, 'time') }
}

/** Apply the date settings (call before the new settings reach the store, so the next render uses them). */
export function applyDateSettings(s: AppSettings, sys?: SystemDateFormat | null): void {
  if (sys) system = sys
  const defaults = systemPatterns(system)
  datePattern = s.dateFormat && s.dateFormat !== 'system' ? s.dateFormat : defaults.date
  timePattern = s.timeFormat && s.timeFormat !== 'system' ? s.timeFormat : defaults.time
  setDataDateDisplay({ zone: s.dataTimeZone || 'UTC', style: s.dataDateStyle === 'interface' ? 'pattern' : 'iso', pattern: `${datePattern} ${timePattern}`, locale: system.locale })
}

export const getSystemDateFormat = (): SystemDateFormat => system

/** Re-render memoized views when any date setting changes. */
export function useDateSettingsKey(): string {
  return useStore((st) => `${st.settings.dateFormat}|${st.settings.timeFormat}|${st.settings.dataTimeZone}|${st.settings.dataDateStyle}`)
}

const local = (): string => resolveZone('local')
const asDate = (d: Date | number | string): Date => (d instanceof Date ? d : new Date(d))
const withoutSeconds = (p: string): string => p.replace(/[:.]s{1,2}(?:[.,]f+)?/, '')

export const fmtDate = (d: Date | number | string): string => formatPattern(asDate(d), datePattern, local(), system.locale)
export const fmtTime = (d: Date | number | string, seconds = true): string => formatPattern(asDate(d), seconds ? timePattern : withoutSeconds(timePattern), local(), system.locale)
export const fmtDateTime = (d: Date | number | string, seconds = true): string => `${fmtDate(d)} ${fmtTime(d, seconds)}`
