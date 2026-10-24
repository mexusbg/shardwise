import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_VALUE_COLORS, normalizeValueColors, valueColor, valueColorsCss } from '@shared/valueColors'
import { normalizeSettings } from '@shared/settings'

describe('value colours', () => {
  it('keeps valid overrides that differ from the defaults', () => {
    expect(
      normalizeValueColors({
        dark: { string: '#FF0000', number: DEFAULT_VALUE_COLORS.dark.number, bogus: '#000000', date: 'red' },
        light: 'nope',
        other: { string: '#00ff00' }
      })
    ).toEqual({ dark: { string: '#ff0000' } })
    expect(normalizeValueColors(null)).toEqual({})
  })

  it('falls back to the theme default', () => {
    const vc = { light: { oid: '#123456' } }
    expect(valueColor(vc, 'light', 'oid')).toBe('#123456')
    expect(valueColor(vc, 'dark', 'oid')).toBe(DEFAULT_VALUE_COLORS.dark.oid)
  })

  it('emits CSS that outranks the theme rules for both forced and system themes', () => {
    expect(valueColorsCss({})).toBe('')
    const css = valueColorsCss({ light: { string: '#111111' }, dark: { date: '#222222' } })
    expect(css).toContain("html:root[data-theme='light'] { --t-string: #111111; }")
    expect(css).toContain("@media (prefers-color-scheme: light) { html:root:not([data-theme='dark']) { --t-string: #111111; } }")
    expect(css).toContain("html:root[data-theme='dark'] { --t-date: #222222; }")
    expect(css).toContain("@media (prefers-color-scheme: dark) { html:root:not([data-theme='light']) { --t-date: #222222; } }")
  })

  it('defaults match the --t-* tokens in styles.css', () => {
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const block = (start: string): string => css.slice(css.indexOf(start), css.indexOf('}', css.indexOf(start)))
    const light = block(':root {')
    const dark = block(":root[data-theme='dark']") || block(':root[data-theme="dark"]') || block(':root[data-theme=dark]')
    for (const [key, color] of Object.entries(DEFAULT_VALUE_COLORS.light)) expect(light).toContain(`--t-${key}: ${color};`)
    for (const [key, color] of Object.entries(DEFAULT_VALUE_COLORS.dark)) expect(dark).toContain(`--t-${key}: ${color};`)
  })

  it('settings files without the field get an empty override set', () => {
    expect(normalizeSettings({}).valueColors).toEqual({})
    expect(normalizeSettings({ valueColors: { light: { bool: '#abcdef' } } }).valueColors).toEqual({ light: { bool: '#abcdef' } })
  })
})
