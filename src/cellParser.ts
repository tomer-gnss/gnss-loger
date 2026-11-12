// Cellular signal logs recorded on Android by cell-logging apps, for plotting next to GNSS C/N0.
// A browser can't read the phone's cellular radio (no API on any platform), so the data comes
// from a file. Header-driven: the columns are found by name, so these all work:
//  - Tower Collector (open source, F-Droid): CSV export. measured_at is ISO UTC; one row per cell,
//    neighbouring cells are skipped.
//  - G-NetTrack (Lite/Pro): tab-separated text log with Timestamp / Level / Qual / SNR / CellID ...
//  - Any CSV/TSV with a time column and a signal column (rsrp / level / signal / dbm ...).
// Like GNSS logs, the file is untrusted input: size/line/row caps, range checks, no regex that
// can backtrack, and header lookup through a Map (no prototype pollution).

export type CellTech = '2G' | '3G' | '4G' | '5G'
export type CellSample = {
  t: number
  /** Main signal level, dBm: RSRP on 4G/5G, RSCP on 3G, RSSI/RxLev on 2G. */
  level: number
  rsrq: number | null
  sinr: number | null
  tech: CellTech | null
  cell: string | null
  arfcn: string | null
}
export type CellLog = {
  fileName: string
  format: 'Tower Collector' | 'G-NetTrack' | 'CSV'
  samples: CellSample[]
  /** True when timestamps had no time zone and were read as this device's local time. */
  localTime: boolean
  badLines: number
  truncated: boolean
}

export const CELL_LIMITS = { fileBytes: 100 * 1024 * 1024, lineLength: 16 * 1024, samples: 300_000, columns: 400, field: 200 }

export class CellLogError extends Error {}

// Column aliases, best first. Matching is on the lower-cased, trimmed header name.
const COLS = {
  time: ['measured_at', 'timestamp', 'time', 'datetime', 'date_time', 'time_utc', 'utc'],
  level: ['ss_rsrp', 'rsrp', 'level', 'rscp', 'signal', 'dbm', 'rxlev', 'rssi'],
  rsrq: ['ss_rsrq', 'rsrq', 'qual'],
  sinr: ['ss_sinr', 'rssnr', 'sinr', 'snr'],
  tech: ['net_type', 'networktech', 'network_type', 'networktype', 'tech', 'rat', 'type'],
  cell: ['cell_id', 'cellid', 'cid', 'ci', 'eci', 'nci', 'cgi'],
  arfcn: ['arfcn', 'earfcn', 'nrarfcn', 'uarfcn'],
  neighboring: ['neighboring', 'neighbouring', 'is_neighbor'],
} as const
type Col = keyof typeof COLS

/** Split one delimited line, honouring "quoted" fields ("" = literal quote). Linear time. */
export function splitDelimited(line: string, delim: string) {
  const out: string[] = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c
    } else if (c === '"') q = true
    else if (c === delim) { out.push(cur); cur = ''; if (out.length > CELL_LIMITS.columns) break } else cur += c
  }
  out.push(cur)
  return out.map((f) => f.trim())
}

const pickDelim = (line: string) => {
  if (line.includes('\t')) return '\t'
  let c = 0, s = 0
  for (const ch of line) { if (ch === ',') c++; else if (ch === ';') s++ }
  return s > c ? ';' : ','
}

// yyyy-mm-dd[T _]hh:mm:ss[.fff][Z|±hh:mm], also with . or / separators (G-NetTrack writes
// 2024.01.15_10.23.45). Fixed-width groups only: no backtracking.
const DATE_RE = /^(\d{4})[-./](\d{2})[-./](\d{2})[T _](\d{2})[:.](\d{2})[:.](\d{2})(?:[.,](\d{1,9}))?\s?(Z|[+-]\d{2}:?\d{2})?$/
const DMY_RE = /^(\d{2})[-./](\d{2})[-./](\d{4})[T _](\d{2})[:.](\d{2})[:.](\d{2})(?:[.,](\d{1,9}))?$/

/** Parse a timestamp → { ms, local } (local = no zone given, read as this device's time zone). */
export function parseCellTime(raw: string): { ms: number; local: boolean } | null {
  const s = raw.trim()
  if (!s || s.length > 40) return null
  if (/^\d{9,13}(\.\d+)?$/.test(s)) {
    const n = Number(s)
    const ms = n > 1e12 ? n : n * 1000 // epoch ms or epoch seconds
    return ms > 946684800000 && ms < 4102444800000 ? { ms, local: false } : null
  }
  let y: number, mo: number, d: number, h: number, mi: number, se: number, frac: string | undefined, zone: string | undefined
  const m = DATE_RE.exec(s)
  if (m) { [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number); frac = m[7]; zone = m[8] } else {
    const k = DMY_RE.exec(s)
    if (!k) return null
    ;[d, mo, y, h, mi, se] = k.slice(1, 7).map(Number); frac = k[7]
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60 || y < 2000 || y > 2100) return null
  const ms = frac ? Math.round(Number('0.' + frac) * 1000) : 0
  if (zone) {
    let off = 0
    if (zone !== 'Z') { const sign = zone[0] === '-' ? -1 : 1, z = zone.slice(1).replace(':', ''); off = sign * (Number(z.slice(0, 2)) * 60 + Number(z.slice(2, 4))) }
    return { ms: Date.UTC(y, mo - 1, d, h, mi, se, ms) - off * 60000, local: false }
  }
  return { ms: new Date(y, mo - 1, d, h, mi, se, ms).getTime(), local: true }
}

