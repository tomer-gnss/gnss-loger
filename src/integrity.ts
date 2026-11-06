// GNSS integrity monitor: heuristics that flag jamming, spoofing and degraded solutions.
//
// Two tiers of evidence:
//  - Position-level (any source, including the phone browser): physically impossible motion,
//    frozen or "too perfect" outputs, timing anomalies, altitude/accuracy that misbehave.
//  - Receiver-level (log files with Raw/Status/NMEA data): AGC, C/N0 distribution, satellite
//    counts, constellation balance, "used in fix" ratio, fix quality and DOP.
//
// Everything here is a heuristic. A flag means "this pattern is consistent with interference",
// not "an attack is in progress". Causes like tunnels, urban canyons and indoor use are listed
// alongside each finding so the user can judge.

import type { Epoch, LogFix } from './logParser'
import { satellitesOf } from './logParser'

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
  /** Per-fix anomaly timeline (same length as the input fixes). */
  timeline: number[]
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

const R = 6371008.8
const rad = Math.PI / 180

/** Great-circle distance in metres. */
export function haversine(a: IntegrityPoint, b: IntegrityPoint) {
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

const fmt = (v: number, d = 1) => v.toFixed(d)
const clock = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour12: false, timeZone: 'UTC' })

// ---- thresholds (documented so they can be tuned) ----
const T = {
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

type Acc = { findings: Finding[]; passed: string[]; unavailable: string[]; timeline: number[] }

function bump(acc: Acc, i: number, w: number) {
  if (i >= 0 && i < acc.timeline.length) acc.timeline[i] = Math.min(100, acc.timeline[i] + w)
}

// ------------------------------------------------------------------
// Position-level checks
// ------------------------------------------------------------------

function checkMotion(p: IntegrityPoint[], acc: Acc) {
  if (p.length < 3) { acc.unavailable.push('תנועה פיזית'); return }
  let worstSpeed = 0, worstSpeedAt = 0, worstSpeedI = -1
  let worstAccel = 0, worstAccelAt = 0, worstAccelI = -1
  let jumps = 0, worstJump = 0, worstJumpAt = 0
  let prevV: number | null = null
  for (let i = 1; i < p.length; i++) {
    const dt = (p[i].t - p[i - 1].t) / 1000
    if (dt <= 0 || dt > 120) { prevV = null; continue }
    const d = haversine(p[i - 1], p[i])
    const v = d / dt
    const tolerance = ((p[i].acc ?? 0) + (p[i - 1].acc ?? 0))
    if (d > T.jumpMetres && d > 3 * tolerance && dt <= 5) {
      jumps++
      if (d > worstJump) { worstJump = d; worstJumpAt = p[i].t }
      bump(acc, i, 60)
    }
    if (v > worstSpeed && d > tolerance) { worstSpeed = v; worstSpeedAt = p[i].t; worstSpeedI = i }
    if (prevV !== null) {
      const a = Math.abs(v - prevV) / dt
      if (a > worstAccel && d > tolerance) { worstAccel = a; worstAccelAt = p[i].t; worstAccelI = i }
    }
    prevV = v
  }
  if (jumps > 0) {
    acc.findings.push({ id: 'jump', severity: jumps >= 3 ? 'critical' : 'serious', title: 'קפיצות מיקום בלתי אפשריות', detail: `${jumps === 1 ? "קפיצה אחת" : `${jumps} קפיצות`} של יותר מ-${T.jumpMetres} מ׳ בין פתרונות עוקבים. ${jumps === 1 ? "גודל: " : "הגדולה: "}${fmt(worstJump, 0)} מ׳ ב-${clock(worstJumpAt)}.`, benign: 'יציאה ממנהרה או מבניין, או מעבר בין GNSS לרשת סלולרית (ספק NLP/FLP).', at: worstJumpAt })
  } else acc.passed.push('קפיצות מיקום')
  if (worstSpeed > T.maxSpeedMps) {
    acc.findings.push({ id: 'speed', severity: worstSpeed > 3 * T.maxSpeedMps ? 'critical' : 'serious', title: 'מהירות בלתי סבירה', detail: `${fmt(worstSpeed * 3.6, 0)} קמ״ש בין שני פתרונות ב-${clock(worstSpeedAt)}.`, benign: 'פתרון יחיד שגוי אחרי אובדן קליטה.', at: worstSpeedAt })
    bump(acc, worstSpeedI, 40)
  } else acc.passed.push('מהירות סבירה')
  if (worstAccel > T.maxAccelMps2) {
    acc.findings.push({ id: 'accel', severity: 'warning', title: 'תאוצה בלתי סבירה', detail: `${fmt(worstAccel, 1)} m/s² (≈${fmt(worstAccel / 9.81, 1)} g) ב-${clock(worstAccelAt)}.`, benign: 'רעש במהירות המחושבת כשהדיוק גרוע.', at: worstAccelAt })
    bump(acc, worstAccelI, 20)
  } else acc.passed.push('תאוצה סבירה')
}

function checkReportedVsDerivedSpeed(p: IntegrityPoint[], acc: Acc) {
  // The receiver's own Doppler speed should agree with position-derived speed. A spoofer that
  // replays positions often leaves Doppler speed near zero (or vice versa).
  const pairs: number[] = []
  let disagree = 0, worstAt = 0, worstDiff = 0
  for (let i = 1; i < p.length; i++) {
    const rs = p[i].speed
    const dt = (p[i].t - p[i - 1].t) / 1000
    if (rs === null || dt <= 0 || dt > 10) continue
    const ds = haversine(p[i - 1], p[i]) / dt
    const tol = Math.max(3, ((p[i].acc ?? 10) + (p[i - 1].acc ?? 10)) / dt)
    pairs.push(i)
    const diff = Math.abs(rs - ds)
    if (diff > tol && Math.max(rs, ds) > 4) { disagree++; if (diff > worstDiff) { worstDiff = diff; worstAt = p[i].t }; bump(acc, i, 10) }
  }
  if (pairs.length < 10) { acc.unavailable.push('השוואת מהירות דופלר למיקום'); return }
  if (disagree / pairs.length > 0.3) {
    acc.findings.push({ id: 'doppler', severity: 'serious', title: 'המהירות המדווחת לא תואמת לתזוזה', detail: `ב-${fmt((disagree / pairs.length) * 100, 0)}% מהפתרונות המהירות שהמקלט מדווח (דופלר) שונה מהמהירות שנגזרת מהמיקום. פער מרבי ${fmt(worstDiff, 1)} m/s ב-${clock(worstAt)}.`, benign: 'מיקום שמגיע משילוב חיישנים או מרשת ולא מ-GNSS.', at: worstAt })
  } else acc.passed.push('מהירות דופלר תואמת לתזוזה')
}

function checkFrozen(p: IntegrityPoint[], acc: Acc) {
  if (p.length < T.frozenWindow) { acc.unavailable.push('מיקום קפוא'); return }
  let run = 1, worst = 0, worstAt = 0, worstI = -1, movingWhileFrozen = false
  for (let i = 1; i < p.length; i++) {
    const same = p[i].lat === p[i - 1].lat && p[i].lon === p[i - 1].lon
    if (same) { run++; if ((p[i].speed ?? 0) > 1) movingWhileFrozen = true } else run = 1
    if (run > worst) { worst = run; worstAt = p[i].t; worstI = i }
  }
  // A stationary receiver legitimately repeats coordinates (NMEA rounds to ~1 m). It only becomes
  // evidence when the receiver simultaneously claims motion, or the run is implausibly long.
  if (movingWhileFrozen && worst >= T.frozenWindow) {
    acc.findings.push({ id: 'frozen', severity: 'serious', title: 'מיקום קפוא בזמן שהמקלט מדווח על תנועה', detail: `${worst} פתרונות עוקבים עם קואורדינטות זהות עד הספרה האחרונה, בעוד המהירות המדווחת גדולה מ-1 m/s (עד ${clock(worstAt)}). חתימה טיפוסית של שידור חוזר (replay).`, benign: 'כמעט אין: מקלט שנע לא יכול להחזיר מיקום זהה.', at: worstAt })
    for (let k = worstI - worst + 1; k <= worstI; k++) bump(acc, k, 15)
  } else if (worst >= 300) {
    acc.findings.push({ id: 'frozen', severity: 'info', title: 'מיקום זהה לאורך זמן רב', detail: `${worst} פתרונות עוקבים עם קואורדינטות זהות (עד ${clock(worstAt)}).`, benign: 'עמידה במקום עם מקלט שמעגל פלט, או מצב חיסכון. מקלט אמיתי בדרך כלל "רועד" במטרים בודדים גם בעמידה.', at: worstAt })
  } else acc.passed.push('המיקום לא קפוא')
}

function checkAccuracyBehaviour(p: IntegrityPoint[], acc: Acc) {
  const withAcc = p.filter((x) => x.acc !== null)
  if (withAcc.length < T.accConstantWindow) { acc.unavailable.push('התנהגות הדיוק המדווח'); return }
  let run = 1, worst = 0, worstAt = 0
  for (let i = 1; i < withAcc.length; i++) {
    if (withAcc[i].acc === withAcc[i - 1].acc) run++; else run = 1
    if (run > worst) { worst = run; worstAt = withAcc[i].t }
  }
  if (worst >= T.accConstantWindow) {
    acc.findings.push({ id: 'acc-const', severity: 'info', title: 'הדיוק המדווח קבוע', detail: `${worst} פתרונות עוקבים עם אותו ערך דיוק בדיוק (${fmt(withAcc[0].acc!, 1)} מ׳). רוב המקלטים משנים את הערכת הדיוק כל הזמן; ערך קבוע אומר שאי אפשר להסתמך עליו כמדד איכות.`, benign: 'מכשירים ישנים וספקי מיקום מסוימים מדווחים ערך קבוע.', at: worstAt })
  } else acc.passed.push('הדיוק המדווח משתנה באופן טבעי')
}

function checkAltitude(p: IntegrityPoint[], acc: Acc) {
  const withAlt = p.filter((x) => x.alt !== null)
  if (withAlt.length < T.altFrozenWindow) { acc.unavailable.push('גובה'); return }
  // Frozen altitude while moving far.
  let run = 1, dist = 0, worst = 0, worstAt = 0
  for (let i = 1; i < withAlt.length; i++) {
    if (withAlt[i].alt === withAlt[i - 1].alt) { run++; dist += haversine(withAlt[i - 1], withAlt[i]) } else { run = 1; dist = 0 }
    if (run >= T.altFrozenWindow && dist > 200 && run > worst) { worst = run; worstAt = withAlt[i].t }
  }
  if (worst) acc.findings.push({ id: 'alt-frozen', severity: 'warning', title: 'הגובה קפוא בזמן תנועה', detail: `${worst} פתרונות עם גובה זהה לאורך יותר מ-200 מ׳ של תנועה (עד ${clock(worstAt)}).`, benign: 'פתרון דו-ממדי (2D fix) כשיש מעט לוויינים.', at: worstAt })
  else acc.passed.push('הגובה משתנה באופן טבעי')
  // Absurd altitude or vertical rate.
  let worstRate = 0, rateAt = 0
  for (let i = 1; i < withAlt.length; i++) {
    const dt = (withAlt[i].t - withAlt[i - 1].t) / 1000
    if (dt <= 0 || dt > 10) continue
    const rate = Math.abs(withAlt[i].alt! - withAlt[i - 1].alt!) / dt
    if (rate > worstRate) { worstRate = rate; rateAt = withAlt[i].t }
  }
  const absurd = withAlt.find((x) => x.alt! < -500 || x.alt! > 9000)
  if (absurd) acc.findings.push({ id: 'alt-absurd', severity: 'serious', title: 'גובה בלתי אפשרי', detail: `גובה של ${fmt(absurd.alt!, 0)} מ׳ ב-${clock(absurd.t)}.`, benign: 'פתרון ראשון שגוי מיד אחרי הפעלה.', at: absurd.t })
  else if (worstRate > 50) acc.findings.push({ id: 'alt-rate', severity: 'warning', title: 'שינוי גובה מהיר מדי', detail: `${fmt(worstRate, 0)} מ׳/שנייה אנכית ב-${clock(rateAt)}.`, benign: 'רעש בגובה בקליטה גרועה. הגובה הוא התוצר הכי רועש של GNSS.', at: rateAt })
  else acc.passed.push('קצב שינוי הגובה סביר')
}

function checkTime(p: IntegrityPoint[], acc: Acc) {
  if (p.length < 5) { acc.unavailable.push('רציפות זמן'); return }
  let backwards = 0, worstBack = 0, backAt = 0
  for (let i = 1; i < p.length; i++) {
    const dt = p[i].t - p[i - 1].t
    if (dt < -T.timeStepTolMs) { backwards++; if (-dt > worstBack) { worstBack = -dt; backAt = p[i].t }; bump(acc, i, 30) }
  }
  if (backwards) acc.findings.push({ id: 'time-back', severity: 'serious', title: 'הזמן של המקלט חזר אחורה', detail: `${backwards === 1 ? "פעם אחת" : `${backwards} פעמים`} חותמת הזמן קטנה מהקודמת (עד ${fmt(worstBack / 1000, 1)} שניות). זיוף GNSS משבש גם את זמן המקלט.`, benign: 'שני ספקי מיקום שכותבים ללוג לסירוגין.', at: backAt })
  else acc.passed.push('רציפות זמן')
}

function checkProviderMix(p: (IntegrityPoint & { provider?: string })[], acc: Acc) {
  const byProv: Record<string, number> = {}
  for (const x of p) if (x.provider) byProv[x.provider] = (byProv[x.provider] ?? 0) + 1
  const keys = Object.keys(byProv)
  if (!keys.length) return
  const gps = byProv.GPS ?? byProv.NMEA ?? 0
  const net = (byProv.NLP ?? 0) + (byProv.FLP ?? 0)
  if (gps === 0 && net > 0) acc.findings.push({ id: 'no-gnss', severity: 'serious', title: 'אין פתרונות GNSS בכלל', detail: `כל ${net} הפתרונות הגיעו מרשת/חיישנים (NLP/FLP), לא מהמקלט.`, benign: 'הקלטה בתוך מבנה.' })
}

// ------------------------------------------------------------------
// Receiver-level checks (log files)
// ------------------------------------------------------------------

function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN }
function std(a: number[]) { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : NaN }

