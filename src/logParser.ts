// Parses GNSS log files recorded on Android by GPSTest or Google's GnssLogger
// (CSV records: Fix / Status / Raw / NMEA, with "# Type,col,col…" header lines),
// and plain NMEA 0183 logs from external receivers (u-blox etc.).
// Everything runs in the browser; the file never leaves the device.

export type Sys = 'GPS' | 'Galileo' | 'GLONASS' | 'BeiDou' | 'QZSS' | 'SBAS' | 'NavIC' | 'Unknown'
/** Fixed categorical order — colour slots follow this order, never the data. */
export const SYS_ORDER: Sys[] = ['GPS', 'Galileo', 'GLONASS', 'BeiDou', 'QZSS', 'SBAS', 'NavIC', 'Unknown']
export const SYS_PREFIX: Record<Sys, string> = { GPS: 'G', Galileo: 'E', GLONASS: 'R', BeiDou: 'C', QZSS: 'J', SBAS: 'S', NavIC: 'I', Unknown: '?' }

export type Signal = {
  sys: Sys
  svid: number
  band: string | null
  cn0: number | null
  az: number | null
  el: number | null
  used: boolean | null
  /** Automatic gain control level, dB (Android Raw records). Rises sharply under RF jamming. */
  agc?: number | null
  /** Baseband C/N0, dB-Hz (Android ≥ 11). Diverging from antenna C/N0 indicates in-band interference. */
  basebandCn0?: number | null
}
export type Epoch = { t: number; signals: Signal[] }
export type LogFix = {
  t: number
  lat: number
  lon: number
  alt: number | null
  acc: number | null
  speed: number | null
  heading: number | null
  provider: string
  /** NMEA GGA fix quality (0 none, 1 GPS, 2 DGPS, 4 RTK fixed, 5 RTK float, 6 dead reckoning). */
  quality?: number | null
  /** Satellites used in the solution (GGA field 7). */
  numSv?: number | null
  hdop?: number | null
}
export type SatSource = 'Status' | 'NMEA' | 'Raw'
export type ParsedLog = {
  fileName: string
  kind: 'android' | 'nmea'
  satSource: SatSource | null
  device: string | null
  epochs: Epoch[]
  fixes: LogFix[]
  providers: Record<string, number>
  lines: number
  badLines: number
  /** True when the file exceeded a safety cap and the rest was skipped. */
  truncated: boolean
}

// ---------- safety limits ----------
// A log file is untrusted input (it may be sent to the user by someone else). These caps keep a
// hostile or simply enormous file from exhausting memory or freezing the tab on a phone.
export const LIMITS = {
  fileBytes: 300 * 1024 * 1024,
  lineLength: 64 * 1024,
  signalsPerEpoch: 512,
  epochs: 200_000,
  fixes: 500_000,
  providers: 16,
  providerName: 16,
  deviceName: 100,
}

// ---------- helpers ----------

