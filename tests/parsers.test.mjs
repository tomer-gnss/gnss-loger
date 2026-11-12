// Unit tests for the parsers and the GNSS-vs-cellular comparison. Run with `npm test`.
// Node 24 runs the TypeScript sources directly (type stripping); these modules have no runtime
// imports, so no build step is needed. Every input here is synthetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LogParser, parseLogFile, LIMITS } from '../src/logParser.ts'
import { CellParser, parseCellFile, parseCellTime, techOf, splitDelimited } from '../src/cellParser.ts'
import { compareGnssCell } from '../src/cellCompare.ts'

const T0 = Date.UTC(2026, 0, 15, 10, 0, 0)
const cks = (b) => { let x = 0; for (const c of b) x ^= c.charCodeAt(0); return x.toString(16).toUpperCase().padStart(2, '0') }
const nmea = (body) => `$${body}*${cks(body)}`
const hhmmss = (ms) => { const d = new Date(ms); return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join('') + '.00' }

/** One NMEA second: RMC + GGA + one GPGSV with the given C/N0 values. */
function nmeaSecond(ms, cn0s) {
  const t = hhmmss(ms)
  const sats = cn0s.map((c, i) => `${String(i + 1).padStart(2, '0')},45,${(i * 40) % 360},${c}`).join(',')
  return [
    nmea(`GNRMC,${t},A,3205.11800,N,03446.90800,E,0.0,0.0,150126,,,A,V`),
    nmea(`GNGGA,${t},3205.11800,N,03446.90800,E,1,08,0.9,40.0,M,18.0,M,,`),
    nmea(`GPGSV,1,1,${String(cn0s.length).padStart(2, '0')},${sats}`),
  ]
}

// ---------- GNSS log parser ----------

test('NMEA: epochs, C/N0 and fixes', () => {
  const p = new LogParser('t.nmea')
  for (let s = 0; s < 5; s++) for (const l of nmeaSecond(T0 + s * 1000, [45, 40, 35, 30])) p.push(l)
  const log = p.finish()
  assert.equal(log.kind, 'nmea')
  assert.equal(log.epochs.length, 5)
  assert.equal(log.epochs[0].t, T0)
  assert.deepEqual(log.epochs[0].signals.map((s) => s.cn0), [45, 40, 35, 30])
  assert.ok(log.fixes.length >= 5)
  assert.ok(Math.abs(log.fixes[0].lat - 32.0853) < 1e-3)
})

test('NMEA: bad checksum and junk are counted, not parsed', () => {
  const p = new LogParser('t.nmea')
  const good = nmeaSecond(T0, [40])
  p.push(good[0].replace(/\*..$/, '*00'))
  p.push('$GPGSV,not,a,sentence')
  p.push('\u0000\u0001 binary junk')
  const log = p.finish()
  assert.equal(log.epochs.length, 0)
  assert.ok(log.badLines >= 2)
})

test('GnssLogger Status + Fix, header-driven', () => {
  const p = new LogParser('gnss_log.txt')
  p.push('# Fix,Provider,LatitudeDegrees,LongitudeDegrees,AltitudeMeters,SpeedMps,AccuracyMeters,BearingDegrees,UnixTimeMillis')
  p.push('# Status,UnixTimeMillis,SignalCount,SignalIndex,ConstellationType,Svid,CarrierFrequencyHz,Cn0DbHz,AzimuthDegrees,ElevationDegrees,UsedInFix,HasAlmanacData,HasEphemerisData,BasebandCn0DbHz')
  p.push(`Fix,GPS,32.0853,34.7818,40,0,4.5,,${T0}`)
  p.push(`Status,${T0},2,0,1,3,1575420000,44.5,32.0,52.0,1,1,1,40.1`)
  p.push(`Status,${T0},2,1,6,8,1575420000,41.2,82.0,34.0,0,1,1,38.0`)
  const log = p.finish()
  assert.equal(log.satSource, 'Status')
  assert.equal(log.epochs.length, 1)
  assert.equal(log.epochs[0].signals.length, 2)
  assert.equal(log.epochs[0].signals[0].sys, 'GPS')
  assert.equal(log.epochs[0].signals[1].sys, 'Galileo')
  assert.equal(log.fixes[0].acc, 4.5)
})