function checkCn0(epochs: Epoch[], acc: Acc) {
  const perEpoch = epochs.map((e) => {
    const v = e.signals.map((s) => s.cn0).filter((x): x is number => x !== null && x > 0)
    return { t: e.t, mean: mean(v), std: std(v), n: v.length, max: v.length ? Math.max(...v.slice(0, 500)) : NaN }
  }).filter((x) => x.n >= 4)
  if (perEpoch.length < 10) { acc.unavailable.push('התפלגות C/N₀'); return }

  // Uniformly high and tight C/N0 = classic simulator/spoofer signature (one transmitter, same path loss).
  const uniform = perEpoch.filter((x) => x.std < T.cn0UniformStd && x.mean > 38)
  if (uniform.length > perEpoch.length * 0.3) {
    acc.findings.push({ id: 'cn0-uniform', severity: 'critical', title: 'עוצמת אות אחידה בכל הלוויינים', detail: `ב-${fmt((uniform.length / perEpoch.length) * 100, 0)}% מהאפוקים פיזור ה-C/N₀ בין הלוויינים קטן מ-${T.cn0UniformStd} dB. לוויינים אמיתיים בזוויות שונות נותנים פיזור של 4–8 dB. אות אחיד מגיע ממשדר יחיד.`, benign: 'כמעט אין הסבר תמים לדפוס הזה.', at: uniform[0].t })
  } else acc.passed.push('פיזור C/N₀ טבעי בין לוויינים')

  const high = perEpoch.filter((x) => x.mean > T.cn0HighMean)
  if (high.length > perEpoch.length * 0.3) {
    acc.findings.push({ id: 'cn0-high', severity: 'serious', title: 'עוצמת אות גבוהה באופן לא טבעי', detail: `ממוצע C/N₀ מעל ${T.cn0HighMean} dB-Hz ב-${fmt((high.length / perEpoch.length) * 100, 0)}% מהאפוקים. אות מהחלל מגיע בדרך כלל ל-35–45 dB-Hz.`, benign: 'אנטנה חיצונית איכותית עם מגבר (LNA).', at: high[0].t })
  } else acc.passed.push('רמת C/N₀ סבירה')

  // Sudden collapse of C/N0 across all satellites at once = jamming or entering a structure.
  let collapses = 0, collapseAt = 0
  for (let i = 1; i < perEpoch.length; i++) {
    if (perEpoch[i - 1].mean - perEpoch[i].mean > 10 && perEpoch[i].mean < 30) { collapses++; collapseAt ||= perEpoch[i].t }
  }
  const low = perEpoch.filter((x) => x.mean < T.cn0LowMean)
  if (collapses > 0 || low.length > perEpoch.length * 0.3) {
    acc.findings.push({ id: 'cn0-low', severity: collapses > 2 ? 'serious' : 'warning', title: 'צניחה בעוצמת האות', detail: `${collapses === 1 ? "צניחה פתאומית אחת" : `${collapses} צניחות פתאומיות`} של יותר מ-10 dB בכל הלוויינים בבת אחת${collapseAt ? ` (הראשונה ב-${clock(collapseAt)})` : ''}; ${fmt((low.length / perEpoch.length) * 100, 0)}% מהזמן הממוצע מתחת ל-${T.cn0LowMean} dB-Hz.`, benign: 'כניסה למבנה, מנהרה או חניון. בשיבוש (jamming) הצניחה חדה ובכל הלוויינים יחד, בלי שינוי במיקום.', at: collapseAt || low[0]?.t })
  } else acc.passed.push('אין צניחות בעוצמת האות')
}

