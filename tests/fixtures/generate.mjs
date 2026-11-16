// Builds the test logs that are derived from the real fixtures: spoofing / jamming / clock attacks,
// hostile inputs and cellular logs. Deterministic (seeded), output in tests/.generated/ (git-ignored):
//   samples/  copies of the real fixtures
//   attack/   generated logs
// Usage: node tests/fixtures/generate.mjs [--force]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = dirname(fileURLToPath(import.meta.url))
export const GEN = join(FIX, '..', '.generated')
const SAMPLES = join(GEN, 'samples'),
  ATTACK = join(GEN, 'attack')
const VERSION = '4' // bump when a generator changes, to rebuild cached output
const stamp = join(GEN, `.version-${VERSION}`)
if (existsSync(stamp) && !process.argv.includes('--force')) process.exit(0)

mkdirSync(SAMPLES, { recursive: true })
mkdirSync(ATTACK, { recursive: true })
mkdirSync(join(GEN, 'out'), { recursive: true })
for (const f of ['ublox.nmea', 'epoch10.txt', 'pr2016.txt', 'gpstest_synth.txt'])
  copyFileSync(join(FIX, f), join(SAMPLES, f))

// Seeded random numbers (Park–Miller): same files on every run and every machine.
let seed = 20261116
const rnd = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const out = (name, text) => writeFileSync(join(ATTACK, name), text)
const read = (name) => readFileSync(join(FIX, name), 'utf8').split('\n')
const cks = (body) => {
  let x = 0
  for (const c of body) x ^= c.charCodeAt(0)
  return x.toString(16).toUpperCase().padStart(2, '0')
}
const sentence = (fields) => {
  const body = fields.join(',')
  return `$${body}*${cks(body)}`
}

/** Rewrite the C/N0 field of every satellite in a GSV sentence. */
function rewriteGsv(line, fn) {
  if (!/^\$G.GSV/.test(line)) return line
  const f = line.slice(1, line.lastIndexOf('*')).split(',')
  const sig = f.length % 4 === 1 ? f.pop() : null
  for (let i = 4; i + 3 < f.length; i += 4) if (f[i + 3] !== '') f[i + 3] = fn(Number(f[i + 3]), f, i, sig)
  if (sig !== null) f.push(sig)
  return sentence(f)
}

// ---------- spoofing / jamming from the u-blox NMEA log ----------
const nmea = read('ublox.nmea')

// Every C/N0 set to 44–45: the signature of a single simulator transmitter.
out('spoof-uniform-cn0.nmea', nmea.map((l) => rewriteGsv(l, () => String(44 + Math.round(rnd())))).join('\n'))

// Teleport: latitude +0.05° (5.5 km) for 60 s in the middle of the log, then back.
{
  let i = 0
  out(
    'spoof-teleport.nmea',
    nmea
      .map((l) => {
        if (!/^\$GNGGA|^\$GNRMC/.test(l)) return l
        i++
        if (i < 1600 || i > 1720) return l
        const f = l.slice(1, l.lastIndexOf('*')).split(',')
        const li = l.startsWith('$GNGGA') ? 2 : 3
        f[li] = (Number(f[li]) + 5).toFixed(5).padStart(10, '0') // +5 minutes of latitude
        return sentence(f)
      })
      .join('\n'),
  )
}

// Frozen replay: position frozen for 300 epochs while RMC says 10 knots.
{
  let j = 0,
    lat = null,
    lon = null
  out(
    'spoof-frozen.nmea',
    nmea
      .map((l) => {
        if (!/^\$GNGGA|^\$GNRMC/.test(l)) return l
        j++
        if (j < 1000 || j > 1600) return l
        const f = l.slice(1, l.lastIndexOf('*')).split(',')
        const gga = l.startsWith('$GNGGA'),
          li = gga ? 2 : 3
        lat ??= f[li]
        lon ??= f[li + 2]
        f[li] = lat
        f[li + 2] = lon
        if (!gga) f[7] = '10.000'
        return sentence(f)
      })
      .join('\n'),
  )
}

