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
}

// ---------- helpers ----------

const num = (s: string | undefined) => {
  if (s === undefined) return null
  const t = s.trim()
  if (t === '') return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

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
  const sys = hint ?? TALKER_SYS[talker]
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
  const d = Number(v.slice(0, degDigits))
  const m = Number(v.slice(degDigits))
  if (!Number.isFinite(d) || !Number.isFinite(m)) return null
  const deg = d + m / 60
  return hemi === 'S' || hemi === 'W' ? -deg : deg
}

/** hhmmss.ss → ms since midnight */
function nmeaTod(v: string) {
  if (v.length < 6) return null
  const h = Number(v.slice(0, 2)), mi = Number(v.slice(2, 4)), s = Number(v.slice(4))
  if (![h, mi, s].every(Number.isFinite)) return null
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

// Default column orders (GPSTest / GnssLogger v3) used when a file has no header for a record type.
const DEFAULT_HEADERS: Record<string, string[]> = {
  Fix: 'Provider,LatitudeDegrees,LongitudeDegrees,AltitudeMeters,SpeedMps,AccuracyMeters,BearingDegrees,UnixTimeMillis'.split(','),
  Status: 'UnixTimeMillis,SignalCount,SignalIndex,ConstellationType,Svid,CarrierFrequencyHz,Cn0DbHz,AzimuthDegrees,ElevationDegrees,UsedInFix,HasAlmanacData,HasEphemerisData,BasebandCn0DbHz'.split(','),
}

// ---------- parser ----------

export class LogParser {
  private headers: Record<string, Record<string, number>> = {}
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
  private nmeaFix: Partial<LogFix> & { quality?: number } = {}
  private rawEcef: { sig: Signal; t: number; sx: number; sy: number; sz: number }[] = []
  private readonly fileName: string

  constructor(fileName: string) {
    this.fileName = fileName
  }

  push(rawLine: string) {
    const line = rawLine.replace(/\r$/, '')
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
    const f = line.split(',')
    const cols = this.headers[type] ?? (DEFAULT_HEADERS[type] ? Object.fromEntries(DEFAULT_HEADERS[type].map((c, i) => [c, i + 1])) : null)
    if (!cols) return
    const get = (...names: string[]) => { for (const n of names) if (cols[n] !== undefined) return f[cols[n]]; return undefined }
    if (type === 'Fix') this.fix(get)
    else if (type === 'Status') this.statusRec(get)
    else if (type === 'Raw') this.rawRec(get)
  }

  private header(line: string) {
    const body = line.replace(/^#\s*/, '')
    const m = /Manufacturer:\s*([^,]+?)\s*,?\s*Model:\s*([^,]+?)(?:\s+GNSS Hardware|,|$)/.exec(body)
    if (m) this.device = `${m[1].trim()} ${m[2].trim()}`
    const parts = body.split(',').map((p) => p.trim())
    if (parts.length > 2 && /^[A-Za-z]+$/.test(parts[0])) {
      this.headers[parts[0]] = Object.fromEntries(parts.slice(1).map((c, i) => [c, i + 1]))
    }
  }

  private fix(get: (...n: string[]) => string | undefined) {
    const lat = num(get('LatitudeDegrees', 'Latitude'))
    const lon = num(get('LongitudeDegrees', 'Longitude'))
    const t = num(get('UnixTimeMillis', '(UTC)TimeInMs'))
    if (lat === null || lon === null || t === null) { this.bad++; return }
    const provider = (get('Provider') ?? '?').trim().toUpperCase()
    const alt = num(get('AltitudeMeters', 'Altitude'))
    this.fixes.push({ t, lat, lon, alt, acc: num(get('AccuracyMeters', 'Accuracy')), speed: num(get('SpeedMps', 'Speed')), heading: num(get('BearingDegrees')), provider })
    this.providers[provider] = (this.providers[provider] ?? 0) + 1
  }

  private statusRec(get: (...n: string[]) => string | undefined) {
    const t = num(get('UnixTimeMillis'))
    const svid = num(get('Svid'))
    if (t === null || svid === null) { this.bad++; return }
    const sys = ANDROID_SYS[num(get('ConstellationType')) ?? 0] ?? 'Unknown'
    const usedRaw = (get('UsedInFix') ?? '').trim().toLowerCase()
    const sig: Signal = {
      sys, svid,
      band: bandFromFreq(num(get('CarrierFrequencyHz')), sys),
      cn0: num(get('Cn0DbHz')) || null,
      az: num(get('AzimuthDegrees')),
      el: num(get('ElevationDegrees')),
      used: usedRaw === '' ? null : usedRaw === '1' || usedRaw === 'true',
    }
    let list = this.status.get(t)
    if (!list) { list = []; this.status.set(t, list) }
    list.push(sig)
  }

  private rawRec(get: (...n: string[]) => string | undefined) {
    const svid = num(get('Svid'))
    const timeNanos = num(get('TimeNanos'))
    if (svid === null || timeNanos === null) { this.bad++; return }
    let t = num(get('utcTimeMillis'))
    if (t === null) {
      // Older logs: derive UTC from the GNSS clock (GPS epoch 1980-01-06, minus leap seconds).
      const fullBias = num(get('FullBiasNanos'))
      if (fullBias === null) return
      const gpsMs = (timeNanos - fullBias) / 1e6 + 315964800000
      const leap = num(get('LeapSecond')) ?? (gpsMs < 1483228817000 ? 17 : 18) // leap second added 2017-01-01
      t = Math.round(gpsMs - leap * 1000)
    }
    const sys = ANDROID_SYS[num(get('ConstellationType')) ?? 0] ?? 'Unknown'
    const sig: Signal = { sys, svid, band: bandFromFreq(num(get('CarrierFrequencyHz')), sys), cn0: num(get('Cn0DbHz')), az: null, el: null, used: null }
    // Newer devices report the satellite's ECEF position; az/el is resolved in finish(),
    // once the receiver fixes (often logged after the Raw records) are known.
    const sx = num(get('SvPositionEcefXMeters')), sy = num(get('SvPositionEcefYMeters')), sz = num(get('SvPositionEcefZMeters'))
    if (sx !== null && sy !== null && sz !== null) this.rawEcef.push({ sig, t, sx, sy, sz })
    let ep = this.raw.get(timeNanos)
    if (!ep) { ep = { t, signals: [] }; this.raw.set(timeNanos, ep) }
    ep.signals.push(sig)
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
      r.sig.az = az
      r.sig.el = el
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
      if (type === 'RMC' && f[9] && f[9].length === 6) {
        const d = Number(f[9].slice(0, 2)), mo = Number(f[9].slice(2, 4)), y = 2000 + Number(f[9].slice(4))
        this.nmeaDate = Date.UTC(y, mo - 1, d)
      }
      const date = this.nmeaDate ?? (wrapperMs !== null ? Math.floor(wrapperMs / 86400000) * 86400000 : 0)
      const t = tod !== null ? date + tod : wrapperMs
      if (t !== null && t !== this.nmeaTime) this.flushNmea(t)
      if (type === 'GGA') {
        const lat = nmeaLatLon(f[2], f[3], 2), lon = nmeaLatLon(f[4], f[5], 3)
        const quality = num(f[6]) ?? 0
        if (lat !== null && lon !== null && quality > 0) Object.assign(this.nmeaFix, { lat, lon, alt: num(f[9]), quality })
      } else if (f[2] === 'A') {
        const lat = nmeaLatLon(f[3], f[4], 2), lon = nmeaLatLon(f[5], f[6], 3)
        const knots = num(f[7])
        if (lat !== null && lon !== null) {
          this.nmeaFix.lat ??= lat
          this.nmeaFix.lon ??= lon
        }
        this.nmeaFix.speed = knots !== null ? knots * 0.514444 : null
        this.nmeaFix.heading = num(f[8])
      }
      return
    }
    // Wrapped NMEA with no RMC/GGA: fall back to the Android timestamp to split epochs.
    if (wrapperMs !== null && !this.nmeaHasTimeSentences) {
      if (this.nmeaTime === null) this.nmeaTime = wrapperMs
      else if (Math.abs(wrapperMs - this.nmeaTime) > 500) this.flushNmea(wrapperMs)
    }

    if (type === 'GSV') {
      const fields = f.slice(4)
      const sigId = fields.length % 4 === 1 ? fields.pop()!.trim().toUpperCase() : null
      for (let i = 0; i + 3 < fields.length; i += 4) {
        const prn = num(fields[i])
        if (prn === null) continue
        const { sys, svid } = prnToSat(talker, prn)
        this.nmeaSignals.push({
          sys, svid,
          band: sigId ? NMEA_SIGNALS[sys]?.[sigId] ?? `sig ${sigId}` : null,
          el: num(fields[i + 1]),
          az: num(fields[i + 2]),
          cn0: num(fields[i + 3]),
          used: null,
        })
      }
    } else if (type === 'GSA') {
      this.nmeaSawGsa = true
      const hint = f.length >= 19 ? NMEA_SYSTEM_ID[f[18].trim()] : talker !== 'GN' ? TALKER_SYS[talker] : undefined
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
        const sigs = this.nmeaSignals.map((s) => ({ ...s, used: this.nmeaSawGsa ? this.nmeaUsed.has(`${s.sys}-${s.svid}`) : null }))
        this.nmeaEpochs.push({ t, signals: sigs })
      }
      const fx = this.nmeaFix
      if (fx.lat !== undefined && fx.lon !== undefined) {
        this.fixes.push({ t, lat: fx.lat, lon: fx.lon, alt: fx.alt ?? null, acc: null, speed: fx.speed ?? null, heading: fx.heading ?? null, provider: 'NMEA' })
        this.providers.NMEA = (this.providers.NMEA ?? 0) + 1
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
    }
  }
}

/** Streams a File line by line so large logs don't need one giant string. */
export async function parseLogFile(file: File, onProgress?: (fraction: number) => void): Promise<ParsedLog> {
  const parser = new LogParser(file.name)
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader()
  let carry = ''
  let read = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    read += value.length
    const chunk = carry + value
    const parts = chunk.split('\n')
    carry = parts.pop() ?? ''
    for (const p of parts) parser.push(p)
    onProgress?.(Math.min(1, read / Math.max(1, file.size)))
  }
  if (carry) parser.push(carry)
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
