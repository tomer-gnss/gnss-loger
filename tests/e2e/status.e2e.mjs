// GNSS status center + Galmon orbit backup. The three outside feeds (and a CelesTrak outage) are
// served by the test from tests/fixtures/status-feeds.mjs, so the suite runs offline and the CSP
// still decides what the page may fetch.
// Usage: node tests/e2e/status.e2e.mjs <BASE>
import { chromium, webkit, devices } from 'playwright-core'
import { GEN } from './lib.mjs'
import { TLV, rfiFile, spoofFile, galmonFile, noaaFiles } from '../fixtures/status-feeds.mjs'

const BASE = process.argv[2] ?? 'https://localhost:4180/'
const S = GEN + 'samples/'
const results = []
const ok = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const ANDROID = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
}
const ymd = (t) => new Date(t).toISOString().slice(0, 10)

/** Serve the feeds. Stanford: yesterday is "not published yet" (404), the day before exists. */
async function serveFeeds(ctx, { celestrakDown = false, stanfordDays = null } = {}) {
  const seen = []
  const json = (route, body, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    })
  const twoDaysAgo = ymd(Date.now() - 2 * 86400000)
  await ctx.route('https://waas-nas.stanford.edu/data/**', (route) => {
    const url = route.request().url()
    seen.push(url)
    const m = /\/(jamming|spoofing)\/(\d{4})\/(\d{2})\/(\d{2})\/(heatmap|events)\.json$/.exec(url)
    const day = m ? `${m[2]}-${m[3]}-${m[4]}` : ''
    const days = stanfordDays ?? [twoDaysAgo]
    if (!m || !days.includes(day)) return json(route, { error: 'not found' }, 404)
    return json(route, m[1] === 'jamming' ? rfiFile({ day }) : spoofFile(day))
  })
  await ctx.route('https://galmon.eu/svs.json', (route) => {
    seen.push(route.request().url())
    return json(route, galmonFile())
  })
  await ctx.route('https://services.swpc.noaa.gov/products/**', (route) => {
    const url = route.request().url()
    seen.push(url)
    const body = noaaFiles()[url.split('/').pop()]
    return body ? json(route, body) : json(route, {}, 404)
  })
  await ctx.route('https://celestrak.org/**', (route) => {
    seen.push(route.request().url())
    return celestrakDown
      ? route.fulfill({ status: 503, body: 'Service Unavailable', headers: { 'access-control-allow-origin': '*' } })
      : route.continue()
  })
  return seen
}

async function open(engine, opts, feedOpts) {
  const b = await (engine === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' }))
  const ctx = await b.newContext({
    ...opts,
    ignoreHTTPSErrors: true,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    permissions: ['geolocation'],
    geolocation: { latitude: TLV.lat, longitude: TLV.lon, accuracy: 4 },
  })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('atlas.welcomeSeen', '1')
    } catch {
      /* blocked */
    }
  })
  const seen = await serveFeeds(ctx, feedOpts)
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => {
    const t = m.text()
    if (p.__shot && /stylesheet/.test(t)) return
    if (
      /Refused|Content Security|Trusted/.test(t) ||
      (m.type() === 'error' && !/404|503|Failed to load resource/.test(t))
    )
      errors.push(t.slice(0, 160))
  })
  await p.goto(BASE)
  return { b, ctx, p, errors, seen }
}
const tile = (p, title) => p.locator('.status-tile', { hasText: title })

