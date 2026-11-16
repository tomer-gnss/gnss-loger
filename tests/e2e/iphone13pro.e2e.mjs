// iPhone 13 Pro profile on the WebKit engine (the engine every iOS browser uses).
import { webkit, devices } from 'playwright-core'
import { GEN } from './lib.mjs'
const BASE = process.argv[2] ?? 'https://localhost:4177/'
const S = GEN + 'samples/'
const A = GEN + 'attack/'
const dev = devices['iPhone 13 Pro']
console.log(
  'profile:',
  JSON.stringify({
    viewport: dev.viewport,
    screen: dev.screen,
    dpr: dev.deviceScaleFactor,
    ua: dev.userAgent.slice(0, 60),
  }),
)
const b = await webkit.launch()
const results = []
const ok = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function ctxPage(geo = { latitude: 32.0853, longitude: 34.7818, accuracy: 5 }) {
  const ctx = await b.newContext({
    ...dev,
    ignoreHTTPSErrors: true,
    locale: 'he-IL',
    permissions: ['geolocation'],
    geolocation: geo,
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
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => {
    const t = m.text()
    if (page.__shooting && /Refused to apply a stylesheet/.test(t)) return
    if (m.type() === 'error' || /Refused|Content Security/i.test(t)) errors.push(t.slice(0, 160))
  })
  return { ctx, page, errors }
}

// 1. Live tab on iPhone: install hint, tracking, integrity, map, no errors
{
  const { ctx, page, errors } = await ctxPage()
  await page.goto(BASE)
  ok('webkit: page renders', (await page.getByRole('button', { name: 'הפעל מעקב' }).count()) === 1)
  ok('iPhone: add-to-home-screen hint shown', (await page.locator('.install-hint').count()) === 1)
  page.__shooting = true
  await page.screenshot({ path: 'P1-iphone-start.png', caret: 'initial' })
  await page.waitForTimeout(200)
  page.__shooting = false
  await page.getByRole('button', { name: 'הפעל מעקב' }).click()
  for (let i = 0; i < 8; i++) {
    await ctx.setGeolocation({ latitude: 32.0853 + i * 1e-5, longitude: 34.7818, accuracy: 4.7 })
    await page.waitForTimeout(700)
  }
  const coords = await page
    .locator('.coords')
    .innerText()
    .catch(() => '')
  ok('live: position shown', /32\.08\d+° N/.test(coords), coords.replace(/\n/g, ' '))
  ok('integrity panel present', (await page.locator('.integrity').count()) === 1)
  ok('no approximate-location warning at 4.7 m', (await page.getByText('המיקום מקורב').count()) === 0)
  ok(
    'layout: no horizontal scroll',
    (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) === 0,
  )
  // Touch targets ≥ 44 px (Apple HIG) for every visible button/link
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button, a')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && r.height < 43.5
      })
      .map((el) => `${el.className || el.tagName}:${Math.round(el.getBoundingClientRect().height)}`),
  )
  ok('touch targets ≥ 44 px', small.length === 0, small.slice(0, 6).join(', '))
  // Simulate the screen locking for 8 s (iOS gives pages no location in the background)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(500)
  const gap = await page
    .locator('.gap-note')
    .innerText()
    .catch(() => '')
  ok('screen-lock gap reported', /נעצר/.test(gap), gap.slice(0, 70))
  // Map in WebKit
  await page.getByRole('button', { name: 'הצג מפה' }).click()
  await page.waitForTimeout(2500)
  ok('map: Leaflet renders in WebKit', (await page.locator('.leaflet-tile-loaded').count()) > 0)
  await page.locator('.hero').scrollIntoViewIfNeeded()
  page.__shooting = true
  await page.screenshot({ path: 'P2-iphone-live.png', caret: 'initial' })
  await page.waitForTimeout(200)
  page.__shooting = false
  ok('no JS / CSP errors (live)', errors.length === 0, errors.join(' | '))
  await ctx.close()
}

// 2. "Precise Location" off: iOS hands out ~km accuracy
{
  const { ctx, page, errors } = await ctxPage({ latitude: 32.08, longitude: 34.78, accuracy: 3000 })
  await page.goto(BASE)
  await page.getByRole('button', { name: 'הפעל מעקב' }).click()
  for (let i = 0; i < 4; i++) {
    await ctx.setGeolocation({ latitude: 32.08, longitude: 34.78, accuracy: 3000 + i })
    await page.waitForTimeout(700)
  }
  const card = await page.getByText('המיקום מקורב').count()
  ok('approximate location detected', card === 1)
  ok('shows iPhone settings path', (await page.getByText('אתרי Safari').count()) >= 1)
  page.__shooting = true
  await page.screenshot({ path: 'P3-iphone-approx.png', caret: 'initial' })
  await page.waitForTimeout(200)
  page.__shooting = false
  ok('no JS / CSP errors (approx)', errors.length === 0, errors.join(' | '))
  await ctx.close()
}

// 3. Log tab in WebKit: streaming parser, BigInt clock check, sky plot, timeline jump
for (const [dir, f, expect] of [
  [S, 'ublox.nmea', 'תקין'],
  [S, 'epoch10.txt', 'תקין'],
  [A, 'clock-pull.txt', 'סימני שיבוש/זיוף'],
  [A, 'spoof-uniform-cn0.nmea', 'סימני שיבוש/זיוף'],
]) {
  const { ctx, page, errors } = await ctxPage()
  await page.goto(BASE)
  await page.getByRole('button', { name: 'ניתוח לוג' }).first().click()
  await page.locator('input[type=file]').setInputFiles(dir + f)
  const loaded = await page
    .locator('.log-summary')
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  const verdict = loaded ? await page.locator('.integrity h2').innerText() : ''
  ok(`log ${f}: parsed + verdict "${expect}"`, loaded && verdict === expect, verdict)
  if (f === 'clock-pull.txt')
    ok('BigInt clock check works in WebKit', (await page.getByText('שעון המקלט').count()) >= 1)
  if (f === 'ublox.nmea') {
    await page.locator('.sky-card').scrollIntoViewIfNeeded()
    page.__shooting = true
    await page.screenshot({ path: 'P4-iphone-log.png', caret: 'initial' })
    await page.waitForTimeout(200)
    page.__shooting = false
  }
  ok(`no JS / CSP errors (${f})`, errors.length === 0, errors.join(' | '))
  await ctx.close()
}

// 4. Sensors: does WebKit expose DeviceMotionEvent / requestPermission like iOS?
{
  const { ctx, page } = await ctxPage()
  await page.goto(BASE)
  const api = await page.evaluate(() => ({
    motion: 'DeviceMotionEvent' in window,
    requestPermission: typeof (window.DeviceMotionEvent ?? {}).requestPermission,
    wakeLock: 'wakeLock' in navigator,
    trustedTypes: 'trustedTypes' in window,
  }))
  console.log('WebKit APIs:', JSON.stringify(api))
  await ctx.close()
}
await b.close()

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
