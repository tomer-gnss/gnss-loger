// Satellite-level charts for the log tab:
//  1. Tracked satellites per constellation over time (stacked area).
//     All systems dropping together at once is the classic jamming signature.
//  2. C/N0 heatmap, one row per satellite, time across, colour = signal strength.
//     Jamming → a vertical stripe of weakening across every row.
//     Single-transmitter spoofing → rows that look suspiciously alike.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { satellitesOf, satLabel, SYS_ORDER, type Epoch, type Sys } from './logParser'
import { SEQ_BLUE, SYS_COLOR } from './colors'
import { useWidth } from './useWidth'

const MAX_BINS = 320
const CN0_MIN = 15, CN0_MAX = 50

/** Split epochs into ≤ maxBins consecutive time bins. */
function binEpochs(epochs: Epoch[], maxBins: number) {
  const n = Math.max(1, Math.min(maxBins, epochs.length))
  const bins: { t0: number; t1: number; epochs: Epoch[] }[] = []
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * epochs.length) / n), to = Math.floor(((b + 1) * epochs.length) / n)
    const slice = epochs.slice(from, Math.max(from + 1, to))
    bins.push({ t0: slice[0].t, t1: slice[slice.length - 1].t, epochs: slice })
  }
  return bins
}

const niceTop = (v: number) => { for (const s of [4, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100]) if (s >= v) return s; return Math.ceil(v / 20) * 20 }

/** Index of the bin containing time t. */
function binAt(bins: { t0: number; t1: number }[], t: number) {
  let lo = 0, hi = bins.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bins[mid].t0 <= t) lo = mid; else hi = mid - 1 }
  return lo
}

type Common = { epochs: Epoch[]; markerT?: number; onPick?: (t: number) => void; fmtTime: (t: number) => string }

// ------------------------------------------------------------------
// 1. Satellites per constellation (stacked area)
// ------------------------------------------------------------------

export function ConstellationChart({ epochs, markerT, onPick, fmtTime }: Common) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const data = useMemo(() => {
    const bins = binEpochs(epochs, MAX_BINS)
    const rows = bins.map((b) => {
      const sum: Partial<Record<Sys, number>> = {}
      for (const e of b.epochs) for (const s of satellitesOf(e.signals)) if ((s.cn0 ?? 0) > 0) sum[s.sys] = (sum[s.sys] ?? 0) + 1
      const avg: Partial<Record<Sys, number>> = {}
      for (const k of Object.keys(sum) as Sys[]) avg[k] = sum[k]! / b.epochs.length
      return { t: b.t1, t0: b.t0, counts: avg }
    })
    const systems = SYS_ORDER.filter((s) => rows.some((r) => (r.counts[s] ?? 0) > 0))
    const maxTotal = rows.reduce((m, r) => Math.max(m, systems.reduce((a, s) => a + (r.counts[s] ?? 0), 0)), 0)
    return { rows, systems, top: niceTop(maxTotal * 1.05) }
  }, [epochs])

  const { rows, systems, top } = data
  const n = rows.length
  const H = 170, m = { top: 10, right: 8, bottom: 6, left: 34 }
  const w = Math.max(10, width - m.left - m.right), h = H - m.top - m.bottom
  const x = (i: number) => m.left + (n <= 1 ? 0 : (i / (n - 1)) * w)
  const y = (v: number) => m.top + h - (v / top) * h

  // Cumulative stacks, bottom → top in fixed system order.
  const layers = systems.map((sys, si) => {
    const lower: number[] = [], upper: number[] = []
    rows.forEach((r) => {
      const below = systems.slice(0, si).reduce((a, s) => a + (r.counts[s] ?? 0), 0)
      lower.push(below); upper.push(below + (r.counts[sys] ?? 0))
    })
    const top_ = upper.map((v, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
    const bottom = lower.map((_, i) => `L ${x(n - 1 - i).toFixed(1)} ${y(lower[n - 1 - i]).toFixed(1)}`).join(' ')
    return { sys, d: `${top_} ${bottom} Z` }
  })

  const pick = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (n < 2) return
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - m.left) / w) * (n - 1))))
    setHover(i)
    if (onPick && (e.type === 'pointerdown' || e.buttons === 1 || e.pointerType !== 'mouse')) onPick(rows[i].t0)
  }
  const shown = hover ?? (markerT !== undefined && n ? binAt(rows.map((r) => ({ t0: r.t0, t1: r.t })), markerT) : n - 1)
  const cur = rows[shown]
  const total = cur ? systems.reduce((a, s) => a + (cur.counts[s] ?? 0), 0) : 0
  const markerI = markerT !== undefined && n ? binAt(rows.map((r) => ({ t0: r.t0, t1: r.t })), markerT) : null

  return (
    <div ref={ref} className="sat-chart" dir="ltr">
      <svg width={width} height={H} role="img" aria-label={`מספר לוויינים במעקב לפי מערכת לאורך הלוג: ${systems.join(', ')}`}
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null) }}>
        {[0, top / 2, top].map((g) => <g key={g}><line x1={m.left} x2={m.left + w} y1={y(g)} y2={y(g)} className={g === 0 ? 'baseline' : 'grid-line'} /><text x={m.left - 6} y={y(g) + 4} className="axis-text" textAnchor="end">{g}</text></g>)}
        {layers.map((l) => <path key={l.sys} d={l.d} fill={SYS_COLOR[l.sys].light} fillOpacity={0.85} stroke="#fff" strokeWidth={1} strokeLinejoin="round" />)}
        {markerI !== null && <line x1={x(markerI)} x2={x(markerI)} y1={m.top - 4} y2={m.top + h} className="playhead" />}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + h} className="crosshair-line" />}
      </svg>
      <div className="time-axis" style={{ paddingLeft: m.left, paddingRight: m.right }}><span>{n ? fmtTime(rows[0].t0) : ''}</span><span>{n ? fmtTime(rows[n - 1].t) : ''}</span></div>
      <div className="sat-legend" dir="rtl">
        <span className="sat-legend-time" dir="ltr">{cur ? fmtTime(cur.t0) : ''}</span>
        {systems.map((s) => <span key={s}><i style={{ background: SYS_COLOR[s].light }} />{s} <b dir="ltr">{(cur?.counts[s] ?? 0).toFixed(0)}</b></span>)}
        <span className="sat-legend-total">סה״כ <b dir="ltr">{total.toFixed(0)}</b></span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// 2. C/N0 heatmap (canvas: up to ~60 rows × 320 columns stays light on a phone)
