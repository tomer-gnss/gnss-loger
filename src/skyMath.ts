// Small sky-geometry helpers shared by the integrity checks and the orbit module.
// Kept separate from orbits.ts so the SGP4 library is only downloaded when the user opts in.
import type { Sys } from './logParser'

/** True when the predicted id can be matched 1:1 with a receiver's PRN (GPS, BeiDou, QZSS, SBAS). */
export const prnComparable = (sys: Sys) => sys === 'GPS' || sys === 'BeiDou' || sys === 'QZSS' || sys === 'SBAS'

/** Great-circle angle between two sky directions, degrees. */
export function skyAngle(az1: number, el1: number, az2: number, el2: number) {
  const r = Math.PI / 180
  const c = Math.sin(el1 * r) * Math.sin(el2 * r) + Math.cos(el1 * r) * Math.cos(el2 * r) * Math.cos((az1 - az2) * r)
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI
}

export type PredictedSat = { sys: Sys; svid: number; name: string; az: number; el: number }
