// Phone motion sensors vs. the GNSS track (live tab, opt-in).

import { rad, haversine, fmt, bumpT, type IntegrityPoint, type Acc } from './core'
import type { MotionSecond } from '../motion'

export const SENSE = {
  stillStd: 0.12, // m/s²: phone lying still (walking ≈ 1–3, car ≈ 0.2–0.6)
  activeStd: 1.0, // m/s²: clearly being carried / walking
  gnssMovingMps: 2.5, // GNSS speed that counts as "moving"
  stillWhileMovingSec: 15, // consecutive seconds of disagreement before flagging
  movingWhileFixedSec: 45,
  turnDeg: 60, // GNSS course change that must show up on the gyroscope
  gyroMinDeg: 15,
}

/** Course over ground (degrees) between two points. */
export function bearing(a: IntegrityPoint, b: IntegrityPoint) {
  const φ1 = a.lat * rad,
    φ2 = b.lat * rad,
    Δλ = (b.lon - a.lon) * rad
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) / rad + 360) % 360
}
export const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

export function checkSensors(p: IntegrityPoint[], motion: MotionSecond[], acc: Acc) {
  if (motion.length < 30 || p.length < 20) {
    acc.unavailable.push(
      motion.length ? 'הצלבה עם חיישני התנועה (נאספים נתונים)' : 'הצלבה עם חיישני התנועה (לא הופעלה)',
    )
    return
  }
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
  let run = 0,
    worstRun = 0,
    worstAt = 0,
    total = 0
  // 2. Phone clearly carried, GNSS frozen in place.
  let run2 = 0,
    worstRun2 = 0,
    worst2At = 0
  for (const [k, v] of [...gnssSpeed.entries()].sort((a, b) => a[0] - b[0])) {
    const m = bySec.get(k)
    if (!m) {
      run = 0
      run2 = 0
      continue
    }
    if (m.accStd < SENSE.stillStd && v > SENSE.gnssMovingMps) {
      run++
      total++
      bumpT(acc, k * 1000, 30)
      if (run > worstRun) {
        worstRun = run
        worstAt = k * 1000
      }
    } else run = 0
    if (m.accStd > SENSE.activeStd && v < 0.3) {
      run2++
      if (run2 > worstRun2) {
        worstRun2 = run2
        worst2At = k * 1000
      }
    } else run2 = 0
  }
  if (worstRun >= SENSE.stillWhileMovingSec) {
    acc.findings.push({
      id: 'sensor-still',
      severity: worstRun >= 60 ? 'critical' : 'serious',
      title: 'ה-GNSS מראה תנועה, אבל הטלפון עומד במקום',
      detail: `${worstRun} שניות רצופות (סה"כ ${total}) שבהן ה-GNSS מדווח מהירות של יותר מ-${fmt(SENSE.gnssMovingMps * 3.6, 0)} קמ"ש, בזמן שמד התאוצה מראה שהטלפון מונח בלי שום תזוזה (עד ${acc.clk(worstAt)}). המזייף שולט במה שה-GNSS מחשב, לא בתנועה הפיזית של הטלפון.`,
      benign: 'נסיעה חלקה במיוחד ברכבת, כשהטלפון מונח על משטח יציב.',
      at: worstAt,
    })
  } else acc.passed.push('חיישני התאוצה מאשרים את התנועה שה-GNSS מדווח')
  if (worstRun2 >= SENSE.movingWhileFixedSec) {
    for (let s = 0; s < worstRun2; s++) bumpT(acc, worst2At - s * 1000, 10)
    acc.findings.push({
      id: 'sensor-moving',
      severity: 'warning',
      title: 'הטלפון בתנועה, אבל מיקום ה-GNSS קפוא',
      detail: `${worstRun2} שניות רצופות שבהן הטלפון נישא או בהליכה לפי מד התאוצה, אבל ה-GNSS מראה עמידה במקום (עד ${acc.clk(worst2At)}). התקפה ש"מקבעת" מיקום גורמת לזה.`,
      benign: 'הליכה בתוך מבנה או במקום, או ניעור של הטלפון ביד.',
      at: worst2At,
    })
  } else acc.passed.push('המיקום זז כשהטלפון זז')

  // 3. GNSS turns that the gyroscope never felt.
  const fast = p.filter((x) => (x.speed ?? 0) > 3)
  let turns = 0,
    missed = 0,
    missAt = 0,
    missDeg = 0
  const course = (j: number) => fast[j].heading ?? bearing(fast[Math.max(0, j - 1)], fast[j])
  for (let i = 5; i < fast.length; i++) {
    const a = fast[i - 5],
      d0 = fast[i]
    if (d0.t - a.t > 8000) continue
    const before = a.heading ?? bearing(a, fast[i - 4])
    if (angleDiff(before, course(i)) < SENSE.turnDeg) continue
    // Follow the turn to where it stops growing, so both GNSS and gyro cover the whole manoeuvre.
    let end = i,
      turn = angleDiff(before, course(i))
    for (let j = i + 1; j < Math.min(fast.length, i + 6) && fast[j].t - a.t <= 15000; j++) {
      const tj = angleDiff(before, course(j))
      if (tj > turn) {
        turn = tj
        end = j
      }
    }
    const d = fast[end]
    turns++
    let gyro = 0
    for (let k = Math.floor(a.t / 1000) - 1; k <= Math.floor(d.t / 1000) + 1; k++) gyro += bySec.get(k)?.yawDeg ?? 0
    if (Math.abs(gyro) < SENSE.gyroMinDeg) {
      missed++
      if (turn > missDeg) {
        missDeg = turn
        missAt = d.t
      }
      bumpT(acc, d.t, 40)
    }
    i = end + 4 // the next turn must start after this one ended
  }
  if (missed)
    acc.findings.push({
      id: 'sensor-turn',
      severity: missed >= 2 ? 'serious' : 'warning',
      title: 'פנייה ב-GNSS שהג׳ירוסקופ לא הרגיש',
      detail: `${missed === 1 ? 'פנייה אחת' : `${missed} פניות`} (מתוך ${turns}) שבהן מסלול ה-GNSS שינה כיוון ב-${fmt(missDeg, 0)}°, אבל חיישן הסיבוב של הטלפון כמעט לא זז (ב-${acc.clk(missAt)}).`,
      benign: 'פתרון GNSS רועש במהירות נמוכה, או טלפון שמחובר לרכב שמסתובב לאט מאוד.',
      at: missAt,
    })
  else if (turns) acc.passed.push(`הג׳ירוסקופ אישר ${turns === 1 ? 'פנייה אחת' : `${turns} פניות`} של ה-GNSS`)
}
