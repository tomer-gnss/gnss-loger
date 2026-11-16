// Shared pieces of the integrity engine: result types, the accumulator every check writes into,
// position-level thresholds, small statistics helpers, scoring and verdict texts.

import { timeLocal, timeUtc } from '../format'

export type Severity = 'critical' | 'serious' | 'warning' | 'info'

export type Finding = {
  id: string
  severity: Severity
  /** Short Hebrew title shown in the UI. */
  title: string
  /** Evidence: the actual measured values. */
  detail: string
  /** What else could explain this. */
  benign: string
  /** Time of the strongest evidence (ms epoch), for the log timeline. */
  at?: number
}

export type Verdict = 'ok' | 'suspect' | 'degraded' | 'critical'

export type IntegrityReport = {
  verdict: Verdict
  /** 0–100, higher = more suspicious. */
  score: number
  findings: Finding[]
  /** Checks that ran and passed, so the user can see coverage. */
  passed: string[]
  /** Checks that could not run on this data. */
  unavailable: string[]
  /** Suspicion over time, one point per second of data (0–100), for the timeline chart. */
  timeline: { t: number; v: number }[]
}

export type IntegrityPoint = {
  t: number
  lat: number
  lon: number
  alt: number | null
  acc: number | null
  speed: number | null
  heading: number | null
}

export const R = 6371008.8
export const rad = Math.PI / 180

/** Great-circle distance in metres. */
export function haversine(a: IntegrityPoint, b: IntegrityPoint) {
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export const fmt = (v: number, d = 1) => v.toFixed(d)
// Time formatting per analysis: logs are shown in UTC, the live tab in the phone's local time.
export const utcClock = timeUtc,
  localClock = timeLocal

// ---- thresholds (documented so they can be tuned) ----
export const T = {
  maxSpeedMps: 100, // 360 km/h: faster than any road or rail use of a phone
  maxAccelMps2: 25, // ~2.5 g sustained between consecutive fixes
  jumpMetres: 250, // instantaneous displacement that no accuracy figure can explain
  frozenWindow: 20, // consecutive identical fixes while reporting motion
  accConstantWindow: 30, // identical accuracy values in a row
  altFrozenWindow: 60, // identical altitude while moving > 200 m
  timeStepTolMs: 2500, // receiver time going backwards or jumping forward
  cn0HighMean: 47, // dB-Hz; a real sky rarely averages this high across all satellites
  cn0UniformStd: 1.5, // dB-Hz; natural spread is 4–8 dB
  cn0LowMean: 25, // dB-Hz; typical jamming floor
  agcJumpDb: 6, // AGC step vs session baseline
  minSatsForFix: 4,
  lowSatsWindow: 10,
}

export type Acc = {
  findings: Finding[]
  passed: string[]
  unavailable: string[]
  /** Points the position checks index into. */
  pts: IntegrityPoint[]
  /** Suspicion per whole second (key = floor(t / 1000)). */
  heat: Map<number, number>
  /** Formats evidence timestamps for this analysis (UTC for logs, local time for live). */
  clk: (t: number) => string
  /** Every second that has data, so quiet periods show as 0 on the timeline. */
  seconds: Set<number>
}

export function newAcc(points: IntegrityPoint[], clk: (t: number) => string): Acc {
  const seconds = new Set<number>()
  for (const p of points) seconds.add(Math.floor(p.t / 1000))
  return { findings: [], passed: [], unavailable: [], pts: points, heat: new Map(), seconds, clk }
}

/** Add suspicion at a moment in time. */
export function bumpT(acc: Acc, t: number, w: number) {
  if (!Number.isFinite(t)) return
  const k = Math.floor(t / 1000)
  acc.heat.set(k, Math.min(100, (acc.heat.get(k) ?? 0) + w))
  acc.seconds.add(k)
}

/** Add suspicion at the time of position point i. */
export function bump(acc: Acc, i: number, w: number) {
  const p = acc.pts[i]
  if (p) bumpT(acc, p.t, w)
}

export function mean(a: number[]) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
}
export function std(a: number[]) {
  const m = mean(a)
  return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : NaN
}
export function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}

const WEIGHT: Record<Severity, number> = { critical: 45, serious: 25, warning: 10, info: 0 }

export function finalize(acc: Acc): IntegrityReport {
  const order: Severity[] = ['critical', 'serious', 'warning', 'info']
  acc.findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
  const score = Math.min(
    100,
    acc.findings.reduce((s, f) => s + WEIGHT[f.severity], 0),
  )
  const has = (s: Severity) => acc.findings.some((f) => f.severity === s)
  // One serious finding is already worth a "suspicion" verdict; warnings alone only add up.
  const verdict: Verdict =
    has('critical') || score >= 70
      ? 'critical'
      : has('serious') || score >= 35
        ? 'degraded'
        : score > 0
          ? 'suspect'
          : 'ok'
  const timeline = [...acc.seconds].sort((a, b) => a - b).map((k) => ({ t: k * 1000, v: acc.heat.get(k) ?? 0 }))
  return { verdict, score, findings: acc.findings, passed: acc.passed, unavailable: acc.unavailable, timeline }
}

/**
 * Drop fixes that arrive less than `minGapMs` after the previous kept one. Browsers sometimes
 * deliver fixes in bursts (e.g. iOS Safari flushing buffered positions when the page returns
 * from the background); a few metres over a few milliseconds would look like an impossible
 * speed. The jump check still sees the first fix after a gap.
 */
export function thin<P extends { t: number }>(points: P[], minGapMs = 500): P[] {
  const out: P[] = []
  for (const p of points) if (!out.length || p.t - out[out.length - 1].t >= minGapMs) out.push(p)
  return out
}

export const VERDICT_TEXT: Record<Verdict, { label: string; summary: string }> = {
  ok: { label: 'תקין', summary: 'לא נמצאו סימני שיבוש או זיוף.' },
  suspect: { label: 'חריגות קלות', summary: 'נמצאו חריגות שבדרך כלל יש להן הסבר תמים.' },
  degraded: { label: 'חשד', summary: 'כמה סימנים מצטברים שמתאימים להפרעה. בדוק את הממצאים.' },
  critical: { label: 'סימני שיבוש/זיוף', summary: 'נמצא לפחות דפוס אחד שקשה להסביר בלי הפרעה מכוונת.' },
}
