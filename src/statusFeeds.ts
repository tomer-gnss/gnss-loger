// "GNSS status center": outside evidence that answers "is it an attack, the satellites, the sky,
// or me?". Three public sources, each downloaded whole (nothing about the user is sent), each
// analysed on the device, each only after the user opts in:
//  - Stanford GPS Lab RFI map (rfi.stanford.edu): per H3 cell (res 4, ~1,700 km²), how many
//    aircraft reported degraded GNSS that day, plus detected spoofing events. CC BY-NC 4.0,
//    attribution "Data from rfi.stanford.edu, Stanford GPS Laboratory". About 2–3 days behind.
//  - Galmon (galmon.eu): live health of every GPS / Galileo / BeiDou / GLONASS satellite and
//    signal, Galileo OSNMA status, and positions (used to tell which unhealthy ones are overhead).
//  - NOAA SWPC: geomagnetic / radiation / radio-blackout scales, Kp index and forecast, alerts.
// External data is untrusted input too: shapes are checked, sizes capped, numbers range-checked.

import { ecefLookAngles } from './orbits'
import type { Sys } from './logParser'

export const RFI_BASE = 'https://waas-nas.stanford.edu/data/'
export const NOAA_BASE = 'https://services.swpc.noaa.gov/products/'
export const GALMON_SVS = 'https://galmon.eu/svs.json'
export const STANFORD_ATTRIBUTION = 'Data from rfi.stanford.edu, Stanford GPS Laboratory (CC BY-NC 4.0)'

/** The h3-js functions we use (injected, so the analysis stays testable and h3 loads lazily). */
export type H3 = {
  latLngToCell: (lat: number, lng: number, res: number) => string
  cellToLatLng: (cell: string) => number[]
}
export type Pos = { lat: number; lon: number }

// ---------- small helpers ----------

const R_KM = 6371.0088
const rad = Math.PI / 180
export function distKm(a: Pos, b: Pos) {
  const dLat = (b.lat - a.lat) * rad,
    dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}
export function bearingDeg(a: Pos, b: Pos) {
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad)
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null
const H3_RE = /^8[0-9a-f]{14}$/
/** UTC date → "YYYY/MM/DD" (Stanford's folder layout). */
export const ymdPath = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '/')

async function getJson(url: string, maxChars: number): Promise<unknown> {
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status })
  const text = await res.text()
  if (text.length > maxChars) throw new Error('נתונים גדולים מדי')
  return JSON.parse(text) as unknown
}

// ---------- Stanford RFI: regional interference ----------

export type RfiCell = { h3: string; low: number; total: number }
export type Hotspot = Pos & { distKm: number; bearing: number; low: number; total: number; ratio: number }
export type SpoofEvent = Pos & {
  start: number
  end: number
  flights: number
  distKm: number
  bearing: number
  id: string
}
export type RfiLevel = 'strong' | 'some' | 'clear' | 'no-data'
export type RfiSummary = {
  /** Day the aircraft data is from (UTC, YYYY-MM-DD). */
  date: string
  here: { low: number; total: number } | null
  /** Cells whose centre is within RFI.nearKm, plus the user's own cell. */
  near: { low: number; total: number; cells: number }
  /** Everything within REGION_KM. */
  region: { low: number; total: number; cells: number }
  hotspots: Hotspot[]
  spoofing: SpoofEvent[]
  level: RfiLevel
}

export const RFI = {
  nearKm: 60, // "around you": cells whose centre is this close (plus your own cell)
  regionKm: 400, // what the radar shows
  minAircraft: 5, // a cell with fewer aircraft says little
  hotspotRatio: 0.1, // ≥10% of aircraft degraded = a hotspot
  strongRatio: 0.2, // near you: ≥20% degraded = active interference
  someRatio: 0.05,
  spoofKm: 600,
}

export function parseRfiCells(data: unknown): RfiCell[] {
  if (!isObj(data) || !Array.isArray(data.data)) throw new Error('נתוני Stanford לא תקינים')
  const out: RfiCell[] = []
  for (const c of data.data.slice(0, 200_000)) {
    if (!isObj(c) || typeof c.h3Index !== 'string' || !H3_RE.test(c.h3Index)) continue
    const low = num(c.lowQualityCount, 0, 1e6),
      total = num(c.totalAircraftCount, 0, 1e6)
    if (low === null || total === null || low > total) continue
    out.push({ h3: c.h3Index, low, total })
  }
  return out
}

