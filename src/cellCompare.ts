// GNSS vs cellular: when GNSS signal strength drops, did the cellular signal drop with it?
//  - GNSS dropped, cellular steady → interference confined to the GNSS band (a typical GPS
//    jammer transmits only around 1.2–1.6 GHz). Innocent cause: sky blocked (bridge, trees,
//    building) — cellular penetrates buildings far better than GNSS does.
//  - Both dropped together → environment (tunnel, car park, building interior), or a
//    wideband jammer that also covers cellular bands.
// Heuristic, and only as good as the two logs' time alignment.

import type { Epoch } from './logParser'
import type { CellSample } from './cellParser'

export const CMP = {
  /** GNSS top-4 mean C/N0 must fall this far below its baseline (dB) to open an event. */
  gnssDropDb: 8,
  /** …and stay down at least this long (s). */
  minDurS: 10,
  /** Baseline = median over this window before the event (s). */
  baselineS: 120,
  /** Cellular change within ±this (dB) counts as "steady". */
  cellSteadyDb: 4,
  /** Cellular drop of at least this (dB) counts as "dropped too". */
  cellDropDb: 6,
}

export type CellEventKind = 'gnss-only' | 'both' | 'unclear' | 'no-cell'
export type CellEvent = { t0: number; t1: number; gnssDrop: number; cellDrop: number | null; kind: CellEventKind }
export type CellComparison = { overlapS: number; events: CellEvent[] }

const median = (v: number[]) => { if (!v.length) return NaN; const s = v.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** First index with t >= target (array sorted by t). */
function lowerBound(arr: { t: number }[], target: number) {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < target) lo = mid + 1; else hi = mid }
  return lo
}

/** Mean of the 4 strongest signals; an epoch with nothing tracked counts as 10 dB-Hz (lost). */
function top4(e: Epoch) {
  const v = e.signals.map((s) => s.cn0 ?? 0).filter((x) => x > 0).sort((a, b) => b - a).slice(0, 4)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 10
}

export function compareGnssCell(epochs: Epoch[], cells: CellSample[]): CellComparison {
  if (!epochs.length || !cells.length) return { overlapS: 0, events: [] }
  const from = Math.max(epochs[0].t, cells[0].t), to = Math.min(epochs[epochs.length - 1].t, cells[cells.length - 1].t)
  const overlapS = Math.max(0, (to - from) / 1000)

  // Smoothed GNSS strength: median of top-4 over ±2.5 s.
  const raw = epochs.map((e) => ({ t: e.t, v: top4(e) }))
  const g: { t: number; v: number }[] = []
  for (let i = 0, lo = 0, hi = 0; i < raw.length; i++) {
    while (raw[lo].t < raw[i].t - 2500) lo++
    while (hi + 1 < raw.length && raw[hi + 1].t <= raw[i].t + 2500) hi++
    g.push({ t: raw[i].t, v: median(raw.slice(lo, hi + 1).map((p) => p.v)) })
  }

  const baselineAt = (t: number) => {
    const w = g.slice(lowerBound(g, t - CMP.baselineS * 1000), lowerBound(g, t - 5000)).map((p) => p.v)
    return w.length >= 10 ? median(w) : NaN
  }
  const cellWindow = (a: number, b: number) => cells.slice(lowerBound(cells, a), lowerBound(cells, b + 1)).map((c) => c.level)

  const events: CellEvent[] = []
  let i = 0
  while (i < g.length) {
    const base = baselineAt(g[i].t)
    if (!(base - g[i].v >= CMP.gnssDropDb)) { i++; continue }
    // Event open: the baseline is frozen at its start (otherwise a long event drags it down
    // and "ends" itself). It closes when strength recovers to within half the threshold.
    let j = i
    while (j + 1 < g.length && base - g[j + 1].v >= CMP.gnssDropDb / 2 && g[j + 1].t - g[j].t < 5000) j++
    const t0 = g[i].t, t1 = g[j].t
    if ((t1 - t0) / 1000 >= CMP.minDurS) {
      const gnssDrop = base - median(g.slice(i, j + 1).map((p) => p.v))
      const before = cellWindow(t0 - CMP.baselineS * 1000, t0 - 5000), during = cellWindow(t0, t1)
      let cellDrop: number | null = null, kind: CellEventKind = 'no-cell'
      if (before.length >= 2 && during.length >= 2) {
        cellDrop = median(before) - median(during)
        kind = Math.abs(cellDrop) <= CMP.cellSteadyDb ? 'gnss-only' : cellDrop >= CMP.cellDropDb ? 'both' : 'unclear'
      }
      events.push({ t0, t1, gnssDrop, cellDrop, kind })
    }
    i = j + 1
  }
  return { overlapS, events }
}