test('hostile GNSS input: prototype keys, out-of-range values, huge lines', async () => {
  const p = new LogParser('evil.txt')
  p.push('# __proto__,constructor,prototype,toString')
  p.push('__proto__,{"polluted":1},x,y')
  p.push('# Fix,Provider,LatitudeDegrees,LongitudeDegrees,AltitudeMeters,SpeedMps,AccuracyMeters,BearingDegrees,UnixTimeMillis')
  p.push(`Fix,GPS,999,34.78,40,0,4.5,,${T0}`) // impossible latitude
  p.push(`Fix,GPS,32.08,34.78,40,0,-3,,${T0}`) // negative accuracy
  p.finish()
  assert.equal(({}).polluted, undefined)
  // A line longer than the cap is skipped by the file reader, not parsed.
  const long = 'A'.repeat(LIMITS.lineLength + 10)
  const log = await parseLogFile(new File([long + '\n' + nmeaSecond(T0, [40]).join('\n')], 'x.nmea'))
  assert.equal(log.epochs.length, 1)
  assert.ok(log.badLines >= 1)
})

// ---------- cellular log parser ----------

const TC_HEADER = 'mcc,mnc,lac,cell_id,short_cell_id,rnc,psc,asu,dbm,ta,lat,lon,accuracy,speed,bearing,altitude,measured_at,net_type,neighboring,discovered_at,device,rsrp,rsrq,rssi,rssnr,cqi,rscp,csi_rsrp,csi_rsrq,csi_sinr,ss_rsrp,ss_rsrq,ss_sinr,cdma_dbm,cdma_ecio,evdo_dbm,evdo_ecio,evdo_snr,ec_no,arfcn'
const tcRow = (ms, rsrp, { neighbour = false, cell = '27012345', tech = 'LTE' } = {}) => {
  const iso = `"${new Date(ms).toISOString()}"`
  return ['425', '01', '1', cell, '1', '', '', '40', rsrp, '', '32.08', '34.78', '5', '0', '0', '40', iso, tech, String(neighbour), iso, '"Pixel"', rsrp, '-10', '-65', '12', '2147483647', '', '', '', '', '', '', '', '', '', '', '', '', '', '1850'].join(',')
}

test('time formats', () => {
  assert.equal(parseCellTime('2026-01-15T10:00:00.000Z').ms, T0)
  assert.equal(parseCellTime('2026-01-15T12:00:00+02:00').ms, T0)
  assert.equal(parseCellTime('"x"'), null)
  assert.equal(parseCellTime(String(T0)).ms, T0)
  assert.equal(parseCellTime(String(T0 / 1000)).ms, T0)
  assert.equal(parseCellTime('2026.01.15_12.00.00').local, true)
  for (const bad of ['', '9999-99-99T99:99:99Z', '2026-13-01T00:00:00Z', '1'.repeat(30), 'abc']) assert.equal(parseCellTime(bad), null, bad)
})

test('technology names', () => {
  assert.equal(techOf('LTE'), '4G'); assert.equal(techOf('NR'), '5G'); assert.equal(techOf('HSPA+'), '3G'); assert.equal(techOf('EDGE'), '2G'); assert.equal(techOf('?'), null)
})

test('quoted CSV fields', () => {
  assert.deepEqual(splitDelimited('a,"b,c","d ""e"""', ','), ['a', 'b,c', 'd "e"'])
})