function checkAgc(epochs: Epoch[], acc: Acc) {
  // Per-epoch mean AGC per band; jamming raises AGC (receiver turns gain down… reported as dB change).
  const series: { t: number; v: number }[] = []
  for (const e of epochs) {
    const v = e.signals.map((s) => s.agc).filter((x): x is number => x !== null && x !== undefined)
    if (v.length) series.push({ t: e.t, v: mean(v) })
  }
  if (series.length < 10) { acc.unavailable.push('AGC (בקרת הגבר)'); return }
  const baseline = median(series.slice(0, Math.max(5, Math.floor(series.length * 0.2))).map((x) => x.v))
  const dev = series.map((x) => ({ t: x.t, d: x.v - baseline }))
  const bad = dev.filter((x) => Math.abs(x.d) > T.agcJumpDb)
  if (bad.length > series.length * 0.1) {
    const worst = bad.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a))
    acc.findings.push({ id: 'agc', severity: 'critical', title: 'שינוי חד ב-AGC (בקרת ההגבר של המקלט)', detail: `ה-AGC סטה ב-${fmt(worst.d, 1)} dB מהבסיס (${fmt(baseline, 1)} dB) ב-${clock(worst.t)}, וב-${fmt((bad.length / series.length) * 100, 0)}% מהזמן. AGC הוא המדד הישיר ביותר לאנרגיית RF זרה בתדר ה-GNSS, והוא משתנה גם כשאין עדיין פגיעה במיקום.`, benign: 'מעבר ליד משדר חזק (רדאר, תחנת בסיס), או הפרעה ממכשיר אלקטרוני בקרבת הטלפון.', at: worst.t })
  } else acc.passed.push('AGC יציב')
}

