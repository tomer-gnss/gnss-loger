// Live satellites: predicted (real CelesTrak data) in Chrome + WebKit, and an external receiver
// via a mocked Web Serial port fed (a) a genuine stream for today's real sky, (b) an old replay.
import { chromium, webkit, devices } from 'playwright-core'
import { GEN } from './lib.mjs'
import { readFileSync } from 'node:fs'
const BASE = process.argv[2] ?? 'https://localhost:4180/'
const D = GEN + ''
const results = []
const ok = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// Mock Web Serial: one port whose readable stream emits the feed. paced = at each epoch's own time.
const serialMock = ({ feed, paced }) => {
  const enc = new TextEncoder()
  const port = {
    async open() {},
    async close() {},
    getInfo: () => ({ usbVendorId: 0x1546, usbProductId: 0x01a8 }),
    readable: new ReadableStream({
      async pull(ctrl) {
        const next = feed.shift()
        if (!next) {
          await new Promise((r) => setTimeout(r, 1000))
          return
        }
        if (paced) {
          const wait = next.t - Date.now()
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        } else await new Promise((r) => setTimeout(r, 60))
        ctrl.enqueue(enc.encode(next.lines.join('\r\n') + '\r\n'))
      },
    }),
  }
  Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => port }, configurable: true })
}

async function run(engine, ctxOpts, scenario) {
  const b = await (engine === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' }))
  const ctx = await b.newContext({
    ...ctxOpts,
    ignoreHTTPSErrors: true,
    locale: 'he-IL',
    permissions: ['geolocation'],
    geolocation: { latitude: 32.0853, longitude: 34.7818, accuracy: 5 },
  })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('atlas.welcomeSeen', '1')
    } catch {
      /* blocked */
    }
  })
  if (scenario.feed) await ctx.addInitScript(serialMock, { feed: scenario.feed, paced: scenario.paced })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => {
    const t = m.text()
    if (p.__shot && /stylesheet/.test(t)) return
    if (m.type() === 'error' || /Refused|Content Security/.test(t)) errors.push(t.slice(0, 140))
  })
  await p.goto(BASE)
  await p.getByRole('button', { name: 'הפעל מעקב' }).click()
  await p.locator('.coords').waitFor({ timeout: 15000 })
  await p.getByRole('button', { name: 'הצג לוויינים חזויים' }).click()
  await p.locator('.live-sats .summary-chips').first().waitFor({ timeout: 30000 })
  const chips = (await p.locator('.live-sats .summary-chips').first().innerText()).replace(/\n/g, ' ')
  return { b, ctx, p, errors, chips }
}

// 1. Predicted sky, Chrome (Android-like) and WebKit (iPhone 13 Pro)
for (const [engine, opts] of [
  ['chrome', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
  ['webkit', devices['iPhone 13 Pro']],
]) {
  const { b, p, errors, chips } = await run(engine, opts, {})
  const gps = Number((/GPS\s*(\d+)/.exec(chips) ?? [])[1] ?? 0)
  ok(`${engine}: predicted satellites shown`, gps >= 5 && gps <= 14, chips)
  ok(`${engine}: CelesTrak fetch allowed by CSP, no errors`, errors.length === 0, errors.join(' | '))
  if (engine === 'webkit')
    ok(
      'webkit: receiver section says iPhone cannot connect',
      (await p.getByText('באייפון אין לדפדפנים אפשרות').count()) === 1,
    )
  await p.locator('.live-sats').scrollIntoViewIfNeeded()
  await p.evaluate(() => {
    document.querySelector('.live-sats').scrollIntoView({ block: 'start' })
    window.scrollBy(0, -70)
  })
  p.__shot = true
  await p.screenshot({ path: `L-${engine}-predicted.png`, caret: 'initial' })
  p.__shot = false
  await b.close()
}

// 2. External receiver, genuine stream for today's sky (paced in real time)
{
  const feed = JSON.parse(readFileSync(D + 'live-genuine.json', 'utf8'))
  const { b, p, errors } = await run(
    'chrome',
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    { feed, paced: true },
  )
  await p.getByRole('button', { name: 'חבר מקלט' }).click()
  await p.locator('.rx-status').waitFor({ timeout: 10000 })
  await p.waitForTimeout(42000)
  const status = (await p.locator('.rx-status').innerText()).replace(/\n/g, ' ')

  await p
    .locator('.live-sats .integrity')
    .getByRole('button', { name: /בדיקות שעברו/ })
    .click()
    .catch(() => {})
  const passed = await p
    .locator('.live-sats .passed-list li')
    .allInnerTexts()
    .catch(() => [])
  const findings = await p.locator('.live-sats .finding-title').allInnerTexts()
  ok('genuine receiver: connected and streaming', /מחובר/.test(status), status.slice(0, 110))
  ok(
    'genuine receiver: sky matches real orbits',
    passed.some((x) => /תואמים את מסלולי הלוויינים/.test(x)),
    passed.find((x) => /מסלולי/.test(x)) ?? findings.join(' / '),
  )
  ok(
    'genuine receiver: clock matches phone',
    passed.some((x) => /שעון המקלט החיצוני צמוד/.test(x)),
  )
  ok(
    'genuine receiver: no sky/clock alarms',
    !findings.some((t) => /השמיים|שעון המקלט/.test(t)),
    findings.join(' / ') || 'no findings',
  )
  ok('no JS / CSP errors (genuine receiver)', errors.length === 0, errors.join(' | '))
  await p.evaluate(() => {
    document.querySelector('.rx-status').scrollIntoView({ block: 'start' })
    window.scrollBy(0, -70)
  })
  await p.screenshot({ path: 'L-receiver-genuine.png' })
  await b.close()
}

// 3. External receiver replaying an old recording (2020, Mountain View) → must be flagged
{
  const lines = readFileSync(D + 'samples/ublox.nmea', 'utf8')
    .split('\n')
    .slice(0, 9000)
  const feed = []
  for (let i = 0; i < lines.length; i += 30) feed.push({ t: 0, lines: lines.slice(i, i + 30) })
  const { b, p, errors } = await run(
    'chrome',
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    { feed, paced: false },
  )
  await p.getByRole('button', { name: 'חבר מקלט' }).click()
  await p.locator('.rx-status').waitFor({ timeout: 10000 })
  await p.waitForTimeout(16000)
  const verdict = await p
    .locator('.live-sats .integrity h2')
    .innerText()
    .catch(() => '')
  const findings = await p.locator('.live-sats .finding-title').allInnerTexts()
  ok('replay: verdict is spoofing', /שיבוש\/זיוף/.test(verdict), verdict)
  ok(
    'replay: sky mismatch detected',
    findings.some((t) => /השמיים שהמקלט מדווח לא תואמים/.test(t)),
    findings.join(' / '),
  )
  ok(
    'replay: receiver clock offset detected',
    findings.some((t) => /שעון המקלט החיצוני רחוק/.test(t)),
  )
  ok('no JS / CSP errors (replay)', errors.length === 0, errors.join(' | '))
  await p.evaluate(() => {
    document.querySelector('.rx-status').scrollIntoView({ block: 'start' })
    window.scrollBy(0, -70)
  })
  await p.screenshot({ path: 'L-receiver-replay.png' })
  await b.close()
}

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
