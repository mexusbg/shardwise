/**
 * Date formatting with .NET / Windows style patterns (`dd.MM.yyyy HH:mm:ss`) in any IANA time zone, and parsing of
 * typed date-times in a chosen zone. Used for interface dates (local time) and for date values stored in the database
 * (UTC, local time or a picked zone, see `setDataDateDisplay`).
 */

/** 'UTC', 'local' (the system zone) or an IANA name such as 'Europe/Sofia'. */
export type ZoneSetting = string

export interface DataDateDisplay {
  zone: ZoneSetting
  /** 'iso': 2026-10-22T09:15:00.000+03:00 · 'pattern': the interface date and time format. */
  style: 'iso' | 'pattern'
  /** Pattern used when style is 'pattern'. */
  pattern: string
  /** Locale for month and day names in patterns. */
  locale?: string
}

let display: DataDateDisplay = { zone: 'UTC', style: 'iso', pattern: 'yyyy-MM-dd HH:mm:ss' }

/** How date values from the database are shown and how typed dates without an offset are read. */
export function setDataDateDisplay(next: Partial<DataDateDisplay>): void {
  display = { ...display, ...next }
}

export function getDataDateDisplay(): DataDateDisplay {
  return display
}

export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** IANA name for a zone setting. */
export function resolveZone(zone: ZoneSetting): string {
  if (!zone || zone === 'UTC') return 'UTC'
  if (zone === 'local') return systemZone()
  return isValidZone(zone) ? zone : 'UTC'
}

const zoneOk = new Map<string, boolean>()
export function isValidZone(zone: string): boolean {
  let ok = zoneOk.get(zone)
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      ok = true
    } catch {
      ok = false
    }
    zoneOk.set(zone, ok)
  }
  return ok
}

/** All IANA zones the runtime knows (for pickers). */
export function timeZoneNames(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}

export interface ZonedParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
  ms: number
  weekday: number // 0 = Sunday
  /** Minutes east of UTC. */
  offset: number
}

const partFormatters = new Map<string, Intl.DateTimeFormat>()
function partFormatter(zone: string): Intl.DateTimeFormat {
  let f = partFormatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    partFormatters.set(zone, f)
  }
  return f
}

/** Calendar fields of `d` as seen in `zone` (IANA name or 'UTC'). */
export function zonedParts(d: Date, zone: string): ZonedParts {
  const t = d.getTime()
  const ms = ((t % 1000) + 1000) % 1000
  if (zone === 'UTC') {
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), ms, weekday: d.getUTCDay(), offset: 0 }
  }
  const p: Record<string, string> = {}
  for (const x of partFormatter(zone).formatToParts(d)) p[x.type] = x.value
  let year = Number(p.year)
  if (p.era === 'BC' || p.era === 'B') year = 1 - year
  const fields = { year, month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second), ms }
  const asUtc = utcMs(fields)
  const offset = Math.round((asUtc - t) / 60000)
  return { ...fields, weekday: new Date(asUtc).getUTCDay(), offset }
}

function utcMs(f: { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number }): number {
  const d = new Date(Date.UTC(2000, f.month - 1, f.day, f.hour, f.minute, f.second, f.ms))
  d.setUTCFullYear(f.year)
  return d.getTime()
}

/** The instant whose wall-clock time in `zone` is the given fields (gaps resolve forward, overlaps to the earlier). */
export function zonedToDate(f: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number; ms?: number }, zone: string): Date {
  const fields = { year: f.year, month: f.month, day: f.day, hour: f.hour ?? 0, minute: f.minute ?? 0, second: f.second ?? 0, ms: f.ms ?? 0 }
  const wall = utcMs(fields)
  if (zone === 'UTC') return new Date(wall)
  // Try the offsets in force a day before and after: both fit in an overlap (take the earlier instant), neither
  // fits in a gap (take the offset from before, which moves the time forward by the gap).
  const DAY = 86400000
  const before = wall - zonedParts(new Date(wall - DAY), zone).offset * 60000
  const after = wall - zonedParts(new Date(wall + DAY), zone).offset * 60000
  const fits = (t: number): boolean => {
    const p = zonedParts(new Date(t), zone)
    return p.hour === fields.hour && p.minute === fields.minute && p.day === fields.day
  }
  const ok = [before, after].filter(fits).sort((x, y) => x - y)
  return new Date(ok.length ? ok[0] : before)
}