function median(a: number[]) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }

function checkSatellites(epochs: Epoch[], acc: Acc) {
  if (epochs.length < 10) { acc.unavailable.push('מספר לוויינים'); return }
  const counts = epochs.map((e) => ({ t: e.t, tracked: satellitesOf(e.signals).filter((s) => (s.cn0 ?? 0) > 0).length, used: satellitesOf(e.signals).filter((s) => s.used).length, hasUsed: e.signals.some((s) => s.used !== null) }))
  // Sudden loss of all satellites.
  let losses = 0, lossAt = 0
  for (let i = 1; i < counts.length; i++) if (counts[i - 1].tracked >= 8 && counts[i].tracked <= 2) { losses++; lossAt ||= counts[i].t }
  if (losses) acc.findings.push({ id: 'sat-loss', severity: 'serious', title: 'אובדן פתאומי של כל הלוויינים', detail: `${losses === 1 ? "פעם אחת" : `${losses} פעמים`} המקלט ירד מ-8+ לוויינים ל-2 או פחות בתוך אפוק אחד (הראשונה ב-${clock(lossAt)}).`, benign: 'כניסה למנהרה. שיבוש רחב-סרט מפיל את כל הלוויינים יחד.', at: lossAt })
  else acc.passed.push('אין אובדן פתאומי של לוויינים')
  // Tracking many but using few: measurements rejected by the receiver's own consistency checks.
  const withUsed = counts.filter((c) => c.hasUsed && c.tracked >= 8)
  if (withUsed.length >= 10) {
    const lowRatio = withUsed.filter((c) => c.used / c.tracked < 0.4)
    if (lowRatio.length > withUsed.length * 0.3) acc.findings.push({ id: 'used-ratio', severity: 'serious', title: 'המקלט פוסל את רוב המדידות', detail: `ב-${fmt((lowRatio.length / withUsed.length) * 100, 0)}% מהאפוקים פחות מ-40% מהלוויינים במעקב משמשים בפתרון. המקלט עוקב אחרי אותות אבל דוחה אותם כלא עקביים.`, benign: 'ריבוי נתיבים (multipath) חמור בין בניינים גבוהים.', at: lowRatio[0].t })
    else acc.passed.push('רוב הלוויינים במעקב משמשים בפתרון')
  }
}