// One transmitter: each satellite = its own fixed level + one shared, slowly wandering power.
{
  let common = 0
  const level = new Map()
  out(
    'spoof-common-cn0.nmea',
    nmea
      .map((l) => {
        if (/^\$GNRMC/.test(l)) {
          common = Math.max(-8, Math.min(8, common + (rnd() - 0.5) * 3))
        }
        return rewriteGsv(l, (_, f, i, sig) => {
          const key = f[0] + f[i] + (sig ?? '')
          if (!level.has(key)) level.set(key, 36 + rnd() * 10)
          return String(Math.round(level.get(key) + common))
        })
      })
      .join('\n'),
  )
}

// Jamming stripe: all satellites weaken together (up to 18 dB) for epochs 700–820.
{
  let epoch = -1
  out(
    'jam-stripe.nmea',
    nmea
      .map((l) => {
        if (/^\$GNRMC/.test(l)) epoch++
        if (epoch < 700 || epoch > 820) return l
        const depth = 18 * Math.sin(((epoch - 700) / 120) * Math.PI)
        return rewriteGsv(l, (v) => {
          const w = v - depth
          return w < 22 ? '' : String(Math.round(w))
        })
      })
      .join('\n'),
  )
}

// ---------- attacks on Android Raw logs ----------
const pixel = read('epoch10.txt')
const header = (lines, type) =>
  lines
    .find((l) => new RegExp(`^#\\s*${type},`).test(l))
    .replace(/^#\s*/, '')
    .split(',')
    .map((s) => s.trim())

// AGC +15 dB and C/N0 −12 dB in the last 5 epochs: RF jamming.
{
  const h = header(pixel, 'Raw')
  const iAgc = h.indexOf('AgcDb'),
    iCn0 = h.indexOf('Cn0DbHz'),
    iT = h.indexOf('utcTimeMillis')
  const times = [...new Set(pixel.filter((l) => l.startsWith('Raw,')).map((l) => l.split(',')[iT]))].sort()
  out(
    'jam-agc.txt',
    pixel
      .map((l) => {
        if (!l.startsWith('Raw,')) return l
        const f = l.split(',')
        if (f[iT] >= times[5]) {
          f[iAgc] = String(Number(f[iAgc]) + 15)
          f[iCn0] = String(Math.max(0, Number(f[iCn0]) - 12))
        }
        return f.join(',')
      })
      .join('\n'),
  )
}

// GNSS position 11 km away while the network (cell / Wi-Fi) position stays put.
{
  const iLat = header(pixel, 'Fix').indexOf('LatitudeDegrees')
  out(
    'spoof-net-mismatch.txt',
    pixel
      .map((l) => {
        if (!l.startsWith('Fix,GPS,')) return l
        const c = l.split(',')
        c[iLat] = (Number(c[iLat]) + 0.1).toFixed(10)
        return c.join(',')
      })
      .join('\n'),
  )
}

/** Edit Raw rows of a log; `fn(cells, index, epochRank)`. BigInt-exact for the 64-bit clock fields. */
function editRaw(lines, name, fn) {
  const h = header(lines, 'Raw'),
    ix = (n) => h.indexOf(n)
  const epochs = [
    ...new Set(lines.filter((l) => l.startsWith('Raw,')).map((l) => l.split(',')[ix('TimeNanos')].trim())),
  ]
  epochs.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const rank = new Map(epochs.map((tn, i) => [tn, i]))
  out(
    name,
    lines
      .map((l) => {
        if (!l.startsWith('Raw,')) return l
        const c = l.split(',')
        fn(c, ix, rank.get(c[ix('TimeNanos')].trim()))
        return c.join(',')
      })
      .join('\n'),
  )
}
// Clock pull: from epoch 5 the bias moves an extra 3 µs/s (the receiver's own drift says otherwise).
editRaw(pixel, 'clock-pull.txt', (c, ix, k) => {
  if (k >= 5) c[ix('FullBiasNanos')] = String(BigInt(c[ix('FullBiasNanos')]) + BigInt((k - 4) * 3000))
})
// Time shift: GNSS time slides 400 ms/epoch away from the phone's clock.
editRaw(pixel, 'time-shift.txt', (c, ix, k) => {
  if (k >= 5) c[ix('utcTimeMillis')] = String(Number(c[ix('utcTimeMillis')]) - (k - 4) * 400)
})
// Clock steps (2016 log, no drift field): every 30 epochs from 100 the clock rate jumps by 1 µs/s.
editRaw(read('pr2016.txt'), 'clock-steps.txt', (c, ix, k) => {
  if (k < 100) return
  let extra = 0n
  for (let j = 100; j <= k; j++) extra += BigInt(Math.floor((j - 100) / 30) * 1000 + 1000)
  c[ix('FullBiasNanos')] = String(BigInt(c[ix('FullBiasNanos')]) + extra)
})

// ---------- hostile inputs ----------
{
  const H =
    '# Status,UnixTimeMillis,SignalCount,SignalIndex,ConstellationType,Svid,CarrierFrequencyHz,Cn0DbHz,AzimuthDegrees,ElevationDegrees,UsedInFix\n# Fix,Provider,LatitudeDegrees,LongitudeDegrees,AltitudeMeters,SpeedMps,AccuracyMeters,BearingDegrees,UnixTimeMillis\n'
  // ReDoS bait on the device header (an old regex took minutes per line).
  out(
    'redos.txt',
    Array.from({ length: 50 }, () => '# Manufacturer:' + ' '.repeat(5000) + 'x').join('\n') +
      '\n' +
      H +
      'Fix,GPS,32.08,34.78,10,0,5,,1730730000000\n',
  )
  // Out-of-range coordinates / accuracy / time (once made Leaflet throw and blank the page).
  out(
    'coords.txt',
    H +
      [
        'Fix,GPS,1e300,1e305,0,0,5,,1730730000000',
        'Fix,GPS,-1e300,-1e305,0,0,1e308,,1730730001000',
        'Fix,GPS,95,200,0,0,-5,,1730730002000',
        'Fix,GPS,32.08,34.78,0,0,5,,9e99',
        'NMEA,$GPGGA,123000.00,001e307,N,03446.90800,E,1,08,0.9,41.2,M,17.5,M,,*00,1730730000000',
        'Fix,GPS,32.0853,34.7818,40,0,4,,1730730003000',
      ].join('\n') +
      '\n',
  )
  // Prototype-pollution keys everywhere.
  out(
    'proto.txt',
    '# __proto__,a,b,c\n# constructor,a,b\n# Fix,Provider,__proto__,LatitudeDegrees,LongitudeDegrees,UnixTimeMillis\n' +
      [
        'Fix,__proto__,x,32.08,34.78,1730730000000',
        'Fix,constructor,x,32.08,34.78,1730730001000',
        '__proto__,1,2,3',
        'constructor,1,2',
      ].join('\n') +
      '\n',
  )
  // One epoch with a million signals (once rendered 1M SVG nodes).
  out(
    'flood.txt',
    H +
      Array.from(
        { length: 1_000_000 },
        (_, i) => `Status,1730730000000,1,0,1,${(i % 32) + 1},1575420000,40,10,45,1`,
      ).join('\n') +
      '\n',
  )
  // 200k distinct providers.
  out(
    'providers.txt',
    H +
      Array.from({ length: 200_000 }, (_, i) => `Fix,P${i},32.08,34.78,0,0,5,,${1730730000000 + i * 1000}`).join('\n') +
      '\n',
  )
  // A single 3 MB line, then valid data.
  out('longline.txt', 'A'.repeat(3_000_000) + '\n' + H + 'Fix,GPS,32.08,34.78,10,0,5,,1730730000000\n')
}

// ---------- cellular logs, aligned with ublox.nmea (2020-02-07 from 02:14:17 UTC, ~1730 s) ----------
{
  const T0 = Date.UTC(2020, 1, 7, 2, 14, 17),
    N = 1730
  const TC =
    'mcc,mnc,lac,cell_id,short_cell_id,rnc,psc,asu,dbm,ta,lat,lon,accuracy,speed,bearing,altitude,measured_at,net_type,neighboring,discovered_at,device,rsrp,rsrq,rssi,rssnr,cqi,rscp,csi_rsrp,csi_rsrq,csi_sinr,ss_rsrp,ss_rsrq,ss_sinr,cdma_dbm,cdma_ecio,evdo_dbm,evdo_ecio,evdo_snr,ec_no,arfcn'
  const iso = (ms) => '"' + new Date(ms).toISOString() + '"'
  // Tower Collector export: serving cell + a stronger neighbour row that must be ignored.
  const towerCollector = (name, drop) => {
    const rows = [TC]
    for (let s = 0; s < N; s += 2) {
      const t = T0 + s * 1000,
        cell = s < 900 ? 27012345 : 27012399
      let rsrp = -95 + Math.round((rnd() - 0.5) * 4)
      if (drop && s >= drop[0] && s <= drop[1]) rsrp -= 20
      const sinr = 12 + Math.round((rnd() - 0.5) * 4)
      rows.push(
        [
          '310',
          '410',
          '12345',
          cell,
          cell % 65536,
          '',
          '',
          '40',
          rsrp,
          '3',
          '37.4263937',
          '-122.0936525',
          '4.0',
          '0',
          '0',
          '4',
          iso(t),
          'LTE',
          'false',
          iso(t),
          '"Pixel 4"',
          rsrp,
          '-10',
          '-65',
          sinr,
          '2147483647',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '1850',
        ].join(','),
      )
      rows.push(
        [
          '310',
          '410',
          '12345',
          '27019999',
          '1',
          '',
          '',
          '50',
          '-70',
          '',
          '37.4263937',
          '-122.0936525',
          '4.0',
          '0',
          '0',
          '4',
          iso(t),
          'LTE',
          'true',
          iso(t),
          '"Pixel 4"',
          '-70',
          '-8',
          '-50',
          '20',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '1850',
        ].join(','),
      )
    }
    out(name, rows.join('\r\n') + '\r\n')
  }
  towerCollector('tc-steady.csv', null)
  towerCollector('tc-tunnel.csv', [690, 830])
  // G-NetTrack text log: tab-separated, local time without a zone (Asia/Jerusalem = UTC+2 in February).
  const p = (n) => String(n).padStart(2, '0')
  const rows = [
    [
      'Timestamp',
      'Longitude',
      'Latitude',
      'Speed',
      'Operatorname',
      'Operator',
      'CGI',
      'Cellname',
      'Node',
      'CellID',
      'LAC',
      'NetworkTech',
      'NetworkMode',
      'Level',
      'Qual',
      'SNR',
      'CQI',
      'LTERSSI',
      'ARFCN',
    ].join('\t'),
  ]
  for (let s = 0; s < N; s++) {
    const d = new Date(T0 + s * 1000 + 2 * 3600000)
    const ts = `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}_${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}`
    const tech = s > 1200 && s < 1300 ? '3G' : s > 1500 ? '5G' : '4G'
    rows.push(
      [
        ts,
        '-122.0936',
        '37.4263',
        '30',
        'Carrier',
        '310410',
        '310410123456',
        '',
        '1234',
        '56',
        '12345',
        tech,
        tech === '3G' ? 'HSPA+' : tech === '5G' ? 'NR' : 'LTE',
        -98 + Math.round((rnd() - 0.5) * 6),
        '-11',
        '9',
        '10',
        '-67',
        '1850',
      ].join('\t'),
    )
  }
  out('gnt-steady.txt', rows.join('\n') + '\n')
  out(
    'cell-hostile.csv',
    [
      'garbage line before header',
      '__proto__,constructor,timestamp,rsrp,"weird ""quoted"" header",net_type',
      'x,y,2020-02-07T02:14:20Z,-95,a,LTE',
      'x,y,"2020-02-07T02:14:21Z,-95,a,LTE',
      'x,y,9999-99-99T99:99:99Z,-95,a,LTE',
      'x,y,2020-02-07T02:14:22Z,2147483647,a,LTE',
      'x,y,2020-02-07T02:14:23Z,NaN,a,LTE',
      'x,y,' + '1'.repeat(30) + ',-95,a,LTE',
      'x,y,2020-02-07T02:14:24Z,-95,' + 'A'.repeat(20000) + ',LTE',
      'x,y,2020-02-07T02:14:25Z' + ' '.repeat(5000) + 'Z,-95,a,LTE',
      'x,y,2020-02-07T02:14:26+02:00,-96,a,NR',
      'x,y,1581041667000,-97,a,GSM',
    ].join('\n'),
  )
}

writeFileSync(stamp, new Date().toISOString())
console.log(`test fixtures generated in ${GEN}`)
