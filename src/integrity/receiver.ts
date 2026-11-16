// Receiver-level checks on satellite data: C/N0, AGC, satellites, constellations, NMEA quality, baseband.

import { fmt, T, bumpT, mean, std, median, type Acc } from './core'
import { satellitesOf, type Epoch, type LogFix } from '../logParser'

export function checkCn0(epochs: Epoch[], acc: Acc) {
  const perEpoch = epochs
    .map((e) => {
      const v = e.signals.map((s) => s.cn0).filter((x): x is number => x !== null && x > 0)
      return { t: e.t, mean: mean(v), std: std(v), n: v.length, max: v.length ? Math.max(...v.slice(0, 500)) : NaN }
    })
    .filter((x) => x.n >= 4)
  if (perEpoch.length < 10) {
    acc.unavailable.push('התפלגות C/N₀')
    return
  }

  // Uniformly high and tight C/N0 = classic simulator/spoofer signature (one transmitter, same path loss).
  const uniform = perEpoch.filter((x) => x.std < T.cn0UniformStd && x.mean > 38)
  for (const x of uniform) bumpT(acc, x.t, 30)
  for (const x of perEpoch) if (x.mean > T.cn0HighMean) bumpT(acc, x.t, 10)
  for (const x of perEpoch) if (x.mean < T.cn0LowMean) bumpT(acc, x.t, 10)
  if (uniform.length > perEpoch.length * 0.3) {
    acc.findings.push({
      id: 'cn0-uniform',
      severity: 'critical',
      title: 'עוצמת אות אחידה בכל הלוויינים',
      detail: `ב-${fmt((uniform.length / perEpoch.length) * 100, 0)}% מהאפוקים פיזור ה-C/N₀ בין הלוויינים קטן מ-${T.cn0UniformStd} dB. לוויינים אמיתיים בזוויות שונות נותנים פיזור של 4–8 dB. אות אחיד מגיע ממשדר יחיד.`,
      benign: 'כמעט אין הסבר תמים לדפוס הזה.',
      at: uniform[0].t,
    })
  } else acc.passed.push('פיזור C/N₀ טבעי בין לוויינים')

  const high = perEpoch.filter((x) => x.mean > T.cn0HighMean)
  if (high.length > perEpoch.length * 0.3) {
    acc.findings.push({
      id: 'cn0-high',
      severity: 'serious',
      title: 'עוצמת אות גבוהה באופן לא טבעי',
      detail: `ממוצע C/N₀ מעל ${T.cn0HighMean} dB-Hz ב-${fmt((high.length / perEpoch.length) * 100, 0)}% מהאפוקים. אות מהחלל מגיע בדרך כלל ל-35–45 dB-Hz.`,
      benign: 'אנטנה חיצונית איכותית עם מגבר (LNA).',
      at: high[0].t,
    })
  } else acc.passed.push('רמת C/N₀ סבירה')

  // Sudden collapse of C/N0 across all satellites at once = jamming or entering a structure.
  let collapses = 0,
    collapseAt = 0
  for (let i = 1; i < perEpoch.length; i++) {
    if (perEpoch[i - 1].mean - perEpoch[i].mean > 10 && perEpoch[i].mean < 30) {
      collapses++
      collapseAt ||= perEpoch[i].t
      bumpT(acc, perEpoch[i].t, 30)
    }
  }
  const low = perEpoch.filter((x) => x.mean < T.cn0LowMean)
  if (collapses > 0 || low.length > perEpoch.length * 0.3) {
    acc.findings.push({
      id: 'cn0-low',
      severity: collapses > 2 ? 'serious' : 'warning',
      title: 'צניחה בעוצמת האות',
      detail: `${collapses === 1 ? 'צניחה פתאומית אחת' : `${collapses} צניחות פתאומיות`} של יותר מ-10 dB בכל הלוויינים בבת אחת${collapseAt ? ` (הראשונה ב-${acc.clk(collapseAt)})` : ''}; ${fmt((low.length / perEpoch.length) * 100, 0)}% מהזמן הממוצע מתחת ל-${T.cn0LowMean} dB-Hz.`,
      benign: 'כניסה למבנה, מנהרה או חניון. בשיבוש (jamming) הצניחה חדה ובכל הלוויינים יחד, בלי שינוי במיקום.',
      at: collapseAt || low[0]?.t,
    })
  } else acc.passed.push('אין צניחות בעוצמת האות')
}

