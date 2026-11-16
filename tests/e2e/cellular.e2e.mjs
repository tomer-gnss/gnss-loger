// Cellular log in the Plots tab: Chrome (Android profile) + WebKit (iPhone 13 Pro).
// Usage: node cell-ui-test.mjs https://localhost:4180/gnss-loger/
import { chromium, webkit, devices } from 'playwright-core'
import { GEN } from './lib.mjs'
const BASE = process.argv[2] ?? 'https://localhost:4180/gnss-loger/'
const A = GEN + 'attack/'
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

async function open(engine, opts) {
  const b = await (engine === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' }))
  const ctx = await b.newContext({ ...opts, ignoreHTTPSErrors: true, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('atlas.welcomeSeen', '1')
    } catch {
      /* blocked */
    }
  })
  const p = await ctx.newPage()
  const errors = [],
    hosts = new Set()
  p.on('request', (r) => hosts.add(new URL(r.url()).host))
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => {
    const t = m.text()
    if (p.__shot && /stylesheet/.test(t)) return
    if (m.type() === 'error' || /Refused|Content Security|Trusted/.test(t)) errors.push(t.slice(0, 160))
  })
  await p.goto(BASE)
  await p.locator('.mode-tabs').getByRole('button', { name: 'גרפים' }).click()
  return { b, p, errors, hosts }
}
const gnssInput = (p) => p.locator('input[type=file]').nth(0)
const cellInput = (p) => p.locator('input[type=file]').nth(1)
const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth === 0)

