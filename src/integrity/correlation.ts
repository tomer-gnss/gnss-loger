// Cross-satellite C/N0 correlation: one transmitter moves every satellite together.

import { fmt, bumpT, median, type Acc } from './core'
import type { Epoch } from '../logParser'

//
// Real satellites sit in different directions. When the phone moves or turns, each satellite's
// signal changes differently (one is blocked by the body, another comes into view). A spoofer
// transmits every "satellite" from one antenna, so all of them rise and fall together.
//
// Per sliding window: take each satellite's epoch-to-epoch C/N0 change, and measure how much of
// the change is shared by all satellites. 0 = independent (genuine), 1 = identical (one source).

export const CORR = {
  window: 30, // epochs per window
  step: 15,
  minSats: 5,
  minActivityDb: 0.7, // windows with less variation than this can't be judged (static, stable)
  flagRho: 0.6, // shared-change ratio above which a window counts as "moving together"
  flagShare: 0.3, // fraction of judged windows that must be flagged
}

export type CorrWindow = { from: number; t: number; rho: number; activity: number; sats: number }

/** Shared-change ratio per window (exported for calibration tests). */
export function cn0CommonMode(epochs: Epoch[]): CorrWindow[] {
  // Per signal (sat + band), C/N0 at each epoch index.
  const series = new Map<string, Map<number, number>>()
  epochs.forEach((e, i) => {
    for (const s of e.signals) {
      if (s.cn0 === null || s.cn0 <= 0) continue
      const k = `${s.sys}-${s.svid}-${s.band ?? ''}`
      let m = series.get(k)
      if (!m) {
        m = new Map()
        series.set(k, m)
      }
      m.set(i, s.cn0)
    }
  })
  const out: CorrWindow[] = []
  for (let start = 0; start + CORR.window <= epochs.length; start += CORR.step) {
    const end = start + CORR.window
    // Signals present in every epoch of the window.
    const deltas: number[][] = []
    for (const m of series.values()) {
      const d: number[] = []
      let ok = true
      for (let i = start + 1; i < end; i++) {
        const a = m.get(i - 1),
          b = m.get(i)
        if (a === undefined || b === undefined) {
          ok = false
          break
        }
        d.push(b - a)
      }
      if (ok) deltas.push(d)
    }
    const n = deltas.length
    if (n < CORR.minSats) continue
    const len = deltas[0].length
    const variance = (x: number[]) => {
      const mu = x.reduce((s, v) => s + v, 0) / x.length
      return x.reduce((s, v) => s + (v - mu) ** 2, 0) / x.length
    }
    const perSat = deltas.map(variance)
    const meanVar = perSat.reduce((s, v) => s + v, 0) / n
    if (meanVar <= 0) continue
    const common: number[] = []
    for (let k = 0; k < len; k++) {
      let s = 0
      for (const d of deltas) s += d[k]
      common.push(s / n)
    }
    const ratio = variance(common) / meanVar // 1/n if independent, 1 if identical
    const rho = Math.max(0, Math.min(1, (ratio - 1 / n) / (1 - 1 / n)))
    out.push({ from: epochs[start].t, t: epochs[end - 1].t, rho, activity: Math.sqrt(meanVar), sats: n })
  }
  return out
}

export function checkCn0Correlation(epochs: Epoch[], acc: Acc) {
  const windows = cn0CommonMode(epochs)
  const judged = windows.filter((w) => w.activity >= CORR.minActivityDb)
  if (judged.length < 3) {
    acc.unavailable.push(
      windows.length
        ? 'מתאם C/N₀ בין לוויינים (האות יציב מדי כדי לשפוט, למשל טלפון מונח במקום)'
        : 'מתאם C/N₀ בין לוויינים (הלוג קצר מדי)',
    )
    return
  }
  const flagged = judged.filter((w) => w.rho > CORR.flagRho)
  // The evidence covers the whole window, not just its last epoch.
  for (const w of flagged)
    for (let s = Math.floor(w.from / 1000); s <= Math.floor(w.t / 1000); s++) bumpT(acc, s * 1000, 25)
  const medianRho = median(judged.map((w) => w.rho))
  if (flagged.length > judged.length * CORR.flagShare) {
    const worst = flagged.reduce((a, b) => (b.rho > a.rho ? b : a))
    acc.findings.push({
      id: 'cn0-correlation',
      severity: flagged.length > judged.length * 0.6 && medianRho > 0.75 ? 'critical' : 'serious',
      title: 'כל הלוויינים מתחזקים ונחלשים יחד',
      detail: `ב-${fmt((flagged.length / judged.length) * 100, 0)}% מחלונות הזמן, השינויים בעוצמת האות היו משותפים לכל הלוויינים (מתאם ${fmt(worst.rho * 100, 0)}% בחלון הגרוע, ${worst.sats} לוויינים, ב-${acc.clk(worst.t)}). לוויינים אמיתיים בכיוונים שונים משתנים כל אחד בנפרד כשהטלפון זז. שינוי משותף מעיד על מקור אחד שמשדר את כולם.`,
      benign: 'כניסה ויציאה חוזרות ממבנה, או שינוי הגבר של המקלט עצמו. אלה בדרך כלל אירועים בודדים ולא דפוס מתמשך.',
      at: worst.t,
    })
  } else acc.passed.push(`כל לוויין משתנה בנפרד (מתאם חציוני ${fmt(medianRho * 100, 0)}%, ${judged.length} חלונות)`)
}
