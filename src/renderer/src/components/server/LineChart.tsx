import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { niceBytesMax, niceMax } from '@shared/serverStats'
import { fmtTime } from '../../lib/datetime'

export interface ChartSeries {
  key: string
  label: string
  /** CSS colour, e.g. `var(--sv-1)`. */
  color: string
  values: (number | null)[]
}

interface Props {
  title: string
  times: number[]
  series: ChartSeries[]
  format: (v: number) => string
  /** Shorter labels for the y axis. */
  axisFormat?: (v: number) => string
  windowMs: number
  /** Right edge of the time axis. */
  now: number
  /** Fixed axis maximum (e.g. 100 for percentages). */
  max?: number
  /** Axis maximum in binary units. */
  bytes?: boolean
  /** Fill under a single series. */
  area?: boolean
  /** Points further apart than this are not joined (pause, hidden tab). */
  gapMs: number
  height?: number
}

const PAD = { left: 50, right: 10, top: 10, bottom: 20 }

const clock = (t: number): string => fmtTime(t)

function lastValue(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i]
  return null
}

/** Lightweight SVG line / area chart over a rolling time window, with a hover crosshair. */
export function LineChart({ title, times, series, format, axisFormat = format, windowMs, now, max, bytes, area, gapMs, height = 150 }: Props): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const plotW = Math.max(10, width - PAD.left - PAD.right)
  const plotH = height - PAD.top - PAD.bottom
  const t0 = now - windowMs
  const x = (t: number): number => PAD.left + ((t - t0) / windowMs) * plotW

  const yMax = useMemo(() => {
    if (max != null) return max
    let m = 0
    for (const s of series) for (const v of s.values) if (v != null && v > m) m = v
    return bytes ? niceBytesMax(m) : niceMax(m)
  }, [series, max, bytes])
  const y = (v: number): number => PAD.top + plotH - (Math.min(v, yMax) / yMax) * plotH

  const paths = useMemo(() => {
    return series.map((s) => {
      const segs: [number, number][][] = []
      let cur: [number, number][] | null = null
      for (let i = 0; i < times.length; i++) {
        const v = s.values[i]
        const joined = i > 0 && times[i] - times[i - 1] <= gapMs
        if (v == null || times[i] < t0) {
          cur = null
          continue
        }
        if (!cur || !joined) segs.push((cur = []))
        cur.push([x(times[i]), y(v)])
      }
      const line = segs.map((pts) => (pts.length === 1 ? `M${pts[0][0] - 1.5},${pts[0][1]}h3` : pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(''))).join('')
      const base = PAD.top + plotH
      const fill = area
        ? segs
            .filter((pts) => pts.length > 1)
            .map((pts) => `M${pts[0][0].toFixed(1)},${base}${pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}L${pts[pts.length - 1][0].toFixed(1)},${base}Z`)
            .join('')
        : ''
      return { key: s.key, color: s.color, line, fill }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, times, width, yMax, now, windowMs, gapMs, area, height])

  const onMove = (e: ReactMouseEvent<SVGSVGElement>): void => {
    if (!times.length) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = t0 + ((e.clientX - r.left - PAD.left) / plotW) * windowMs
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i] - t)
      if (d < bestD && times[i] >= t0) {
        bestD = d
        best = i
      }
    }
    setHover(best >= 0 ? best : null)
  }

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax)
  const minuteTicks: number[] = []
  for (let m = 0; m * 60000 <= windowMs; m++) minuteTicks.push(now - m * 60000)
  const hx = hover != null && times[hover] != null ? x(times[hover]) : null
  const tipLeft = hx != null && hx > width - 190

  return (
    <div className="sv-chart">
      <div className="sv-chart-head">
        <span className="sv-chart-title">{title}</span>
        <span className="sv-legend">
          {series.map((s) => {
            const v = lastValue(s.values)
            return (
              <span key={s.key} className="sv-legend-item" title={s.label}>
                <i style={{ background: s.color }} />
                {s.label}
                <b>{v == null ? '—' : format(v)}</b>
              </span>
            )
          })}
        </span>
      </div>
      <div className="sv-chart-plot" ref={box} style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={title}>
            {gridVals.map((v, i) => (
              <g key={i}>
                <line className={i === 0 ? 'sv-axis' : 'sv-grid'} x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
                <text className="sv-tick" x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end">
                  {axisFormat(v)}
                </text>
              </g>
            ))}
            {minuteTicks.map((t, i) => (
              <text key={t} className="sv-tick" x={x(t)} y={height - 5} textAnchor={i === 0 ? 'end' : 'middle'}>
                {i === 0 ? 'now' : `−${i}m`}
              </text>
            ))}
            {paths.map((p) => p.fill && <path key={`${p.key}-f`} d={p.fill} style={{ fill: p.color }} className="sv-area" />)}
            {paths.map((p) => (
              <path key={p.key} d={p.line} style={{ stroke: p.color }} className="sv-line" />
            ))}
            {times.length < 2 && (
              <text className="sv-tick" x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle">
                Collecting data…
              </text>
            )}
            {hx != null && (
              <g>
                <line className="sv-cross" x1={hx} x2={hx} y1={PAD.top} y2={PAD.top + plotH} />
                {series.map((s) => {
                  const v = s.values[hover!]
                  return v == null ? null : <circle key={s.key} cx={hx} cy={y(v)} r={3.5} className="sv-dot" style={{ fill: s.color }} />
                })}
              </g>
            )}
          </svg>
        )}
        {hx != null && (
          <div className="sv-tip" style={tipLeft ? { right: width - hx + 12 } : { left: hx + 12 }}>
            <div className="sv-tip-time">{clock(times[hover!])}</div>
            {series.map((s) => {
              const v = s.values[hover!]
              return (
                <div key={s.key} className="sv-tip-row">
                  <i style={{ background: s.color }} />
                  <span>{s.label}</span>
                  <b>{v == null ? '—' : format(v)}</b>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