const num = (s: string | undefined) => {
  if (s === undefined) return null
  const t = s.trim()
  if (t === '' || t.length > 40) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** Own-property lookup: file-supplied keys like "__proto__" must never reach Object.prototype. */
const own = <T,>(obj: Record<string, T> | undefined, key: string | number): T | undefined =>
  obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined

const validTime = (t: number | null): t is number => t !== null && Number.isFinite(t) && Math.abs(t) < 8.64e15 && Number.isFinite(new Date(t).getTime())
const inRange = (v: number | null, lo: number, hi: number) => (v !== null && v >= lo && v <= hi ? v : null)
const validLat = (v: number | null) => inRange(v, -90, 90)
const validLon = (v: number | null) => inRange(v, -180, 180)
const validAcc = (v: number | null) => inRange(v, 0, 1e6)
const validAz = (v: number | null) => inRange(v, 0, 360)
const validEl = (v: number | null) => inRange(v, -90, 90)
const validCn0 = (v: number | null) => inRange(v, 0, 100)

const ANDROID_SYS: Record<number, Sys> = { 1: 'GPS', 2: 'SBAS', 3: 'GLONASS', 4: 'QZSS', 5: 'BeiDou', 6: 'Galileo', 7: 'NavIC' }

/** Signal band name from carrier frequency (Android Status/Raw records). */
export function bandFromFreq(hz: number | null, sys: Sys): string | null {
  if (!hz) return null
  const f = hz / 1e6
  const near = (c: number, tol = 1.5) => Math.abs(f - c) < tol
  if (sys === 'GLONASS') return f > 1590 ? 'G1' : f > 1230 ? 'G2' : 'G3'
  if (near(1575.42)) return sys === 'Galileo' ? 'E1' : sys === 'BeiDou' ? 'B1C' : 'L1'
  if (near(1176.45)) return sys === 'Galileo' ? 'E5a' : sys === 'BeiDou' ? 'B2a' : 'L5'
  if (near(1561.098)) return 'B1I'
  if (near(1207.14)) return sys === 'Galileo' ? 'E5b' : 'B2I'
  if (near(1227.6)) return 'L2'
  if (near(1268.52)) return 'B3I'
  if (near(1278.75)) return sys === 'QZSS' ? 'L6' : 'E6'
  return `${Math.round(f)} MHz`
}

// NMEA 4.11 signal IDs per constellation (hex digits allowed, e.g. u-blox "B").
const NMEA_SIGNALS: Partial<Record<Sys, Record<string, string>>> = {
  GPS: { '1': 'L1', '2': 'L1P', '3': 'L1M', '4': 'L2P', '5': 'L2C', '6': 'L2C', '7': 'L5', '8': 'L5' },
  GLONASS: { '1': 'G1', '2': 'G1P', '3': 'G2', '4': 'G2P' },
  Galileo: { '1': 'E5a', '2': 'E5b', '3': 'E5', '4': 'E6', '5': 'E6', '6': 'E1', '7': 'E1' },
  BeiDou: { '1': 'B1I', '2': 'B1Q', '3': 'B1C', '4': 'B1A', '5': 'B2a', '6': 'B2b', '7': 'B2', '8': 'B3I', '9': 'B3Q', 'A': 'B3A', 'B': 'B2I', 'C': 'B2Q' },
  QZSS: { '1': 'L1', '4': 'L1S', '5': 'L2C', '6': 'L2C', '7': 'L5', '8': 'L5' },
  NavIC: { '1': 'L5', '2': 'S' },
}

const TALKER_SYS: Record<string, Sys> = { GP: 'GPS', GL: 'GLONASS', GA: 'Galileo', GB: 'BeiDou', BD: 'BeiDou', GQ: 'QZSS', QZ: 'QZSS', GI: 'NavIC', IR: 'NavIC' }
const NMEA_SYSTEM_ID: Record<string, Sys> = { '1': 'GPS', '2': 'GLONASS', '3': 'Galileo', '4': 'BeiDou', '5': 'QZSS', '6': 'NavIC' }

/** Map an NMEA PRN (talker-specific numbering) to constellation + native svid. */
function prnToSat(talker: string, prn: number, hint?: Sys): { sys: Sys; svid: number } {
  const sys = hint ?? own(TALKER_SYS, talker)
  if (sys === 'GLONASS') return { sys, svid: prn > 64 && prn <= 96 ? prn - 64 : prn }
  if (sys === 'Galileo') return { sys, svid: prn > 300 ? prn - 300 : prn }
  if (sys === 'BeiDou') return { sys, svid: prn > 400 ? prn - 400 : prn > 200 ? prn - 200 : prn }
  if (sys === 'QZSS' || sys === 'NavIC') return { sys, svid: prn }
  // GP / GN: numbering ranges (NMEA 4.x)
  if (prn >= 1 && prn <= 32) return { sys: 'GPS', svid: prn }
  if (prn >= 33 && prn <= 64) return { sys: 'SBAS', svid: prn + 87 }
  if (prn >= 65 && prn <= 96) return { sys: 'GLONASS', svid: prn - 64 }
  if (prn >= 193 && prn <= 202) return { sys: 'QZSS', svid: prn }
  if (prn >= 201 && prn <= 263) return { sys: 'BeiDou', svid: prn - 200 }
  if (prn >= 301 && prn <= 336) return { sys: 'Galileo', svid: prn - 300 }
  return { sys: sys ?? 'Unknown', svid: prn }
}

function nmeaChecksumOk(s: string) {
  const star = s.lastIndexOf('*')
  if (s[0] !== '$' || star < 0) return false
  const given = s.slice(star + 1, star + 3)
  if (given.length < 2) return false
  let x = 0
  for (let i = 1; i < star; i++) x ^= s.charCodeAt(i)
  return x === parseInt(given, 16)
}

function nmeaLatLon(v: string, hemi: string, degDigits: number) {
  if (!v) return null
  if (v.length > 16 || !/^\d+(\.\d+)?$/.test(v)) return null
  const d = Number(v.slice(0, degDigits))
  const m = Number(v.slice(degDigits))
  if (!Number.isFinite(d) || !Number.isFinite(m) || m < 0 || m >= 60) return null
  const deg = d + m / 60
  return hemi === 'S' || hemi === 'W' ? -deg : deg
}

/** hhmmss.ss → ms since midnight */
function nmeaTod(v: string) {
  if (v.length < 6 || v.length > 12) return null
  const h = Number(v.slice(0, 2)), mi = Number(v.slice(2, 4)), s = Number(v.slice(4))
  if (![h, mi, s].every(Number.isFinite) || h > 23 || mi > 59 || s < 0 || s >= 61) return null
  return ((h * 60 + mi) * 60 + s) * 1000
}

const WGS84_A = 6378137
const WGS84_E2 = 6.69437999014e-3

/** Azimuth / elevation (degrees) of a satellite ECEF position seen from a receiver lat/lon/alt. */
function azEl(lat: number, lon: number, alt: number, sx: number, sy: number, sz: number) {
  const φ = (lat * Math.PI) / 180, λ = (lon * Math.PI) / 180
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(φ) ** 2)
  const rx = (N + alt) * Math.cos(φ) * Math.cos(λ)
  const ry = (N + alt) * Math.cos(φ) * Math.sin(λ)
  const rz = (N * (1 - WGS84_E2) + alt) * Math.sin(φ)
  const dx = sx - rx, dy = sy - ry, dz = sz - rz
  const e = -Math.sin(λ) * dx + Math.cos(λ) * dy
  const n = -Math.sin(φ) * Math.cos(λ) * dx - Math.sin(φ) * Math.sin(λ) * dy + Math.cos(φ) * dz
  const u = Math.cos(φ) * Math.cos(λ) * dx + Math.cos(φ) * Math.sin(λ) * dy + Math.sin(φ) * dz
  const el = (Math.atan2(u, Math.hypot(e, n)) * 180) / Math.PI
  const az = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360
  return { az, el }
}

