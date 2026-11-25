// GNSS status center: parsing and analysis of the three outside feeds (synthetic data shaped like
// the real Stanford / Galmon / NOAA files), and the Galmon orbit backup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as h3 from 'h3-js'
import {
  parseRfiCells,
  parseSpoofEvents,
  summarizeRfi,
  summarizeHealth,
  unhealthyOverhead,
  summarizeSpaceWeather,
  distKm,
  bearingDeg,
} from '../../src/statusFeeds.ts'
import { ecefLookAngles, parseGalmon } from '../../src/orbits.ts'

const TLV = { lat: 32.0853, lon: 34.7818 }
const NORTH_100 = { lat: 32.985, lon: 34.78 } // ~100 km north

/** ECEF (m) of a point at azimuth/elevation/range (m) from an observer — inverse of ecefLookAngles. */
function ecefAt(lat, lon, az, el, range) {
  const A = 6378137,
    E2 = 6.69437999014e-3,
    φ = (lat * Math.PI) / 180,
    λ = (lon * Math.PI) / 180
  const N = A / Math.sqrt(1 - E2 * Math.sin(φ) ** 2)
  const o = [N * Math.cos(φ) * Math.cos(λ), N * Math.cos(φ) * Math.sin(λ), N * (1 - E2) * Math.sin(φ)]
  const a = (az * Math.PI) / 180,
    e = (el * Math.PI) / 180
  const [east, north, up] = [range * Math.cos(e) * Math.sin(a), range * Math.cos(e) * Math.cos(a), range * Math.sin(e)]
  return [
    o[0] - Math.sin(λ) * east - Math.sin(φ) * Math.cos(λ) * north + Math.cos(φ) * Math.cos(λ) * up,
    o[1] + Math.cos(λ) * east - Math.sin(φ) * Math.sin(λ) * north + Math.cos(φ) * Math.sin(λ) * up,
    o[2] + Math.cos(φ) * north + Math.sin(φ) * up,
  ]
}

// ---------- geometry ----------

test('distance and bearing', () => {
  assert.ok(Math.abs(distKm(TLV, NORTH_100) - 100) < 3)
  assert.ok(Math.abs(bearingDeg(TLV, NORTH_100)) < 1 || Math.abs(bearingDeg(TLV, NORTH_100) - 360) < 1)
})

test('ECEF look angles: round trip at several directions', () => {
  for (const [az, el] of [
    [0, 90],
    [45, 30],
    [200, 10],
    [310, 60],
  ]) {
    const r = ecefLookAngles(TLV.lat, TLV.lon, 0, ecefAt(TLV.lat, TLV.lon, az, el, 2.2e7))
    assert.ok(Math.abs(r.el - el) < 0.01, `el ${r.el} vs ${el}`)
    if (el < 89.9) assert.ok(Math.abs(((r.az - az + 540) % 360) - 180) < 0.01, `az ${r.az} vs ${az}`)
  }
})

// ---------- Stanford RFI ----------

/** Daily file like Stanford's: the user's area quiet, a hotspot ~100 km north. */
function rfiFile({ nearRatio = 0, hotRatio = 0.4 } = {}) {
  const data = []
  for (const c of h3.gridDisk(h3.latLngToCell(TLV.lat, TLV.lon, 4), 2))
    data.push({
      h3Index: c,
      timestamp: '2026-11-22T12:00:00.000Z',
      granularity: 'DAILY',
      lowQualityCount: Math.round(100 * nearRatio),
      totalAircraftCount: 100,
    })
  data.push({
    h3Index: h3.latLngToCell(NORTH_100.lat, NORTH_100.lon, 4),
    timestamp: '2026-11-22T12:00:00.000Z',
    granularity: 'DAILY',
    lowQualityCount: Math.round(50 * hotRatio),
    totalAircraftCount: 50,
  })
  data.push({
    h3Index: h3.latLngToCell(51.5, -0.1, 4),
    timestamp: '2026-11-22T12:00:00.000Z',
    granularity: 'DAILY',
    lowQualityCount: 40,
    totalAircraftCount: 50,
  }) // London: outside the region
  return { license: 'CC BY-NC 4.0', attribution: 'Data from rfi.stanford.edu, Stanford GPS Laboratory', data }
}