function checkConstellations(epochs: Epoch[], acc: Acc) {
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
    if (sats.length >= 6 && sats.every((s) => s.sys === 'GPS')) gpsOnly++
  }
  if (systems.size >= 2 && gpsOnly > epochs.length * 0.2) {
    acc.findings.push({ id: 'gps-only', severity: 'serious', title: 'רק לווייני GPS נקלטים בחלק מהזמן', detail: `ב-${fmt((gpsOnly / epochs.length) * 100, 0)}% מהאפוקים נקלטים 6+ לווייני GPS אבל אפס Galileo/GLONASS/BeiDou, למרות שהמקלט קולט אותם בשאר הלוג. סימולטורים פשוטים משדרים GPS L1 בלבד.`, benign: 'הגדרת מקלט שמכבה מערכות אחרות.' })
  } else if (systems.size >= 2) acc.passed.push('קליטה רב-מערכתית עקבית')
  if (bands.size >= 2) acc.passed.push(`קליטה בכמה תדרים (${[...bands].slice(0, 4).join(', ')})`)
  else if (bands.size === 1) acc.findings.push({ id: 'single-band', severity: 'info', title: 'קליטה בתדר יחיד', detail: `רק ${[...bands][0]} בלוג. זיוף של תדר אחד קל בהרבה מזיוף של L1+L5 יחד.`, benign: 'מקלט חד-תדרי.' })
}

