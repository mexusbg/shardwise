import type { ReactElement } from 'react'
import type { AppSettings } from '@shared/api'
import { DEFAULT_VALUE_COLORS, normalizeValueColors, VALUE_COLOR_TYPES, valueColor } from '@shared/valueColors'
import type { ThemeName, ValueColorKey } from '@shared/valueColors'

const THEMES: { theme: ThemeName; label: string; bg: string }[] = [
  { theme: 'light', label: 'Light theme', bg: '#ffffff' },
  { theme: 'dark', label: 'Dark theme', bg: '#1e1f22' }
]

/** Settings → Browsing data: colour of each value type in the table, tree and JSON views, per theme. */
export function ValueColorsSettings({ s, setS }: { s: AppSettings; setS: (s: AppSettings) => void }): ReactElement {
  const vc = s.valueColors ?? {}
  const set = (theme: ThemeName, key: ValueColorKey, color: string | null): void => {
    const next = { ...vc, [theme]: { ...vc[theme], [key]: color ?? undefined } }
    setS({ ...s, valueColors: normalizeValueColors(next) })
  }
  const changed = Object.keys(vc.light ?? {}).length + Object.keys(vc.dark ?? {}).length

  return (
    <div className="field top" data-pref="valueColors">
      <label>Value colours</label>
      <div style={{ minWidth: 0 }}>
        <div className="vcol-grid">
          <span />
          {THEMES.map((t) => (
            <span key={t.theme} className="vcol-head">
              {t.label}
            </span>
          ))}
          {VALUE_COLOR_TYPES.map((type) => (
            <div key={type.key} className="vcol-row">
              <span className="vcol-label">{type.label}</span>
              {THEMES.map(({ theme, bg }) => {
                const color = valueColor(vc, theme, type.key)
                const isDefault = color === DEFAULT_VALUE_COLORS[theme][type.key]
                return (
                  <span key={theme} className="vcol-cell">
                    <input
                      type="color"
                      className="vcol-pick"
                      value={color}
                      aria-label={`${type.label}, ${theme} theme`}
                      onChange={(e) => set(theme, type.key, e.target.value)}
                    />
                    <span className="vcol-sample mono" style={{ background: bg, color }}>
                      {type.sample}
                    </span>
                    <button className="btn ghost small" disabled={isDefault} onClick={() => set(theme, type.key, null)} title="Back to the default colour">
                      Reset
                    </button>
                  </span>
                )
              })}
            </div>
          ))}
        </div>
        <div className="pref-hint row" style={{ gap: 8 }}>
          <span>Table, tree and JSON views. Changes show after Save.</span>
          <span className="spacer" />
          <button className="btn small" disabled={!changed} onClick={() => setS({ ...s, valueColors: {} })}>
            Reset all colours
          </button>
        </div>
      </div>
    </div>
  )
}
