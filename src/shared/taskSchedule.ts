import type { TaskSchedule } from './tasksApi'

/** Schedule math in local time. Daily / weekly runs are built from calendar fields, so DST shifts keep the wall-clock time. */

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MINUTE = 60_000

export function parseTime(t: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

export function intervalMs(s: Extract<TaskSchedule, { kind: 'interval' }>): number {
  return Math.max(1, Math.floor(s.every)) * (s.unit === 'hours' ? 60 : 1) * MINUTE
}

export function validateSchedule(s: TaskSchedule): string | null {
  switch (s.kind) {
    case 'none':
      return null
    case 'once':
      return typeof s.at?.getTime === 'function' && !isNaN(s.at.getTime()) ? null : 'Choose a date and time'
    case 'interval':
      return Number.isFinite(s.every) && s.every >= 1 && Number.isInteger(s.every) ? null : 'Enter a whole number of at least 1'
    case 'daily':
      return parseTime(s.time) ? null : 'Enter a time as HH:MM'
    case 'weekly':
      if (!s.days.length) return 'Choose at least one day'
      return parseTime(s.time) ? null : 'Enter a time as HH:MM'
  }
}

/** First run strictly after `after`; null when the schedule never runs again. */
export function nextRunAfter(s: TaskSchedule, after: Date): Date | null {
  if (validateSchedule(s)) return null
  switch (s.kind) {
    case 'none':
      return null
    case 'once':
      return s.at.getTime() > after.getTime() ? new Date(s.at) : null
    case 'interval':
      return new Date(after.getTime() + intervalMs(s))
    case 'daily':
    case 'weekly': {
      const t = parseTime(s.time)!
      const days = s.kind === 'weekly' ? new Set(s.days) : null
      for (let i = 0; i <= 8; i++) {
        const c = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, t.h, t.m, 0, 0)
        if (c.getTime() <= after.getTime()) continue
        // getDay() of the calendar day, not of the (possibly DST-shifted) instant.
        const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, 12).getDay()
        if (!days || days.has(day)) return c
      }
      return null
    }
  }
}

/**
 * Next run once a run due at `due` was handled at `now`. Intervals stay aligned to their original slots (a late
 * run does not shift later ones); the other kinds take the next slot after `now`.
 */
export function advanceSchedule(s: TaskSchedule, due: Date, now: Date): Date | null {
  if (s.kind === 'interval' && !validateSchedule(s)) {
    const p = intervalMs(s)
    const steps = Math.max(1, Math.floor((now.getTime() - due.getTime()) / p) + 1)
    return new Date(due.getTime() + steps * p)
  }
  return nextRunAfter(s, now)
}

/** The next `count` runs after `after`, for previews. */
export function upcomingRuns(s: TaskSchedule, after: Date, count: number): Date[] {
  const out: Date[] = []
  let cur = after
  for (let i = 0; i < count; i++) {
    const n = nextRunAfter(s, cur)
    if (!n) break
    out.push(n)
    cur = n
  }
  return out
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `when` formats the date of one-off runs (defaults to the runtime's locale). */
export function scheduleText(s: TaskSchedule, when?: (d: Date) => string): string {
  switch (s.kind) {
    case 'none':
      return 'Manual'
    case 'once':
      return `Once on ${when ? when(s.at) : `${s.at.toLocaleDateString()} ${pad(s.at.getHours())}:${pad(s.at.getMinutes())}`}`
    case 'interval':
      return `Every ${s.every === 1 ? '' : `${s.every} `}${s.unit === 'hours' ? (s.every === 1 ? 'hour' : 'hours') : s.every === 1 ? 'minute' : 'minutes'}`
    case 'daily':
      return `Daily at ${s.time}`
    case 'weekly': {
      const days = [...s.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      const key = days.join(',')
      const label = key === '1,2,3,4,5' ? 'Weekdays' : key === '6,0' ? 'Weekends' : days.length === 7 ? 'Every day' : days.map((d) => DAY_NAMES[d]).join(', ')
      return `${label} at ${s.time}`
    }
  }
}
