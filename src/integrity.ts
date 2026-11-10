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

import type { ClockSample, Epoch, LogFix } from './logParser'
import type { MotionSecond } from './motion'
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
// Time formatting per analysis: logs are shown in UTC, the live tab in the phone's local time.
const utcClock = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour12: false, timeZone: 'UTC' })
const localClock = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour12: false })

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

type Acc = {
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

function newAcc(points: IntegrityPoint[], clk: (t: number) => string): Acc {
  const seconds = new Set<number>()
  for (const p of points) seconds.add(Math.floor(p.t / 1000))
  return { findings: [], passed: [], unavailable: [], pts: points, heat: new Map(), seconds, clk }
}

/** Add suspicion at a moment in time. */
function bumpT(acc: Acc, t: number, w: number) {
  if (!Number.isFinite(t)) return
  const k = Math.floor(t / 1000)
  acc.heat.set(k, Math.min(100, (acc.heat.get(k) ?? 0) + w))
  acc.seconds.add(k)
}

/** Add suspicion at the time of position point i. */
function bump(acc: Acc, i: number, w: number) {
  const p = acc.pts[i]
  if (p) bumpT(acc, p.t, w)
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
    acc.findings.push({ id: 'jump', severity: jumps >= 3 ? 'critical' : 'serious', title: 'קפיצות מיקום בלתי אפשריות', detail: `${jumps === 1 ? "קפיצה אחת" : `${jumps} קפיצות`} של יותר מ-${T.jumpMetres} מ׳ בין פתרונות עוקבים. ${jumps === 1 ? "גודל: " : "הגדולה: "}${fmt(worstJump, 0)} מ׳ ב-${acc.clk(worstJumpAt)}.`, benign: 'יציאה ממנהרה או מבניין, או מעבר בין GNSS לרשת סלולרית (ספק NLP/FLP).', at: worstJumpAt })
  } else acc.passed.push('קפיצות מיקום')
  if (worstSpeed > T.maxSpeedMps) {
    acc.findings.push({ id: 'speed', severity: worstSpeed > 3 * T.maxSpeedMps ? 'critical' : 'serious', title: 'מהירות בלתי סבירה', detail: `${fmt(worstSpeed * 3.6, 0)} קמ״ש בין שני פתרונות ב-${acc.clk(worstSpeedAt)}.`, benign: 'פתרון יחיד שגוי אחרי אובדן קליטה.', at: worstSpeedAt })
    bump(acc, worstSpeedI, 40)
  } else acc.passed.push('מהירות סבירה')
  if (worstAccel > T.maxAccelMps2) {
    acc.findings.push({ id: 'accel', severity: 'warning', title: 'תאוצה בלתי סבירה', detail: `${fmt(worstAccel, 1)} m/s² (≈${fmt(worstAccel / 9.81, 1)} g) ב-${acc.clk(worstAccelAt)}.`, benign: 'רעש במהירות המחושבת כשהדיוק גרוע.', at: worstAccelAt })
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
    acc.findings.push({ id: 'doppler', severity: 'serious', title: 'המהירות המדווחת לא תואמת לתזוזה', detail: `ב-${fmt((disagree / pairs.length) * 100, 0)}% מהפתרונות המהירות שהמקלט מדווח (דופלר) שונה מהמהירות שנגזרת מהמיקום. פער מרבי ${fmt(worstDiff, 1)} m/s ב-${acc.clk(worstAt)}.`, benign: 'מיקום שמגיע משילוב חיישנים או מרשת ולא מ-GNSS.', at: worstAt })
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
    acc.findings.push({ id: 'frozen', severity: 'serious', title: 'מיקום קפוא בזמן שהמקלט מדווח על תנועה', detail: `${worst} פתרונות עוקבים עם קואורדינטות זהות עד הספרה האחרונה, בעוד המהירות המדווחת גדולה מ-1 m/s (עד ${acc.clk(worstAt)}). חתימה טיפוסית של שידור חוזר (replay).`, benign: 'כמעט אין: מקלט שנע לא יכול להחזיר מיקום זהה.', at: worstAt })
    for (let k = worstI - worst + 1; k <= worstI; k++) bump(acc, k, 15)
  } else if (worst >= 300) {
    acc.findings.push({ id: 'frozen', severity: 'info', title: 'מיקום זהה לאורך זמן רב', detail: `${worst} פתרונות עוקבים עם קואורדינטות זהות (עד ${acc.clk(worstAt)}).`, benign: 'עמידה במקום עם מקלט שמעגל פלט, או מצב חיסכון. מקלט אמיתי בדרך כלל "רועד" במטרים בודדים גם בעמידה.', at: worstAt })
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
  if (worst) acc.findings.push({ id: 'alt-frozen', severity: 'warning', title: 'הגובה קפוא בזמן תנועה', detail: `${worst} פתרונות עם גובה זהה לאורך יותר מ-200 מ׳ של תנועה (עד ${acc.clk(worstAt)}).`, benign: 'פתרון דו-ממדי (2D fix) כשיש מעט לוויינים.', at: worstAt })
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
  if (absurd) acc.findings.push({ id: 'alt-absurd', severity: 'serious', title: 'גובה בלתי אפשרי', detail: `גובה של ${fmt(absurd.alt!, 0)} מ׳ ב-${acc.clk(absurd.t)}.`, benign: 'פתרון ראשון שגוי מיד אחרי הפעלה.', at: absurd.t })
  else if (worstRate > 50) acc.findings.push({ id: 'alt-rate', severity: 'warning', title: 'שינוי גובה מהיר מדי', detail: `${fmt(worstRate, 0)} מ׳/שנייה אנכית ב-${acc.clk(rateAt)}.`, benign: 'רעש בגובה בקליטה גרועה. הגובה הוא התוצר הכי רועש של GNSS.', at: rateAt })
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
  for (const x of uniform) bumpT(acc, x.t, 30)
  for (const x of perEpoch) if (x.mean > T.cn0HighMean) bumpT(acc, x.t, 10)
  for (const x of perEpoch) if (x.mean < T.cn0LowMean) bumpT(acc, x.t, 10)
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
    if (perEpoch[i - 1].mean - perEpoch[i].mean > 10 && perEpoch[i].mean < 30) { collapses++; collapseAt ||= perEpoch[i].t; bumpT(acc, perEpoch[i].t, 30) }
  }
  const low = perEpoch.filter((x) => x.mean < T.cn0LowMean)
  if (collapses > 0 || low.length > perEpoch.length * 0.3) {
    acc.findings.push({ id: 'cn0-low', severity: collapses > 2 ? 'serious' : 'warning', title: 'צניחה בעוצמת האות', detail: `${collapses === 1 ? "צניחה פתאומית אחת" : `${collapses} צניחות פתאומיות`} של יותר מ-10 dB בכל הלוויינים בבת אחת${collapseAt ? ` (הראשונה ב-${acc.clk(collapseAt)})` : ''}; ${fmt((low.length / perEpoch.length) * 100, 0)}% מהזמן הממוצע מתחת ל-${T.cn0LowMean} dB-Hz.`, benign: 'כניסה למבנה, מנהרה או חניון. בשיבוש (jamming) הצניחה חדה ובכל הלוויינים יחד, בלי שינוי במיקום.', at: collapseAt || low[0]?.t })
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
  for (const x of bad) bumpT(acc, x.t, 40)
  if (bad.length > series.length * 0.1) {
    const worst = bad.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a))
    acc.findings.push({ id: 'agc', severity: 'critical', title: 'שינוי חד ב-AGC (בקרת ההגבר של המקלט)', detail: `ה-AGC סטה ב-${fmt(worst.d, 1)} dB מהבסיס (${fmt(baseline, 1)} dB) ב-${acc.clk(worst.t)}, וב-${fmt((bad.length / series.length) * 100, 0)}% מהזמן. AGC הוא המדד הישיר ביותר לאנרגיית RF זרה בתדר ה-GNSS, והוא משתנה גם כשאין עדיין פגיעה במיקום.`, benign: 'מעבר ליד משדר חזק (רדאר, תחנת בסיס), או הפרעה ממכשיר אלקטרוני בקרבת הטלפון.', at: worst.t })
  } else acc.passed.push('AGC יציב')
}

