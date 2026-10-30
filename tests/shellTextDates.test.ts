import { afterEach, describe, expect, it } from 'vitest'
import { parseShellValue, shellText } from '@shared/bsonValue'
import { setDataDateDisplay } from '@shared/dateFormat'

describe('shellText dates', () => {
  afterEach(() => {
    setDataDateDisplay({ zone: 'UTC' })
  })

  const doc = { at: new Date('2026-10-30T14:00:00.123Z'), summer: new Date('2026-07-01T00:00:00.000Z'), note: "ISODate('2026-10-30T14:00:00.123Z')" }

  it('keeps UTC when the date zone is UTC', () => {
    expect(shellText(doc)).toBe("{at:ISODate('2026-10-30T14:00:00.123Z'),summer:ISODate('2026-07-01T00:00:00.000Z'),note:'ISODate(\\'2026-10-30T14:00:00.123Z\\')'}")
  })

  it('writes dates in the chosen zone with the offset, and they parse back to the same instant', () => {
    setDataDateDisplay({ zone: 'Europe/Sofia' })
    const text = shellText(doc, 2)
    expect(text).toContain("ISODate('2026-10-30T16:00:00.123+02:00')")
    expect(text).toContain("ISODate('2026-07-01T03:00:00.000+03:00')")
    // String values that look like a date call stay as they are.
    expect(text).toContain("'ISODate(\\'2026-10-30T14:00:00.123Z\\')'")
    expect(parseShellValue(text)).toEqual(doc)
  })
})
