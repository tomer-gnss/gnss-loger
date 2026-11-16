// Position-level checks: impossible motion, frozen or too-perfect output, altitude, time.

import { haversine, fmt, T, bump, type IntegrityPoint, type Acc } from './core'

export function checkMotion(p: IntegrityPoint[], acc: Acc) {
  if (p.length < 3) {
    acc.unavailable.push('תנועה פיזית')
    return
  }
  let worstSpeed = 0,
    worstSpeedAt = 0,
    worstSpeedI = -1
  let worstAccel = 0,
    worstAccelAt = 0,
    worstAccelI = -1
  let jumps = 0,
    worstJump = 0,
    worstJumpAt = 0
  let prevV: number | null = null
  for (let i = 1; i < p.length; i++) {
    const dt = (p[i].t - p[i - 1].t) / 1000
    if (dt <= 0 || dt > 120) {
      prevV = null
      continue
    }
    const d = haversine(p[i - 1], p[i])
    const v = d / dt
    const tolerance = (p[i].acc ?? 0) + (p[i - 1].acc ?? 0)
    if (d > T.jumpMetres && d > 3 * tolerance && dt <= 5) {
      jumps++
      if (d > worstJump) {
        worstJump = d
        worstJumpAt = p[i].t
      }
      bump(acc, i, 60)
    }
    if (v > worstSpeed && d > tolerance) {
      worstSpeed = v
      worstSpeedAt = p[i].t
      worstSpeedI = i
    }
    if (prevV !== null) {
      const a = Math.abs(v - prevV) / dt
      if (a > worstAccel && d > tolerance) {
        worstAccel = a
        worstAccelAt = p[i].t
        worstAccelI = i
      }
    }
    prevV = v
  }
  if (jumps > 0) {
    acc.findings.push({
      id: 'jump',
      severity: jumps >= 3 ? 'critical' : 'serious',
      title: 'קפיצות מיקום בלתי אפשריות',
      detail: `${jumps === 1 ? 'קפיצה אחת' : `${jumps} קפיצות`} של יותר מ-${T.jumpMetres} מ׳ בין פתרונות עוקבים. ${jumps === 1 ? 'גודל: ' : 'הגדולה: '}${fmt(worstJump, 0)} מ׳ ב-${acc.clk(worstJumpAt)}.`,
      benign: 'יציאה ממנהרה או מבניין, או מעבר בין GNSS לרשת סלולרית (ספק NLP/FLP).',
      at: worstJumpAt,
    })
  } else acc.passed.push('קפיצות מיקום')
  if (worstSpeed > T.maxSpeedMps) {
    acc.findings.push({
      id: 'speed',
      severity: worstSpeed > 3 * T.maxSpeedMps ? 'critical' : 'serious',
      title: 'מהירות בלתי סבירה',
      detail: `${fmt(worstSpeed * 3.6, 0)} קמ״ש בין שני פתרונות ב-${acc.clk(worstSpeedAt)}.`,
      benign: 'פתרון יחיד שגוי אחרי אובדן קליטה.',
      at: worstSpeedAt,
    })
    bump(acc, worstSpeedI, 40)
  } else acc.passed.push('מהירות סבירה')
  if (worstAccel > T.maxAccelMps2) {
    acc.findings.push({
      id: 'accel',
      severity: 'warning',
      title: 'תאוצה בלתי סבירה',
      detail: `${fmt(worstAccel, 1)} m/s² (≈${fmt(worstAccel / 9.81, 1)} g) ב-${acc.clk(worstAccelAt)}.`,
      benign: 'רעש במהירות המחושבת כשהדיוק גרוע.',
      at: worstAccelAt,
    })
    bump(acc, worstAccelI, 20)
  } else acc.passed.push('תאוצה סבירה')
}