function median(a: number[]) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }

function checkSatellites(epochs: Epoch[], acc: Acc) {
  if (epochs.length < 10) { acc.unavailable.push('מספר לוויינים'); return }
  const counts = epochs.map((e) => ({ t: e.t, tracked: satellitesOf(e.signals).filter((s) => (s.cn0 ?? 0) > 0).length, used: satellitesOf(e.signals).filter((s) => s.used).length, hasUsed: e.signals.some((s) => s.used !== null) }))
  // Sudden loss of all satellites.
  let losses = 0, lossAt = 0
  for (let i = 1; i < counts.length; i++) if (counts[i - 1].tracked >= 8 && counts[i].tracked <= 2) { losses++; lossAt ||= counts[i].t; bumpT(acc, counts[i].t, 30) }
  if (losses) acc.findings.push({ id: 'sat-loss', severity: 'serious', title: 'אובדן פתאומי של כל הלוויינים', detail: `${losses === 1 ? "פעם אחת" : `${losses} פעמים`} המקלט ירד מ-8+ לוויינים ל-2 או פחות בתוך אפוק אחד (הראשונה ב-${acc.clk(lossAt)}).`, benign: 'כניסה למנהרה. שיבוש רחב-סרט מפיל את כל הלוויינים יחד.', at: lossAt })
  else acc.passed.push('אין אובדן פתאומי של לוויינים')
  // Tracking many but using few: measurements rejected by the receiver's own consistency checks.
  const withUsed = counts.filter((c) => c.hasUsed && c.tracked >= 8)
  if (withUsed.length >= 10) {
    const lowRatio = withUsed.filter((c) => c.used / c.tracked < 0.4)
    for (const c of lowRatio) bumpT(acc, c.t, 10)
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
    if (sats.length >= 6 && sats.every((s) => s.sys === 'GPS')) { gpsOnly++; if (systems.size >= 2) bumpT(acc, e.t, 20) }
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
  for (const f of dr) bumpT(acc, f.t, 15)
  if (dr.length) acc.findings.push({ id: 'dead-reckoning', severity: 'warning', title: 'המקלט עבר לניווט עיוור (dead reckoning)', detail: `${dr.length} פתרונות (${fmt((dr.length / q.length) * 100, 0)}%) סומנו כ-DR, כלומר בלי לוויינים, רק חיישנים. הראשון ב-${acc.clk(dr[0].t)}.`, benign: 'מנהרה או חניון.', at: dr[0].t })
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
  for (const x of bad) bumpT(acc, x.t, 20)
  if (bad.length > diffs.length * 0.1) acc.findings.push({ id: 'baseband', severity: 'serious', title: 'פער גדל בין C/N₀ באנטנה לבייסבנד', detail: `הפער עלה ביותר מ-4 dB מעל הבסיס (${fmt(base, 1)} dB) ב-${fmt((bad.length / diffs.length) * 100, 0)}% מהזמן, מ-${acc.clk(bad[0].t)}. פער שגדל מעיד על אנרגיה בתוך רוחב הפס שאינה אות לוויין.`, benign: 'הפרעה מקומית מהטלפון עצמו (USB, טעינה).', at: bad[0].t })
  else acc.passed.push('C/N₀ אנטנה ובייסבנד עקביים')
}

// ------------------------------------------------------------------
// GNSS vs network location (Android logs with NLP fixes)
// ------------------------------------------------------------------
//
// The phone has two independent ways to know where it is: the GNSS receiver, and the network
// location provider (cell towers + Wi-Fi access points). A GNSS spoofer only fools the first.
// GnssLogger / GPSTest record both as Fix records (provider GPS vs NLP). FLP is a fusion that
// already contains GNSS, so it is not an independent witness and is ignored here.

const NET = {
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
    let lo = 0, hi = gnss.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (gnss[mid].t < n.t) lo = mid + 1; else hi = mid }
    const g = lo > 0 && Math.abs(gnss[lo - 1].t - n.t) < Math.abs(gnss[lo].t - n.t) ? gnss[lo - 1] : gnss[lo]
    if (Math.abs(g.t - n.t) > NET.maxPairGapMs) continue
    const distM = haversine(g as IntegrityPoint, n as IntegrityPoint)
    const tolM = Math.max(NET.minDisagreeM, NET.sigmaFactor * ((g.acc ?? 20) + (n.acc ?? 1000)))
    out.push({ t: n.t, distM, tolM, gnssAcc: g.acc, netAcc: n.acc })
  }
  return out
}