test('RFI: quiet here, hotspot to the north → "some", hotspot found by direction and distance', () => {
  const r = summarizeRfi(parseRfiCells(rfiFile()), [], TLV, '2026-11-22', h3)
  assert.equal(r.level, 'some')
  assert.equal(r.near.low, 0)
  assert.equal(r.hotspots.length, 1)
  assert.ok(Math.abs(r.hotspots[0].distKm - 100) < 25, String(r.hotspots[0].distKm))
  assert.ok(r.hotspots[0].bearing < 20 || r.hotspots[0].bearing > 340)
  assert.ok(Math.abs(r.hotspots[0].ratio - 0.4) < 0.01)
})

test('RFI: interference over the user → "strong"; none anywhere → "clear"; no aircraft → "no-data"', () => {
  assert.equal(summarizeRfi(parseRfiCells(rfiFile({ nearRatio: 0.3 })), [], TLV, 'd', h3).level, 'strong')
  assert.equal(summarizeRfi(parseRfiCells(rfiFile({ hotRatio: 0 })), [], TLV, 'd', h3).level, 'clear')
  assert.equal(summarizeRfi([], [], TLV, 'd', h3).level, 'no-data')
})

test('RFI: hostile file is filtered, not trusted', () => {
  const cells = parseRfiCells({
    data: [
      { h3Index: '__proto__', lowQualityCount: 1, totalAircraftCount: 2 },
      { h3Index: '84daaa1ffffffff', lowQualityCount: 5, totalAircraftCount: 2 }, // low > total
      { h3Index: '84daaa1ffffffff', lowQualityCount: -1, totalAircraftCount: 2 },
      { h3Index: '84daaa1ffffffff', lowQualityCount: 'x', totalAircraftCount: 2 },
      { h3Index: '84daaa1ffffffff', lowQualityCount: 1, totalAircraftCount: 2 },
    ],
  })
  assert.equal(cells.length, 1)
  assert.throws(() => parseRfiCells({ nope: true }))
  assert.equal({}.polluted, undefined)
})

test('spoofing events: parsed, distance-filtered, newest first', () => {
  const ev = parseSpoofEvents({
    data: [
      {
        eventId: '1',
        latitude: 33.0,
        longitude: 35.0,
        startTime: '2026-11-22T10:00:00Z',
        endTime: '2026-11-22T10:20:00Z',
        numFltAffected: 4,
      },
      {
        eventId: '2',
        latitude: 33.2,
        longitude: 35.2,
        startTime: '2026-11-22T12:00:00Z',
        endTime: '2026-11-22T12:05:00Z',
        numFltAffected: 2,
      },
      { eventId: '3', latitude: 54.9, longitude: 22.6, startTime: '2026-11-22T21:55:48Z', numFltAffected: 9 }, // Baltic: far
      { eventId: '4', latitude: 999, longitude: 35, startTime: '2026-11-22T12:00:00Z' }, // invalid
    ],
  })
  assert.equal(ev.length, 3)
  const r = summarizeRfi([], ev, TLV, 'd', h3)
  assert.deepEqual(
    r.spoofing.map((e) => e.id),
    ['2', '1'],
  )
})

// ---------- Galmon ----------

