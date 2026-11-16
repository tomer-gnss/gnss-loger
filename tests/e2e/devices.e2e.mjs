// Build 1: a brand-new user on each iPhone model (WebKit), plus Android Chrome.
// Usage: node devices-test.mjs https://localhost:4180/gnss-loger/
import { chromium, webkit, devices } from 'playwright-core'
import { GEN } from './lib.mjs'
const BASE = process.argv[2] ?? 'https://localhost:4180/gnss-loger/'
const A = GEN + 'attack/'
const results = []
const ok = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const ANDROID = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
}
const PROFILES = [
  ['iPhone SE', 'webkit', devices['iPhone SE']],
  ['iPhone 13 Pro', 'webkit', devices['iPhone 13 Pro']],
  ['iPhone 14 Pro Max', 'webkit', devices['iPhone 14 Pro Max']],
  ['iPhone 15 Pro', 'webkit', devices['iPhone 15 Pro']],
  ['iPhone 15 Pro Max', 'webkit', devices['iPhone 15 Pro Max']],
  ['iPhone 15 Pro Max landscape', 'webkit', devices['iPhone 15 Pro Max landscape']],
  ['Android (Pixel 9)', 'chrome', ANDROID],
]
/** No horizontal page scroll; on failure, names the elements that stick out (for debugging). */
const hScroll = (p) =>
  p.evaluate(() => {
    const W = innerWidth
    const over = [...document.body.querySelectorAll('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && (r.right > W + 1 || r.left < -1)
      })
      .slice(0, 3)
      .map((el) => `${el.tagName}.${el.className?.baseVal ?? el.className}: "${(el.textContent || '').slice(0, 25)}"`)
    return {
      ok: document.documentElement.scrollWidth - W <= 0,
      detail: `${document.documentElement.scrollWidth}/${W} ${over.join(' | ')}`,
    }
  })
