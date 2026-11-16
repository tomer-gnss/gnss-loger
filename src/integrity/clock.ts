// Receiver clock (Android Raw, BigInt-exact) vs. its own reported drift and the phone clock.

import { fmt, bumpT, median, type Acc } from './core'
import type { ClockSample } from '../logParser'

//
// The receiver estimates its own clock offset (FullBiasNanos + BiasNanos) and its rate
// (DriftNanosPerSecond). On genuine signals the two agree to ~1 ns/s: the bias changes exactly
// as fast as the reported drift says. Most real spoofing attacks work by slowly "pulling" the
// victim's time and position; the receiver then sees its clock bias move in ways its own drift
// estimate doesn't explain. Independently, GNSS time should stay locked to the phone's system
// clock (which is set from the cellular network on most phones).

export const CLOCK = {
  warmupEpochs: 3, // the first fixes legitimately re-estimate the bias
  driftResidualNs: 50, // |observed rate − reported drift|, ns/s (genuine: ≤ 1)
  rateStepNs2: 200, // |change in observed rate| / dt, ns/s² when drift isn't reported (genuine: ≤ ~45)
  offsetSerialMs: 200, // spread of GNSS-vs-system time offset during the session
  offsetCriticalMs: 2000,
}

export function checkClock(samples: ClockSample[], acc: Acc) {
  if (samples.length < CLOCK.warmupEpochs + 5) {
    acc.unavailable.push('שעון המקלט (דורש רשומות Raw)')
    return
  }
  const c = samples.slice(CLOCK.warmupEpochs)
  type Step = { t: number; dt: number; rate: number; drift: number | null }
  const steps: Step[] = []
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1],
      b = c[i]
    if (a.discontinuity !== b.discontinuity) continue // hardware clock reset: not comparable
    const dt = Number(b.timeNanos - a.timeNanos) / 1e9
    if (!(dt > 0 && dt <= 10)) continue
    const dBias = Number(b.fullBiasNanos - a.fullBiasNanos) + (b.biasNanos - a.biasNanos)
    const drift =
      a.driftNanosPerSecond !== null && b.driftNanosPerSecond !== null
        ? (a.driftNanosPerSecond + b.driftNanosPerSecond) / 2
        : null
    steps.push({ t: b.t, dt, rate: dBias / dt, drift })
  }
  if (steps.length < 4) {
    acc.unavailable.push('שעון המקלט')
    return
  }

  // 1. Bias moves in a way the receiver's own drift estimate doesn't explain.
  const withDrift = steps.filter((s) => s.drift !== null)
  const anomalies: { t: number; v: number; unit: string }[] = []
  if (withDrift.length >= steps.length / 2) {
    for (const s of withDrift) {
      const r = s.rate - s.drift!
      if (Math.abs(r) > CLOCK.driftResidualNs) anomalies.push({ t: s.t, v: r, unit: 'ns/s' })
    }
  } else {
    for (let i = 1; i < steps.length; i++) {
      const jerk = (steps[i].rate - steps[i - 1].rate) / steps[i].dt
      if (Math.abs(jerk) > CLOCK.rateStepNs2) anomalies.push({ t: steps[i].t, v: jerk, unit: 'ns/s²' })
    }
  }
  for (const a of anomalies) bumpT(acc, a.t, 40)
  if (anomalies.length) {
    const worst = anomalies.reduce((x, y) => (Math.abs(y.v) > Math.abs(x.v) ? y : x))
    const how =
      worst.unit === 'ns/s'
        ? `קצב השינוי של הסטת השעון סטה ב-${fmt(Math.abs(worst.v), 0)} ns/s מהסחיפה שהמקלט עצמו מדווח (במקלט תקין הפער הוא כ-1 ns/s)`
        : `קצב הסחיפה של השעון השתנה ב-${fmt(Math.abs(worst.v), 0)} ns/s² בבת אחת (במקלט תקין: עד כ-45)`
    acc.findings.push({
      id: 'clock',
      severity: anomalies.length >= 3 ? 'critical' : 'serious',
      title: 'שעון המקלט "נמשך" (סימן מובהק לזיוף)',
      detail: `${how}, ב-${acc.clk(worst.t)}. ${anomalies.length === 1 ? 'אירוע אחד' : `${anomalies.length} אירועים`} כאלה בלוג. זיוף GNSS מתוחכם מושך בהדרגה את הזמן של המקלט, וזה הסימן שהוא משאיר.`,
      benign: 'כמעט אין: איפוס של שעון החומרה מסומן בנפרד ומוחרג מהבדיקה.',
      at: worst.t,
    })
  } else
    acc.passed.push(withDrift.length >= steps.length / 2 ? 'הסטת השעון תואמת לסחיפה המדווחת' : 'קצב סחיפת השעון יציב')

  // 2. GNSS time vs the phone's own clock.
  const offs: { t: number; ms: number }[] = []
  for (const s of c) {
    if (s.systemMs === null) continue
    const gpsMs = Number(s.timeNanos - s.fullBiasNanos) / 1e6 - s.biasNanos / 1e6 + 315964800000
    offs.push({ t: s.t, ms: gpsMs - (s.leapSecond ?? 18) * 1000 - s.systemMs })
  }
  if (offs.length < 5) {
    acc.unavailable.push('השוואת זמן GNSS לשעון הטלפון')
    return
  }
  // Baseline from the start of the session only, so a slow shift can't drag the reference along.
  const base = median(offs.slice(0, Math.max(3, Math.min(10, Math.floor(offs.length * 0.2)))).map((o) => o.ms))
  let worst = offs[0],
    spread = 0
  for (const o of offs) {
    const d = Math.abs(o.ms - base)
    if (d > spread) {
      spread = d
      worst = o
    }
    if (d > CLOCK.offsetSerialMs) bumpT(acc, o.t, 30)
  }
  if (spread > CLOCK.offsetSerialMs) {
    acc.findings.push({
      id: 'time-offset',
      severity: spread > CLOCK.offsetCriticalMs ? 'critical' : 'serious',
      title: 'זמן ה-GNSS נפרד משעון הטלפון',
      detail: `ההפרש בין הזמן שהמקלט מחשב מהלוויינים לבין השעון של הטלפון זז ב-${fmt(spread, 0)} מילישניות במהלך ההקלטה (ב-${acc.clk(worst.t)}). בהקלטה תקינה ההפרש יציב בטווח של כמה מילישניות. זיוף שמזיז זמן גורם בדיוק לזה.`,
      benign: 'כיוון של שעון הטלפון מהרשת (NTP) באמצע ההקלטה. בדרך כלל זה תיקון חד-פעמי של עשרות מילישניות.',
      at: worst.t,
    })
  } else acc.passed.push(`זמן ה-GNSS צמוד לשעון הטלפון (סטייה מרבית ${fmt(spread, 0)} ms)`)
}