export function parseSpoofEvents(data: unknown): Omit<SpoofEvent, 'distKm' | 'bearing'>[] {
  if (!isObj(data) || !Array.isArray(data.data)) return []
  const out: Omit<SpoofEvent, 'distKm' | 'bearing'>[] = []
  for (const e of data.data.slice(0, 10_000)) {
    if (!isObj(e)) continue
    const lat = num(e.latitude, -90, 90),
      lon = num(e.longitude, -180, 180)
    const start = typeof e.startTime === 'string' ? Date.parse(e.startTime) : NaN
    const end = typeof e.endTime === 'string' ? Date.parse(e.endTime) : NaN
    if (lat === null || lon === null || !Number.isFinite(start)) continue
    out.push({
      lat,
      lon,
      start,
      end: Number.isFinite(end) ? end : start,
      flights: num(e.numFltAffected, 0, 1e5) ?? 0,
      id: String(e.eventId ?? '').slice(0, 20),
    })
  }
  return out
}

export function summarizeRfi(
  cells: RfiCell[],
  events: Omit<SpoofEvent, 'distKm' | 'bearing'>[],
  pos: Pos,
  date: string,
  h3: H3,
): RfiSummary {
  const mine = h3.latLngToCell(pos.lat, pos.lon, 4)
  const near = { low: 0, total: 0, cells: 0 },
    region = { low: 0, total: 0, cells: 0 }
  let here: RfiSummary['here'] = null
  const hotspots: Hotspot[] = []
  for (const c of cells) {
    // Decode every cell centre (about 40k cells: a few tens of ms). "Near" is by real distance:
    // a res-4 cell spans ~40 km, so counting rings of cells would overstate how close "near" is.
    const [lat, lon] = h3.cellToLatLng(c.h3)
    const p = { lat, lon }
    const d = distKm(pos, p)
    if (c.h3 === mine) here = { low: c.low, total: c.total }
    if (c.h3 === mine || d <= RFI.nearKm) {
      near.low += c.low
      near.total += c.total
      near.cells++
    }
    if (d > RFI.regionKm) continue
    region.low += c.low
    region.total += c.total
    region.cells++
    const ratio = c.total ? c.low / c.total : 0
    if (c.total >= RFI.minAircraft && ratio >= RFI.hotspotRatio)
      hotspots.push({ ...p, distKm: d, bearing: bearingDeg(pos, p), low: c.low, total: c.total, ratio })
  }
  hotspots.sort((a, b) => b.ratio - a.ratio || a.distKm - b.distKm)
  const spoofing = events
    .map((e) => ({ ...e, distKm: distKm(pos, e), bearing: bearingDeg(pos, e) }))
    .filter((e) => e.distKm <= RFI.spoofKm)
    .sort((a, b) => b.start - a.start)
  const basis = near.total >= RFI.minAircraft ? near : region.total >= RFI.minAircraft ? region : null
  const ratio = basis ? basis.low / basis.total : 0
  const level: RfiLevel = !basis
    ? 'no-data'
    : ratio >= RFI.strongRatio
      ? 'strong'
      : ratio >= RFI.someRatio || hotspots.some((h) => h.distKm < 150)
        ? 'some'
        : 'clear'
  return { date, here, near, region, hotspots: hotspots.slice(0, 12), spoofing: spoofing.slice(0, 10), level }
}

const rfiCache = new Map<string, { cells: RfiCell[]; events: Omit<SpoofEvent, 'distKm' | 'bearing'>[] }>()