/** Visible interactive elements smaller than 44 px in either dimension (inline text links excluded). */
const smallTargets = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('button, select, input[type=range], a.button')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !el.closest('.leaflet-control')
      })
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.height < 43.5 || (r.width < 43.5 && !el.classList.contains('link-button'))
      })
      .map(
        (el) =>
          `${el.className || el.tagName}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
      ),
  )

for (const [name, engine, dev] of PROFILES) {
  const b = await (engine === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' }))
  const ctx = await b.newContext({
    ...dev,
    ignoreHTTPSErrors: true,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    permissions: ['geolocation'],
    geolocation: { latitude: 32.0853, longitude: 34.7818, accuracy: 4 },
  })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => {
    const t = m.text()
    if (p.__shot && /stylesheet/.test(t)) return
    if (m.type() === 'error' || /Refused|Content Security|Trusted/.test(t)) errors.push(t.slice(0, 160))
  })
  p.on('dialog', (d) => d.accept())
  const tag = `[${name}]`
  await p.goto(BASE)

  // First visit: welcome
  const dlg = p.getByRole('dialog')
  ok(
    `${tag} welcome on first visit`,
    await dlg
      .waitFor({ timeout: 10000 })
      .then(() => true)
      .catch(() => false),
  )
  const steps = await dlg.innerText()
  ok(
    `${tag} welcome has platform steps`,
    engine === 'webkit' ? /להתחלה באייפון/.test(steps) && /אתרי Safari/.test(steps) : /להתחלה באנדרואיד/.test(steps),
  )
  const btn = p.getByRole('button', { name: 'הבנתי, מתחילים' })
  await btn.scrollIntoViewIfNeeded()
  const bb = await btn.boundingBox()
  const vp = p.viewportSize()
  ok(
    `${tag} welcome button reachable on screen`,
    bb && bb.y >= 0 && bb.y + bb.height <= vp.height + 1 && bb.height >= 44,
    JSON.stringify(bb && { y: Math.round(bb.y), h: Math.round(bb.height) }),
  )
  if (name.startsWith('iPhone 15 Pro Max') || name === 'iPhone SE') {
    p.__shot = true
    await p.screenshot({ path: `D-welcome-${name.replace(/ /g, '_')}.png` })
    p.__shot = false
  }
  await btn.click()
  ok(`${tag} welcome closes`, !(await dlg.isVisible()))
  await p.reload()
  ok(`${tag} welcome not shown again`, !(await p.getByRole('dialog').isVisible()))

  // Live
  await p.getByRole('button', { name: 'הפעל מעקב' }).click()
  const live = await p
    .locator('.coords')
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false)
  ok(`${tag} live: position shown`, live)
  {
    const h = await hScroll(p)
    ok(`${tag} live: no horizontal scroll`, h.ok, h.ok ? '' : h.detail)
  }
  const small = await smallTargets(p)
  ok(`${tag} live: tap targets ≥ 44`, small.length === 0, small.slice(0, 6).join(' '))

  // Plots with a GNSS log + cellular log
  await p.locator('.mode-tabs').getByRole('button', { name: 'גרפים' }).click()
  await p
    .locator('input[type=file]')
    .nth(0)
    .setInputFiles(A + 'jam-stripe.nmea')
  await p.locator('.cn0-chart').waitFor({ timeout: 30000 })
  await p
    .locator('input[type=file]')
    .nth(1)
    .setInputFiles(A + 'tc-steady.csv')
  await p.locator('.cell-chart').waitFor({ timeout: 15000 })
  await p.getByRole('button', { name: 'כל הלוג' }).click()
  ok(`${tag} plots: C/N0 + cellular + comparison`, (await p.locator('.cmp-item.gnss-only').count()) === 1)
  {
    const h = await hScroll(p)
    ok(`${tag} plots: no horizontal scroll`, h.ok, h.ok ? '' : h.detail)
  }
  const smallP = await smallTargets(p)
  ok(`${tag} plots: tap targets ≥ 44`, smallP.length === 0, smallP.slice(0, 6).join(' '))

  // Log tab (shares the loaded log)
  await p.locator('.mode-tabs').getByRole('button', { name: 'ניתוח לוג' }).click()
  ok(`${tag} log: same log already loaded`, (await p.locator('.log-summary').count()) === 1)
  {
    const h = await hScroll(p)
    ok(`${tag} log: no horizontal scroll`, h.ok, h.ok ? '' : h.detail)
  }

  // Footer: version + erase
  const ver = await p.locator('.app-version').innerText()
  ok(`${tag} footer: version shown`, /v\d+\.\d+\.\d+/.test(ver), ver)
  await p.getByRole('button', { name: /מחיקת נתונים מהמכשיר/ }).click()
  await p.waitForLoadState('load')
  await p.waitForTimeout(800)
  const left = await p.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('atlas.'))
      .concat(Object.keys(sessionStorage).filter((k) => k.startsWith('atlas.'))),
  )
  ok(
    `${tag} erase: storage cleared and welcome back`,
    left.length === 0 && (await p.getByRole('dialog').isVisible()),
    left.join(','),
  )
  ok(`${tag} no JS / CSP errors`, errors.length === 0, errors.join(' | '))
  await b.close()
}

// Manifest is served and valid under the CSP (Chrome reports manifest problems in the console).
{
  const b = await chromium.launch({ channel: 'chrome' })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true })
  const p = await ctx.newPage()
  const errors = []
  p.on('console', (m) => {
    if (m.type() === 'error' || /Refused|manifest/i.test(m.text())) errors.push(m.text().slice(0, 160))
  })
  await p.goto(BASE)
  const href = await p.locator('link[rel=manifest]').getAttribute('href')
  const res = await p.request.get(new URL(href, BASE).href)
  const man = await res.json().catch(() => null)
  ok('manifest: served + parsed', res.ok() && man?.name === 'אטלס GNSS' && man.icons.length === 2, href)
  for (const ic of man?.icons ?? []) {
    const r = await p.request.get(new URL(ic.src, new URL(href, BASE)).href)
    ok(`manifest icon ${ic.sizes}`, r.ok() && r.headers()['content-type'].includes('png'))
  }
  await p.waitForTimeout(1500)
  ok('manifest: no CSP / manifest errors', errors.length === 0, errors.join(' | '))
  await b.close()
}

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