test('Tower Collector: serving cell only, strongest per time, unavailable values dropped', () => {
  const p = new CellParser('tc.csv')
  p.push(TC_HEADER)
  p.push(tcRow(T0, -95))
  p.push(tcRow(T0, -70, { neighbour: true })) // neighbour: ignored
  p.push(tcRow(T0 + 1000, 2147483647)) // Android "unavailable": no level → bad row
  p.push(tcRow(T0 + 2000, -97, { tech: 'NR' }))
  const log = p.finish()
  assert.equal(log.format, 'Tower Collector')
  assert.equal(log.samples.length, 2)
  assert.equal(log.samples[0].level, -95)
  assert.equal(log.samples[0].tech, '4G')
  assert.equal(log.samples[1].tech, '5G')
  assert.equal(log.samples[0].cell, '27012345')
  assert.equal(log.localTime, false)
})

test('G-NetTrack: tab-separated, local time', () => {
  const p = new CellParser('g.txt')
  p.push(['Timestamp', 'Longitude', 'Latitude', 'CellID', 'NetworkTech', 'Level', 'Qual', 'SNR'].join('\t'))
  p.push(['2026.01.15_12.00.00', '34.78', '32.08', '56', '4G', '-98', '-11', '9'].join('\t'))
  const log = p.finish()
  assert.equal(log.format, 'G-NetTrack')
  assert.equal(log.localTime, true)
  assert.equal(log.samples[0].level, -98)
  assert.equal(log.samples[0].rsrq, -11)
  assert.equal(log.samples[0].sinr, 9)
})

test('hostile cellular input', async () => {
  const lines = [
    'junk before header',
    '__proto__,constructor,timestamp,rsrp,net_type',
    'x,y,2026-01-15T10:00:00Z,-95,LTE',
    'x,y,"2026-01-15T10:00:01Z,-95,LTE', // unbalanced quote
    'x,y,2026-01-15T10:00:02Z,NaN,LTE',
    'x,y,2026-01-15T10:00:03Z' + ' '.repeat(5000) + 'Z,-95,LTE',
    'x,y,2026-01-15T10:00:04Z,-95,' + 'A'.repeat(20000),
  ]
  const started = performance.now()
  const log = await parseCellFile(new File([lines.join('\n')], 'evil.csv'))
  assert.ok(performance.now() - started < 2000, 'no catastrophic backtracking')
  assert.equal(log.samples.length, 1)
  assert.equal(({}).polluted, undefined)
  await assert.rejects(parseCellFile(new File(['a,b\n1,2\n'], 'x.csv')), /לא נמצאה שורת כותרת/)
})

// ---------- GNSS vs cellular ----------

/** 20 min of GNSS epochs; between 600 and 720 s every signal is `depth` dB weaker. */
function gnssEpochs(depth) {
  const out = []
  for (let s = 0; s < 1200; s++) {
    const d = s >= 600 && s <= 720 ? depth : 0
    out.push({ t: T0 + s * 1000, signals: [45, 43, 41, 40, 35, 30].map((c, i) => ({ sys: 'GPS', svid: i + 1, band: 'L1', cn0: c - d + ((s * 7 + i * 3) % 3) - 1, az: 0, el: 45, used: null })) })
  }
  return out
}
const cells = (drop) => {
  const out = []
  for (let s = 0; s < 1200; s += 2) out.push({ t: T0 + s * 1000, level: -95 - (s >= 600 && s <= 720 ? drop : 0) + ((s * 5) % 3) - 1, rsrq: null, sinr: null, tech: '4G', cell: '1', arfcn: null })
  return out
}

test('compare: steady GNSS → no events', () => {
  assert.equal(compareGnssCell(gnssEpochs(0), cells(0)).events.length, 0)
})
test('compare: GNSS drop, cellular steady → gnss-only', () => {
  const r = compareGnssCell(gnssEpochs(15), cells(0))
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].kind, 'gnss-only')
  assert.ok(r.overlapS > 1100)
})
test('compare: both drop → both', () => {
  assert.equal(compareGnssCell(gnssEpochs(15), cells(20)).events[0].kind, 'both')
})
test('compare: no cellular data at that time → no-cell', () => {
  const c = cells(0).filter((x) => x.t < T0 + 500000 || x.t > T0 + 800000)
  assert.equal(compareGnssCell(gnssEpochs(15), c).events[0].kind, 'no-cell')
})