// 1. Live tab (Android Chrome): consent, three tiles, radar, report, privacy
{
  const { b, p, errors, seen } = await open('chrome', ANDROID)
  ok('before tracking: status center offered', (await p.getByRole('button', { name: 'הפעל מרכז מצב' }).count()) === 1)
  await p.getByRole('button', { name: 'הפעל מעקב' }).click()
  await p.locator('.coords').waitFor({ timeout: 15000 })
  ok('nothing fetched before consent', seen.length === 0, seen.join(' '))
  await p.getByRole('button', { name: 'הפעל מרכז מצב' }).click()
  await tile(p, 'שיבושים באזור').locator('strong').waitFor({ timeout: 20000 })
  const rfi = await tile(p, 'שיבושים באזור').innerText()
  ok(
    'interference: hotspot north reported as "nearby interference"',
    /שיבוש בסביבה/.test(rfi) && /40%/.test(rfi) && /צפון/.test(rfi),
    rfi.replace(/\n/g, ' ').slice(0, 160),
  )
  ok(
    'interference: newest available day used (yesterday not published yet)',
    seen.some((u) => u.includes(`/jamming/${ymd(Date.now() - 86400000).replace(/-/g, '/')}/`)) &&
      rfi.includes(
        ymd(Date.now() - 2 * 86400000)
          .slice(5)
          .split('-')
          .reverse()
          .join('.'),
      ),
  )
  await tile(p, 'מצב הלוויינים').locator('strong').waitFor({ timeout: 15000 })
  const sats = await tile(p, 'מצב הלוויינים').innerText()
  ok(
    'satellites: 3 unhealthy, E09 overhead, E14 not',
    /3 לוויינים לא תקינים/.test(sats) &&
      /מעליך עכשיו: E09\b/.test(sats.replace(/\n/g, ' ')) &&
      !/מעליך עכשיו:[^.]*E14/.test(sats),
    sats.replace(/\n/g, ' ').slice(0, 200),
  )
  ok('satellites: OSNMA count', /OSNMA[^\d]*6 מתוך 13/.test(sats))
  await tile(p, 'מזג אוויר חללי').locator('strong').waitFor({ timeout: 15000 })
  const space = await tile(p, 'מזג אוויר חללי').innerText()
  ok(
    'space weather: quiet, Kp 2, storm forecast, G1 watch',
    /שקט/.test(space) &&
      /Kp 2\.0/.test(space) &&
      /5\.3/.test(space) &&
      /WATCH: Geomagnetic Storm Category G1/.test(space),
    space.replace(/\n/g, ' ').slice(0, 200),
  )
  ok(
    'radar: hotspot and spoofing event drawn',
    (await p.locator('.radar circle[fill]').count()) >= 1 && (await p.locator('.radar-spoof').count()) === 1,
  )
  const box = await p.locator('.radar').boundingBox()
  const c = box.width / 2,
    R = c - 22
  await p.locator('.radar').tap({ position: { x: c, y: c - (100 / 400) * R } }) // ~100 km north
  ok('radar: tapping the hotspot explains it', /40%/.test(await p.locator('.radar-tip').innerText()))
  ok(
    'privacy: requests carry no position',
    seen.every((u) => !/32\.0|34\.7|lat=|lon=/.test(u)),
    seen.length + ' requests',
  )
  ok(
    'privacy: only the three feeds were contacted',
    seen.every((u) =>
      /^https:\/\/(waas-nas\.stanford\.edu\/data\/|galmon\.eu\/svs\.json|services\.swpc\.noaa\.gov\/products\/)/.test(
        u,
      ),
    ),
  )
  ok('layout 390: no horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  p.__shot = true
  await p.locator('.status-center').screenshot({ path: 'ST1-status-center.png' })
  p.__shot = false
  // Report carries the context; hiding the location removes the radar.
  await p.locator('.action-bar').getByRole('button', { name: 'דוח' }).click()
  await p.locator('.report-page').waitFor({ timeout: 10000 })
  const rep = await p.locator('.report-page').innerText()
  ok(
    'report: outside-context section',
    /הקשר חיצוני/.test(rep) && /שיבוש בסביבה/.test(rep) && /E09/.test(rep) && /Stanford/.test(rep),
  )
  ok('report: radar included with location', (await p.locator('.report-page .report-radar').count()) === 1)
  await p.getByLabel('כולל מיקום ומסלול').uncheck()
  ok(
    'report: radar and distances removed without location',
    (await p.locator('.report-page .report-radar').count()) === 0 &&
      !/מוקד חזק/.test(await p.locator('.report-page').innerText()),
  )
  await p.getByRole('button', { name: 'סגור את הדוח' }).click()
  // Turning it off forgets the data.
  await p.locator('.status-center').getByRole('button', { name: 'כבה' }).click()
  ok('turn off: back to the consent screen', (await p.getByRole('button', { name: 'הפעל מרכז מצב' }).count()) === 1)
  ok('no JS / CSP errors (live)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 2. Orbit backup: CelesTrak down → predicted sky from Galmon
{
  const { b, p, errors } = await open('chrome', ANDROID, { celestrakDown: true })
  await p.getByRole('button', { name: 'הפעל מעקב' }).click()
  await p.locator('.coords').waitFor({ timeout: 15000 })
  await p.getByRole('button', { name: 'הצג לוויינים חזויים' }).click()
  await p.locator('.live-sats .summary-chips').first().waitFor({ timeout: 20000 })
  const chips = (await p.locator('.live-sats .summary-chips').first().innerText()).replace(/\n/g, ' ')
  const note = await p.locator('.live-sats').innerText()
  ok(
    'backup: predicted sky still shown when CelesTrak is down',
    /GPS\s*\d+/.test(chips) && /Galileo\s*\d+/.test(chips),
    chips,
  )
  ok('backup: source says Galmon', /Galmon \(גיבוי/.test(note))
  ok(
    'backup: Galileo labelled by real PRN (Galmon knows it)',
    (await p.locator('.live-sats .sky-plot text', { hasText: /^E0\d$/ }).count()) > 0,
  )
  ok('no JS / CSP errors (backup)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 3. Log tab: the log's own day and place
{
  const { b, p, errors, seen } = await open('chrome', ANDROID, { stanfordDays: ['2026-04-08'] })
  await p.locator('.mode-tabs').getByRole('button', { name: 'ניתוח לוג' }).click()
  await p.locator('input[type=file]').setInputFiles(S + 'epoch10.txt') // Pixel, San Jose, 2026-04-08
  await p.locator('.log-summary').waitFor({ timeout: 30000 })
  ok(
    "log: card explains it is about the log's day and place",
    /ליום ולמקום של הלוג/.test(await p.locator('.status-center').innerText()),
  )
  await p.getByRole('button', { name: 'הפעל מרכז מצב' }).click()
  await tile(p, 'שיבושים באזור').locator('strong').waitFor({ timeout: 20000 })
  ok(
    "log: the log's date was requested",
    seen.some((u) => u.includes('/jamming/2026/04/08/heatmap.json')),
  )
  ok(
    'log: no "now" feeds (satellites, space weather) for an old log',
    (await tile(p, 'מצב הלוויינים').count()) === 0 && !seen.some((u) => /galmon|swpc/.test(u)),
  )
  ok(
    'log: far from any synthetic aircraft → "not enough aircraft"',
    /אין מספיק מטוסים/.test(await tile(p, 'שיבושים באזור').innerText()),
  )
  await p.getByRole('button', { name: 'קובץ אחר' }).click()
  await p.locator('input[type=file]').setInputFiles(S + 'ublox.nmea') // 2020: before Stanford's archive
  await p.locator('.log-summary').waitFor({ timeout: 30000 })
  await p.locator('.status-tile .error-text').waitFor({ timeout: 20000 })
  ok(
    'log 2020: clear "no data for this date" message',
    /אין נתוני Stanford לתאריך הזה/.test(await tile(p, 'שיבושים באזור').innerText()),
  )
  ok('no JS / CSP errors (log)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 4. iPhone 15 Pro (WebKit)
{
  const { b, p, errors } = await open('webkit', devices['iPhone 15 Pro'])
  await p.getByRole('button', { name: 'הפעל מעקב' }).click()
  await p.locator('.coords').waitFor({ timeout: 15000 })
  await p.getByRole('button', { name: 'הפעל מרכז מצב' }).click()
  await tile(p, 'שיבושים באזור').locator('strong').waitFor({ timeout: 20000 })
  await tile(p, 'מזג אוויר חללי').locator('strong').waitFor({ timeout: 15000 })
  ok('iphone: all three tiles', (await p.locator('.status-tile strong').count()) === 3)
  ok('iphone: radar drawn', (await p.locator('.radar').count()) === 1)
  ok('iphone: no horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  const small = await p.locator('.status-center button').evaluateAll(
    (els) =>
      els.filter((e) => {
        const r = e.getBoundingClientRect()
        return r.height > 0 && r.height < 43.5 && !e.classList.contains('link-button')
      }).length,
  )
  ok('iphone: buttons ≥ 44', small === 0)
  p.__shot = true
  await p.locator('.status-center').screenshot({ path: 'ST2-iphone.png' })
  p.__shot = false
  ok('no JS / CSP errors (iphone)', errors.length === 0, errors.join(' | '))
  await b.close()
}

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
