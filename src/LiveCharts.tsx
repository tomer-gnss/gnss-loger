import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useWidth } from './useWidth'
import { toLocal } from './geo'


const NICE = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
const niceAbove = (v: number) => NICE.find((n) => n >= v) ?? Math.ceil(v / 1000) * 1000
/** Tight "nice" axis top (…, 1000, 1200, 1500, 2000, 2500, …) so bars use the plot height. */
const niceTop = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(v))
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((k) => k * p >= v) ?? 10
  return step * p
}
const fmtM =(m: number) => (m < 10 ? m.toFixed(1) : Math.round(m).toString())
const clock = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour12: false })

export type GeoPoint = { t: number; lat: number; lon: number; acc: number | null }

/**
 * Fixes in local metres. 'recent': the last 120 fixes fading by age around their mean (jitter view).
 * 'track': a whole recorded path with the fix at `current` highlighted.
 */
export function ScatterPlot({ points, center, mode = 'recent', current }: {
  points: GeoPoint[]
  center: { lat: number; lon: number }
  mode?: 'recent' | 'track'
  current?: number
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const size = Math.min(width, 420)
  const shown = mode === 'recent' ? points.slice(-120) : points
  const step = Math.max(1, Math.ceil(shown.length / 1500)) // keep the SVG light on phones
  const pts = toLocal(shown, center.lat, center.lon)
  const curIdx = mode === 'recent' ? pts.length - 1 : Math.min(current ?? pts.length - 1, pts.length - 1)
  const cur = shown[curIdx]
  const curPt = pts[curIdx]
  const maxDist = pts.reduce((m, p) => Math.max(m, Math.hypot(p.e, p.n)), 0)
  const curReach = cur && cur.acc !== null && mode === 'recent' ? Math.hypot(curPt.e, curPt.n) + cur.acc : 0
  const extent = niceAbove(Math.max(maxDist, curReach, 1) * 1.08)
  const pad = 22
  const r = size / 2 - pad
  const c = size / 2
  const s = r / extent
  const rings = [extent / 2, extent]
  const X = (p: { e: number }) => c + p.e * s
  const Y = (p: { n: number }) => c - p.n * s
  const track = mode === 'track' ? pts.filter((_, i) => i % step === 0).map((p, i) => `${i ? 'L' : 'M'} ${X(p).toFixed(1)} ${Y(p).toFixed(1)}`).join(' ') : ''

  return (
    <div ref={ref} className="chart-box">
      <svg width={size} height={size} className="scatter" role="img" aria-label={mode === 'recent' ? `פיזור ${shown.length} פתרונות אחרונים סביב המיקום הממוצע, רדיוס ${fmtM(extent)} מטר` : `מסלול של ${shown.length} פתרונות, רדיוס ${fmtM(extent)} מטר`}>
        {rings.map((ring) => <circle key={ring} cx={c} cy={c} r={ring * s} className="grid-ring" />)}
        <path d={`M ${c - r} ${c} H ${c + r} M ${c} ${c - r} V ${c + r}`} className="grid-line" />
        {rings.map((ring) => <text key={ring} x={c + ring * s * 0.707 + 4} y={c + ring * s * 0.707 + 12} className="axis-text ring-text">{fmtM(ring)} m</text>)}
        <text x={c} y={pad - 8} className="axis-text" textAnchor="middle">N</text>
        <text x={size - pad + 9} y={c + 4} className="axis-text" textAnchor="middle">E</text>
        {cur && cur.acc !== null && <circle cx={X(curPt)} cy={Y(curPt)} r={Math.max(4, cur.acc * s)} className="acc-circle" />}
        {mode === 'track' && <path d={track} className="track-line" />}
        {mode === 'recent' && pts.map((p, i) => {
          if (i === curIdx) return null
          const age = (pts.length - 1 - i) / pts.length
          return <circle key={shown[i].t + ':' + i} cx={X(p)} cy={Y(p)} r={4} className="scatter-dot" style={{ opacity: 0.85 - age * 0.65 }}><title>{`${clock(shown[i].t)}${shown[i].acc !== null ? ` · ±${fmtM(shown[i].acc!)} m` : ''}`}</title></circle>
        })}
        {cur && <g transform={`translate(${X(curPt)} ${Y(curPt)})`}><circle r={9} className="scatter-now-halo" /><circle r={6} className="scatter-now" /><title>{`${clock(cur.t)}${cur.acc !== null ? ` · ±${fmtM(cur.acc)} m` : ''}`}</title></g>}
      </svg>
    </div>
  )
}

type Series = { t: number; v: number }

/** Single-series time chart (line or bars) with a touch/hover crosshair. */
export function TimeChart({ data, kind, unit, format, refValue, refLabel, ariaLabel, markerIndex, onPick, endLabel, fmtTime }: {
  data: Series[]
  kind: 'line' | 'bars'
  unit: string
  format: (v: number) => string
  refValue?: number
  refLabel?: string
  ariaLabel: string
  /** Playhead position (index into data). */
  markerIndex?: number
  /** Tap / drag on the chart seeks to that index. */
  onPick?: (i: number) => void
  /** Right-hand time label; defaults to "עכשיו" (now) for live charts. */
  endLabel?: string
  /** Time formatter for axis/tooltip (logs use UTC). */
  fmtTime?: (t: number) => string
}) {
  const tfmt = fmtTime ?? clock
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const height = 132
  const m = { top: 12, right: 8, bottom: 6, left: 40 }
  const w = width - m.left - m.right
  const h = height - m.top - m.bottom
  // A loop, not Math.max(...data): spreading 65k+ values overflows the call stack on iOS.
  let maxV = Math.max(refValue ?? 0, 1e-6)
  for (const d of data) if (Number.isFinite(d.v) && d.v > maxV) maxV = d.v
  const top = niceTop(maxV * 1.05)
  const y = (v: number) => m.top + h - (v / top) * h
  const n = data.length
  const x = (i: number) => m.left + (n <= 1 ? w : (i / (n - 1)) * w)
  const band = n ? w / n : w
  const bx = (i: number) => m.left + i * band
  const hi = hover !== null && hover < n ? hover : null

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!n) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left - m.left
    const i = Math.min(n - 1, Math.max(0, kind === 'bars' ? Math.floor(px / band) : Math.round((px / w) * (n - 1))))
    setHover(i)
    // Seek only on press/drag — a hovering mouse just inspects.
    if (onPick && (e.type === 'pointerdown' || e.buttons === 1 || e.pointerType !== 'mouse')) onPick(i)
  }

  // Long logs: draw at most ~2 points per pixel.
  const stride = Math.max(1, Math.floor(n / Math.max(1, w * 2)))
  const line = data.map((d, i) => (i % stride === 0 || i === n - 1 ? `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(d.v).toFixed(1)}` : '')).join(' ')
  const area = n > 1 ? `${line} L ${x(n - 1)} ${m.top + h} L ${x(0)} ${m.top + h} Z` : ''
  const hx = hi === null ? 0 : kind === 'bars' ? bx(hi) + band / 2 : x(hi)
  const tipLeft = Math.min(Math.max(hx, 70), width - 70)

  return (
    <div ref={ref} className="chart-box time-chart">
      <svg width={width} height={height} role="img" aria-label={ariaLabel}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null) }}>
        {[0, top / 2, top].map((g) => <g key={g}><line x1={m.left} x2={m.left + w} y1={y(g)} y2={y(g)} className={g === 0 ? 'baseline' : 'grid-line'} /><text x={m.left - 6} y={y(g) + 4} className="axis-text" textAnchor="end">{format(g)}</text></g>)}
        {refValue !== undefined && refValue <= top && <g><line x1={m.left} x2={m.left + w} y1={y(refValue)} y2={y(refValue)} className="ref-line" />{refLabel && <text x={m.left + w} y={y(refValue) - 5} className="axis-text ref-text" textAnchor="end">{refLabel}</text>}</g>}
        {kind === 'line' && n > 1 && <><path d={area} className="series-area" /><path d={line} className="series-line" /></>}
        {kind === 'line' && n > 0 && <circle cx={x(n - 1)} cy={y(data[n - 1].v)} r={4} className="series-end" />}
        {kind === 'bars' && data.map((d, i) => {
          const bw = Math.max(1, band - 2)
          const bh = Math.max(1, m.top + h - y(d.v))
          const rr = Math.min(4, bw / 2, bh)
          const x0 = bx(i) + 1
          const y0 = m.top + h - bh
          // Rounded top, square baseline.
          const p = `M ${x0} ${m.top + h} V ${y0 + rr} Q ${x0} ${y0} ${x0 + rr} ${y0} H ${x0 + bw - rr} Q ${x0 + bw} ${y0} ${x0 + bw} ${y0 + rr} V ${m.top + h} Z`
          return <path key={d.t} d={p} className={`series-bar ${hi === i ? 'is-hover' : ''}`} />
        })}
        {markerIndex !== undefined && markerIndex < n && <line x1={x(markerIndex)} x2={x(markerIndex)} y1={m.top - 4} y2={m.top + h} className="playhead" />}
        {hi !== null && <g className="crosshair"><line x1={hx} x2={hx} y1={m.top} y2={m.top + h} />{kind === 'line' && <circle cx={hx} cy={y(data[hi].v)} r={5} />}</g>}
      </svg>
      {hi !== null && <div className="chart-tip" style={{ left: tipLeft }}><b>{format(data[hi].v)} {unit}</b><span>{tfmt(data[hi].t)}</span></div>}
      {n > 0 && <div className="time-axis" style={{ paddingLeft: m.left, paddingRight: m.right }}><span>{tfmt(data[0].t)}</span>{endLabel ? <span>{endLabel}</span> : <span dir="rtl" className="axis-now">עכשיו</span>}</div>}
    </div>
  )
}

/** Compass rose for heading; null heading (stationary) shows a muted dial. */
export function Compass({ heading }: { heading: number | null }) {
  return (
    <svg className="compass" viewBox="-20 -20 40 40" aria-hidden="true">
      <circle r="18" className="compass-dial" />
      <text y="-11" textAnchor="middle" className="compass-n">N</text>
      {heading !== null && <path d="M 0 -14 L 4 4 L 0 1 L -4 4 Z" className="compass-needle" transform={`rotate(${heading})`} />}
      {heading === null && <circle r="2.5" className="compass-idle" />}
    </svg>
  )
}