function checkGnssVsNetwork(fixes: LogFix[], acc: Acc) {
  const pairs = pairGnssWithNetwork(fixes)
  if (!pairs.length) {
    const hasNet = fixes.some((f) => f.provider === 'NLP')
    acc.unavailable.push(hasNet ? 'השוואת GNSS למיקום מהרשת (אין פתרונות GNSS ורשת באותו זמן)' : 'השוואת GNSS למיקום מהרשת (אין בלוג מיקומי רשת NLP)')
    return
  }
  const bad = pairs.filter((p) => p.distM > p.tolM)
  for (const p of bad) bumpT(acc, p.t, 35)
  if (!bad.length) {
    const worst = pairs.reduce((a, b) => (b.distM > a.distM ? b : a))
    acc.passed.push(`מיקום ה-GNSS תואם למיקום מהרשת הסלולרית (${pairs.length === 1 ? 'השוואה אחת' : `${pairs.length} השוואות`}, פער מרבי ${fmt(worst.distM, 0)} מ׳)`)
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

// ------------------------------------------------------------------
// C/N0 common-mode correlation across satellites
// ------------------------------------------------------------------
//
// Real satellites sit in different directions. When the phone moves or turns, each satellite's
// signal changes differently (one is blocked by the body, another comes into view). A spoofer
// transmits every "satellite" from one antenna, so all of them rise and fall together.
//
// Per sliding window: take each satellite's epoch-to-epoch C/N0 change, and measure how much of
// the change is shared by all satellites. 0 = independent (genuine), 1 = identical (one source).

const CORR = {
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
      if (!m) { m = new Map(); series.set(k, m) }
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
        const a = m.get(i - 1), b = m.get(i)
        if (a === undefined || b === undefined) { ok = false; break }
        d.push(b - a)
      }
      if (ok) deltas.push(d)
    }
    const n = deltas.length
    if (n < CORR.minSats) continue
    const len = deltas[0].length
    const variance = (x: number[]) => { const mu = x.reduce((s, v) => s + v, 0) / x.length; return x.reduce((s, v) => s + (v - mu) ** 2, 0) / x.length }
    const perSat = deltas.map(variance)
    const meanVar = perSat.reduce((s, v) => s + v, 0) / n
    if (meanVar <= 0) continue
    const common: number[] = []
    for (let k = 0; k < len; k++) { let s = 0; for (const d of deltas) s += d[k]; common.push(s / n) }
    const ratio = variance(common) / meanVar // 1/n if independent, 1 if identical
    const rho = Math.max(0, Math.min(1, (ratio - 1 / n) / (1 - 1 / n)))
    out.push({ from: epochs[start].t, t: epochs[end - 1].t, rho, activity: Math.sqrt(meanVar), sats: n })
  }
  return out
}