function checkNmeaQuality(fixes: LogFix[], acc: Acc) {
  const q = fixes.filter((f) => f.quality !== null && f.quality !== undefined)
  if (q.length < 10) return
  const dr = q.filter((f) => f.quality === 6)
  if (dr.length) acc.findings.push({ id: 'dead-reckoning', severity: 'warning', title: 'המקלט עבר לניווט עיוור (dead reckoning)', detail: `${dr.length} פתרונות (${fmt((dr.length / q.length) * 100, 0)}%) סומנו כ-DR, כלומר בלי לוויינים, רק חיישנים. הראשון ב-${clock(dr[0].t)}.`, benign: 'מנהרה או חניון.', at: dr[0].t })
  const sv = q.filter((f) => f.numSv !== null && f.numSv !== undefined)
  const lowSv = sv.filter((f) => f.numSv! < T.minSatsForFix)
  if (sv.length >= 10 && lowSv.length > sv.length * 0.2) acc.findings.push({ id: 'low-sv', severity: 'warning', title: 'מעט לוויינים בפתרון', detail: `${fmt((lowSv.length / sv.length) * 100, 0)}% מהפתרונות עם פחות מ-${T.minSatsForFix} לוויינים.`, benign: 'שמיים חסומים.' })
  const hd = q.filter((f) => f.hdop !== null && f.hdop !== undefined)
  const badHdop = hd.filter((f) => f.hdop! > 5)
  if (hd.length >= 10 && badHdop.length > hd.length * 0.2) acc.findings.push({ id: 'hdop', severity: 'warning', title: 'גאומטריה גרועה (HDOP גבוה)', detail: `HDOP מעל 5 ב-${fmt((badHdop.length / hd.length) * 100, 0)}% מהפתרונות.`, benign: 'שמיים חסומים.' })
}

