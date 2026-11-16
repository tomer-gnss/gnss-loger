// Reported sky vs. the real orbits, and the external receiver clock vs. the phone clock.

import { fmt, bumpT, median, type Acc } from './core'
import { satellitesOf, satLabel, type Epoch, type LogFix } from '../logParser'
import { prnComparable, skyAngle, type PredictedSat } from '../skyMath'

//
// A receiver reports where each satellite is in its sky (azimuth/elevation). Public orbital data
// says where that satellite really is. A replayed recording or a simulator generating a fake sky
// can't match the real sky at this place and time. Only constellations whose public names carry
// the PRN (GPS, BeiDou, QZSS, SBAS) are compared, so no satellite is matched by guesswork.

export type PredictFn = (epoch: Epoch, fix: LogFix | null) => PredictedSat[] | null

export const SKY = {
  minEl: 5, // receivers' low-elevation numbers are the noisiest
  maxSepDeg: 10, // NMEA reports whole degrees; real orbits agree to < 0.1°
  belowHorizonDeg: -3,
  samples: 40,
  minCompared: 4,
}

export function checkSkyConsistency(epochs: Epoch[], fixes: LogFix[], predictAt: PredictFn | undefined, acc: Acc) {
  if (!predictAt) {
    acc.unavailable.push('השוואת השמיים למסלולי הלוויינים (לא הופעלו מסלולים חזויים)')
    return
  }
  if (epochs.length < 3) {
    acc.unavailable.push('השוואת השמיים למסלולי הלוויינים')
    return
  }
  const sorted = fixes.slice().sort((a, b) => a.t - b.t)
  const fixAt = (t: number) => {
    if (!sorted.length) return null
    let lo = 0,
      hi = sorted.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid].t < t) lo = mid + 1
      else hi = mid
    }
    return sorted[lo]
  }
  const step = Math.max(1, Math.floor(epochs.length / SKY.samples))
  type Ev = {
    t: number
    bad: number
    compared: number
    worst: { label: string; got: string; want: string; sep: number } | null
    impossible: number
  }
  const evs: Ev[] = []
  for (let i = 0; i < epochs.length; i += step) {
    const e = epochs[i]
    const pred = predictAt(e, fixAt(e.t))
    if (!pred) continue
    let bad = 0,
      compared = 0,
      impossible = 0
    let worst: Ev['worst'] = null
    for (const s of satellitesOf(e.signals)) {
      if (s.az === null || s.el === null || s.el < SKY.minEl || !prnComparable(s.sys)) continue
      const q = pred.find((p) => p.sys === s.sys && p.svid === s.svid)
      if (!q) continue
      compared++
      const sep = skyAngle(s.az, s.el, q.az, q.el)
      const below = q.el < SKY.belowHorizonDeg
      if (below || sep > SKY.maxSepDeg) {
        bad++
        if (below) impossible++
        if (!worst || sep > worst.sep)
          worst = {
            label: satLabel(s),
            got: `${Math.round(s.az)}°/${Math.round(s.el)}°`,
            want: `${Math.round(q.az)}°/${Math.round(q.el)}°`,
            sep,
          }
      }
    }
    if (compared >= SKY.minCompared) evs.push({ t: e.t, bad, compared, worst, impossible })
  }
  if (evs.length < 2) {
    acc.unavailable.push('השוואת השמיים למסלולי הלוויינים (מעט מדי לוויינים עם מספר PRN מזוהה)')
    return
  }
  const fracs = evs.map((v) => v.bad / v.compared)
  const med = median(fracs)
  for (const v of evs) if (v.bad / v.compared > 0.25) bumpT(acc, v.t, 45)
  if (med > 0.2) {
    const w = evs.filter((v) => v.worst).reduce((a, b) => (b.worst!.sep > (a.worst?.sep ?? -1) ? b : a))
    const impossible = evs.reduce((s, v) => s + v.impossible, 0)
    acc.findings.push({
      id: 'sky-mismatch',
      severity: med > 0.5 ? 'critical' : 'serious',
      title: 'השמיים שהמקלט מדווח לא תואמים את המסלולים האמיתיים',
      detail: `בחציון ${fmt(med * 100, 0)}% מהלוויינים נמצאים במקום שונה ממה שהמסלולים הציבוריים שלהם מראים${impossible ? `, ו-${impossible} מהם בכלל מתחת לאופק כאן ועכשיו` : ''}. לדוגמה ${w.worst!.label}: המקלט מדווח ${w.worst!.got} (אזימוט/גובה), המסלול אומר ${w.worst!.want}, פער ${fmt(w.worst!.sep, 0)}° (ב-${acc.clk(w.t)}). מסלולים אמיתיים מתאימים בפחות מעשירית מעלה. דפוס כזה מתאים להקלטה שמשודרת מחדש או לסימולטור.`,
      benign:
        'שעון או תאריך שגויים במקלט, או נתוני מסלולים ישנים מאוד. בהקלטות היסטוריות, ההשוואה למסלולים של היום לא רלוונטית.',
      at: w.t,
    })
  } else
    acc.passed.push(
      `השמיים שהמקלט מדווח תואמים את מסלולי הלוויינים (${evs.length} בדיקות, חציון ${fmt(med * 100, 0)}% חריגים)`,
    )
}

export function checkRxTimeOffset(offsetMs: number | null | undefined, acc: Acc) {
  if (offsetMs === null || offsetMs === undefined) return
  if (Math.abs(offsetMs) > 2000) {
    acc.findings.push({
      id: 'rx-time',
      severity: Math.abs(offsetMs) > 60000 ? 'critical' : 'serious',
      title: 'שעון המקלט החיצוני רחוק משעון הטלפון',
      detail: `המקלט מדווח שעה שרחוקה ${fmt(Math.abs(offsetMs) / 1000, 1)} שניות משעון הטלפון (שמסונכרן מהרשת). זיוף שמזיז זמן גורם בדיוק לזה.`,
      benign: 'שעון הטלפון לא מסונכרן (בדוק "תאריך ושעה אוטומטיים"), או מקלט שעוד לא קיבל זמן מהלוויינים.',
    })
  } else acc.passed.push(`שעון המקלט החיצוני צמוד לשעון הטלפון (${fmt(offsetMs, 0)} ms)`)
}