function checkCn0Correlation(epochs: Epoch[], acc: Acc) {
  const windows = cn0CommonMode(epochs)
  const judged = windows.filter((w) => w.activity >= CORR.minActivityDb)
  if (judged.length < 3) {
    acc.unavailable.push(windows.length ? 'מתאם C/N₀ בין לוויינים (האות יציב מדי כדי לשפוט, למשל טלפון מונח במקום)' : 'מתאם C/N₀ בין לוויינים (הלוג קצר מדי)')
    return
  }
  const flagged = judged.filter((w) => w.rho > CORR.flagRho)
  // The evidence covers the whole window, not just its last epoch.
  for (const w of flagged) for (let s = Math.floor(w.from / 1000); s <= Math.floor(w.t / 1000); s++) bumpT(acc, s * 1000, 25)
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

// ------------------------------------------------------------------
// Receiver clock (Android Raw logs)
// ------------------------------------------------------------------
//
// The receiver estimates its own clock offset (FullBiasNanos + BiasNanos) and its rate
// (DriftNanosPerSecond). On genuine signals the two agree to ~1 ns/s: the bias changes exactly
// as fast as the reported drift says. Most real spoofing attacks work by slowly "pulling" the
// victim's time and position; the receiver then sees its clock bias move in ways its own drift
// estimate doesn't explain. Independently, GNSS time should stay locked to the phone's system
// clock (which is set from the cellular network on most phones).

const CLOCK = {
  warmupEpochs: 3, // the first fixes legitimately re-estimate the bias
  driftResidualNs: 50, // |observed rate − reported drift|, ns/s (genuine: ≤ 1)
  rateStepNs2: 200, // |change in observed rate| / dt, ns/s² when drift isn't reported (genuine: ≤ ~45)
  offsetSerialMs: 200, // spread of GNSS-vs-system time offset during the session
  offsetCriticalMs: 2000,
}

function checkClock(samples: ClockSample[], acc: Acc) {
  if (samples.length < CLOCK.warmupEpochs + 5) { acc.unavailable.push('שעון המקלט (דורש רשומות Raw)'); return }
  const c = samples.slice(CLOCK.warmupEpochs)
  type Step = { t: number; dt: number; rate: number; drift: number | null }
  const steps: Step[] = []
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1], b = c[i]
    if (a.discontinuity !== b.discontinuity) continue // hardware clock reset: not comparable
    const dt = Number(b.timeNanos - a.timeNanos) / 1e9
    if (!(dt > 0 && dt <= 10)) continue
    const dBias = Number(b.fullBiasNanos - a.fullBiasNanos) + (b.biasNanos - a.biasNanos)
    const drift = a.driftNanosPerSecond !== null && b.driftNanosPerSecond !== null ? (a.driftNanosPerSecond + b.driftNanosPerSecond) / 2 : null
    steps.push({ t: b.t, dt, rate: dBias / dt, drift })
  }
  if (steps.length < 4) { acc.unavailable.push('שעון המקלט'); return }

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
    const how = worst.unit === 'ns/s'
      ? `קצב השינוי של הסטת השעון סטה ב-${fmt(Math.abs(worst.v), 0)} ns/s מהסחיפה שהמקלט עצמו מדווח (במקלט תקין הפער הוא כ-1 ns/s)`
      : `קצב הסחיפה של השעון השתנה ב-${fmt(Math.abs(worst.v), 0)} ns/s² בבת אחת (במקלט תקין: עד כ-45)`
    acc.findings.push({ id: 'clock', severity: anomalies.length >= 3 ? 'critical' : 'serious', title: 'שעון המקלט "נמשך" (סימן מובהק לזיוף)', detail: `${how}, ב-${acc.clk(worst.t)}. ${anomalies.length === 1 ? 'אירוע אחד' : `${anomalies.length} אירועים`} כאלה בלוג. זיוף GNSS מתוחכם מושך בהדרגה את הזמן של המקלט, וזה הסימן שהוא משאיר.`, benign: 'כמעט אין: איפוס של שעון החומרה מסומן בנפרד ומוחרג מהבדיקה.', at: worst.t })
  } else acc.passed.push(withDrift.length >= steps.length / 2 ? 'הסטת השעון תואמת לסחיפה המדווחת' : 'קצב סחיפת השעון יציב')

  // 2. GNSS time vs the phone's own clock.
  const offs: { t: number; ms: number }[] = []
  for (const s of c) {
    if (s.systemMs === null) continue
    const gpsMs = Number(s.timeNanos - s.fullBiasNanos) / 1e6 - s.biasNanos / 1e6 + 315964800000
    offs.push({ t: s.t, ms: gpsMs - (s.leapSecond ?? 18) * 1000 - s.systemMs })
  }
  if (offs.length < 5) { acc.unavailable.push('השוואת זמן GNSS לשעון הטלפון'); return }
  // Baseline from the start of the session only, so a slow shift can't drag the reference along.
  const base = median(offs.slice(0, Math.max(3, Math.min(10, Math.floor(offs.length * 0.2)))).map((o) => o.ms))
  let worst = offs[0], spread = 0
  for (const o of offs) { const d = Math.abs(o.ms - base); if (d > spread) { spread = d; worst = o } if (d > CLOCK.offsetSerialMs) bumpT(acc, o.t, 30) }
  if (spread > CLOCK.offsetSerialMs) {
    acc.findings.push({ id: 'time-offset', severity: spread > CLOCK.offsetCriticalMs ? 'critical' : 'serious', title: 'זמן ה-GNSS נפרד משעון הטלפון', detail: `ההפרש בין הזמן שהמקלט מחשב מהלוויינים לבין השעון של הטלפון זז ב-${fmt(spread, 0)} מילישניות במהלך ההקלטה (ב-${acc.clk(worst.t)}). בהקלטה תקינה ההפרש יציב בטווח של כמה מילישניות. זיוף שמזיז זמן גורם בדיוק לזה.`, benign: 'כיוון של שעון הטלפון מהרשת (NTP) באמצע ההקלטה. בדרך כלל זה תיקון חד-פעמי של עשרות מילישניות.', at: worst.t })
  } else acc.passed.push(`זמן ה-GNSS צמוד לשעון הטלפון (סטייה מרבית ${fmt(spread, 0)} ms)`)
}