export function checkAgc(epochs: Epoch[], acc: Acc) {
  // Per-epoch mean AGC per band; jamming raises AGC (receiver turns gain down… reported as dB change).
  const series: { t: number; v: number }[] = []
  for (const e of epochs) {
    const v = e.signals.map((s) => s.agc).filter((x): x is number => x !== null && x !== undefined)
    if (v.length) series.push({ t: e.t, v: mean(v) })
  }
  if (series.length < 10) {
    acc.unavailable.push('AGC (בקרת הגבר)')
    return
  }
  const baseline = median(series.slice(0, Math.max(5, Math.floor(series.length * 0.2))).map((x) => x.v))
  const dev = series.map((x) => ({ t: x.t, d: x.v - baseline }))
  const bad = dev.filter((x) => Math.abs(x.d) > T.agcJumpDb)
  for (const x of bad) bumpT(acc, x.t, 40)
  if (bad.length > series.length * 0.1) {
    const worst = bad.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a))
    acc.findings.push({
      id: 'agc',
      severity: 'critical',
      title: 'שינוי חד ב-AGC (בקרת ההגבר של המקלט)',
      detail: `ה-AGC סטה ב-${fmt(worst.d, 1)} dB מהבסיס (${fmt(baseline, 1)} dB) ב-${acc.clk(worst.t)}, וב-${fmt((bad.length / series.length) * 100, 0)}% מהזמן. AGC הוא המדד הישיר ביותר לאנרגיית RF זרה בתדר ה-GNSS, והוא משתנה גם כשאין עדיין פגיעה במיקום.`,
      benign: 'מעבר ליד משדר חזק (רדאר, תחנת בסיס), או הפרעה ממכשיר אלקטרוני בקרבת הטלפון.',
      at: worst.t,
    })
  } else acc.passed.push('AGC יציב')
}

export function checkSatellites(epochs: Epoch[], acc: Acc) {
  if (epochs.length < 10) {
    acc.unavailable.push('מספר לוויינים')
    return
  }
  const counts = epochs.map((e) => ({
    t: e.t,
    tracked: satellitesOf(e.signals).filter((s) => (s.cn0 ?? 0) > 0).length,
    used: satellitesOf(e.signals).filter((s) => s.used).length,
    hasUsed: e.signals.some((s) => s.used !== null),
  }))
  // Sudden loss of all satellites.
  let losses = 0,
    lossAt = 0
  for (let i = 1; i < counts.length; i++)
    if (counts[i - 1].tracked >= 8 && counts[i].tracked <= 2) {
      losses++
      lossAt ||= counts[i].t
      bumpT(acc, counts[i].t, 30)
    }
  if (losses)
    acc.findings.push({
      id: 'sat-loss',
      severity: 'serious',
      title: 'אובדן פתאומי של כל הלוויינים',
      detail: `${losses === 1 ? 'פעם אחת' : `${losses} פעמים`} המקלט ירד מ-8+ לוויינים ל-2 או פחות בתוך אפוק אחד (הראשונה ב-${acc.clk(lossAt)}).`,
      benign: 'כניסה למנהרה. שיבוש רחב-סרט מפיל את כל הלוויינים יחד.',
      at: lossAt,
    })
  else acc.passed.push('אין אובדן פתאומי של לוויינים')
  // Tracking many but using few: measurements rejected by the receiver's own consistency checks.
  const withUsed = counts.filter((c) => c.hasUsed && c.tracked >= 8)
  if (withUsed.length >= 10) {
    const lowRatio = withUsed.filter((c) => c.used / c.tracked < 0.4)
    for (const c of lowRatio) bumpT(acc, c.t, 10)
    if (lowRatio.length > withUsed.length * 0.3)
      acc.findings.push({
        id: 'used-ratio',
        severity: 'serious',
        title: 'המקלט פוסל את רוב המדידות',
        detail: `ב-${fmt((lowRatio.length / withUsed.length) * 100, 0)}% מהאפוקים פחות מ-40% מהלוויינים במעקב משמשים בפתרון. המקלט עוקב אחרי אותות אבל דוחה אותם כלא עקביים.`,
        benign: 'ריבוי נתיבים (multipath) חמור בין בניינים גבוהים.',
        at: lowRatio[0].t,
      })
    else acc.passed.push('רוב הלוויינים במעקב משמשים בפתרון')
  }
}