const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0')
const offsetText = (min: number): string => `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`

/** ISO 8601 in a zone: `…Z` for UTC, otherwise with the zone's offset (`2026-10-22T12:06:57.123+03:00`). */
export function isoInZone(d: Date, zone: string): string {
  if (isNaN(d.getTime())) return 'Invalid Date'
  if (zone === 'UTC') return d.toISOString()
  const p = zonedParts(d, zone)
  if (p.year < 0 || p.year > 9999) return d.toISOString()
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(p.ms, 3)}${offsetText(p.offset)}`
}

const nameCache = new Map<string, string[]>()
function names(locale: string | undefined, kind: 'month' | 'weekday', width: 'short' | 'long'): string[] {
  const key = `${locale ?? ''}|${kind}|${width}`
  let list = nameCache.get(key)
  if (!list) {
    let f: Intl.DateTimeFormat
    try {
      f = new Intl.DateTimeFormat(locale, { [kind]: width, timeZone: 'UTC' })
    } catch {
      f = new Intl.DateTimeFormat('en-US', { [kind]: width, timeZone: 'UTC' })
    }
    // 2023-01-01 was a Sunday.
    list = kind === 'month' ? Array.from({ length: 12 }, (_, i) => f.format(Date.UTC(2023, i, 15))) : Array.from({ length: 7 }, (_, i) => f.format(Date.UTC(2023, 0, 1 + i)))
    nameCache.set(key, list)
  }
  return list
}

const TOKEN = /'[^']*'|\\.|yyyy|yyy|yy|y|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fff|ff|f|tt|t|zzz|zz|z|K/g

/**
 * Format with .NET / Windows tokens: yyyy yy y · MMMM MMM MM M · dddd ddd dd d · HH H hh h · mm m · ss s · fff ff f ·
 * tt t (AM/PM) · zzz zz z K (UTC offset) · 'literal' and \x escapes. Other characters are copied.
 */
export function formatPattern(d: Date, pattern: string, zone: string, locale?: string): string {
  if (isNaN(d.getTime())) return 'Invalid Date'
  const p = zonedParts(d, zone)
  const h12 = p.hour % 12 || 12
  return pattern.replace(TOKEN, (tok) => {
    if (tok.startsWith("'")) return tok.slice(1, -1)
    if (tok.startsWith('\\')) return tok.slice(1)
    switch (tok) {
      case 'yyyy':
      case 'yyy':
        return pad(p.year, tok.length)
      case 'yy':
        return pad(p.year % 100)
      case 'y':
        return String(p.year % 100)
      case 'MMMM':
        return names(locale, 'month', 'long')[p.month - 1]
      case 'MMM':
        return names(locale, 'month', 'short')[p.month - 1]
      case 'MM':
        return pad(p.month)
      case 'M':
        return String(p.month)
      case 'dddd':
        return names(locale, 'weekday', 'long')[p.weekday]
      case 'ddd':
        return names(locale, 'weekday', 'short')[p.weekday]
      case 'dd':
        return pad(p.day)
      case 'd':
        return String(p.day)
      case 'HH':
        return pad(p.hour)
      case 'H':
        return String(p.hour)
      case 'hh':
        return pad(h12)
      case 'h':
        return String(h12)
      case 'mm':
        return pad(p.minute)
      case 'm':
        return String(p.minute)
      case 'ss':
        return pad(p.second)
      case 's':
        return String(p.second)
      case 'fff':
        return pad(p.ms, 3)
      case 'ff':
        return pad(Math.floor(p.ms / 10))
      case 'f':
        return String(Math.floor(p.ms / 100))
      case 'tt':
        return p.hour < 12 ? 'AM' : 'PM'
      case 't':
        return p.hour < 12 ? 'A' : 'P'
      case 'zzz':
      case 'K':
        return zone === 'UTC' && tok === 'K' ? 'Z' : offsetText(p.offset)
      case 'zz':
        return `${p.offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(p.offset) / 60))}`
      case 'z':
        return `${p.offset < 0 ? '-' : '+'}${Math.floor(Math.abs(p.offset) / 60)}`
      default:
        return tok
    }
  })
}

/**
 * A pattern equivalent to how `locale` writes a short date or a time with seconds by default, built from Intl's
 * parts: 'bg-BG' → `d.MM.yyyy 'г.'`, 'en-US' → `M/d/yyyy` and `h:mm:ss tt`, 'de-DE' → `dd.MM.yyyy` and `HH:mm:ss`.
 */
export function localePattern(locale: string | undefined, kind: 'date' | 'time'): string {
  // The locale's standard short date and medium time, as an OS would show them (two-digit years become four).
  const opts: Intl.DateTimeFormatOptions = kind === 'date' ? { dateStyle: 'short', timeZone: 'UTC' } : { timeStyle: 'medium', timeZone: 'UTC' }
  let f: Intl.DateTimeFormat
  try {
    f = new Intl.DateTimeFormat(locale, opts)
  } catch {
    f = new Intl.DateTimeFormat('en-US', opts)
  }
  // Single-digit day, month and hour show whether the locale pads them.
  const early = f.formatToParts(Date.UTC(2023, 0, 5, 1, 4, 5))
  const width = (type: string): number => early.find((x) => x.type === type)?.value.length ?? 2
  const h12 = ['h11', 'h12'].includes(f.resolvedOptions().hourCycle ?? '')
  return early
    .map((part) => {
      switch (part.type) {
        case 'year':
          return 'yyyy'
        case 'month':
          return /^\d+$/.test(part.value) ? (width('month') >= 2 ? 'MM' : 'M') : 'MMM'
        case 'day':
          return width('day') >= 2 ? 'dd' : 'd'
        case 'hour':
          return (h12 ? 'h' : 'H').repeat(width('hour') >= 2 ? 2 : 1)
        case 'minute':
          return 'mm'
        case 'second':
          return 'ss'
        case 'dayPeriod':
          return 'tt'
        case 'literal':
          // Quote letters (e.g. Bulgarian "г."); Intl uses narrow no-break spaces before AM/PM.
          return part.value.replace(/\u202f|\u00a0/g, ' ').replace(/[^\s\d.,:/\-]+/g, (w) => `'${w.replace(/'/g, '')}'`)
        default:
          return ''
      }
    })
    .join('')
}

