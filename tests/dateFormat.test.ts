import { afterEach, describe, expect, it } from 'vitest'
import { cellText, editText, parseTyped } from '@shared/bsonValue'
import { formatPattern, isoInZone, localePattern, parseDateInZone, setDataDateDisplay, zonedToDate } from '@shared/dateFormat'
import { autoCastFilter } from '@shared/autoCast'
import { parseRegQuery, posixToBcp47 } from '../src/main/systemDateFormat'

const summer = new Date('2026-07-15T09:05:07.042Z')
const winter = new Date('2026-01-05T21:30:00.000Z')

afterEach(() => setDataDateDisplay({ zone: 'UTC', style: 'iso', pattern: 'yyyy-MM-dd HH:mm:ss', locale: undefined }))

describe('formatPattern', () => {
  it('formats .NET-style tokens in a zone', () => {
    expect(formatPattern(summer, 'dd.MM.yyyy HH:mm:ss.fff', 'UTC')).toBe('15.07.2026 09:05:07.042')
    expect(formatPattern(summer, 'dd.MM.yyyy HH:mm', 'Europe/Sofia')).toBe('15.07.2026 12:05')
    expect(formatPattern(winter, 'd.M.yy H:mm', 'Europe/Sofia')).toBe('5.1.26 23:30')
    expect(formatPattern(winter, 'MM/dd/yyyy h:mm tt', 'America/New_York')).toBe('01/05/2026 4:30 PM')
    expect(formatPattern(summer, 'd MMM yyyy, dddd', 'UTC', 'en-US')).toBe('15 Jul 2026, Wednesday')
    expect(formatPattern(summer, "yyyy-MM-dd'T'HH:mm zzz", 'Asia/Kolkata')).toBe('2026-07-15T14:35 +05:30')
  })

  it('crosses the date line correctly', () => {
    expect(formatPattern(winter, 'yyyy-MM-dd', 'Pacific/Auckland')).toBe('2026-01-06')
    expect(formatPattern(winter, 'yyyy-MM-dd', 'Pacific/Honolulu')).toBe('2026-01-05')
  })
})

describe('isoInZone', () => {
  it('keeps UTC as Z and uses the zone offset (with DST) elsewhere', () => {
    expect(isoInZone(summer, 'UTC')).toBe('2026-07-15T09:05:07.042Z')
    expect(isoInZone(summer, 'Europe/Sofia')).toBe('2026-07-15T12:05:07.042+03:00')
    expect(isoInZone(winter, 'Europe/Sofia')).toBe('2026-01-05T23:30:00.000+02:00')
    expect(new Date(isoInZone(summer, 'America/Los_Angeles')).getTime()).toBe(summer.getTime())
  })
})

describe('localePattern (follow system)', () => {
  it('derives patterns from the locale', () => {
    expect(localePattern('en-US', 'date')).toBe('M/d/yyyy')
    expect(localePattern('en-US', 'time')).toBe('h:mm:ss tt')
    expect(localePattern('de-DE', 'date')).toBe('dd.MM.yyyy')
    expect(localePattern('de-DE', 'time')).toBe('HH:mm:ss')
    expect(localePattern('en-GB', 'date')).toBe('dd/MM/yyyy')
    expect(localePattern('ja-JP', 'date')).toBe('yyyy/MM/dd')
    expect(localePattern('bg-BG', 'date')).toMatch(/^d\.MM\.yyyy ?'г'\.$/)
    expect(formatPattern(summer, localePattern('bg-BG', 'date'), 'UTC')).toMatch(/^15\.07\.2026 ?г\.$/)
  })
})

