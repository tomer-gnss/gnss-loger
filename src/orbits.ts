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
/** Backup when CelesTrak is unreachable: Galmon's live broadcast-ephemeris positions (ECEF). */
export const GALMON_URL = 'https://galmon.eu/svs.json'
const CACHE_KEY = 'atlas.gnssOrbits'
const CACHE_MS = 6 * 3600 * 1000

/** Either SGP4 elements (CelesTrak) or a position snapshot in metres, ECEF (Galmon). */
export type OrbitSat = { sys: Sys; svid: number; name: string; satrec?: SatRec; ecef?: [number, number, number] }
export type OrbitSource = 'CelesTrak' | 'Galmon'

/**
 * Constellation + identifier from the CelesTrak object name. PRN-based labels only where the
 * name carries the PRN (GPS, BeiDou, QZSS, SBAS); otherwise a catalogue-based label, never a guess.
 */
export function classify(name: string): { sys: Sys; svid: number; name: string; prnKnown: boolean } | null {
  let m: RegExpExecArray | null
  if ((m = /\/PRN (\d{3})\)/.exec(name)) && /GAGAN|EGNOS|SDCM|WAAS|MSAS|SOUTHPAN|BDSBAS|KASS|SBAS/.test(name))
    return { sys: 'SBAS', svid: Number(m[1]), name: `S${m[1]}`, prnKnown: true }
  if ((m = /QZSS\/PRN (\d{3})/.exec(name)))
    return {
      sys: 'QZSS',
      svid: Number(m[1]),
      name: `J${Number(m[1]) - 192}`.replace(/^J(\d)$/, 'J0$1'),
      prnKnown: true,
    }
  if (/^(GPS|NAVSTAR)\b/.test(name) && (m = /\(PRN (\d{1,2})\)/.exec(name)))
    return { sys: 'GPS', svid: Number(m[1]), name: `G${m[1].padStart(2, '0')}`, prnKnown: true }
  if (/^BEIDOU/.test(name) && (m = /\(C(\d{1,2})\)/.exec(name)))
    return { sys: 'BeiDou', svid: Number(m[1]), name: `C${m[1].padStart(2, '0')}`, prnKnown: true }
  if (/^COSMOS/.test(name) && (m = /\((\d{3})\)/.exec(name)))
    return { sys: 'GLONASS', svid: Number(m[1]), name: `R·${m[1]}`, prnKnown: false }
  if ((m = /^GSAT(\d{4})/.exec(name))) return { sys: 'Galileo', svid: Number(m[1]), name: `E·${m[1]}`, prnKnown: false }
  if ((m = /^(IRNSS-1[A-Z]|NVS-\d+)/.exec(name)))
    return { sys: 'NavIC', svid: 900 + name.length, name: `I·${m[1].replace(/^IRNSS-/, '')}`, prnKnown: false }
  return null
}

function build(data: unknown): OrbitSat[] {
  if (!Array.isArray(data) || data.length > 1000) throw new Error('נתוני מסלולים לא תקינים')
  const out: OrbitSat[] = []
  for (const o of data) {
    if (typeof o !== 'object' || o === null || typeof (o as { OBJECT_NAME?: unknown }).OBJECT_NAME !== 'string')
      continue
    const c = classify((o as { OBJECT_NAME: string }).OBJECT_NAME)
    if (!c) continue
    try {
      const satrec = json2satrec(o as Parameters<typeof json2satrec>[0])
      if (satrec.error === 0) out.push({ sys: c.sys, svid: c.svid, name: c.name, satrec })
    } catch {
      /* malformed element set: skip */
    }
  }
  if (out.length < 20) throw new Error('נתוני מסלולים חסרים')
  return out
}

export type Orbits = { sats: OrbitSat[]; fetchedAt: number; fromCache: boolean; source: OrbitSource }

/**
 * Orbits for all GNSS satellites: CelesTrak (6-hour device cache, then download). If CelesTrak
 * fails, Galmon's current positions instead. Those are a snapshot: reload them every few minutes.
 */
export async function loadOrbits(): Promise<Orbits> {
  try {
    return await loadCelestrak()
  } catch (celestrakError) {
    try {
      return await loadGalmonOrbits()
    } catch {
      throw celestrakError
    }
  }
}

const GALMON_SYS: Record<number, Sys> = { 0: 'GPS', 2: 'Galileo', 3: 'BeiDou', 6: 'GLONASS' }
const GALMON_PREFIX: Record<string, string> = { GPS: 'G', Galileo: 'E', BeiDou: 'C', GLONASS: 'R' }