// ------------------------------------------------------------------
// Phone motion sensors vs GNSS (live tab)
// ------------------------------------------------------------------

const SENSE = {
  stillStd: 0.12, // m/s²: phone lying still (walking ≈ 1–3, car ≈ 0.2–0.6)
  activeStd: 1.0, // m/s²: clearly being carried / walking
  gnssMovingMps: 2.5, // GNSS speed that counts as "moving"
  stillWhileMovingSec: 15, // consecutive seconds of disagreement before flagging
  movingWhileFixedSec: 45,
  turnDeg: 60, // GNSS course change that must show up on the gyroscope
  gyroMinDeg: 15,
}

/** Course over ground (degrees) between two points. */
function bearing(a: IntegrityPoint, b: IntegrityPoint) {
  const φ1 = a.lat * rad, φ2 = b.lat * rad, Δλ = (b.lon - a.lon) * rad
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) / rad) + 360) % 360
}
const angleDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

function checkSensors(p: IntegrityPoint[], motion: MotionSecond[], acc: Acc) {
  if (motion.length < 30 || p.length < 20) { acc.unavailable.push(motion.length ? 'הצלבה עם חיישני התנועה (נאספים נתונים)' : 'הצלבה עם חיישני התנועה (לא הופעלה)'); return }
  const bySec = new Map(motion.map((m) => [Math.floor(m.t / 1000), m]))

  // GNSS speed per second: Doppler speed when reported, otherwise displacement over ~5 s.
  const gnssSpeed = new Map<number, number>()
  for (let i = 0; i < p.length; i++) {
    let v = p[i].speed
    if (v === null) {
      const j = Math.max(0, i - 5)
      const dt = (p[i].t - p[j].t) / 1000
      const d = haversine(p[j], p[i])
      v = dt > 0 && d > 2 * ((p[i].acc ?? 5) + (p[j].acc ?? 5)) ? d / dt : 0
    }
    gnssSpeed.set(Math.floor(p[i].t / 1000), v)
  }

  // 1. GNSS moving, phone perfectly still.
  let run = 0, worstRun = 0, worstAt = 0, total = 0
  // 2. Phone clearly carried, GNSS frozen in place.
  let run2 = 0, worstRun2 = 0, worst2At = 0
  for (const [k, v] of [...gnssSpeed.entries()].sort((a, b) => a[0] - b[0])) {
    const m = bySec.get(k)
    if (!m) { run = 0; run2 = 0; continue }
    if (m.accStd < SENSE.stillStd && v > SENSE.gnssMovingMps) {
      run++; total++; bumpT(acc, k * 1000, 30)
      if (run > worstRun) { worstRun = run; worstAt = k * 1000 }
    } else run = 0
    if (m.accStd > SENSE.activeStd && v < 0.3) {
      run2++
      if (run2 > worstRun2) { worstRun2 = run2; worst2At = k * 1000 }
    } else run2 = 0
  }
  if (worstRun >= SENSE.stillWhileMovingSec) {
    acc.findings.push({ id: 'sensor-still', severity: worstRun >= 60 ? 'critical' : 'serious', title: 'ה-GNSS מראה תנועה, אבל הטלפון עומד במקום', detail: `${worstRun} שניות רצופות (סה"כ ${total}) שבהן ה-GNSS מדווח מהירות של יותר מ-${fmt(SENSE.gnssMovingMps * 3.6, 0)} קמ"ש, בזמן שמד התאוצה מראה שהטלפון מונח בלי שום תזוזה (עד ${acc.clk(worstAt)}). המזייף שולט במה שה-GNSS מחשב, לא בתנועה הפיזית של הטלפון.`, benign: 'נסיעה חלקה במיוחד ברכבת, כשהטלפון מונח על משטח יציב.', at: worstAt })
  } else acc.passed.push('חיישני התאוצה מאשרים את התנועה שה-GNSS מדווח')
  if (worstRun2 >= SENSE.movingWhileFixedSec) {
    for (let s = 0; s < worstRun2; s++) bumpT(acc, worst2At - s * 1000, 10)
    acc.findings.push({ id: 'sensor-moving', severity: 'warning', title: 'הטלפון בתנועה, אבל מיקום ה-GNSS קפוא', detail: `${worstRun2} שניות רצופות שבהן הטלפון נישא או בהליכה לפי מד התאוצה, אבל ה-GNSS מראה עמידה במקום (עד ${acc.clk(worst2At)}). התקפה ש"מקבעת" מיקום גורמת לזה.`, benign: 'הליכה בתוך מבנה או במקום, או ניעור של הטלפון ביד.', at: worst2At })
  } else acc.passed.push('המיקום זז כשהטלפון זז')

  // 3. GNSS turns that the gyroscope never felt.
  const fast = p.filter((x) => (x.speed ?? 0) > 3)
  let turns = 0, missed = 0, missAt = 0, missDeg = 0
  const course = (j: number) => fast[j].heading ?? bearing(fast[Math.max(0, j - 1)], fast[j])
  for (let i = 5; i < fast.length; i++) {
    const a = fast[i - 5], d0 = fast[i]
    if (d0.t - a.t > 8000) continue
    const before = a.heading ?? bearing(a, fast[i - 4])
    if (angleDiff(before, course(i)) < SENSE.turnDeg) continue
    // Follow the turn to where it stops growing, so both GNSS and gyro cover the whole manoeuvre.
    let end = i, turn = angleDiff(before, course(i))
    for (let j = i + 1; j < Math.min(fast.length, i + 6) && fast[j].t - a.t <= 15000; j++) {
      const tj = angleDiff(before, course(j))
      if (tj > turn) { turn = tj; end = j }
    }
    const d = fast[end]
    turns++
    let gyro = 0
    for (let k = Math.floor(a.t / 1000) - 1; k <= Math.floor(d.t / 1000) + 1; k++) gyro += bySec.get(k)?.yawDeg ?? 0
    if (Math.abs(gyro) < SENSE.gyroMinDeg) { missed++; if (turn > missDeg) { missDeg = turn; missAt = d.t } bumpT(acc, d.t, 40) }
    i = end + 4 // the next turn must start after this one ended
  }
  if (missed) acc.findings.push({ id: 'sensor-turn', severity: missed >= 2 ? 'serious' : 'warning', title: 'פנייה ב-GNSS שהג׳ירוסקופ לא הרגיש', detail: `${missed === 1 ? 'פנייה אחת' : `${missed} פניות`} (מתוך ${turns}) שבהן מסלול ה-GNSS שינה כיוון ב-${fmt(missDeg, 0)}°, אבל חיישן הסיבוב של הטלפון כמעט לא זז (ב-${acc.clk(missAt)}).`, benign: 'פתרון GNSS רועש במהירות נמוכה, או טלפון שמחובר לרכב שמסתובב לאט מאוד.', at: missAt })
  else if (turns) acc.passed.push(`הג׳ירוסקופ אישר ${turns === 1 ? 'פנייה אחת' : `${turns} פניות`} של ה-GNSS`)
}

