// Plots tab (C/N0 vs time) + recording guide. Chrome (Android-like), WebKit (iPhone 13 Pro).
// Usage: node plots-test.mjs https://localhost:4180/
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
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: ANDROID_UA,
}

const serialMock = ({ feed }) => {
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
        await new Promise((r) => setTimeout(r, 120))
        ctrl.enqueue(enc.encode(next.lines.join('\r\n') + '\r\n'))
      },
    }),
  }
  Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => port }, configurable: true })
}

async function open(engine, opts, feed) {
  const b = await (engine === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' }))
  const ctx = await b.newContext({
    ...opts,
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
  if (feed) await ctx.addInitScript(serialMock, { feed })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => {
    const t = m.text()
    if (p.__shot && /stylesheet/.test(t)) return
    if (m.type() === 'error' || /Refused|Content Security|Trusted/.test(t)) errors.push(t.slice(0, 160))
  })
  await p.goto(BASE)
  return { b, p, errors }
}
const paths = (p) => p.locator('.cn0-chart svg path').count()
const timeS = async (p) =>
  Number((/(\d+) s/.exec(await p.locator('.plots-stats > div').first().innerText()) ?? [])[1] ?? -1)
const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth === 0)

// 1. Android: guide open in the log tab; log replay in the plots tab
{
  const { b, p, errors } = await open('chrome', PHONE)
  ok('android: 3 tabs', (await p.locator('.mode-tabs button').count()) === 3)
  await p.locator('.mode-tabs').getByRole('button', { name: 'ניתוח לוג' }).click()
  ok(
    'android: guide titled for Android and open',
    (await p.getByRole('button', { name: /מדריך הקלטה לאנדרואיד/ }).getAttribute('aria-expanded')) === 'true',
  )
  ok(
    'android: guide mentions Force full GNSS measurements',
    (await p.getByText('Force full GNSS measurements').count()) === 1,
  )
  await p.locator('.mode-tabs').getByRole('button', { name: 'גרפים' }).click()
  ok('plots: honest note about browsers', (await p.getByText(/דפדפנים לא מקבלים C\/N₀/).count()) === 1)
  await p
    .locator('input[type=file]')
    .first()
    .setInputFiles(D + 'samples/ublox.nmea')
  await p.locator('.cn0-chart').waitFor({ timeout: 30000 })
  await p.waitForTimeout(1500)
  const t1 = await timeS(p)
  await p.waitForTimeout(3000)
  const t2 = await timeS(p)
  ok('replay 1×: advances in real time', t2 - t1 >= 2 && t2 - t1 <= 5, `${t1} → ${t2} s`)
  const n = await paths(p)
  ok('chart: one line per signal', n >= 10, `${n} paths`)
  ok('chart: 25 dB-Hz reference line', (await p.locator('.cn0-chart .ref-line').count()) === 1)
  p.__shot = true
  await p.locator('.plots').nth(1).screenshot({ path: 'PL1-replay-1x.png' })
  p.__shot = false
  await p.getByRole('button', { name: '10×' }).click()
  const t3 = await timeS(p)
  await p.waitForTimeout(2000)
  const t4 = await timeS(p)
  ok('replay 10×: ~10× faster', t4 - t3 >= 14 && t4 - t3 <= 26, `${t3} → ${t4} s`)
  // Hover/tap a line → tooltip
  const box = await p.locator('.cn0-chart svg').boundingBox()
  await p.locator('.cn0-chart svg').tap({ position: { x: box.width * 0.2, y: box.height * 0.35 } })
  const tip = await p
    .locator('.cn0-chart .chart-tip')
    .innerText()
    .catch(() => '')
  ok('chart: tap shows signal tooltip', /dB-Hz/.test(tip), tip.replace(/\n/g, ' '))
  // Filter: hide GPS
  const before = await paths(p)
  await p.locator('.sys-filter button', { hasText: 'GPS' }).click()
  const after = await paths(p)
  ok('filter: hiding GPS removes its lines', after < before, `${before} → ${after}`)
  await p.locator('.sys-filter button', { hasText: 'GPS' }).click()
  // Focus a signal from the chips
  await p.locator('.sig-chip').first().click()
  ok('focus: chip highlights one line', (await p.locator('.cn0-chart path[stroke-width="3"]').count()) === 1)
  // Whole log
  await p.getByRole('button', { name: 'כל הלוג' }).click()
  await p.waitForTimeout(300)
  const tEnd = await timeS(p)
  ok('whole log: shows full duration', tEnd > 1700, `${tEnd} s`)
  ok('layout 390: no horizontal scroll', await noHScroll(p))
  p.__shot = true
  await p.locator('.plots').nth(1).screenshot({ path: 'PL2-whole-log.png' })
  p.__shot = false
  // Shared log: the log tab already has it
  await p.locator('.mode-tabs').getByRole('button', { name: 'ניתוח לוג' }).click()
  ok('shared: log tab shows the same log without reloading', (await p.locator('.log-summary').count()) === 1)
  ok('no JS / CSP errors (android replay)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 2. External receiver (mocked Web Serial) live in the plots tab; survives tab switches
{
  const lines = readFileSync(D + 'samples/ublox.nmea', 'utf8')
    .split('\n')
    .slice(0, 6000)
  const feed = []
  for (let i = 0; i < lines.length; i += 30) feed.push({ lines: lines.slice(i, i + 30) })
  const { b, p, errors } = await open('chrome', PHONE, feed)
  await p.locator('.mode-tabs').getByRole('button', { name: 'גרפים' }).click()
  await p.getByRole('button', { name: /מקלט חיצוני/ }).click()
  await p.getByRole('button', { name: 'חבר מקלט' }).click()
  await p.locator('.rx-status').waitFor({ timeout: 10000 })
  await p.waitForTimeout(5000)
  const n1 = await paths(p),
    s1 = await timeS(p)
  ok('receiver: live C/N0 lines', n1 >= 5, `${n1} paths, t=${s1} s`)
  await p.waitForTimeout(3000)
  const s2 = await timeS(p)
  ok('receiver: chart keeps updating', s2 > s1, `${s1} → ${s2} s`)
  await p.locator('.mode-tabs').getByRole('button', { name: 'מעקב חי' }).click()
  await p.getByRole('button', { name: 'הפעל מעקב' }).click()
  await p.locator('.live-sats').waitFor({ timeout: 15000 })
  ok('receiver: live tab sees the same connection', (await p.locator('.live-sats .rx-status').count()) === 1)
  await p.waitForTimeout(1500)
  await p.locator('.mode-tabs').getByRole('button', { name: 'גרפים' }).click()
  await p.getByRole('button', { name: /מקלט חיצוני/ }).click()
  ok('receiver: still connected after tab switch', (await p.locator('.plots .rx-status').count()) === 1)
  ok('layout 390 (receiver): no horizontal scroll', await noHScroll(p))
  p.__shot = true
  await p.locator('.plots').nth(1).screenshot({ path: 'PL3-receiver.png' })
  p.__shot = false
  ok('no JS / CSP errors (receiver)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 3. iPhone 13 Pro (WebKit)
{
  const { b, p, errors } = await open('webkit', devices['iPhone 13 Pro'])
  await p.locator('.mode-tabs').getByRole('button', { name: 'גרפים' }).click()
  ok('iphone: explains Apple does not expose C/N0', (await p.getByText(/Apple לא חושפת אותו/).count()) === 1)
  ok(
    'iphone: guide is collapsed (not Android)',
    (await p.getByRole('button', { name: 'איך מקליטים לוג?' }).getAttribute('aria-expanded')) === 'false',
  )
  await p.getByRole('button', { name: /מקלט חיצוני/ }).click()
  ok(
    'iphone: receiver option explains Web Serial is missing',
    (await p.getByText(/Apple לא תומכת ב-Web Serial/).count()) === 1,
  )
  await p.getByRole('button', { name: /לוג מוקלט/ }).click()
  await p
    .locator('input[type=file]')
    .first()
    .setInputFiles(D + 'samples/epoch10.txt')
  await p.locator('.cn0-chart').waitFor({ timeout: 30000 })
  await p.getByRole('button', { name: 'כל הלוג' }).click()
  ok('iphone: Android log plotted', (await paths(p)) >= 5, `${await paths(p)} paths`)
  ok('iphone layout: no horizontal scroll', await noHScroll(p))
  p.__shot = true
  await p.screenshot({ path: 'PL4-iphone.png', fullPage: true })
  p.__shot = false
  ok('no JS / CSP errors (iphone)', errors.length === 0, errors.join(' | '))
  await b.close()
}

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
