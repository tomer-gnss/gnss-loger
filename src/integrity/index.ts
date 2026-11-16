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
//
// Layout: core.ts (types, accumulator, scoring) and one file per family of checks. To add a
// check: write `checkX(data, acc)` in the right family, push findings / passed / unavailable
// into `acc`, call bumpT/bump for the timeline, then call it from analyzeLive and/or analyzeLog.

import { utcClock, localClock, newAcc, finalize, thin, type IntegrityReport, type IntegrityPoint } from './core'
import type { ClockSample, Epoch, LogFix } from '../logParser'
import type { MotionSecond } from '../motion'
import type { PredictFn } from './sky'
import {
  checkMotion,
  checkReportedVsDerivedSpeed,
  checkFrozen,
  checkAccuracyBehaviour,
  checkAltitude,
  checkTime,
  checkProviderMix,
} from './position'
import {
  checkCn0,
  checkAgc,
  checkSatellites,
  checkConstellations,
  checkNmeaQuality,
  checkBasebandDivergence,
} from './receiver'
import { checkGnssVsNetwork } from './network'
import { checkSkyConsistency, checkRxTimeOffset } from './sky'
import { checkCn0Correlation } from './correlation'
import { checkClock } from './clock'
import { checkSensors } from './sensors'

export {
  haversine,
  VERDICT_TEXT,
  type Finding,
  type IntegrityPoint,
  type IntegrityReport,
  type Severity,
  type Verdict,
} from './core'
export { pairGnssWithNetwork, type NetworkPair } from './network'
export { cn0CommonMode, type CorrWindow } from './correlation'
export type { PredictFn } from './sky'

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

/**
 * Log tab and external receiver: positions plus whatever receiver data is available.
 * opts.predictAt enables the sky-consistency check (orbits loaded); opts.rxTimeOffsetMs is the
 * live receiver-vs-phone clock offset; opts.localTime formats evidence in local time (live).
 */
export function analyzeLog(
  fixes: LogFix[],
  epochs: Epoch[],
  clockSamples: ClockSample[] = [],
  opts: { predictAt?: PredictFn; rxTimeOffsetMs?: number | null; localTime?: boolean } = {},
): IntegrityReport {
  // Prefer GNSS-provider fixes for motion checks so NLP jumps aren't blamed on the receiver.
  const gnss = fixes.filter((f) => f.provider === 'GPS' || f.provider === 'NMEA')
  const points = thin(gnss.length >= 10 ? gnss : fixes)
  const acc = newAcc(points, opts.localTime ? localClock : utcClock)
  checkSkyConsistency(epochs, fixes, opts.predictAt, acc)
  checkRxTimeOffset(opts.rxTimeOffsetMs, acc)
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
