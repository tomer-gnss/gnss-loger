// GNSS position vs. the network (cell / Wi-Fi) position from the same log.

import { haversine, fmt, bumpT, type IntegrityPoint, type Acc } from './core'
import type { LogFix } from '../logParser'

//
// The phone has two independent ways to know where it is: the GNSS receiver, and the network
// location provider (cell towers + Wi-Fi access points). A GNSS spoofer only fools the first.
// GnssLogger / GPSTest record both as Fix records (provider GPS vs NLP). FLP is a fusion that
// already contains GNSS, so it is not an independent witness and is ignored here.

export const NET = {
  maxPairGapMs: 5000, // compare an NLP fix with the GNSS fix closest in time, within ±5 s
  minDisagreeM: 300, // below this the two are considered consistent regardless of accuracy
  sigmaFactor: 2, // disagreement must exceed 2 × (GNSS accuracy + network accuracy)
}

export type NetworkPair = { t: number; distM: number; tolM: number; gnssAcc: number | null; netAcc: number | null }

/** Pairs each network (NLP) fix with the nearest GNSS fix in time. */
export function pairGnssWithNetwork(fixes: LogFix[]): NetworkPair[] {
  const gnss = fixes.filter((f) => f.provider === 'GPS' || f.provider === 'NMEA').sort((a, b) => a.t - b.t)
  const net = fixes.filter((f) => f.provider === 'NLP')
  const out: NetworkPair[] = []
  if (!gnss.length) return out
  for (const n of net) {
    let lo = 0,
      hi = gnss.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (gnss[mid].t < n.t) lo = mid + 1
      else hi = mid
    }
    const g = lo > 0 && Math.abs(gnss[lo - 1].t - n.t) < Math.abs(gnss[lo].t - n.t) ? gnss[lo - 1] : gnss[lo]
    if (Math.abs(g.t - n.t) > NET.maxPairGapMs) continue
    const distM = haversine(g as IntegrityPoint, n as IntegrityPoint)
    const tolM = Math.max(NET.minDisagreeM, NET.sigmaFactor * ((g.acc ?? 20) + (n.acc ?? 1000)))
    out.push({ t: n.t, distM, tolM, gnssAcc: g.acc, netAcc: n.acc })
  }
  return out
}

export function checkGnssVsNetwork(fixes: LogFix[], acc: Acc) {
  const pairs = pairGnssWithNetwork(fixes)
  if (!pairs.length) {
    const hasNet = fixes.some((f) => f.provider === 'NLP')
    acc.unavailable.push(
      hasNet
        ? 'השוואת GNSS למיקום מהרשת (אין פתרונות GNSS ורשת באותו זמן)'
        : 'השוואת GNSS למיקום מהרשת (אין בלוג מיקומי רשת NLP)',
    )
    return
  }
  const bad = pairs.filter((p) => p.distM > p.tolM)
  for (const p of bad) bumpT(acc, p.t, 35)
  if (!bad.length) {
    const worst = pairs.reduce((a, b) => (b.distM > a.distM ? b : a))
    acc.passed.push(
      `מיקום ה-GNSS תואם למיקום מהרשת הסלולרית (${pairs.length === 1 ? 'השוואה אחת' : `${pairs.length} השוואות`}, פער מרבי ${fmt(worst.distM, 0)} מ׳)`,
    )
    return
  }
  const worst = bad.reduce((a, b) => (b.distM > a.distM ? b : a))
  const km = (m: number) => (m >= 1000 ? `${fmt(m / 1000, 1)} ק״מ` : `${fmt(m, 0)} מ׳`)
  const persistent = bad.length >= 3 && bad.length > pairs.length / 2
  acc.findings.push({
    id: 'gnss-vs-network',
    severity: persistent ? 'critical' : 'serious',
    title: 'ה-GNSS והרשת הסלולרית לא מסכימים על המיקום',
    detail: `${bad.length === 1 ? 'בהשוואה אחת' : `ב-${bad.length} מתוך ${pairs.length} השוואות`} מיקום ה-GNSS רחוק ממיקום הרשת (אנטנות ו-Wi-Fi) יותר ממה שהדיוק של שניהם מסביר. הפער הגדול: ${km(worst.distM)} ב-${acc.clk(worst.t)}, כשהטווח הסביר היה עד ${km(worst.tolM)}. מזייף GNSS לא משפיע על מיקום הרשת, ולכן זה אחד הסימנים החזקים לזיוף.`,
    benign: 'מיקום רשת שגוי: נקודת Wi-Fi שהועברה ממקום אחר, אנטנה רחוקה באזור כפרי, טיסה, או מעבר גבול.',
    at: worst.t,
  })
}
