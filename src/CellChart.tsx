// Cellular signal level (dBm) over time, on the same time axis as the C/N0 chart above it.
// Line colour = network generation (2G/3G/4G/5G); ticks along the top = serving-cell changes.

import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { CellSample, CellTech } from './cellParser'
import { TECH_COLOR } from './colors'
import { useWidth } from './useWidth'
import { BAND_FILL, lastAtOrBefore, TIME_MARGIN, timeTicks, type TimeBand } from './timeAxis'

const TECHS: CellTech[] = ['5G', '4G', '3G', '2G']

export function CellChart({ samples, t0, tFrom, tTo, bands = [] }: { samples: CellSample[]; t0: number; tFrom: number; tTo: number; bands?: TimeBand[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<CellSample | null>(null)
  const H = 190, m = { top: 12, right: TIME_MARGIN.right, bottom: 8, left: TIME_MARGIN.left }
  const w = Math.max(10, width - m.left - m.right), h = H - m.top - m.bottom

  const data = useMemo(() => {
    const i0 = Math.max(0, lastAtOrBefore(samples, tFrom)), i1 = lastAtOrBefore(samples, tTo)
    const inView = i1 >= i0 ? samples.slice(i0, i1 + 1) : []
    const stride = Math.max(1, Math.ceil(inView.length / Math.max(60, w / 1.5)))
    const pts = stride === 1 ? inView : inView.filter((_, i) => i % stride === 0 || i === inView.length - 1)
    const dts: number[] = []
    for (let i = 1; i < Math.min(samples.length, 300); i++) dts.push(samples[i].t - samples[i - 1].t)
    dts.sort((a, b) => a - b)
    const gap = Math.max(10000, (dts[dts.length >> 1] ?? 1000) * 3)
    let lo = Infinity, hi = -Infinity
    for (const p of pts) { if (p.level < lo) lo = p.level; if (p.level > hi) hi = p.level }
    const handovers: number[] = []
    for (let i = 1; i < inView.length; i++) if (inView[i].cell && inView[i - 1].cell && inView[i].cell !== inView[i - 1].cell) handovers.push(inView[i].t)
    const techs = TECHS.filter((t) => inView.some((p) => p.tech === t))
    return { pts, gap, lo, hi, handovers, techs }
  }, [samples, tFrom, tTo, w])

  // Y range in 10 dB steps around the data, at least 40 dB tall.
  let yLo = Number.isFinite(data.lo) ? Math.floor(data.lo / 10) * 10 : -120
  let yHi = Number.isFinite(data.hi) ? Math.ceil(data.hi / 10) * 10 : -60
  if (yHi - yLo < 40) { const mid = (yHi + yLo) / 2; yLo = Math.floor((mid - 20) / 10) * 10; yHi = yLo + 40 }
  yLo = Math.max(-150, yLo); yHi = Math.min(-20, yHi)
  const span = Math.max(1000, tTo - tFrom)
  const x = (t: number) => m.left + ((t - tFrom) / span) * w
  const y = (v: number) => m.top + h - ((Math.min(yHi, Math.max(yLo, v)) - yLo) / (yHi - yLo)) * h
  const ticks = timeTicks(t0, tFrom, tTo, w)
  const yTicks: number[] = []
  for (let v = yLo; v <= yHi; v += 10) yTicks.push(v)

  // One path per run of the same technology; a gap or a technology change starts a new run.
  const runs: { tech: CellTech | null; d: string }[] = []
  let prev: CellSample | null = null
  for (const p of data.pts) {
    const pt = `${x(p.t).toFixed(1)} ${y(p.level).toFixed(1)}`
    if (!prev || p.t - prev.t > data.gap) runs.push({ tech: p.tech, d: `M${pt}` })
    else if (p.tech !== prev.tech) runs.push({ tech: p.tech, d: `M${x(prev.t).toFixed(1)} ${y(prev.level).toFixed(1)}L${pt}` })
    else runs[runs.length - 1].d += `L${pt}`
    prev = p
  }

  const pick = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const t = tFrom + ((e.clientX - r.left - m.left) / w) * span
    const i = lastAtOrBefore(data.pts, t)
    const cands = [data.pts[i], data.pts[i + 1]].filter((p): p is CellSample => !!p && Math.abs(p.t - t) <= data.gap)
    setHover(cands.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0] ?? null)
  }
  const tipX = hover ? Math.max(90, Math.min(width - 90, x(hover.t))) : 0

  return (
    <div ref={ref} className="sat-chart cell-chart" dir="ltr">
      <div className="axis-title"><span>Cell signal (dBm)</span></div>
      <svg width={width} height={H} role="img" aria-label="עוצמת האות הסלולרי לאורך הזמן, צבע לפי דור הרשת"
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null) }}>
        {bands.map((b, i) => <rect key={i} x={x(Math.max(tFrom, b.t0))} width={Math.max(2, x(Math.min(tTo, b.t1)) - x(Math.max(tFrom, b.t0)))} y={m.top} height={h} fill={BAND_FILL[b.tone]} />)}
        {yTicks.map((v) => <g key={v}><line x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} className={v === yLo ? 'baseline' : 'grid-line'} /><text x={m.left - 6} y={y(v) + 4} className="axis-text" textAnchor="end">{v}</text></g>)}
        {ticks.map((s) => <line key={s} x1={x(t0 + s * 1000)} x2={x(t0 + s * 1000)} y1={m.top} y2={m.top + h} className="grid-line" />)}
        {data.handovers.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={m.top - 6} y2={m.top + 2} className="handover-tick" />)}
        <g fill="none" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round">
          {runs.map((r, i) => <path key={i} d={r.d} stroke={r.tech ? TECH_COLOR[r.tech] : '#5f6d65'} />)}
        </g>
        {hover && <>
          <line x1={x(hover.t)} x2={x(hover.t)} y1={m.top} y2={m.top + h} className="crosshair-line" />
          <circle cx={x(hover.t)} cy={y(hover.level)} r={4.5} fill="#fff" stroke={hover.tech ? TECH_COLOR[hover.tech] : '#5f6d65'} strokeWidth={2.5} />
        </>}
        {!data.pts.length && <text x={m.left + w / 2} y={m.top + h / 2} textAnchor="middle" className="axis-text">אין מדידות סלולר בטווח הזה</text>}
      </svg>
      {hover && <div className="chart-tip" style={{ left: tipX }}>
        <b>{hover.level} dBm</b>
        <span>{[hover.tech, hover.rsrq !== null && `RSRQ ${hover.rsrq}`, hover.sinr !== null && `SINR ${hover.sinr}`, hover.cell && `cell ${hover.cell}`, `${Math.round((hover.t - t0) / 1000)} s`].filter(Boolean).join(' · ')}</span>
      </div>}
      <div className="x-ticks" style={{ marginLeft: m.left, width: w }}>
        {ticks.map((s) => <span key={s} style={{ left: `${((t0 + s * 1000 - tFrom) / span) * 100}%` }}>{s}</span>)}
      </div>
      <div className="axis-title x"><span>time (s)</span></div>
      <div className="sat-legend" dir="rtl">
        {data.techs.map((t) => <span key={t}><i style={{ background: TECH_COLOR[t] }} />{t}</span>)}
        {data.handovers.length > 0 && <span><i className="handover-key" />החלפת תא</span>}
      </div>
    </div>
  )
}
