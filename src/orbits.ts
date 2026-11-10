// Predicted GNSS satellite positions from public orbital elements (CelesTrak "gnss" group, SGP4).
//
// Privacy: one request downloads the orbits of *every* GNSS satellite worldwide; nothing about
// the user's position is sent. The look angles (azimuth/elevation) are computed on the phone.
// The data is cached on the device for 6 hours (CelesTrak asks clients not to re-download the
// same data more often than every couple of hours). Only after the user opts in.
//
// Accuracy: SGP4 elements for GNSS orbits are good to a few kilometres; from the ground that is
// far below 0.1° of sky angle, plenty for drawing where satellites are and for checking whether
// a receiver's reported sky is physically possible.

// satellite.js's main entry also re-exports a WebAssembly build that spawns Web Workers; that
// would bloat the bundle and is blocked by our CSP (no workers, no wasm). Import only the
// pure-JavaScript SGP4 and coordinate-transform modules directly (none reference wasm/workers).
import { json2satrec } from '../node_modules/satellite.js/dist/io.js'
import { gstime, propagate } from '../node_modules/satellite.js/dist/propagation.js'
import { degreesToRadians, ecfToLookAngles, eciToEcf } from '../node_modules/satellite.js/dist/transforms.js'
import type { SatRec } from '../node_modules/satellite.js/dist/propagation/SatRec.js'
import type { Sys } from './logParser'
import type { PredictedSat } from './skyMath'
export { prnComparable, skyAngle, type PredictedSat } from './skyMath'

export const ORBITS_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=gnss&FORMAT=json'
const CACHE_KEY = 'atlas.gnssOrbits'
const CACHE_MS = 6 * 3600 * 1000

export type OrbitSat = { sys: Sys; svid: number; name: string; satrec: SatRec }

/**
 * Constellation + identifier from the CelesTrak object name. PRN-based labels only where the
 * name carries the PRN (GPS, BeiDou, QZSS, SBAS); otherwise a catalogue-based label, never a guess.
 */
export function classify(name: string): { sys: Sys; svid: number; name: string; prnKnown: boolean } | null {
  let m: RegExpExecArray | null
  if ((m = /\/PRN (\d{3})\)/.exec(name)) && /GAGAN|EGNOS|SDCM|WAAS|MSAS|SOUTHPAN|BDSBAS|KASS|SBAS/.test(name)) return { sys: 'SBAS', svid: Number(m[1]), name: `S${m[1]}`, prnKnown: true }
  if ((m = /QZSS\/PRN (\d{3})/.exec(name))) return { sys: 'QZSS', svid: Number(m[1]), name: `J${Number(m[1]) - 192}`.replace(/^J(\d)$/, 'J0$1'), prnKnown: true }
  if (/^(GPS|NAVSTAR)\b/.test(name) && (m = /\(PRN (\d{1,2})\)/.exec(name))) return { sys: 'GPS', svid: Number(m[1]), name: `G${m[1].padStart(2, '0')}`, prnKnown: true }
  if (/^BEIDOU/.test(name) && (m = /\(C(\d{1,2})\)/.exec(name))) return { sys: 'BeiDou', svid: Number(m[1]), name: `C${m[1].padStart(2, '0')}`, prnKnown: true }
  if (/^COSMOS/.test(name) && (m = /\((\d{3})\)/.exec(name))) return { sys: 'GLONASS', svid: Number(m[1]), name: `R·${m[1]}`, prnKnown: false }
  if ((m = /^GSAT(\d{4})/.exec(name))) return { sys: 'Galileo', svid: Number(m[1]), name: `E·${m[1]}`, prnKnown: false }
  if ((m = /^(IRNSS-1[A-Z]|NVS-\d+)/.exec(name))) return { sys: 'NavIC', svid: 900 + name.length, name: `I·${m[1].replace(/^IRNSS-/, '')}`, prnKnown: false }
  return null
}

function build(data: unknown): OrbitSat[] {
  if (!Array.isArray(data) || data.length > 1000) throw new Error('נתוני מסלולים לא תקינים')
  const out: OrbitSat[] = []
  for (const o of data) {
    if (typeof o !== 'object' || o === null || typeof (o as { OBJECT_NAME?: unknown }).OBJECT_NAME !== 'string') continue
    const c = classify((o as { OBJECT_NAME: string }).OBJECT_NAME)
    if (!c) continue
    try {
      const satrec = json2satrec(o as Parameters<typeof json2satrec>[0])
      if (satrec.error === 0) out.push({ sys: c.sys, svid: c.svid, name: c.name, satrec })
    } catch { /* malformed element set: skip */ }
  }
  if (out.length < 20) throw new Error('נתוני מסלולים חסרים')
  return out
}

/** Orbits for all GNSS satellites, from the 6-hour device cache or a fresh download. */
export async function loadOrbits(): Promise<{ sats: OrbitSat[]; fetchedAt: number; fromCache: boolean }> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const { t, data } = JSON.parse(raw) as { t: number; data: unknown }
      if (Number.isFinite(t) && Date.now() - t < CACHE_MS) return { sats: build(data), fetchedAt: t, fromCache: true }
    }
  } catch { /* corrupt or blocked cache: refetch */ }
  const res = await fetch(ORBITS_URL, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  if (!res.ok) throw new Error(`הורדת המסלולים נכשלה (${res.status})`)
  const text = await res.text()
  if (text.length > 2_000_000) throw new Error('נתוני מסלולים גדולים מדי')
  const data = JSON.parse(text) as unknown
  const sats = build(data)
  const t = Date.now()
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t, data })) } catch { /* storage full/blocked */ }
  return { sats, fetchedAt: t, fromCache: false }
}

/** Azimuth/elevation (degrees) of every satellite as seen from lat/lon/alt at time t. */
export function lookAngles(sats: OrbitSat[], lat: number, lon: number, altM: number, t: number): PredictedSat[] {
  const date = new Date(t)
  const gmst = gstime(date)
  const observer = { latitude: degreesToRadians(lat), longitude: degreesToRadians(lon), height: altM / 1000 }
  const out: PredictedSat[] = []
  for (const s of sats) {
    const pv = propagate(s.satrec, date)
    const p = pv?.position
    if (!p || typeof p === 'boolean') continue
    const la = ecfToLookAngles(observer, eciToEcf(p, gmst))
    const az = ((la.azimuth * 180) / Math.PI + 360) % 360, el = (la.elevation * 180) / Math.PI
    if (Number.isFinite(az) && Number.isFinite(el)) out.push({ sys: s.sys, svid: s.svid, name: s.name, az, el })
  }
  return out
}