// ------------------------------------------------------------------
// Scoring
// ------------------------------------------------------------------

const WEIGHT: Record<Severity, number> = { critical: 45, serious: 25, warning: 10, info: 0 }

function finalize(acc: Acc): IntegrityReport {
  const order: Severity[] = ['critical', 'serious', 'warning', 'info']
  acc.findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
  const score = Math.min(100, acc.findings.reduce((s, f) => s + WEIGHT[f.severity], 0))
  const has = (s: Severity) => acc.findings.some((f) => f.severity === s)
  // One serious finding is already worth a "suspicion" verdict; warnings alone only add up.
  const verdict: Verdict = has('critical') || score >= 70 ? 'critical' : has('serious') || score >= 35 ? 'degraded' : score > 0 ? 'suspect' : 'ok'
  const timeline = [...acc.seconds].sort((a, b) => a - b).map((k) => ({ t: k * 1000, v: acc.heat.get(k) ?? 0 }))
  return { verdict, score, findings: acc.findings, passed: acc.passed, unavailable: acc.unavailable, timeline }
}

/**
 * Drop fixes that arrive less than `minGapMs` after the previous kept one. Browsers sometimes
 * deliver fixes in bursts (e.g. iOS Safari flushing buffered positions when the page returns
 * from the background); a few metres over a few milliseconds would look like an impossible
 * speed. The jump check still sees the first fix after a gap.
 */