export function checkConstellations(epochs: Epoch[], acc: Acc) {
  if (epochs.length < 10) return
  // Only GPS L1 present while the device clearly supports more: a simple spoofer transmits GPS L1 only.
  const seen = new Set<string>()
  for (const e of epochs) for (const s of e.signals) if ((s.cn0 ?? 0) > 0) seen.add(`${s.sys}|${s.band ?? ''}`)
  const systems = new Set([...seen].map((k) => k.split('|')[0]))
  const bands = new Set([...seen].map((k) => k.split('|')[1]).filter(Boolean))
  // Look for epochs where GPS is strong but every other constellation is absent, after they were seen.
  let gpsOnly = 0
  for (const e of epochs) {
    const sats = satellitesOf(e.signals).filter((s) => (s.cn0 ?? 0) > 0)
    if (sats.length >= 6 && sats.every((s) => s.sys === 'GPS')) {
      gpsOnly++
      if (systems.size >= 2) bumpT(acc, e.t, 20)
    }
  }
  if (systems.size >= 2 && gpsOnly > epochs.length * 0.2) {
    acc.findings.push({
      id: 'gps-only',
      severity: 'serious',
      title: 'רק לווייני GPS נקלטים בחלק מהזמן',
      detail: `ב-${fmt((gpsOnly / epochs.length) * 100, 0)}% מהאפוקים נקלטים 6+ לווייני GPS אבל אפס Galileo/GLONASS/BeiDou, למרות שהמקלט קולט אותם בשאר הלוג. סימולטורים פשוטים משדרים GPS L1 בלבד.`,
      benign: 'הגדרת מקלט שמכבה מערכות אחרות.',
    })
  } else if (systems.size >= 2) acc.passed.push('קליטה רב-מערכתית עקבית')
  if (bands.size >= 2) acc.passed.push(`קליטה בכמה תדרים (${[...bands].slice(0, 4).join(', ')})`)
  else if (bands.size === 1)
    acc.findings.push({
      id: 'single-band',
      severity: 'info',
      title: 'קליטה בתדר יחיד',
      detail: `רק ${[...bands][0]} בלוג. זיוף של תדר אחד קל בהרבה מזיוף של L1+L5 יחד.`,
      benign: 'מקלט חד-תדרי.',
    })
}

export function checkNmeaQuality(fixes: LogFix[], acc: Acc) {
  const q = fixes.filter((f) => f.quality !== null && f.quality !== undefined)
  if (q.length < 10) return
  const dr = q.filter((f) => f.quality === 6)
  for (const f of dr) bumpT(acc, f.t, 15)
  if (dr.length)
    acc.findings.push({
      id: 'dead-reckoning',
      severity: 'warning',
      title: 'המקלט עבר לניווט עיוור (dead reckoning)',
      detail: `${dr.length} פתרונות (${fmt((dr.length / q.length) * 100, 0)}%) סומנו כ-DR, כלומר בלי לוויינים, רק חיישנים. הראשון ב-${acc.clk(dr[0].t)}.`,
      benign: 'מנהרה או חניון.',
      at: dr[0].t,
    })
  const sv = q.filter((f) => f.numSv !== null && f.numSv !== undefined)
  const lowSv = sv.filter((f) => f.numSv! < T.minSatsForFix)
  if (sv.length >= 10 && lowSv.length > sv.length * 0.2)
    acc.findings.push({
      id: 'low-sv',
      severity: 'warning',
      title: 'מעט לוויינים בפתרון',
      detail: `${fmt((lowSv.length / sv.length) * 100, 0)}% מהפתרונות עם פחות מ-${T.minSatsForFix} לוויינים.`,
      benign: 'שמיים חסומים.',
    })
  const hd = q.filter((f) => f.hdop !== null && f.hdop !== undefined)
  const badHdop = hd.filter((f) => f.hdop! > 5)
  if (hd.length >= 10 && badHdop.length > hd.length * 0.2)
    acc.findings.push({
      id: 'hdop',
      severity: 'warning',
      title: 'גאומטריה גרועה (HDOP גבוה)',
      detail: `HDOP מעל 5 ב-${fmt((badHdop.length / hd.length) * 100, 0)}% מהפתרונות.`,
      benign: 'שמיים חסומים.',
    })
}

export function checkBasebandDivergence(epochs: Epoch[], acc: Acc) {
  const diffs: { t: number; d: number }[] = []
  for (const e of epochs) {
    const pairs = e.signals.filter(
      (s) => s.cn0 !== null && s.basebandCn0 !== null && s.basebandCn0 !== undefined && s.cn0 > 0,
    )
    if (pairs.length >= 4) diffs.push({ t: e.t, d: mean(pairs.map((s) => s.cn0! - s.basebandCn0!)) })
  }
  if (diffs.length < 10) {
    acc.unavailable.push('השוואת C/N₀ אנטנה/בייסבנד')
    return
  }
  const base = median(diffs.slice(0, Math.max(5, Math.floor(diffs.length * 0.2))).map((x) => x.d))
  const bad = diffs.filter((x) => x.d - base > 4)
  for (const x of bad) bumpT(acc, x.t, 20)
  if (bad.length > diffs.length * 0.1)
    acc.findings.push({
      id: 'baseband',
      severity: 'serious',
      title: 'פער גדל בין C/N₀ באנטנה לבייסבנד',
      detail: `הפער עלה ביותר מ-4 dB מעל הבסיס (${fmt(base, 1)} dB) ב-${fmt((bad.length / diffs.length) * 100, 0)}% מהזמן, מ-${acc.clk(bad[0].t)}. פער שגדל מעיד על אנרגיה בתוך רוחב הפס שאינה אות לוויין.`,
      benign: 'הפרעה מקומית מהטלפון עצמו (USB, טעינה).',
      at: bad[0].t,
    })
  else acc.passed.push('C/N₀ אנטנה ובייסבנד עקביים')
}