export function checkReportedVsDerivedSpeed(p: IntegrityPoint[], acc: Acc) {
  // The receiver's own Doppler speed should agree with position-derived speed. A spoofer that
  // replays positions often leaves Doppler speed near zero (or vice versa).
  const pairs: number[] = []
  let disagree = 0,
    worstAt = 0,
    worstDiff = 0
  for (let i = 1; i < p.length; i++) {
    const rs = p[i].speed
    const dt = (p[i].t - p[i - 1].t) / 1000
    if (rs === null || dt <= 0 || dt > 10) continue
    const ds = haversine(p[i - 1], p[i]) / dt
    const tol = Math.max(3, ((p[i].acc ?? 10) + (p[i - 1].acc ?? 10)) / dt)
    pairs.push(i)
    const diff = Math.abs(rs - ds)
    if (diff > tol && Math.max(rs, ds) > 4) {
      disagree++
      if (diff > worstDiff) {
        worstDiff = diff
        worstAt = p[i].t
      }
      bump(acc, i, 10)
    }
  }
  if (pairs.length < 10) {
    acc.unavailable.push('השוואת מהירות דופלר למיקום')
    return
  }
  if (disagree / pairs.length > 0.3) {
    acc.findings.push({
      id: 'doppler',
      severity: 'serious',
      title: 'המהירות המדווחת לא תואמת לתזוזה',
      detail: `ב-${fmt((disagree / pairs.length) * 100, 0)}% מהפתרונות המהירות שהמקלט מדווח (דופלר) שונה מהמהירות שנגזרת מהמיקום. פער מרבי ${fmt(worstDiff, 1)} m/s ב-${acc.clk(worstAt)}.`,
      benign: 'מיקום שמגיע משילוב חיישנים או מרשת ולא מ-GNSS.',
      at: worstAt,
    })
  } else acc.passed.push('מהירות דופלר תואמת לתזוזה')
}

export function checkFrozen(p: IntegrityPoint[], acc: Acc) {
  if (p.length < T.frozenWindow) {
    acc.unavailable.push('מיקום קפוא')
    return
  }
  let run = 1,
    worst = 0,
    worstAt = 0,
    worstI = -1,
    movingWhileFrozen = false
  for (let i = 1; i < p.length; i++) {
    const same = p[i].lat === p[i - 1].lat && p[i].lon === p[i - 1].lon
    if (same) {
      run++
      if ((p[i].speed ?? 0) > 1) movingWhileFrozen = true
    } else run = 1
    if (run > worst) {
      worst = run
      worstAt = p[i].t
      worstI = i
    }
  }
  // A stationary receiver legitimately repeats coordinates (NMEA rounds to ~1 m). It only becomes
  // evidence when the receiver simultaneously claims motion, or the run is implausibly long.
  if (movingWhileFrozen && worst >= T.frozenWindow) {
    acc.findings.push({
      id: 'frozen',
      severity: 'serious',
      title: 'מיקום קפוא בזמן שהמקלט מדווח על תנועה',
      detail: `${worst} פתרונות עוקבים עם קואורדינטות זהות עד הספרה האחרונה, בעוד המהירות המדווחת גדולה מ-1 m/s (עד ${acc.clk(worstAt)}). חתימה טיפוסית של שידור חוזר (replay).`,
      benign: 'כמעט אין: מקלט שנע לא יכול להחזיר מיקום זהה.',
      at: worstAt,
    })
    for (let k = worstI - worst + 1; k <= worstI; k++) bump(acc, k, 15)
  } else if (worst >= 300) {
    acc.findings.push({
      id: 'frozen',
      severity: 'info',
      title: 'מיקום זהה לאורך זמן רב',
      detail: `${worst} פתרונות עוקבים עם קואורדינטות זהות (עד ${acc.clk(worstAt)}).`,
      benign: 'עמידה במקום עם מקלט שמעגל פלט, או מצב חיסכון. מקלט אמיתי בדרך כלל "רועד" במטרים בודדים גם בעמידה.',
      at: worstAt,
    })
  } else acc.passed.push('המיקום לא קפוא')
}

export function checkAccuracyBehaviour(p: IntegrityPoint[], acc: Acc) {
  const withAcc = p.filter((x) => x.acc !== null)
  if (withAcc.length < T.accConstantWindow) {
    acc.unavailable.push('התנהגות הדיוק המדווח')
    return
  }
  let run = 1,
    worst = 0,
    worstAt = 0
  for (let i = 1; i < withAcc.length; i++) {
    if (withAcc[i].acc === withAcc[i - 1].acc) run++
    else run = 1
    if (run > worst) {
      worst = run
      worstAt = withAcc[i].t
    }
  }
  if (worst >= T.accConstantWindow) {
    acc.findings.push({
      id: 'acc-const',
      severity: 'info',
      title: 'הדיוק המדווח קבוע',
      detail: `${worst} פתרונות עוקבים עם אותו ערך דיוק בדיוק (${fmt(withAcc[0].acc!, 1)} מ׳). רוב המקלטים משנים את הערכת הדיוק כל הזמן; ערך קבוע אומר שאי אפשר להסתמך עליו כמדד איכות.`,
      benign: 'מכשירים ישנים וספקי מיקום מסוימים מדווחים ערך קבוע.',
      at: worstAt,
    })
  } else acc.passed.push('הדיוק המדווח משתנה באופן טבעי')
}