/** Text shown for a database date value (table cells, tree, value previews). */
export function dataDateText(d: Date): string {
  if (isNaN(d.getTime())) return 'Invalid Date'
  const zone = resolveZone(display.zone)
  return display.style === 'pattern' ? formatPattern(d, display.pattern, zone, display.locale) : isoInZone(d, zone)
}

/** Editable text for a database date: always ISO 8601 with the offset of the chosen zone, so it parses back exactly. */
export function dataDateEditText(d: Date): string {
  if (isNaN(d.getTime())) return ''
  return isoInZone(d, resolveZone(display.zone))
}

const LOCAL_DATE_TIME = /^(-?\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/

/**
 * Parse a date typed by the user. Text with `Z` or an offset is exact; a date or date-time without one is wall-clock
 * time in `zone` (default: the database date zone). Anything else goes to `new Date()`.
 */
export function parseDateInZone(text: string, zone: ZoneSetting = display.zone): Date {
  const t = text.trim()
  const m = LOCAL_DATE_TIME.exec(t)
  if (m) {
    const [, y, mo, d, h, mi, s, frac] = m
    const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0
    const month = Number(mo)
    const day = Number(d)
    if (month < 1 || month > 12 || day < 1 || day > 31) return new Date(NaN)
    const out = zonedToDate({ year: Number(y), month, day, hour: h ? Number(h) : 0, minute: mi ? Number(mi) : 0, second: s ? Number(s) : 0, ms }, resolveZone(zone))
    // Reject impossible days such as 2026-02-31 instead of rolling them over.
    return zonedParts(out, resolveZone(zone)).day === day ? out : new Date(NaN)
  }
  return new Date(t.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'))
}