function checkBasebandDivergence(epochs: Epoch[], acc: Acc) {
  const diffs: { t: number; d: number }[] = []
  for (const e of epochs) {
    const pairs = e.signals.filter((s) => s.cn0 !== null && s.basebandCn0 !== null && s.basebandCn0 !== undefined && s.cn0 > 0)
    if (pairs.length >= 4) diffs.push({ t: e.t, d: mean(pairs.map((s) => s.cn0! - s.basebandCn0!)) })
  }
  if (diffs.length < 10) { acc.unavailable.push('השוואת C/N₀ אנטנה/בייסבנד'); return }
  const base = median(diffs.slice(0, Math.max(5, Math.floor(diffs.length * 0.2))).map((x) => x.d))
  const bad = diffs.filter((x) => x.d - base > 4)
  if (bad.length > diffs.length * 0.1) acc.findings.push({ id: 'baseband', severity: 'serious', title: 'פער גדל בין C/N₀ באנטנה לבייסבנד', detail: `הפער עלה ביותר מ-4 dB מעל הבסיס (${fmt(base, 1)} dB) ב-${fmt((bad.length / diffs.length) * 100, 0)}% מהזמן, מ-${clock(bad[0].t)}. פער שגדל מעיד על אנרגיה בתוך רוחב הפס שאינה אות לוויין.`, benign: 'הפרעה מקומית מהטלפון עצמו (USB, טעינה).', at: bad[0].t })
  else acc.passed.push('C/N₀ אנטנה ובייסבנד עקביים')
}

// ------------------------------------------------------------------
// Scoring
// ------------------------------------------------------------------

const WEIGHT: Record<Severity, number> = { critical: 45, serious: 25, warning: 10, info: 0 }

function finalize(acc: Acc): IntegrityReport {
  const order: Severity[] = ['critical', 'serious', 'warning', 'info']
  acc.findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
  const score = Math.min(100, acc.findings.reduce((s, f) => s + WEIGHT[f.severity], 0))
  const verdict: Verdict = acc.findings.some((f) => f.severity === 'critical') || score >= 70 ? 'critical' : score >= 35 ? 'degraded' : score > 0 ? 'suspect' : 'ok'
  return { verdict, score, findings: acc.findings, passed: acc.passed, unavailable: acc.unavailable, timeline: acc.timeline }
}

/** Live tab: only the position stream from the browser is available. */
export function analyzeLive(points: IntegrityPoint[]): IntegrityReport {
  const acc: Acc = { findings: [], passed: [], unavailable: [], timeline: new Array(points.length).fill(0) }
  checkMotion(points, acc)
  checkReportedVsDerivedSpeed(points, acc)
  checkFrozen(points, acc)
  checkAccuracyBehaviour(points, acc)
  checkAltitude(points, acc)
  checkTime(points, acc)
  acc.unavailable.push('AGC, C/N₀, לוויינים: לא זמינים בדפדפן. טען לוג מ-GPSTest/GnssLogger לבדיקה מלאה.')
  return finalize(acc)
}

/** Log tab: positions plus whatever receiver data the file carries. */
export function analyzeLog(fixes: LogFix[], epochs: Epoch[]): IntegrityReport {
  // Prefer GNSS-provider fixes for motion checks so NLP jumps aren't blamed on the receiver.
  const gnss = fixes.filter((f) => f.provider === 'GPS' || f.provider === 'NMEA')
  const points = (gnss.length >= 10 ? gnss : fixes)
  const acc: Acc = { findings: [], passed: [], unavailable: [], timeline: new Array(points.length).fill(0) }
  checkMotion(points, acc)
  checkReportedVsDerivedSpeed(points, acc)
  checkFrozen(points, acc)
  checkAccuracyBehaviour(points, acc)
  checkAltitude(points, acc)
  checkTime(points, acc)
  checkProviderMix(fixes, acc)
  if (epochs.length) {
    checkCn0(epochs, acc)
    checkAgc(epochs, acc)
    checkBasebandDivergence(epochs, acc)
    checkSatellites(epochs, acc)
    checkConstellations(epochs, acc)
  } else acc.unavailable.push('נתוני לוויינים (אין רשומות Status/Raw/GSV בלוג)')
  checkNmeaQuality(fixes, acc)
  return finalize(acc)
}

export const VERDICT_TEXT: Record<Verdict, { label: string; summary: string }> = {
  ok: { label: 'תקין', summary: 'לא נמצאו סימני שיבוש או זיוף.' },
  suspect: { label: 'חריגות קלות', summary: 'נמצאו חריגות שבדרך כלל יש להן הסבר תמים.' },
  degraded: { label: 'חשד', summary: 'כמה סימנים מצטברים שמתאימים להפרעה. בדוק את הממצאים.' },
  critical: { label: 'סימני שיבוש/זיוף', summary: 'נמצא לפחות דפוס אחד שקשה להסביר בלי הפרעה מכוונת.' },
}
