// Synthetic outside feeds for the GNSS status center, shaped exactly like the real files
// (Stanford RFI, Galmon svs.json, NOAA SWPC). Used by unit tests and by the browser suite, which
// serves them in place of the network. Scenario around Tel Aviv:
//  - interference: quiet over the user, a 40% hotspot ~100 km north, two spoofing events north;
//  - satellites: E09 out of service and overhead, E14 out but below the horizon, R22 unhealthy;
//  - space weather: quiet (Kp 2), G1 storm watch, forecast Kp 5.33 within 72 h.
import * as h3 from 'h3-js'

export const TLV = { lat: 32.0853, lon: 34.7818 }
export const NORTH_100 = { lat: 32.985, lon: 34.78 }

/** ECEF (m) of a point at azimuth / elevation / range (m) from an observer. */
export function ecefAt(lat, lon, az, el, range) {
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

const META = {
  license: 'CC BY-NC 4.0',
  license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
  attribution: 'Data from rfi.stanford.edu, Stanford GPS Laboratory',
}

/** Stanford daily jamming heatmap. */
export function rfiFile({ nearRatio = 0, hotRatio = 0.4, day = '2026-11-22' } = {}) {
  const ts = `${day}T12:00:00.000Z`
  const data = []
  for (const c of h3.gridDisk(h3.latLngToCell(TLV.lat, TLV.lon, 4), 1))
    data.push({
      h3Index: c,
      timestamp: ts,
      granularity: 'DAILY',
      lowQualityCount: Math.round(100 * nearRatio),
      totalAircraftCount: 100,
    })
  data.push({
    h3Index: h3.latLngToCell(NORTH_100.lat, NORTH_100.lon, 4),
    timestamp: ts,
    granularity: 'DAILY',
    lowQualityCount: Math.round(50 * hotRatio),
    totalAircraftCount: 50,
  })
  data.push({
    h3Index: h3.latLngToCell(51.5, -0.1, 4),
    timestamp: ts,
    granularity: 'DAILY',
    lowQualityCount: 40,
    totalAircraftCount: 50,
  })
  return { ...META, data }
}

/** Stanford spoofing events for a day. */
export function spoofFile(day = '2026-11-22') {
  return {
    ...META,
    data: [
      {
        eventId: '901',
        latitude: 33.3,
        longitude: 35.3,
        startTime: `${day}T10:00:00.000Z`,
        endTime: `${day}T10:20:00.000Z`,
        date: day,
        numFltAffected: 4,
      },
      {
        eventId: '902',
        latitude: 54.9,
        longitude: 22.6,
        startTime: `${day}T21:55:48.000Z`,
        endTime: `${day}T22:14:50.000Z`,
        date: day,
        numFltAffected: 9,
      },
    ],
  }
}

/** Galmon svs.json: 12 GPS + 12 Galileo across the sky over Tel Aviv, plus unhealthy ones. */
export function galmonFile() {
  const out = {}
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
    const [ex, ey, ez] = ecefAt(TLV.lat, TLV.lon, i * 30 + 15, 25 + (i % 3) * 15, 2.3e7)
    out[`E${String(i).padStart(2, '0')}@1`] = {
      gnssid: 2,
      svid: i,
      health: 'ok/ok/val/val',
      healthissue: 0,
      osnma: i % 2 === 0,
      x: ex,
      y: ey,
      z: ez,
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
  return out
}

/** NOAA SWPC products, by file name. Times relative to `now` so the forecast stays in range. */
export function noaaFiles(now = Date.now()) {
  const iso = (t) => new Date(t).toISOString().slice(0, 19)
  return {
    'noaa-scales.json': {
      0: {
        DateStamp: iso(now).slice(0, 10),
        G: { Scale: '0', Text: 'none' },
        S: { Scale: '0', Text: 'none' },
        R: { Scale: '0', Text: 'none' },
      },
    },
    'noaa-planetary-k-index.json': [
      { time_tag: iso(now - 6 * 3600e3), Kp: 2.33, a_running: 9, station_count: 8 },
      { time_tag: iso(now - 3 * 3600e3), Kp: 2, a_running: 7, station_count: 8 },
    ],
    'noaa-planetary-k-index-forecast.json': [
      { time_tag: iso(now - 3 * 3600e3), kp: 2, observed: 'observed', noaa_scale: null },
      { time_tag: iso(now + 30 * 3600e3), kp: 5.33, observed: 'predicted', noaa_scale: 'G1' },
    ],
    'alerts.json': [
      {
        product_id: 'A20F',
        issue_datetime: iso(now - 5 * 3600e3).replace('T', ' ') + '.000',
        message: 'Space Weather Message Code: WATA20\r\n\r\nWATCH: Geomagnetic Storm Category G1 Predicted\nmore',
      },
    ],
  }
}