// 1. GNSS jamming log + steady cellular (Tower Collector)
{
  const { b, p, errors, hosts } = await open('chrome', PHONE)
  ok('cell: how-to-record panel shown', (await p.getByText('איך מקליטים לוג סלולר').count()) === 1)
  await gnssInput(p).setInputFiles(A + 'jam-stripe.nmea')
  await p.locator('.cn0-chart').waitFor({ timeout: 30000 })
  await cellInput(p).setInputFiles(A + 'tc-steady.csv')
  await p.locator('.cell-chart').waitFor({ timeout: 15000 })
  const row = await p.locator('.file-row', { hasText: 'סלולר:' }).innerText()
  ok(
    'cell: file recognised as Tower Collector',
    /Tower Collector/.test(row) && /865/.test(row),
    row.replace(/\n/g, ' '),
  )
  await p.waitForTimeout(2500)
  ok('cell: chart draws a line while replaying', (await p.locator('.cell-chart svg path').count()) >= 1)
  const chips = await p.locator('.cell-block .summary-chips').innerText()
  ok('cell: current level + 4G shown', /dBm/.test(chips) && /4G/.test(chips), chips.replace(/\n/g, ' '))
  const item = p.locator('.cmp-item.gnss-only')
  ok(
    'compare: GNSS-only event listed',
    (await item.count()) === 1,
    (await item.innerText().catch(() => '')).replace(/\n/g, ' ').slice(0, 120),
  )
  await item.getByRole('button', { name: 'הצג את הרגע הזה' }).click()
  await p.waitForTimeout(400)
  const t = Number((/(\d+) s/.exec(await p.locator('.plots-stats > div').first().innerText()) ?? [])[1] ?? -1)
  ok('compare: jump moves the replay to the event', t >= 670 && t <= 700, `${t} s`)
  await p.getByRole('button', { name: 'כל הלוג' }).click()
  await p.waitForTimeout(300)
  ok(
    'compare: event band drawn on both charts',
    (await p.locator('.cn0-chart svg rect').count()) >= 1 && (await p.locator('.cell-chart svg rect').count()) >= 1,
  )
  ok('cell: handover tick drawn', (await p.locator('.cell-chart .handover-tick').count()) >= 1)
  const box = await p.locator('.cell-chart svg').boundingBox()
  await p.locator('.cell-chart svg').tap({ position: { x: box.width * 0.5, y: box.height * 0.5 } })
  const tip = await p
    .locator('.cell-chart .chart-tip')
    .innerText()
    .catch(() => '')
  ok(
    'cell: tap shows level / tech / cell id',
    /dBm/.test(tip) && /4G/.test(tip) && /cell/.test(tip),
    tip.replace(/\n/g, ' '),
  )
  ok('layout 390: no horizontal scroll', await noHScroll(p))
  ok(
    'privacy: nothing leaves the device',
    [...hosts].every((h) => h === new URL(BASE).host),
    [...hosts].join(','),
  )
  p.__shot = true
  await p.locator('.plots').nth(1).screenshot({ path: 'CL1-gnss-cell.png' })
  await p.locator('.cell-compare').screenshot({ path: 'CL2-compare.png' })
  p.__shot = false
  // Tunnel: replace the cellular file → "both"
  await p.getByRole('button', { name: 'הסר' }).click()
  await cellInput(p).setInputFiles(A + 'tc-tunnel.csv')
  await p.locator('.cmp-item').first().waitFor({ timeout: 15000 })
  ok('compare: tunnel → "both dropped"', (await p.locator('.cmp-item.both').count()) === 1)
  ok('no JS / CSP errors (chrome)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 2. Cellular log alone (G-NetTrack, local time), hostile file, no-header file
{
  const { b, p, errors } = await open('chrome', PHONE)
  await cellInput(p).setInputFiles(A + 'gnt-steady.txt')
  await p.locator('.cell-chart').waitFor({ timeout: 15000 })
  ok(
    'cell alone: G-NetTrack recognised',
    /G-NetTrack/.test(await p.locator('.file-row', { hasText: 'סלולר:' }).innerText()),
  )
  ok('cell alone: local-time note shown', (await p.getByText(/אין אזור זמן/).count()) === 1)
  ok('cell alone: replay bar works without GNSS', (await p.locator('.replay-bar').count()) === 1)
  await p.getByRole('button', { name: 'כל הלוג' }).click()
  await p.waitForTimeout(300)
  const legend = await p.locator('.cell-chart .sat-legend').innerText()
  ok(
    'cell alone: 3G / 4G / 5G in legend',
    /3G/.test(legend) && /4G/.test(legend) && /5G/.test(legend),
    legend.replace(/\n/g, ' '),
  )
  await p.getByRole('button', { name: 'הסר' }).click()
  await cellInput(p).setInputFiles(A + 'cell-hostile.csv')
  await p.locator('.cell-chart').waitFor({ timeout: 15000 })
  ok(
    'hostile: loads only the valid rows',
    /\b3\b/.test(await p.locator('.file-row', { hasText: 'סלולר:' }).innerText()),
  )
  await p.getByRole('button', { name: 'הסר' }).click()
  await cellInput(p).setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b,c\n1,2,3\n') })
  ok(
    'no header: clear error',
    await p
      .getByText(/לא נמצאה שורת כותרת/)
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  )
  ok('no JS / CSP errors (alone/hostile)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 3. iPhone 13 Pro (WebKit)
{
  const { b, p, errors } = await open('webkit', devices['iPhone 13 Pro'])
  await gnssInput(p).setInputFiles(A + 'jam-stripe.nmea')
  await p.locator('.cn0-chart').waitFor({ timeout: 30000 })
  await cellInput(p).setInputFiles(A + 'tc-steady.csv')
  await p.locator('.cell-chart').waitFor({ timeout: 15000 })
  await p.getByRole('button', { name: 'כל הלוג' }).click()
  ok('iphone: cellular chart + comparison', (await p.locator('.cmp-item.gnss-only').count()) === 1)
  ok(
    'iphone: says no iPhone app can log cellular',
    (await p.getByText(/באייפון אין אפליקציה שיכולה לרשום/).count()) === 1,
  )
  ok('iphone layout: no horizontal scroll', await noHScroll(p))
  p.__shot = true
  await p.screenshot({ path: 'CL3-iphone.png', fullPage: true })
  p.__shot = false
  ok('no JS / CSP errors (iphone)', errors.length === 0, errors.join(' | '))
  await b.close()
}

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