function galmonFile() {
  const out = {}
  // 12 GPS + 12 Galileo around the sky over Tel Aviv; E09 out of service overhead, E14 below the horizon.
  for (let i = 1; i <= 12; i++) {
    const [x, y, z] = ecefAt(TLV.lat, TLV.lon, i * 30, 20 + (i % 4) * 15, 2.2e7)
    out[`G${String(i).padStart(2, '0')}@0`] = {
      gnssid: 0,
      svid: i,
      health: 'OK',
      healthissue: 0,
      x,
      y,
      z,
      'last-seen-s': 10,
      'eph-age-m': 20,
    }
    out[`E${String(i).padStart(2, '0')}@1`] = {
      gnssid: 2,
      svid: i,
      health: 'ok/ok/val/val',
      healthissue: 0,
      osnma: i % 2 === 0,
      x,
      y,
      z,
      'last-seen-s': 10,
    }
  }
  const [x9, y9, z9] = ecefAt(TLV.lat, TLV.lon, 100, 50, 2.3e7)
  out['E09@1'] = {
    gnssid: 2,
    svid: 9,
    health: 'OUT/OUT/val/val',
    healthissue: 2,
    x: x9,
    y: y9,
    z: z9,
    'last-seen-s': 10,
  }
  const [x14, y14, z14] = ecefAt(TLV.lat, TLV.lon, 100, -40, 2.3e7)
  out['E14@1'] = {
    gnssid: 2,
    svid: 14,
    health: 'OUT/OUT/val/val',
    healthissue: 2,
    x: x14,
    y: y14,
    z: z14,
    'last-seen-s': 10,
  }
  out['R22@0'] = { gnssid: 6, svid: 22, health: 'NOT OK: 2', healthissue: 2, 'last-seen-s': 10 }
  out['C99@0'] = { gnssid: 3, svid: 999, health: 'OK' } // invalid svid: ignored
  out.__proto__x = { gnssid: 0, svid: 5 }
  return out
}

test('Galmon health: unhealthy per system, which are overhead, OSNMA count', () => {
  const h = summarizeHealth(galmonFile(), 0)
  const bad = Object.fromEntries(h.bySys.map((g) => [g.sys, g.unhealthy.map((s) => s.name)]))
  assert.deepEqual(bad.GPS, [])
  assert.deepEqual(bad.Galileo.sort(), ['E09', 'E14'])
  assert.deepEqual(bad.GLONASS, ['R22'])
  assert.deepEqual(
    unhealthyOverhead(h, TLV).map((s) => s.name),
    ['E09'],
  ) // E14 is below the horizon, R22 has no position
  assert.equal(h.osnma, 6)
})

test('Galmon orbit backup: one position per satellite, sky angles right', () => {
  const sats = parseGalmon(galmonFile())
  assert.ok(sats.length >= 24)
  const g3 = sats.find((s) => s.name === 'G03')
  const la = ecefLookAngles(TLV.lat, TLV.lon, 0, g3.ecef)
  assert.ok(Math.abs(la.az - 90) < 0.1 && Math.abs(la.el - 65) < 0.1, JSON.stringify(la))
  assert.throws(() => parseGalmon({ a: 1 }), /חסרים/)
})

// ---------- NOAA ----------

test('space weather: quiet, storm, forecast and notices', () => {
  const now = Date.parse('2026-11-25T14:00:00Z')
  const scales = (g) => ({ 0: { G: { Scale: String(g) }, S: { Scale: '0' }, R: { Scale: '0' } } })
  const kpObs = [
    { time_tag: '2026-11-25T06:00:00', Kp: 2.33 },
    { time_tag: '2026-11-25T09:00:00', Kp: 2 },
  ]
  const kpFc = [
    { time_tag: '2026-11-26T21:00:00', kp: 5.33, observed: 'predicted' },
    { time_tag: '2026-12-10T00:00:00', kp: 8, observed: 'predicted' },
  ]
  const alerts = [
    {
      issue_datetime: '2026-11-25 08:33:12.430',
      message:
        'Space Weather Message Code: WATA20\r\nIssue Time: x\r\n\r\nWATCH: Geomagnetic Storm Category G1 Predicted\nmore',
    },
  ]
  const quiet = summarizeSpaceWeather(scales(0), kpObs, kpFc, alerts, now)
  assert.equal(quiet.level, 'quiet')
  assert.equal(quiet.kp, 2)
  assert.equal(quiet.kpForecastMax, 5.33) // the 10-Dec value is outside 72 h
  assert.equal(quiet.notices[0].text, 'WATCH: Geomagnetic Storm Category G1 Predicted')
  assert.equal(summarizeSpaceWeather(scales(2), kpObs, [], [], now).level, 'storm')
  assert.equal(summarizeSpaceWeather(scales(4), kpObs, [], [], now).level, 'severe')
  assert.equal(summarizeSpaceWeather(null, 'x', 7, {}, now).level, 'quiet') // garbage → safe defaults
})