export function checkAltitude(p: IntegrityPoint[], acc: Acc) {
  const withAlt = p.filter((x) => x.alt !== null)
  if (withAlt.length < T.altFrozenWindow) {
    acc.unavailable.push('גובה')
    return
  }
  // Frozen altitude while moving far.
  let run = 1,
    dist = 0,
    worst = 0,
    worstAt = 0
  for (let i = 1; i < withAlt.length; i++) {
    if (withAlt[i].alt === withAlt[i - 1].alt) {
      run++
      dist += haversine(withAlt[i - 1], withAlt[i])
    } else {
      run = 1
      dist = 0
    }
    if (run >= T.altFrozenWindow && dist > 200 && run > worst) {
      worst = run
      worstAt = withAlt[i].t
    }
  }
  if (worst)
    acc.findings.push({
      id: 'alt-frozen',
      severity: 'warning',
      title: 'הגובה קפוא בזמן תנועה',
      detail: `${worst} פתרונות עם גובה זהה לאורך יותר מ-200 מ׳ של תנועה (עד ${acc.clk(worstAt)}).`,
      benign: 'פתרון דו-ממדי (2D fix) כשיש מעט לוויינים.',
      at: worstAt,
    })
  else acc.passed.push('הגובה משתנה באופן טבעי')
  // Absurd altitude or vertical rate.
  let worstRate = 0,
    rateAt = 0
  for (let i = 1; i < withAlt.length; i++) {
    const dt = (withAlt[i].t - withAlt[i - 1].t) / 1000
    if (dt <= 0 || dt > 10) continue
    const rate = Math.abs(withAlt[i].alt! - withAlt[i - 1].alt!) / dt
    if (rate > worstRate) {
      worstRate = rate
      rateAt = withAlt[i].t
    }
  }
  const absurd = withAlt.find((x) => x.alt! < -500 || x.alt! > 9000)
  if (absurd)
    acc.findings.push({
      id: 'alt-absurd',
      severity: 'serious',
      title: 'גובה בלתי אפשרי',
      detail: `גובה של ${fmt(absurd.alt!, 0)} מ׳ ב-${acc.clk(absurd.t)}.`,
      benign: 'פתרון ראשון שגוי מיד אחרי הפעלה.',
      at: absurd.t,
    })
  else if (worstRate > 50)
    acc.findings.push({
      id: 'alt-rate',
      severity: 'warning',
      title: 'שינוי גובה מהיר מדי',
      detail: `${fmt(worstRate, 0)} מ׳/שנייה אנכית ב-${acc.clk(rateAt)}.`,
      benign: 'רעש בגובה בקליטה גרועה. הגובה הוא התוצר הכי רועש של GNSS.',
      at: rateAt,
    })
  else acc.passed.push('קצב שינוי הגובה סביר')
}

export function checkTime(p: IntegrityPoint[], acc: Acc) {
  if (p.length < 5) {
    acc.unavailable.push('רציפות זמן')
    return
  }
  let backwards = 0,
    worstBack = 0,
    backAt = 0
  for (let i = 1; i < p.length; i++) {
    const dt = p[i].t - p[i - 1].t
    if (dt < -T.timeStepTolMs) {
      backwards++
      if (-dt > worstBack) {
        worstBack = -dt
        backAt = p[i].t
      }
      bump(acc, i, 30)
    }
  }
  if (backwards)
    acc.findings.push({
      id: 'time-back',
      severity: 'serious',
      title: 'הזמן של המקלט חזר אחורה',
      detail: `${backwards === 1 ? 'פעם אחת' : `${backwards} פעמים`} חותמת הזמן קטנה מהקודמת (עד ${fmt(worstBack / 1000, 1)} שניות). זיוף GNSS משבש גם את זמן המקלט.`,
      benign: 'שני ספקי מיקום שכותבים ללוג לסירוגין.',
      at: backAt,
    })
  else acc.passed.push('רציפות זמן')
}

export function checkProviderMix(p: (IntegrityPoint & { provider?: string })[], acc: Acc) {
  const byProv: Record<string, number> = {}
  for (const x of p) if (x.provider) byProv[x.provider] = (byProv[x.provider] ?? 0) + 1
  const keys = Object.keys(byProv)
  if (!keys.length) return
  const gps = byProv.GPS ?? byProv.NMEA ?? 0
  const net = (byProv.NLP ?? 0) + (byProv.FLP ?? 0)
  if (gps === 0 && net > 0)
    acc.findings.push({
      id: 'no-gnss',
      severity: 'serious',
      title: 'אין פתרונות GNSS בכלל',
      detail: `כל ${net} הפתרונות הגיעו מרשת/חיישנים (NLP/FLP), לא מהמקלט.`,
      benign: 'הקלטה בתוך מבנה.',
    })
}