// ------------------------------------------------------------------

const MAX_ROWS = 64
const GUTTER = 44 // left column for satellite labels (chart is LTR, time flows left → right)
const EMPTY = '#eef0ec'

function colorFor(cn0: number) {
  const f = (Math.max(CN0_MIN, Math.min(CN0_MAX, cn0)) - CN0_MIN) / (CN0_MAX - CN0_MIN)
  return SEQ_BLUE[Math.round(f * (SEQ_BLUE.length - 1))]
}

export function Cn0Heatmap({ epochs, markerT, onPick, fmtTime }: Common) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)

  const grid = useMemo(() => {
    // Satellites, most-observed first, capped; then shown grouped by system.
    const seen = new Map<string, { sys: Sys; svid: number; n: number }>()
    for (const e of epochs) for (const s of satellitesOf(e.signals)) {
      if ((s.cn0 ?? 0) <= 0) continue
      const k = `${s.sys}-${s.svid}`
      const v = seen.get(k)
      if (v) v.n++; else seen.set(k, { sys: s.sys, svid: s.svid, n: 1 })
    }
    const sats = [...seen.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, MAX_ROWS)
      .map(([k, v]) => ({ key: k, ...v }))
      .sort((a, b) => SYS_ORDER.indexOf(a.sys) - SYS_ORDER.indexOf(b.sys) || a.svid - b.svid)
    const rowOf = new Map(sats.map((s, i) => [s.key, i]))
    const bins = binEpochs(epochs, MAX_BINS)
    // values[row][bin] = mean C/N0 in that bin, or null if not tracked.
    const values = sats.map(() => new Array<number | null>(bins.length).fill(null))
    bins.forEach((b, bi) => {
      const sum = new Map<number, { s: number; n: number }>()
      for (const e of b.epochs) for (const s of satellitesOf(e.signals)) {
        const r = rowOf.get(`${s.sys}-${s.svid}`)
        if (r === undefined || (s.cn0 ?? 0) <= 0) continue
        const a = sum.get(r) ?? { s: 0, n: 0 }; a.s += s.cn0!; a.n++; sum.set(r, a)
      }
      for (const [r, a] of sum) values[r][bi] = a.s / a.n
    })
    return { sats, bins, values, dropped: seen.size - sats.length }
  }, [epochs])

  const { sats, bins, values } = grid
  const rowH = Math.max(6, Math.min(12, Math.floor(520 / Math.max(1, sats.length))))
  const plotW = Math.max(10, width - GUTTER - 4)
  const height = sats.length * rowH
  const colW = plotW / Math.max(1, bins.length)
  const markerBin = markerT !== undefined && bins.length ? binAt(bins, markerT) : null

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    c.width = Math.round(width * dpr); c.height = Math.round(height * dpr)
    c.style.width = `${width}px`; c.style.height = `${height}px`
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    // cells
    values.forEach((row, r) => row.forEach((v, b) => {
      g.fillStyle = v === null ? EMPTY : colorFor(v)
      g.fillRect(GUTTER + b * colW, r * rowH, Math.ceil(colW), rowH - (rowH >= 8 ? 1 : 0))
    }))
    // labels + system colour ticks + group separators
    g.font = `${Math.min(10, rowH)}px ui-monospace, Consolas, monospace`
    g.textBaseline = 'middle'
    sats.forEach((s, r) => {
      g.fillStyle = SYS_COLOR[s.sys].light
      g.fillRect(0, r * rowH + 1, 3, rowH - 2)
      if (rowH >= 8) { g.fillStyle = '#4c5c53'; g.fillText(satLabel(s), 6, r * rowH + rowH / 2) }
      if (r > 0 && sats[r - 1].sys !== s.sys) { g.fillStyle = '#4c5c53'; g.fillRect(0, r * rowH - 0.5, width, 1) }
    })
    // playhead
    if (markerBin !== null) {
      g.fillStyle = '#d0703f'
      g.fillRect(GUTTER + (markerBin + 0.5) * colW - 1, 0, 2, height)
    }
  }, [values, sats, width, height, rowH, colW, markerBin])

  const locate = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left, py = e.clientY - r.top
    const row = Math.floor(py / rowH), bin = Math.floor((px - GUTTER) / colW)
    if (row < 0 || row >= sats.length || bin < 0 || bin >= bins.length) { setTip(null); return }
    const v = values[row][bin]
    setTip({ x: px, y: py, text: `${satLabel(sats[row])} · ${v === null ? 'לא נקלט' : `${v.toFixed(0)} dB-Hz`} · ${fmtTime(bins[bin].t0)}` })
    if (onPick && (e.type === 'pointerdown' || e.buttons === 1 || e.pointerType !== 'mouse')) onPick(bins[bin].t0)
  }

  if (!sats.length) return <p className="muted">אין נתוני C/N₀ לכל לוויין בלוג הזה.</p>
  return (
    <div ref={ref} className="sat-chart heatmap" dir="ltr">
      <div className="heatmap-wrap">
        <canvas ref={canvas} role="img" aria-label={`מפת חום של עוצמת אות לכל אחד מ-${sats.length} לוויינים לאורך הלוג`}
          onPointerMove={locate} onPointerDown={locate} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setTip(null) }} />
        {tip && <div className="chart-tip heat-tip" style={{ left: Math.min(Math.max(tip.x, 90), width - 90), top: Math.max(0, tip.y - 34) }}><span>{tip.text}</span></div>}
      </div>
      <div className="time-axis" style={{ paddingLeft: GUTTER, paddingRight: 4 }}><span>{bins.length ? fmtTime(bins[0].t0) : ''}</span><span>{bins.length ? fmtTime(bins[bins.length - 1].t1) : ''}</span></div>
      <div className="heat-legend" dir="rtl">
        <span>חלש</span>
        <span className="heat-scale" dir="ltr">{SEQ_BLUE.map((c) => <i key={c} style={{ background: c }} />)}</span>
        <span>חזק</span>
        <span className="muted" dir="ltr">{CN0_MIN}–{CN0_MAX} dB-Hz</span>
        <span className="heat-empty"><i style={{ background: EMPTY }} />לא נקלט</span>
      </div>
      {grid.dropped > 0 && <p className="muted">מוצגים {sats.length} הלוויינים שנקלטו הכי הרבה זמן ({grid.dropped} נוספים הושמטו).</p>}
    </div>
  )
}