/** Galmon svs.json → one position per satellite (it lists each signal; they share the position). */
export function parseGalmon(data: unknown): OrbitSat[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('נתוני Galmon לא תקינים')
  const bySat = new Map<string, OrbitSat>()
  for (const v of Object.values(data as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const o = v as { gnssid?: unknown; svid?: unknown; x?: unknown; y?: unknown; z?: unknown; 'last-seen-s'?: unknown }
    const sys = typeof o.gnssid === 'number' ? GALMON_SYS[o.gnssid] : undefined
    const svid = typeof o.svid === 'number' ? o.svid : NaN
    const [x, y, z] = [o.x, o.y, o.z].map((c) => (typeof c === 'number' ? c : NaN))
    const r = Math.hypot(x, y, z)
    // A GNSS orbit is 19,000–42,000 km from the Earth's centre; anything else is not a usable fix.
    if (!sys || !(svid > 0 && svid < 100) || !(r > 2e7 && r < 4.5e7)) continue
    if (typeof o['last-seen-s'] === 'number' && o['last-seen-s'] > 3600) continue // stale satellite
    const key = `${sys}${svid}`
    if (!bySat.has(key))
      bySat.set(key, { sys, svid, name: `${GALMON_PREFIX[sys]}${String(svid).padStart(2, '0')}`, ecef: [x, y, z] })
  }
  const out = [...bySat.values()]
  if (out.length < 20) throw new Error('נתוני Galmon חסרים')
  return out
}

export async function loadGalmonOrbits(): Promise<Orbits> {
  const res = await fetch(GALMON_URL, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  if (!res.ok) throw new Error(`Galmon (${res.status})`)
  const text = await res.text()
  if (text.length > 5_000_000) throw new Error('נתוני Galmon גדולים מדי')
  return { sats: parseGalmon(JSON.parse(text)), fetchedAt: Date.now(), fromCache: false, source: 'Galmon' }
}

async function loadCelestrak(): Promise<Orbits> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const { t, data } = JSON.parse(raw) as { t: number; data: unknown }
      if (Number.isFinite(t) && Date.now() - t < CACHE_MS)
        return { sats: build(data), fetchedAt: t, fromCache: true, source: 'CelesTrak' }
    }
  } catch {
    /* corrupt or blocked cache: refetch */
  }
  const res = await fetch(ORBITS_URL, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  if (!res.ok) throw new Error(`הורדת המסלולים נכשלה (${res.status})`)
  const text = await res.text()
  if (text.length > 2_000_000) throw new Error('נתוני מסלולים גדולים מדי')
  const data = JSON.parse(text) as unknown
  const sats = build(data)
  const t = Date.now()
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t, data }))
  } catch {
    /* storage full/blocked */
  }
  return { sats, fetchedAt: t, fromCache: false, source: 'CelesTrak' }
}

const WGS84_A = 6378137,
  WGS84_E2 = 6.69437999014e-3

/** Azimuth/elevation (degrees) of an ECEF point (metres) seen from geodetic lat/lon/alt. */
export function ecefLookAngles(lat: number, lon: number, altM: number, [x, y, z]: [number, number, number]) {
  const φ = (lat * Math.PI) / 180,
    λ = (lon * Math.PI) / 180
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(φ) ** 2)
  const ox = (N + altM) * Math.cos(φ) * Math.cos(λ)
  const oy = (N + altM) * Math.cos(φ) * Math.sin(λ)
  const oz = (N * (1 - WGS84_E2) + altM) * Math.sin(φ)
  const dx = x - ox,
    dy = y - oy,
    dz = z - oz
  // ECEF → local east / north / up
  const e = -Math.sin(λ) * dx + Math.cos(λ) * dy
  const n = -Math.sin(φ) * Math.cos(λ) * dx - Math.sin(φ) * Math.sin(λ) * dy + Math.cos(φ) * dz
  const u = Math.cos(φ) * Math.cos(λ) * dx + Math.cos(φ) * Math.sin(λ) * dy + Math.sin(φ) * dz
  const az = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360
  const el = (Math.atan2(u, Math.hypot(e, n)) * 180) / Math.PI
  return { az, el }
}

/** Azimuth/elevation (degrees) of every satellite as seen from lat/lon/alt at time t. */
export function lookAngles(sats: OrbitSat[], lat: number, lon: number, altM: number, t: number): PredictedSat[] {
  const date = new Date(t)
  const gmst = gstime(date)
  const observer = { latitude: degreesToRadians(lat), longitude: degreesToRadians(lon), height: altM / 1000 }
  const out: PredictedSat[] = []
  for (const s of sats) {
    if (s.ecef) {
      const { az, el } = ecefLookAngles(lat, lon, altM, s.ecef)
      if (Number.isFinite(az) && Number.isFinite(el)) out.push({ sys: s.sys, svid: s.svid, name: s.name, az, el })
      continue
    }
    if (!s.satrec) continue
    const pv = propagate(s.satrec, date)
    const p = pv?.position
    if (!p || typeof p === 'boolean') continue
    const la = ecfToLookAngles(observer, eciToEcf(p, gmst))
    const az = ((la.azimuth * 180) / Math.PI + 360) % 360,
      el = (la.elevation * 180) / Math.PI
    if (Number.isFinite(az) && Number.isFinite(el)) out.push({ sys: s.sys, svid: s.svid, name: s.name, az, el })
  }
  return out
}
