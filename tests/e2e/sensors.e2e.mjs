// Motion-sensor cross-check in the live tab: emulated GNSS (CDP) + synthetic DeviceMotionEvents.
// A genuine drive must stay clean; GNSS "driving" while the phone lies still, and GNSS turns the
// gyroscope never felt, must be flagged.
// Usage: node tests/e2e/sensors.e2e.mjs <BASE>
import { chromium } from 'playwright-core'

const BASE = process.argv[2] ?? 'https://localhost:4180/'
const results = []
const ok = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const b = await chromium.launch({ channel: 'chrome', headless: true })

async function scenario({ seconds, gnss, motion }) {
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    locale: 'he-IL',
    permissions: ['geolocation', 'accelerometer', 'gyroscope'],
    geolocation: { latitude: 32.0853, longitude: 34.7818, accuracy: 5 },
  })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('atlas.welcomeSeen', '1')
    } catch {
      /* blocked */
    }
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (/Refused|Trusted/i.test(m.text())) errors.push(m.text())
  })
  const cdp = await ctx.newCDPSession(page)
  await page.goto(BASE)
  // Sensor generator in the page: gravity on z, seeded gaussian noise (window.__std), yaw rate (window.__yaw, deg/s).
  await page.evaluate(() => {
    window.__std = 0.02
    window.__yaw = 0
    let seed = 11
    const rnd = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd())
    setInterval(() => {
      const n = () => gauss() * window.__std
      window.dispatchEvent(
        new DeviceMotionEvent('devicemotion', {
          acceleration: { x: n(), y: n(), z: n() },
          accelerationIncludingGravity: { x: n(), y: n(), z: 9.81 + n() },
          rotationRate: { alpha: window.__yaw, beta: 0, gamma: 0 },
          interval: 20,
        }),
      )
    }, 20)
  })
  await page.getByRole('button', { name: 'הפעל מעקב' }).click()
  await page.getByRole('button', { name: 'הפעל', exact: true }).first().click() // the sensors switch
  let lat = 32.0853,
    lon = 34.7818
  for (let s = 0; s < seconds; s++) {
    const g = gnss(s),
      m = motion(s)
    await page.evaluate(
      ([std, yaw]) => {
        window.__std = std
        window.__yaw = yaw
      },
      [m.std, m.yaw],
    )
    lat += (g.speed * Math.cos((g.heading * Math.PI) / 180)) / 111320
    lon += (g.speed * Math.sin((g.heading * Math.PI) / 180)) / (111320 * Math.cos((lat * Math.PI) / 180))
    await cdp.send('Emulation.setGeolocationOverride', {
      latitude: lat,
      longitude: lon,
      accuracy: 4.5,
      altitude: 40,
      altitudeAccuracy: 6,
      speed: g.speed,
      heading: g.heading,
    })
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(1500)
  const ids = await page
    .locator('.integrity [data-finding]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-finding')))
  await ctx.close()
  return { ids, errors }
}

const drive = await scenario({
  seconds: 50,
  gnss: (s) => ({ speed: 10, heading: s < 25 ? 0 : s < 28 ? (s - 24) * 30 : 90 }),
  motion: (s) => ({ std: 0.35, yaw: s >= 25 && s < 28 ? 30 : 0 }),
})
ok(
  'genuine drive with a real turn: no sensor findings',
  !drive.ids.some((i) => i.startsWith('sensor-')),
  drive.ids.join(',') || 'none',
)
ok('genuine drive: no errors', drive.errors.length === 0, drive.errors.join(' | '))

const still = await scenario({
  seconds: 50,
  gnss: () => ({ speed: 12, heading: 45 }),
  motion: () => ({ std: 0.02, yaw: 0 }),
})
ok('GNSS says driving, phone lies still → sensor-still', still.ids.includes('sensor-still'), still.ids.join(','))

const turns = await scenario({
  seconds: 50,
  gnss: (s) => ({
    speed: 9,
    heading: s < 15 ? 0 : s < 18 ? (s - 14) * 30 : s < 32 ? 90 : s < 35 ? 90 + (s - 31) * 30 : 180,
  }),
  motion: () => ({ std: 0.35, yaw: 0 }),
})
ok('GNSS turns the gyroscope never felt → sensor-turn', turns.ids.includes('sensor-turn'), turns.ids.join(','))
await b.close()

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