describe('parseDateInZone', () => {
  it('reads wall-clock time in the zone, exact instants as given', () => {
    expect(parseDateInZone('2026-07-15 12:05', 'Europe/Sofia').toISOString()).toBe('2026-07-15T09:05:00.000Z')
    expect(parseDateInZone('2026-01-05', 'Europe/Sofia').toISOString()).toBe('2026-01-04T22:00:00.000Z')
    expect(parseDateInZone('2026-07-15T12:05:00Z', 'Europe/Sofia').toISOString()).toBe('2026-07-15T12:05:00.000Z')
    expect(parseDateInZone('2026-07-15T12:05:00+01:00', 'Europe/Sofia').toISOString()).toBe('2026-07-15T11:05:00.000Z')
    expect(parseDateInZone('2026-07-15T09:05:07.042', 'UTC').toISOString()).toBe(summer.toISOString())
  })

  it('rejects impossible dates and handles DST gaps', () => {
    expect(isNaN(parseDateInZone('2026-02-31', 'UTC').getTime())).toBe(true)
    expect(isNaN(parseDateInZone('2026-13-01', 'UTC').getTime())).toBe(true)
    // 03:30 does not exist in Sofia on 2026-03-29 (clocks jump 03:00 → 04:00).
    const gap = parseDateInZone('2026-03-29 03:30', 'Europe/Sofia')
    expect(isNaN(gap.getTime())).toBe(false)
    expect(zonedToDate({ year: 2026, month: 10, day: 25, hour: 3, minute: 30 }, 'Europe/Sofia').toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })
})

describe('database dates follow the display setting', () => {
  it('UTC ISO by default (unchanged behaviour)', () => {
    expect(cellText(summer)).toBe('2026-07-15T09:05:07.042Z')
    expect(editText(summer)).toBe('2026-07-15T09:05:07.042Z')
    expect((parseTyped('2026-07-15 09:05', 'date') as Date).toISOString()).toBe('2026-07-15T09:05:00.000Z')
  })

  it('a chosen zone round-trips through the editor', () => {
    setDataDateDisplay({ zone: 'Europe/Sofia' })
    expect(cellText(summer)).toBe('2026-07-15T12:05:07.042+03:00')
    const text = editText(summer)
    expect((parseTyped(text, 'date') as Date).getTime()).toBe(summer.getTime())
    expect((parseTyped('2026-07-15 12:05:07.042', 'date') as Date).getTime()).toBe(summer.getTime())
  })

  it('interface style uses the pattern, editing stays ISO', () => {
    setDataDateDisplay({ zone: 'Europe/Sofia', style: 'pattern', pattern: 'dd.MM.yyyy HH:mm:ss' })
    expect(cellText(summer)).toBe('15.07.2026 12:05:07')
    expect(editText(summer)).toBe('2026-07-15T12:05:07.042+03:00')
  })

  it('auto-cast query strings are read in the zone', () => {
    setDataDateDisplay({ zone: 'Europe/Sofia' })
    const { filter } = autoCastFilter({ createdAt: { $gte: '2026-01-05' } }, (p) => (p === 'createdAt' ? 'date' : undefined))
    expect(((filter.createdAt as { $gte: Date }).$gte).toISOString()).toBe('2026-01-04T22:00:00.000Z')
  })
})

describe('system date format', () => {
  it('maps POSIX locales', () => {
    expect(posixToBcp47('bg_BG.UTF-8')).toBe('bg-BG')
    expect(posixToBcp47('de_DE@euro')).toBe('de-DE')
    expect(posixToBcp47('C.UTF-8')).toBeNull()
    expect(posixToBcp47(undefined)).toBeNull()
  })

  it('reads Windows regional patterns from reg query output', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Control Panel\\International\r\n    Locale    REG_SZ    00000402\r\n    LocaleName    REG_SZ    bg-BG\r\n    sShortDate    REG_SZ    d.M.yyyy \'г.\'\r\n    sLongTime    REG_SZ    H:mm:ss ч.\r\n'
    expect(parseRegQuery(out)).toMatchObject({ LocaleName: 'bg-BG', sShortDate: "d.M.yyyy 'г.'", sLongTime: 'H:mm:ss ч.' })
  })
})