/** Network technology name (LTE, NR, HSPA+, 4G ...) → generation. */
export function techOf(raw: string): CellTech | null {
  const s = raw.trim().toUpperCase()
  if (!s) return null
  if (s === '5G' || s.startsWith('NR') || s.includes('5G')) return '5G'
  if (s === '4G' || s.startsWith('LTE') || s.includes('4G')) return '4G'
  if (s === '3G' || s.includes('UMTS') || s.includes('WCDMA') || s.includes('HSPA') || s.includes('HSDPA') || s.includes('HSUPA') || s.includes('TD-SCDMA') || s.includes('EVDO') || s.includes('EHRPD') || s.includes('3G')) return '3G'
  if (s === '2G' || s.includes('GSM') || s.includes('GPRS') || s.includes('EDGE') || s.includes('CDMA') || s.includes('1XRTT') || s.includes('2G')) return '2G'
  return null
}

const num = (raw: string | undefined, lo: number, hi: number) => {
  if (raw === undefined || raw === '' || raw.length > 20) return null
  const v = Number(raw.replace(',', '.'))
  return Number.isFinite(v) && v >= lo && v <= hi ? v : null // Android uses Integer.MAX_VALUE for "unavailable"
}
const text = (raw: string | undefined) => (raw ? raw.slice(0, CELL_LIMITS.field) : null)

export class CellParser {
  /** For each field, every matching column in alias order: a row uses the first valid one. */
  private idx: Map<Col, number[]> | null = null
  private delim = ','
  private format: CellLog['format'] = 'CSV'
  private samples: CellSample[] = []
  private local = false
  private bad = 0
  private truncated = false
  private fileName: string
  constructor(fileName: string) { this.fileName = fileName }

  /** Find the header: the first line that names both a time column and a signal column. */
  private header(line: string) {
    const delim = pickDelim(line)
    const names = splitDelimited(line, delim).map((h) => h.replace(/^\uFEFF/, '').toLowerCase())
    const pos = new Map<string, number>()
    names.forEach((n, i) => { if (!pos.has(n)) pos.set(n, i) })
    const idx = new Map<Col, number[]>()
    for (const col of Object.keys(COLS) as Col[]) {
      const found = COLS[col].map((a) => pos.get(a)).filter((i): i is number => i !== undefined)
      if (found.length) idx.set(col, found)
    }
    if (!idx.has('time') || !idx.has('level')) return false
    this.idx = idx; this.delim = delim
    this.format = pos.has('measured_at') && pos.has('short_cell_id') ? 'Tower Collector' : pos.has('networktech') ? 'G-NetTrack' : 'CSV'
    return true
  }

  push(rawLine: string) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) return
    if (line.length > CELL_LIMITS.lineLength) { this.bad++; return }
    if (!this.idx) { if (!this.header(line)) this.bad++; return }
    if (this.samples.length >= CELL_LIMITS.samples) { this.truncated = true; return }
    const f = splitDelimited(line, this.delim)
    const idx = this.idx
    /** First column of this field whose value passes `ok`. */
    const first = <T>(c: Col, ok: (raw: string) => T | null): T | null => {
      for (const i of idx.get(c) ?? []) { const v = f[i]; if (v !== undefined && v !== '') { const r = ok(v); if (r !== null) return r } }
      return null
    }
    if (first('neighboring', (v) => (v.toLowerCase() === 'true' ? true : null))) return // neighbour cell, not the one in use
    const time = first('time', parseCellTime)
    const level = first('level', (v) => num(v, -160, -20))
    if (!time || level === null) { this.bad++; return }
    if (time.local) this.local = true
    this.samples.push({
      t: time.ms, level,
      rsrq: first('rsrq', (v) => num(v, -45, 10)),
      sinr: first('sinr', (v) => num(v, -30, 60)),
      tech: first('tech', techOf),
      cell: first('cell', text),
      arfcn: first('arfcn', text),
    })
  }

  finish(): CellLog {
    if (!this.idx) throw new CellLogError('לא נמצאה שורת כותרת עם עמודת זמן ועמודת עוצמת אות (למשל measured_at + rsrp, או Timestamp + Level).')
    // Several rows can share a time (Tower Collector writes one row per cell): keep the strongest.
    const byT = new Map<number, CellSample>()
    for (const s of this.samples) { const p = byT.get(s.t); if (!p || s.level > p.level) byT.set(s.t, s) }
    const samples = [...byT.values()].sort((a, b) => a.t - b.t)
    if (!samples.length) throw new CellLogError('לא נמצאו בקובץ מדידות סלולר תקינות עם זמן ועוצמת אות.')
    return { fileName: this.fileName, format: this.format, samples, localTime: this.local, badLines: this.bad, truncated: this.truncated }
  }
}

export async function parseCellFile(file: File): Promise<CellLog> {
  if (file.size > CELL_LIMITS.fileBytes) throw new CellLogError(`הקובץ גדול מדי (${Math.round(file.size / 1048576)} MB). המגבלה היא ${CELL_LIMITS.fileBytes / 1048576} MB.`)
  const parser = new CellParser(file.name.slice(0, 200))
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader()
  let carry = '', skipping = false
  const feed = (line: string) => parser.push(line)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    let chunk = value
    if (skipping) { const nl = chunk.indexOf('\n'); if (nl < 0) continue; chunk = chunk.slice(nl + 1); skipping = false }
    const parts = (carry + chunk).split('\n')
    carry = parts.pop() ?? ''
    for (const p of parts) feed(p)
    if (carry.length > CELL_LIMITS.lineLength) { carry = ''; skipping = true }
  }
  if (carry && !skipping) feed(carry)
  return parser.finish()
}