type Columns = Map<string, number>
const columns = (names: string[]): Columns => new Map(names.map((c, i) => [c, i + 1]))

// Default column orders (GPSTest / GnssLogger v3) used when a file has no header for a record type.
const DEFAULT_HEADERS = new Map<string, Columns>([
  ['Fix', columns('Provider,LatitudeDegrees,LongitudeDegrees,AltitudeMeters,SpeedMps,AccuracyMeters,BearingDegrees,UnixTimeMillis'.split(','))],
  ['Status', columns('UnixTimeMillis,SignalCount,SignalIndex,ConstellationType,Svid,CarrierFrequencyHz,Cn0DbHz,AzimuthDegrees,ElevationDegrees,UsedInFix,HasAlmanacData,HasEphemerisData,BasebandCn0DbHz'.split(','))],
])

/**
 * "…Manufacturer: Google Model: Pixel 10 GNSS Hardware…" → "Google Pixel 10".
 * Plain indexOf parsing: the previous regex backtracked catastrophically on crafted lines.
 */
function parseDevice(body: string): string | null {
  if (body.length > 512) return null
  const i = body.indexOf('Manufacturer:')
  if (i < 0) return null
  const j = body.indexOf('Model:', i + 13)
  if (j < 0) return null
  const maker = body.slice(i + 13, j).trim().replace(/,$/, '').trim()
  let model = body.slice(j + 6).split(',')[0]
  const hw = model.indexOf(' GNSS Hardware')
  if (hw >= 0) model = model.slice(0, hw)
  const name = `${maker} ${model.trim()}`.trim()
  return name ? name.slice(0, LIMITS.deviceName) : null
}

// ---------- parser ----------

