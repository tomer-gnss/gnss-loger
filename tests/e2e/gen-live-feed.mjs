// A genuine-looking NMEA stream for the real sky over Tel Aviv, starting a few seconds from now
// (1 epoch/s), computed from current public orbits (CelesTrak, network). Feeds the mocked
// external receiver in receiver.e2e.mjs. Output: tests/.generated/live-genuine.json
// Usage: node --import ./tests/resolve-ts.mjs tests/e2e/gen-live-feed.mjs [seconds]
import { writeFileSync } from 'node:fs'
import { json2satrec } from '../../node_modules/satellite.js/dist/io.js'
import { classify, lookAngles, ORBITS_URL } from '../../src/orbits.ts'
import { GEN } from './lib.mjs'

const seconds = Number(process.argv[2] ?? 70)
const res = await fetch(ORBITS_URL)
if (!res.ok) throw new Error(`CelesTrak ${res.status}`)
const sats = (await res.json())
  .map((o) => {
    const c = classify(o.OBJECT_NAME)
    return c ? { ...c, satrec: json2satrec(o) } : null
  })
  .filter(Boolean)

let seed = 7
const rnd = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const lat = 32.0853,
  lon = 34.7818,
  alt = 30
const cks = (b) => {
  let x = 0
  for (const c of b) x ^= c.charCodeAt(0)
  return x.toString(16).toUpperCase().padStart(2, '0')
}
const S = (body) => `$${body}*${cks(body)}`
const ll = (v, degW, pos, neg) => {
  const a = Math.abs(v),
    d = Math.floor(a),
    m = (a - d) * 60
  return [String(d).padStart(degW, '0') + m.toFixed(5).padStart(8, '0'), v >= 0 ? pos : neg]
}
const talker = { GPS: 'GP', Galileo: 'GA', GLONASS: 'GL', BeiDou: 'GB' }
const t0 = Math.ceil(Date.now() / 1000) * 1000 + 6000
const epochs = []
for (let k = 0; k < seconds; k++) {
  const t = t0 + k * 1000
  const iso = new Date(t).toISOString()
  const hms = iso.slice(11, 19).replace(/:/g, '') + '.00'
  const dmy = iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(2, 4)
  const [la, ns] = ll(lat + (rnd() - 0.5) * 2e-5, 2, 'N', 'S')
  const [lo, ew] = ll(lon + (rnd() - 0.5) * 2e-5, 3, 'E', 'W')
  const lines = [
    S(`GNRMC,${hms},A,${la},${ns},${lo},${ew},0.02,,${dmy},,,A`),
    S(`GNGGA,${hms},${la},${ns},${lo},${ew},1,12,0.8,${alt.toFixed(1)},M,17.5,M,,`),
  ]
  const vis = lookAngles(sats, lat, lon, alt, t).filter((p) => p.el >= 5 && talker[p.sys])
  for (const sys of Object.keys(talker)) {
    const list = vis.filter((p) => p.sys === sys)
    // GPS and BeiDou keep their real PRNs (these are what the sky check compares).
    const prn = (p) => (sys === 'GLONASS' ? 65 + (p.svid % 24) : sys === 'Galileo' ? (p.svid % 36) + 1 : p.svid)
    const used = list
      .filter((p) => p.el >= 10)
      .map(prn)
      .slice(0, 12)
    if (sys === 'GPS' || sys === 'BeiDou')
      lines.push(
        S(`GNGSA,A,3,${[...used, ...Array(12 - used.length).fill('')].join(',')},1.4,0.8,1.1,${sys === 'GPS' ? 1 : 4}`),
      )
    const groups = Math.ceil(list.length / 4)
    for (let g = 0; g < groups; g++) {
      const part = list
        .slice(g * 4, g * 4 + 4)
        .map(
          (p) =>
            `${String(prn(p)).padStart(2, '0')},${Math.round(p.el)},${String(Math.round(p.az)).padStart(3, '0')},${Math.round(30 + p.el / 6 + (rnd() - 0.5) * 4)}`,
        )
      lines.push(S(`${talker[sys]}GSV,${groups},${g + 1},${list.length},${part.join(',')}`))
    }
  }
  epochs.push({ t, lines })
}
writeFileSync(GEN + 'live-genuine.json', JSON.stringify(epochs))
console.log(`live feed: ${epochs.length} epochs from ${new Date(t0).toISOString()}`)
