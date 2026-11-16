// Numbers for the analysis report (log report and live-session report). Pure functions: the same
// data the screens show, condensed into the tables of a printable report.

import type { Epoch, LogFix, ParsedLog, Sys } from './logParser'
import { SYS_ORDER } from './logParser'

export const pct = (v: number[], p: number) => {
  if (!v.length) return null
  const s = v.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]
}
/** Min / max without spreading (a long log has 100k+ values: spread overflows the stack). */
const minOf = (v: number[]) => { let m: number | null = null; for (const x of v) if (m === null || x < m) m = x; return m }
const maxOf = (v: number[]) => { let m: number | null = null; for (const x of v) if (m === null || x > m) m = x; return m }
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null)

/** SHA-256 of a file, hex. Lets a reader confirm the report was made from exactly this file. */
export async function sha256Hex(file: Blob, maxBytes = 150 * 1024 * 1024): Promise<string | null> {
  if (file.size > maxBytes || typeof crypto === 'undefined' || !crypto.subtle) return null
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const R = 6371008.8, rad = Math.PI / 180
export function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Path length, ignoring steps smaller than the accuracy (standing still is not travel). */
export function trackLength(pts: { lat: number; lon: number; acc: number | null }[]) {
  let total = 0, anchor = pts[0]
  for (let i = 1; i < pts.length; i++) {
    const d = distM(anchor, pts[i])
    if (d > Math.max(3, anchor.acc ?? 0, pts[i].acc ?? 0)) { total += d; anchor = pts[i] }
  }
  return total
}

/** Mean of the 4 strongest signals. */
const top4 = (e: Epoch) => {
  const v = e.signals.map((s) => s.cn0 ?? 0).filter((x) => x > 0).sort((a, b) => b - a).slice(0, 4)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

/** Fixes worth reporting: receiver (GPS/NMEA) first, fused (FLP) next, network (NLP) last. */
export function primaryFixes(fixes: LogFix[]) {
  for (const p of ['GPS', 'NMEA', 'FLP']) { const f = fixes.filter((x) => x.provider === p); if (f.length) return { provider: p, fixes: f } }
  return { provider: fixes[0]?.provider ?? null, fixes }
}

export type SysRow = { sys: Sys; maxSats: number; meanSats: number; meanCn0: number | null; bands: string[] }

export function logStats(log: ParsedLog) {
  const { epochs } = log
  const { provider, fixes } = primaryFixes(log.fixes)
  const times = [epochs[0]?.t, epochs[epochs.length - 1]?.t, fixes[0]?.t, fixes[fixes.length - 1]?.t].filter((t): t is number => typeof t === 'number')
  const t0 = minOf(times), t1 = maxOf(times)

  // Per constellation: satellites tracked (max / mean per epoch), mean C/N0, bands.
  const acc = new Map<Sys, { max: number; sum: number; cn0: number[]; bands: Set<string> }>()
  const tracked: number[] = [], used: number[] = [], strength: number[] = []
  let sawUsed = false
  for (const e of epochs) {
    const perSys = new Map<Sys, Set<number>>()
    const usedSats = new Set<string>()
    for (const s of e.signals) {
      if (!((s.cn0 ?? 0) > 0)) continue
      let set = perSys.get(s.sys); if (!set) { set = new Set(); perSys.set(s.sys, set) }
      set.add(s.svid)
      let a = acc.get(s.sys); if (!a) { a = { max: 0, sum: 0, cn0: [], bands: new Set() }; acc.set(s.sys, a) }
      a.cn0.push(s.cn0!)
      if (s.band) a.bands.add(s.band)
      if (s.used !== null) sawUsed = true
      if (s.used) usedSats.add(`${s.sys}-${s.svid}`)
    }
    let n = 0
    for (const [sys, set] of perSys) { const a = acc.get(sys)!; a.max = Math.max(a.max, set.size); a.sum += set.size; n += set.size }
    tracked.push(n); used.push(usedSats.size)
    const t4 = top4(e); if (t4 !== null) strength.push(t4)
  }
  const systems: SysRow[] = SYS_ORDER.filter((s) => acc.has(s)).map((sys) => {
    const a = acc.get(sys)!
    return { sys, maxSats: a.max, meanSats: epochs.length ? a.sum / epochs.length : 0, meanCn0: mean(a.cn0), bands: [...a.bands].sort() }
  })

  const accs = fixes.map((f) => f.acc).filter((v): v is number => v !== null)
  // Gaps: no epoch for more than 5 s inside the recording.
  let gaps = 0, gapS = 0
  for (let i = 1; i < epochs.length; i++) { const d = epochs[i].t - epochs[i - 1].t; if (d > 5000) { gaps++; gapS += d / 1000 } }
  const ivals: number[] = []
  for (let i = 1; i < Math.min(epochs.length, 2000); i++) ivals.push(epochs[i].t - epochs[i - 1].t)

  return {
    t0, t1, durationS: t0 !== null && t1 !== null ? (t1 - t0) / 1000 : 0,
    provider, fixCount: fixes.length,
    epochRateHz: ivals.length ? 1000 / (pct(ivals, 50) || 1000) : null,
    systems,
    tracked: { mean: mean(tracked), max: maxOf(tracked) ?? 0, min: minOf(tracked) ?? 0 },
    used: sawUsed ? { mean: mean(used) } : null,
    strength: { median: pct(strength, 50), p10: pct(strength, 10), min: minOf(strength) },
    accuracy: { median: pct(accs, 50), p95: pct(accs, 95), best: minOf(accs) },
    distanceM: fixes.length > 1 ? trackLength(fixes) : 0,
    maxSpeed: pct(fixes.map((f) => f.speed).filter((v): v is number => v !== null), 100),
    gaps, gapS,
  }
}

/** The epoch with the most satellites that have a position in the sky (for the report's sky plot). */
export function richestSkyEpoch(epochs: Epoch[]) {
  let best: Epoch | null = null, n = -1
  const step = Math.max(1, Math.floor(epochs.length / 400))
  for (let i = 0; i < epochs.length; i += step) {
    const k = epochs[i].signals.filter((s) => s.az !== null && s.el !== null && (s.cn0 ?? 0) > 0).length
    if (k > n) { n = k; best = epochs[i] }
  }
  return n > 0 ? best : null
}

export type LivePoint = { wall: number; lat: number; lon: number; acc: number; alt: number | null; speed: number | null }

export function liveStats(fixes: LivePoint[], gaps: { from: number; to: number }[]) {
  const t0 = fixes[0]?.wall ?? null, t1 = fixes[fixes.length - 1]?.wall ?? null
  const accs = fixes.map((f) => f.acc)
  const ivals: number[] = []
  for (let i = 1; i < fixes.length; i++) ivals.push(fixes[i].wall - fixes[i - 1].wall)
  const alts = fixes.map((f) => f.alt).filter((v): v is number => v !== null)
  return {
    t0, t1, durationS: t0 !== null && t1 !== null ? (t1 - t0) / 1000 : 0,
    count: fixes.length,
    rateHz: ivals.length ? 1000 / (pct(ivals, 50) || 1000) : null,
    accuracy: { median: pct(accs, 50), p95: pct(accs, 95), best: minOf(accs), worst: maxOf(accs) },
    distanceM: fixes.length > 1 ? trackLength(fixes) : 0,
    maxSpeed: pct(fixes.map((f) => f.speed).filter((v): v is number => v !== null), 100),
    alt: alts.length ? { min: minOf(alts)!, max: maxOf(alts)! } : null,
    gaps: gaps.length, gapS: gaps.reduce((s, g) => s + (g.to - g.from), 0) / 1000,
  }
}