export class LogParser {
  private headers = new Map<string, Columns>()
  private truncated = false
  private kind: 'android' | 'nmea' | null = null
  private device: string | null = null
  private lines = 0
  private bad = 0
  private fixes: LogFix[] = []
  private providers: Record<string, number> = {}
  private status = new Map<number, Signal[]>()
  private raw = new Map<number, { t: number; signals: Signal[] }>()
  private nmeaEpochs: Epoch[] = []
  // NMEA epoch state
  private nmeaTime: number | null = null
  private nmeaDate: number | null = null // ms of UTC midnight from RMC
  private nmeaSignals: Signal[] = []
  private nmeaUsed = new Set<string>()
  private nmeaSawGsa = false
  private nmeaHasTimeSentences = false
  private nmeaFix: Partial<LogFix> = {}
  private rawEcef: { sig: Signal; t: number; sx: number; sy: number; sz: number }[] = []
  private readonly fileName: string

  constructor(fileName: string) {
    this.fileName = fileName
  }

  push(rawLine: string) {
    if (rawLine.length > LIMITS.lineLength) { this.lines++; this.bad++; return }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.trim()) return
    this.lines++
    if (line.startsWith('#')) return this.header(line)
    if (line.startsWith('$')) {
      this.kind ??= 'nmea'
      return this.nmea(line, null)
    }
    const comma = line.indexOf(',')
    if (comma < 0) { this.bad++; return }
    const type = line.slice(0, comma)
    this.kind ??= 'android'
    if (type === 'NMEA') {
      const last = line.lastIndexOf(',')
      return this.nmea(line.slice(comma + 1, last), num(line.slice(last + 1)))
    }
    const cols = this.headers.get(type) ?? DEFAULT_HEADERS.get(type)
    if (!cols || (type !== 'Fix' && type !== 'Status' && type !== 'Raw')) return
    const f = line.split(',')
    const get = (...names: string[]) => { for (const n of names) { const i = cols.get(n); if (i !== undefined) return f[i] } return undefined }
    if (type === 'Fix') this.fix(get)
    else if (type === 'Status') this.statusRec(get)
    else if (type === 'Raw') this.rawRec(get)
  }

  private header(line: string) {
    const body = line.slice(1).trimStart()
    if (this.device === null) this.device = parseDevice(body)
    const parts = body.split(',').map((p) => p.trim())
    if (parts.length > 2 && parts.length < 200 && /^[A-Za-z]{1,32}$/.test(parts[0])) this.headers.set(parts[0], columns(parts.slice(1)))
  }

  private addProvider(raw: string) {
    let p = raw.trim().toUpperCase().slice(0, LIMITS.providerName) || '?'
    if (!Object.hasOwn(this.providers, p) && Object.keys(this.providers).length >= LIMITS.providers) p = 'OTHER'
    this.providers[p] = (Object.hasOwn(this.providers, p) ? this.providers[p] : 0) + 1
    return p
  }

  private pushFix(fix: LogFix) {
    if (this.fixes.length >= LIMITS.fixes) { this.truncated = true; return }
    this.fixes.push(fix)
  }

  /** Signal list for an epoch key, or null when the epoch/signal caps are hit. */
  private epochList<K>(map: Map<K, Signal[]>, key: K): Signal[] | null {
    let list = map.get(key)
    if (!list) {
      if (map.size >= LIMITS.epochs) { this.truncated = true; return null }
      list = []
      map.set(key, list)
    }
    if (list.length >= LIMITS.signalsPerEpoch) { this.truncated = true; return null }
    return list
  }

  private fix(get: (...n: string[]) => string | undefined) {
    const lat = validLat(num(get('LatitudeDegrees', 'Latitude')))
    const lon = validLon(num(get('LongitudeDegrees', 'Longitude')))
    const t = num(get('UnixTimeMillis', '(UTC)TimeInMs'))
    if (lat === null || lon === null || !validTime(t)) { this.bad++; return }
    const provider = this.addProvider(get('Provider') ?? '?')
    const alt = inRange(num(get('AltitudeMeters', 'Altitude')), -1e5, 1e6)
    this.pushFix({ t, lat, lon, alt, acc: validAcc(num(get('AccuracyMeters', 'Accuracy'))), speed: inRange(num(get('SpeedMps', 'Speed')), 0, 1e4), heading: validAz(num(get('BearingDegrees'))), provider })
  }

  private statusRec(get: (...n: string[]) => string | undefined) {
    const t = num(get('UnixTimeMillis'))
    const svid = inRange(num(get('Svid')), 0, 1000)
    if (!validTime(t) || svid === null) { this.bad++; return }
    const sys = own(ANDROID_SYS, num(get('ConstellationType')) ?? 0) ?? 'Unknown'
    const usedRaw = (get('UsedInFix') ?? '').trim().toLowerCase()
    const sig: Signal = {
      sys, svid,
      band: bandFromFreq(num(get('CarrierFrequencyHz')), sys),
      cn0: validCn0(num(get('Cn0DbHz'))) || null,
      az: validAz(num(get('AzimuthDegrees'))),
      el: validEl(num(get('ElevationDegrees'))),
      used: usedRaw === '' ? null : usedRaw === '1' || usedRaw === 'true',
    }
    this.epochList(this.status, t)?.push(sig)
  }

  private rawRec(get: (...n: string[]) => string | undefined) {
    const svid = inRange(num(get('Svid')), 0, 1000)
    const timeNanos = num(get('TimeNanos'))
    if (svid === null || timeNanos === null) { this.bad++; return }
    let t = num(get('utcTimeMillis'))
    if (t === null) {
      // Older logs: derive UTC from the GNSS clock (GPS epoch 1980-01-06, minus leap seconds).
      const fullBias = num(get('FullBiasNanos'))
      if (fullBias === null) return
      const gpsMs = (timeNanos - fullBias) / 1e6 + 315964800000
      const leap = inRange(num(get('LeapSecond')), 0, 60) ?? (gpsMs < 1483228817000 ? 17 : 18) // leap second added 2017-01-01
      t = Math.round(gpsMs - leap * 1000)
    }
    if (!validTime(t)) { this.bad++; return }
    const sys = own(ANDROID_SYS, num(get('ConstellationType')) ?? 0) ?? 'Unknown'
    const sig: Signal = {
      sys, svid,
      band: bandFromFreq(num(get('CarrierFrequencyHz')), sys),
      cn0: validCn0(num(get('Cn0DbHz'))),
      az: null, el: null, used: null,
      agc: inRange(num(get('AgcDb')), -100, 100),
      basebandCn0: validCn0(num(get('BasebandCn0DbHz'))),
    }
    let ep = this.raw.get(timeNanos)
    if (!ep) {
      if (this.raw.size >= LIMITS.epochs) { this.truncated = true; return }
      ep = { t, signals: [] }
      this.raw.set(timeNanos, ep)
    }
    if (ep.signals.length >= LIMITS.signalsPerEpoch) { this.truncated = true; return }
    ep.signals.push(sig)
    // Newer devices report the satellite's ECEF position; az/el is resolved in finish(),
    // once the receiver fixes (often logged after the Raw records) are known.
    const sx = num(get('SvPositionEcefXMeters')), sy = num(get('SvPositionEcefYMeters')), sz = num(get('SvPositionEcefZMeters'))
    const ecefOk = (v: number | null): v is number => v !== null && Math.abs(v) < 1e9 // satellites sit within ~5e7 m
    if (ecefOk(sx) && ecefOk(sy) && ecefOk(sz)) this.rawEcef.push({ sig, t, sx, sy, sz })
  }

  private resolveRawAzEl(fixes: LogFix[]) {
    const good = fixes.filter((f) => f.provider !== 'NLP' && (f.acc === null || f.acc < 200))
    const ref = good.length ? good : fixes
    if (!ref.length) return
    for (const r of this.rawEcef) {
      // nearest fix in time (binary search on sorted fixes)
      let lo = 0, hi = ref.length - 1
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ref[mid].t < r.t) lo = mid + 1; else hi = mid }
      const c = lo > 0 && Math.abs(ref[lo - 1].t - r.t) < Math.abs(ref[lo].t - r.t) ? ref[lo - 1] : ref[lo]
      const { az, el } = azEl(c.lat, c.lon, c.alt ?? 0, r.sx, r.sy, r.sz)
      r.sig.az = Number.isFinite(az) ? az : null
      r.sig.el = Number.isFinite(el) ? el : null
    }
  }

  // --- NMEA ---
  private nmea(sentence: string, wrapperMs: number | null) {
    const s = sentence.trim()
    if (!nmeaChecksumOk(s)) { this.bad++; return }
    const body = s.slice(1, s.lastIndexOf('*'))
    const f = body.split(',')
    const id = f[0]
    if (id.length !== 5) { this.bad++; return }
    const talker = id.slice(0, 2)
    const type = id.slice(2)

    if (type === 'RMC' || type === 'GGA') {
      this.nmeaHasTimeSentences = true
      const tod = nmeaTod(f[1])
      if (type === 'RMC' && f[9] && /^\d{6}$/.test(f[9])) {
        const d = Number(f[9].slice(0, 2)), mo = Number(f[9].slice(2, 4)), y = 2000 + Number(f[9].slice(4))
        if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) this.nmeaDate = Date.UTC(y, mo - 1, d)
      }
      const wrapper = validTime(wrapperMs) ? wrapperMs : null
      const date = this.nmeaDate ?? (wrapper !== null ? Math.floor(wrapper / 86400000) * 86400000 : 0)
      const t = tod !== null ? date + tod : wrapper
      if (validTime(t) && t !== this.nmeaTime) this.flushNmea(t)
      if (type === 'GGA') {
        const lat = validLat(nmeaLatLon(f[2], f[3], 2)), lon = validLon(nmeaLatLon(f[4], f[5], 3))
        const quality = inRange(num(f[6]), 0, 9) ?? 0
        if (lat !== null && lon !== null && quality > 0) Object.assign(this.nmeaFix, { lat, lon, alt: inRange(num(f[9]), -1e5, 1e6), quality, numSv: inRange(num(f[7]), 0, 99), hdop: inRange(num(f[8]), 0, 99.9) })
      } else if (f[2] === 'A') {
        const lat = validLat(nmeaLatLon(f[3], f[4], 2)), lon = validLon(nmeaLatLon(f[5], f[6], 3))
        const knots = inRange(num(f[7]), 0, 2e4)
        if (lat !== null && lon !== null) {
          this.nmeaFix.lat ??= lat
          this.nmeaFix.lon ??= lon
        }
        this.nmeaFix.speed = knots !== null ? knots * 0.514444 : null
        this.nmeaFix.heading = validAz(num(f[8]))
      }
      return
    }
    // Wrapped NMEA with no RMC/GGA: fall back to the Android timestamp to split epochs.
    if (validTime(wrapperMs) && !this.nmeaHasTimeSentences) {
      if (this.nmeaTime === null) this.nmeaTime = wrapperMs
      else if (Math.abs(wrapperMs - this.nmeaTime) > 500) this.flushNmea(wrapperMs)
    }

    if (type === 'GSV') {
      const fields = f.slice(4)
      const rawSig = fields.length % 4 === 1 ? fields.pop()!.trim().toUpperCase() : null
      const sigId = rawSig && /^[0-9A-F]$/.test(rawSig) ? rawSig : null
      for (let i = 0; i + 3 < fields.length; i += 4) {
        const prn = inRange(num(fields[i]), 1, 1000)
        if (prn === null) continue
        if (this.nmeaSignals.length >= LIMITS.signalsPerEpoch) { this.truncated = true; break }
        const { sys, svid } = prnToSat(talker, prn)
        this.nmeaSignals.push({
          sys, svid,
          band: sigId ? own(NMEA_SIGNALS[sys], sigId) ?? `sig ${sigId}` : null,
          el: validEl(num(fields[i + 1])),
          az: validAz(num(fields[i + 2])),
          cn0: validCn0(num(fields[i + 3])),
          used: null,
        })
      }
    } else if (type === 'GSA') {
      this.nmeaSawGsa = true
      const hint = f.length >= 19 ? own(NMEA_SYSTEM_ID, f[18].trim()) : talker !== 'GN' ? own(TALKER_SYS, talker) : undefined
      for (let i = 3; i <= 14; i++) {
        const prn = num(f[i])
        if (prn === null) continue
        const { sys, svid } = prnToSat(talker, prn, hint)
        this.nmeaUsed.add(`${sys}-${svid}`)
      }
    }
  }

  private flushNmea(nextTime: number | null) {
    const t = this.nmeaTime
    if (t !== null) {
      if (this.nmeaSignals.length) {
        if (this.nmeaEpochs.length >= LIMITS.epochs) this.truncated = true
        else this.nmeaEpochs.push({ t, signals: this.nmeaSignals.map((s) => ({ ...s, used: this.nmeaSawGsa ? this.nmeaUsed.has(`${s.sys}-${s.svid}`) : null })) })
      }
      const fx = this.nmeaFix
      if (fx.lat !== undefined && fx.lon !== undefined) {
        this.pushFix({ t, lat: fx.lat, lon: fx.lon, alt: fx.alt ?? null, acc: null, speed: fx.speed ?? null, heading: fx.heading ?? null, provider: this.addProvider('NMEA'), quality: fx.quality ?? null, numSv: fx.numSv ?? null, hdop: fx.hdop ?? null })
      }
    }
    this.nmeaTime = nextTime
    this.nmeaSignals = []
    this.nmeaUsed = new Set()
    this.nmeaSawGsa = false
    this.nmeaFix = {}
  }

  finish(): ParsedLog {
    this.flushNmea(null)
    this.fixes.sort((a, b) => a.t - b.t)
    this.resolveRawAzEl(this.fixes)
    const fromMap = (m: Map<number, Signal[]>) => [...m.entries()].map(([t, signals]) => ({ t, signals }))
    const sources: [SatSource, Epoch[]][] = [
      ['Status', fromMap(this.status)],
      ['NMEA', this.nmeaEpochs],
      ['Raw', [...this.raw.values()]],
    ]
    const best = sources.find(([, e]) => e.length > 0)
    const epochs = (best?.[1] ?? []).sort((a, b) => a.t - b.t)
    const fixes = this.fixes.sort((a, b) => a.t - b.t)
    return {
      fileName: this.fileName,
      kind: this.kind ?? 'android',
      satSource: best?.[0] ?? null,
      device: this.device,
      epochs,
      fixes,
      providers: this.providers,
      lines: this.lines,
      badLines: this.bad,
      truncated: this.truncated,
    }
  }

  /** Counts a line that was dropped before parsing (e.g. over the length cap). */
  skipLine() {
    this.lines++
    this.bad++
  }
}

