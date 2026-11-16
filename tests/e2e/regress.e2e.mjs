// Full functional + security regression against a production build served at BASE.
// Usage: node regress.mjs https://localhost:4173/
import { chromium } from 'playwright-core'
import { GEN } from './lib.mjs'

const BASE = process.argv[2] ?? 'https://localhost:4173/'
const S = GEN + 'samples/'
const OWN = new URL(BASE).host
const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const b = await chromium.launch({ channel: 'chrome', headless: true })

async function phone(w = 390, h = 844) {
  const ctx = await b.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    locale: 'he-IL',
    permissions: ['geolocation'],
    geolocation: { latitude: 32.0853, longitude: 34.7818, accuracy: 6 },
  })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('atlas.welcomeSeen', '1')
    } catch {
      /* blocked */
    }
  })
  const page = await ctx.newPage()
  const hosts = new Set(),
    csp = [],
    errors = []
  page.on('request', (r) => hosts.add(new URL(r.url()).host))
  page.on('console', (m) => {
    const t = m.text()
    if (/Content Security Policy|Refused to|TrustedHTML|Trusted Type/i.test(t)) csp.push(t.slice(0, 200))
    else if (m.type() === 'error') errors.push(t.slice(0, 200))
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  const cdp = await ctx.newCDPSession(page)
  return { ctx, page, hosts, csp, errors, cdp }
}

// 1. Live tab
{
  const { ctx, page, hosts, csp, errors, cdp } = await phone()
  await page.goto(BASE)
  await page.getByRole('button', { name: 'הפעל מעקב' }).click()
  for (let i = 0; i < 6; i++) {
    await cdp.send('Emulation.setGeolocationOverride', {
      latitude: 32.0853 + i * 1e-5,
      longitude: 34.7818,
      accuracy: 5,
      altitude: 40,
      altitudeAccuracy: 6,
      speed: 1.2,
      heading: 30,
    })
    await page.waitForTimeout(900)
  }
  const coords = await page
    .locator('.coords')
    .innerText()
    .catch(() => '')
  ok('live: position shown', /32\.08\d+° N/.test(coords), coords.replace(/\n/g, ' '))
  const hz = await page.locator('.live-badge').innerText()
  ok('live: update rate shown', /Hz/.test(hz), hz)
  const external = [...hosts].filter((h) => h !== OWN)
  ok('privacy: no external requests before map opt-in', external.length === 0, external.join(','))
  ok('privacy: map gated by default', (await page.locator('.map-panel .map-consent').count()) === 1)
  await page.getByRole('button', { name: 'הצג מפה' }).click()
  await page.waitForTimeout(2500)
  ok('map: renders after opt-in', (await page.locator('.leaflet-tile-loaded').count()) > 0)
  ok(
    'map: only OSM added',
    [...hosts].filter((h) => h !== OWN).every((h) => h === 'tile.openstreetmap.org'),
  )
  await page.getByRole('button', { name: 'כבה מפה' }).click()
  ok('map: can be turned off', (await page.locator('.map-panel .map-consent').count()) === 1)
  ok(
    'layout 390: no horizontal scroll',
    (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) === 0,
  )
  // CSV export
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    page.getByRole('button', { name: 'CSV' }).click(),
  ])
  ok('live: CSV export downloads', !!dl, dl?.suggestedFilename() ?? '')
  ok('security: no CSP/Trusted-Types violations (live)', csp.length === 0, csp.join(' | '))
  ok('no JS errors (live)', errors.length === 0, errors.join(' | '))
  await ctx.close()
}

// 2. Log tab with each sample
for (const [file, expect] of [
  ['ublox.nmea', /1653/],
  ['epoch10.txt', /10/],
  ['pr2016.txt', /207/],
  ['gpstest_synth.txt', /2/],
]) {
  const { ctx, page, csp, errors } = await phone(360, 740)
  await page.goto(BASE)
  await page.getByRole('button', { name: 'ניתוח לוג' }).first().click()
  await page.locator('input[type=file]').setInputFiles(S + file)
  const loaded = await page
    .locator('.log-summary')
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  const chips = loaded ? await page.locator('.summary-chips').innerText() : ''
  ok(`log: ${file} parsed`, loaded && expect.test(chips), chips.replace(/\n/g, ' ').slice(0, 80))
  if (loaded && (await page.locator('.sky-plot').count())) {
    // The 2016 log predates satellite-position reporting: the plot must say so instead of drawing.
    const noPos = file === 'pr2016.txt'
    const sats = await page.locator('.sky-plot g').count()
    const msg = await page.locator('.sky-plot').innerHTML()
    ok(`log: ${file} sky plot`, noPos ? sats === 0 && msg.includes('אין מיקומי לוויינים') : sats > 0)
  }
  ok(
    `layout 360 (${file}): no horizontal scroll`,
    (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) === 0,
  )
  ok(`security: no CSP violations (${file})`, csp.length === 0, csp.join(' | '))
  ok(`no JS errors (${file})`, errors.length === 0, errors.join(' | '))
  await ctx.close()
}

// 3. Sample download + playback
{
  const { ctx, page, csp, errors } = await phone()
  await page.goto(BASE)
  await page.getByRole('button', { name: 'ניתוח לוג' }).first().click()
  await page.getByRole('button', { name: /קובץ לדוגמה/ }).click()
  const loaded = await page
    .locator('.log-summary')
    .waitFor({ timeout: 60000 })
    .then(() => true)
    .catch(() => false)
  ok('log: sample fetch works under CSP', loaded)
  if (loaded) {
    const t0 = await page.locator('.scrub-times b').innerText()
    await page.getByRole('button', { name: 'נגן' }).click()
    await page.waitForTimeout(1500)
    ok('log: playback advances', (await page.locator('.scrub-times b').innerText()) !== t0)
  }
  ok('security: no CSP violations (sample)', csp.length === 0, csp.join(' | '))
  ok('no JS errors (sample)', errors.length === 0, errors.join(' | '))
  await ctx.close()
}

// 4. Clickjacking
{
  const { ctx, page } = await phone()
  await page.setContent(`<iframe src="${BASE}" allow="geolocation" style="width:390px;height:600px"></iframe>`)
  await page.waitForTimeout(2500)
  const txt = await page
    .frames()[1]
    ?.locator('#root')
    .innerText()
    .catch(() => '')
  ok('security: refuses to run in a frame', /מסגרת/.test(txt ?? ''), (txt ?? '').slice(0, 50))
  await ctx.close()
}

// 5. Desktop smoke
{
  const ctx = await b.newContext({
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 32.0853, longitude: 34.7818, accuracy: 6 },
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
  await page.goto(BASE)
  await page.getByRole('button', { name: 'הפעל מעקב' }).click()
  await page.locator('.coords').waitFor({ timeout: 10000 })
  ok('desktop: live works', true)
  ok('no JS errors (desktop)', errors.length === 0, errors.join(' | '))
  await ctx.close()
}

await b.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