function thin<P extends { t: number }>(points: P[], minGapMs = 500): P[] {
  const out: P[] = []
  for (const p of points) if (!out.length || p.t - out[out.length - 1].t >= minGapMs) out.push(p)
  return out
}

/** Live tab: the browser position stream, plus the phone's motion sensors when the user enabled them. */
export function analyzeLive(rawPoints: IntegrityPoint[], motion: MotionSecond[] = []): IntegrityReport {
  const points = thin(rawPoints)
  const acc = newAcc(points, localClock)
  checkMotion(points, acc)
  checkReportedVsDerivedSpeed(points, acc)
  checkFrozen(points, acc)
  checkAccuracyBehaviour(points, acc)
  checkAltitude(points, acc)
  checkTime(points, acc)
  checkSensors(points, motion, acc)
  acc.unavailable.push('AGC, C/N₀, לוויינים ושעון המקלט: לא זמינים בדפדפן. טען לוג מ-GPSTest/GnssLogger לבדיקה מלאה.')
  return finalize(acc)
}

/** Log tab: positions plus whatever receiver data the file carries. */
export function analyzeLog(fixes: LogFix[], epochs: Epoch[], clockSamples: ClockSample[] = []): IntegrityReport {
  // Prefer GNSS-provider fixes for motion checks so NLP jumps aren't blamed on the receiver.
  const gnss = fixes.filter((f) => f.provider === 'GPS' || f.provider === 'NMEA')
  const points = thin(gnss.length >= 10 ? gnss : fixes)
  const acc = newAcc(points, utcClock)
  for (const e of epochs) acc.seconds.add(Math.floor(e.t / 1000))
  checkClock(clockSamples, acc)
  checkMotion(points, acc)
  checkReportedVsDerivedSpeed(points, acc)
  checkFrozen(points, acc)
  checkAccuracyBehaviour(points, acc)
  checkAltitude(points, acc)
  checkTime(points, acc)
  checkProviderMix(fixes, acc)
  checkGnssVsNetwork(fixes, acc)
  if (epochs.length) {
    checkCn0(epochs, acc)
    checkAgc(epochs, acc)
    checkBasebandDivergence(epochs, acc)
    checkSatellites(epochs, acc)
    checkConstellations(epochs, acc)
    checkCn0Correlation(epochs, acc)
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
