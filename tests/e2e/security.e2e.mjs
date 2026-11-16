// Hostile log files in the browser, Trusted Types against injection, reverse-tabnabbing guard.
// Usage: node tests/e2e/security.e2e.mjs <BASE>
import { chromium } from 'playwright-core'
import { GEN } from './lib.mjs'

const BASE = process.argv[2] ?? 'https://localhost:4180/'
const A = GEN + 'attack/'
const results = []
const ok = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const b = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await b.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  ignoreHTTPSErrors: true,
})
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('atlas.welcomeSeen', '1')
  } catch {
    /* blocked */
  }
})

// Each hostile file must load (possibly truncated) or be rejected with a message, quickly,
// without freezing the page, without errors, and without rendering an unbounded DOM.
const HOSTILE = {
  'redos.txt': 'ReDoS header',
  'coords.txt': 'out-of-range coordinates',
  'proto.txt': 'prototype-pollution keys',
  'flood.txt': '1M signals in one epoch',
  'providers.txt': '200k providers',
  'longline.txt': '3 MB single line',
}
for (const [f, what] of Object.entries(HOSTILE)) {
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 100)))
  await p.goto(BASE)
  await p.locator('.mode-tabs').getByRole('button', { name: 'ניתוח לוג' }).click()
  const t0 = Date.now()
  await p.locator('input[type=file]').setInputFiles(A + f)
  const res = await Promise.race([
    p
      .locator('.log-summary')
      .waitFor({ timeout: 30000 })
      .then(() => 'loaded'),
    p
      .locator('.error-text')
      .waitFor({ timeout: 30000 })
      .then(() => 'rejected'),
  ]).catch(() => 'TIMEOUT')
  const ms = Date.now() - t0
  const alive = await p
    .evaluate(
      () => new Promise((r) => requestAnimationFrame(() => r(document.querySelectorAll('.app-shell').length === 1))),
    )
    .catch(() => false)
  const nodes = await p.locator('svg *').count()
  const polluted = await p.evaluate(() => ({}).polluted !== undefined || Object.prototype.constructor !== Object)
  ok(
    `hostile ${f} (${what}): handled in time, page alive`,
    res !== 'TIMEOUT' && ms < 20000 && alive,
    `${res} in ${ms} ms`,
  )
  ok(
    `hostile ${f}: bounded DOM, no pollution, no errors`,
    nodes < 5000 && !polluted && errs.length === 0,
    `${nodes} svg nodes ${errs.join('|')}`,
  )
  await p.close()
}

// Trusted Types: HTML strings with code can't be injected.
const p = await ctx.newPage()
await p.goto(BASE)
const tt = await p.evaluate(() => {
  try {
    document.body.insertAdjacentHTML('beforeend', '<img src=x onerror="window.pwned=1">')
    return 'not blocked'
  } catch (e) {
    return 'blocked: ' + e.constructor.name
  }
})
ok('Trusted Types blocks injected <img onerror>', tt.startsWith('blocked'), tt)
const tt2 = await p.evaluate(() => {
  try {
    const s = document.createElement('script')
    s.textContent = 'window.pwned=1'
    document.body.append(s)
    return window.pwned ? 'ran' : 'did not run'
  } catch (e) {
    return 'blocked: ' + e.constructor.name
  }
})
ok('inline <script> injection does not run', tt2 !== 'ran', tt2)

// Reverse tabnabbing: opened by another page → warning first.
const [popup] = await Promise.all([
  p.waitForEvent('popup'),
  p.evaluate((u) => {
    window.open(u)
  }, BASE),
])
await popup.waitForTimeout(1500)
ok('opened by another page: warning shown', (await popup.locator('.opener-warning').count()) === 1)
await popup.getByRole('button', { name: 'המשך בכל זאת' }).click()
ok('continue anyway: app loads', (await popup.getByRole('button', { name: 'הפעל מעקב' }).count()) === 1)
await b.close()

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