export class LogTooLargeError extends Error {}

/**
 * Streams a File line by line so large logs don't need one giant string.
 * Over-long lines are dropped without being buffered, and the UI gets a chance to repaint
 * regularly so even a huge file can't freeze the page.
 */
export async function parseLogFile(file: File, onProgress?: (fraction: number) => void): Promise<ParsedLog> {
  if (file.size > LIMITS.fileBytes) throw new LogTooLargeError(`הקובץ גדול מדי (${Math.round(file.size / 1048576)} MB). המגבלה היא ${LIMITS.fileBytes / 1048576} MB.`)
  const parser = new LogParser(file.name.slice(0, 200))
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader()
  let carry = ''
  let skipping = false // inside an over-long line: discard until the next newline
  let read = 0
  let lastYield = performance.now()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    read += value.length
    let chunk = value
    if (skipping) {
      const nl = chunk.indexOf('\n')
      if (nl < 0) continue
      chunk = chunk.slice(nl + 1)
      skipping = false
    }
    const parts = (carry + chunk).split('\n')
    carry = parts.pop() ?? ''
    for (const p of parts) parser.push(p)
    if (carry.length > LIMITS.lineLength) { parser.skipLine(); carry = ''; skipping = true }
    onProgress?.(Math.min(1, read / Math.max(1, file.size)))
    if (performance.now() - lastYield > 50) { await new Promise((r) => setTimeout(r, 0)); lastYield = performance.now() }
  }
  if (carry && !skipping) parser.push(carry)
  return parser.finish()
}

/** One entry per satellite (strongest signal wins) — for the sky plot. */
export function satellitesOf(signals: Signal[]) {
  const bySat = new Map<string, Signal>()
  for (const s of signals) {
    const k = `${s.sys}-${s.svid}`
    const prev = bySat.get(k)
    if (prev && (s.cn0 ?? -1) <= (prev.cn0 ?? -1)) {
      prev.az ??= s.az
      prev.el ??= s.el
      if (s.used) prev.used = true
      continue
    }
    const used = s.used || prev?.used ? true : s.used ?? prev?.used ?? null
    bySat.set(k, { ...s, az: s.az ?? prev?.az ?? null, el: s.el ?? prev?.el ?? null, used })
  }
  return [...bySat.values()]
}

export const satLabel = (s: { sys: Sys; svid: number }) => `${SYS_PREFIX[s.sys]}${String(s.svid).padStart(2, '0')}`