/** Stanford data for a UTC day, or (no day given) the newest available day (they lag 2–3 days). */
export async function loadRfi(
  day?: number,
): Promise<{ date: string; cells: RfiCell[]; events: Omit<SpoofEvent, 'distKm' | 'bearing'>[] }> {
  const candidates = day !== undefined ? [day] : Array.from({ length: 7 }, (_, i) => Date.now() - (i + 1) * 86400000)
  for (const t of candidates) {
    const path = ymdPath(t)
    const hit = rfiCache.get(path)
    if (hit) return { date: path.replace(/\//g, '-'), ...hit }
    try {
      const cells = parseRfiCells(await getJson(`${RFI_BASE}jamming/${path}/heatmap.json`, 40_000_000))
      // Spoofing events: that day and the two before it (small files; a missing day is fine).
      const events = (
        await Promise.all(
          [0, 1, 2].map((k) =>
            getJson(`${RFI_BASE}spoofing/${ymdPath(t - k * 86400000)}/events.json`, 5_000_000)
              .then(parseSpoofEvents)
              .catch(() => []),
          ),
        )
      ).flat()
      rfiCache.set(path, { cells, events })
      return { date: path.replace(/\//g, '-'), cells, events }
    } catch (e) {
      if ((e as { status?: number }).status === 404 && day === undefined) continue
      throw e
    }
  }
  throw new Error('אין נתוני Stanford לימים האחרונים')
}

// ---------- Galmon: satellite health ----------

export type SatHealth = {
  name: string
  sys: Sys
  svid: number
  signals: string[]
  osnma: boolean | null
  ephAgeMin: number | null
  ecef: [number, number, number] | null
}
export type HealthSummary = {
  fetchedAt: number
  bySys: { sys: Sys; total: number; unhealthy: SatHealth[] }[]
  /** Galileo satellites broadcasting OSNMA (authentication). */
  osnma: number
  galileo: number
}
const GSYS: Record<number, Sys> = { 0: 'GPS', 2: 'Galileo', 3: 'BeiDou', 6: 'GLONASS' }
const PREFIX: Record<string, string> = { GPS: 'G', Galileo: 'E', BeiDou: 'C', GLONASS: 'R' }

/** A signal is unhealthy when Galmon flags a health issue, or its health text says OUT / NOT OK. */
const signalUnhealthy = (health: unknown, issue: unknown) =>
  (typeof issue === 'number' && issue > 0) ||
  issue === true ||
  (typeof health === 'string' && /OUT|NOT ?OK|DUB|UNHEALTH/i.test(health))

export function summarizeHealth(data: unknown, fetchedAt: number): HealthSummary {
  if (!isObj(data)) throw new Error('נתוני Galmon לא תקינים')
  const sats = new Map<string, SatHealth & { bad: boolean }>()
  for (const [key, v] of Object.entries(data).slice(0, 5000)) {
    if (!isObj(v)) continue
    const sys = typeof v.gnssid === 'number' ? GSYS[v.gnssid] : undefined
    const svid = num(v.svid, 1, 99)
    if (!sys || svid === null) continue
    if (num(v['last-seen-s'], 0, 1e9) !== null && (v['last-seen-s'] as number) > 6 * 3600) continue // not seen for hours
    const name = `${PREFIX[sys]}${String(svid).padStart(2, '0')}`
    let s = sats.get(name)
    const [x, y, z] = [v.x, v.y, v.z].map((c) => num(c, -5e7, 5e7))
    if (!s) {
      s = {
        name,
        sys,
        svid,
        signals: [],
        osnma: sys === 'Galileo' ? false : null,
        ephAgeMin: num(v['eph-age-m'], -1e4, 1e5),
        ecef: x !== null && y !== null && z !== null ? [x, y, z] : null,
        bad: false,
      }
      sats.set(name, s)
    }
    if (v.osnma === true) s.osnma = true
    if (signalUnhealthy(v.health, v.healthissue)) {
      s.bad = true
      const sig = key.split('@')[1] ?? '?'
      if (!s.signals.includes(sig)) s.signals.push(sig)
    }
  }
  const all = [...sats.values()]
  const bySys = (['GPS', 'Galileo', 'BeiDou', 'GLONASS'] as Sys[])
    .map((sys) => {
      const list = all.filter((s) => s.sys === sys)
      return { sys, total: list.length, unhealthy: list.filter((s) => s.bad).map(({ bad: _bad, ...rest }) => rest) }
    })
    .filter((g) => g.total > 0)
  const galileo = all.filter((s) => s.sys === 'Galileo')
  return { fetchedAt, bySys, osnma: galileo.filter((s) => s.osnma).length, galileo: galileo.length }
}

/** Unhealthy satellites that are above the user's horizon right now. */
export function unhealthyOverhead(h: HealthSummary, pos: Pos & { alt?: number | null }) {
  return h.bySys
    .flatMap((g) => g.unhealthy)
    .filter((s) => s.ecef && ecefLookAngles(pos.lat, pos.lon, pos.alt ?? 0, s.ecef).el > 0)
}

export async function loadHealth(): Promise<HealthSummary> {
  return summarizeHealth(await getJson(GALMON_SVS, 5_000_000), Date.now())
}

// ---------- NOAA SWPC: space weather ----------

export type SpaceWeather = {
  g: number
  s: number
  r: number
  kp: number | null
  kpTime: number | null
  /** Highest predicted Kp in the next 72 h. */
  kpForecastMax: number | null
  /** Recent watches / warnings / alerts (last 3 days), first line of each. */
  notices: { t: number; text: string }[]
  level: 'quiet' | 'unsettled' | 'storm' | 'severe'
}

export function summarizeSpaceWeather(
  scales: unknown,
  kpObserved: unknown,
  kpForecast: unknown,
  alerts: unknown,
  now = Date.now(),
): SpaceWeather {
  const cur = isObj(scales) && isObj(scales['0']) ? scales['0'] : {}
  const scale = (k: string) => (isObj(cur[k]) ? (num(Number((cur[k] as Record<string, unknown>).Scale), 0, 5) ?? 0) : 0)
  const g = scale('G'),
    s = scale('S'),
    r = scale('R')
  let kp: number | null = null,
    kpTime: number | null = null
  if (Array.isArray(kpObserved)) {
    for (const row of kpObserved.slice(-200)) {
      if (!isObj(row)) continue
      const v = num(row.Kp ?? row.kp, 0, 9),
        t = typeof row.time_tag === 'string' ? Date.parse(row.time_tag + 'Z') : NaN
      if (v !== null && Number.isFinite(t) && (kpTime === null || t > kpTime)) {
        kp = v
        kpTime = t
      }
    }
  }
  let kpForecastMax: number | null = null
  if (Array.isArray(kpForecast)) {
    for (const row of kpForecast.slice(-200)) {
      if (!isObj(row) || row.observed !== 'predicted') continue
      const v = num(row.kp ?? row.Kp, 0, 9),
        t = typeof row.time_tag === 'string' ? Date.parse(row.time_tag + 'Z') : NaN
      if (v !== null && t > now && t < now + 72 * 3600000) kpForecastMax = Math.max(kpForecastMax ?? 0, v)
    }
  }
  const notices: SpaceWeather['notices'] = []
  if (Array.isArray(alerts)) {
    for (const a of alerts.slice(0, 200)) {
      if (!isObj(a) || typeof a.message !== 'string' || typeof a.issue_datetime !== 'string') continue
      const t = Date.parse(a.issue_datetime.replace(' ', 'T') + 'Z')
      if (!(now - t < 3 * 86400000)) continue
      const line = a.message.split(/\r?\n/).find((l) => /^(WATCH|WARNING|ALERT|EXTENDED WARNING|CANCEL)/.test(l.trim()))
      if (line) notices.push({ t, text: line.trim().slice(0, 160) })
    }
  }
  notices.sort((a, b) => b.t - a.t)
  const worst = Math.max(g, kp !== null ? Math.max(0, Math.floor(kp) - 4) : 0)
  // Mid-latitudes (Israel ~32°N): GNSS effects are minor below G3 and notable from G4.
  const level: SpaceWeather['level'] =
    worst >= 4 ? 'severe' : worst >= 2 ? 'storm' : (kp ?? 0) >= 4 || worst === 1 ? 'unsettled' : 'quiet'
  return { g, s, r, kp, kpTime, kpForecastMax, notices: notices.slice(0, 4), level }
}

export async function loadSpaceWeather(): Promise<SpaceWeather> {
  const [scales, kpObs, kpFc, alerts] = await Promise.all([
    getJson(NOAA_BASE + 'noaa-scales.json', 200_000),
    getJson(NOAA_BASE + 'noaa-planetary-k-index.json', 2_000_000),
    getJson(NOAA_BASE + 'noaa-planetary-k-index-forecast.json', 2_000_000),
    getJson(NOAA_BASE + 'alerts.json', 5_000_000).catch(() => []),
  ])
  return summarizeSpaceWeather(scales, kpObs, kpFc, alerts)
}

// ---------- the combined context (shown in the card, the integrity panel and the report) ----------

export type StatusContext = {
  pos: Pos
  rfi: RfiSummary | null
  health: HealthSummary | null
  overheadUnhealthy: string[]
  space: SpaceWeather | null
  /** Live tab ("now") or a log (its own date). */
  mode: 'live' | 'log'
}
