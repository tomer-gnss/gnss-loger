// Analysis report: log report (with cellular), live-session report, PDF via print, HTML download.
// Usage: node report-test.mjs https://localhost:4180/gnss-loger/
import { chromium, webkit, devices } from 'playwright-core'
import { GEN } from './lib.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const BASE = process.argv[2] ?? 'https://localhost:4180/gnss-loger/'
const D = GEN + ''
const A = D + 'attack/'
const results = []
const ok = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
}

async function open(engine, opts) {
  const b = await (engine === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' }))
  const ctx = await b.newContext({
    ...opts,
    ignoreHTTPSErrors: true,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    acceptDownloads: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 32.0853, longitude: 34.7818, accuracy: 5 },
  })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('atlas.welcomeSeen', '1')
    } catch {
      /* */
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
  return { b, ctx, p, errors, hosts }
}
const tab = (p, name) => p.locator('.mode-tabs').getByRole('button', { name }).click()

// 1. Log report (Chrome): jam log + cellular, PDF, HTML download
{
  const { b, p, errors, hosts } = await open('chrome', PHONE)
  await tab(p, 'גרפים')
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
  await p.getByRole('button', { name: 'דוח PDF' }).click()
  const page = p.locator('.report-page')
  await page.waitFor({ timeout: 15000 })
  await p.waitForTimeout(1200)
  const text = await page.innerText()
  const expectHash = createHash('sha256')
    .update(readFileSync(A + 'jam-stripe.nmea'))
    .digest('hex')
  ok('log report: opens with title + version', /דוח ניתוח לוג GNSS/.test(text) && /v\d+\.\d+\.\d+/.test(text))
  ok('log report: SHA-256 matches the file', text.includes(expectHash), expectHash.slice(0, 16) + '…')
  ok('log report: verdict + score', (await p.locator('.report-verdict').count()) === 1 && /ציון חשד/.test(text))
  ok('log report: findings listed', (await p.locator('.report-section .report-findings li').count()) >= 1)
  ok('log report: per-system table', (await p.locator('.report-table.sys tbody tr').count()) >= 3)
  ok(
    'log report: charts (C/N0, constellation, heatmap, sky)',
    (await page.locator('.cn0-chart svg path').count()) > 10 &&
      (await page.locator('canvas').count()) === 1 &&
      (await page.locator('.sky-plot').count()) === 1,
  )
  ok(
    'log report: cellular section with GNSS-only event',
    /GNSS נחלש והסלולר לא/.test(text) && (await page.locator('.cell-chart').count()) === 1,
  )
  ok('log report: track included by default', (await page.locator('.report-track').count()) === 1)
  {
    const r = await p.locator('.report-overlay').evaluate((el) => {
      const W = el.clientWidth
      const bad = [...el.querySelectorAll('*')]
        .filter((x) => {
          const r = x.getBoundingClientRect()
          return r.width > 0 && (r.right > W + 1 || r.left < -1)
        })
        .slice(0, 4)
        .map((x) => x.tagName + '.' + (x.className?.baseVal ?? x.className) + ':' + x.textContent.slice(0, 25))
      return { ok: el.scrollWidth <= W + 1, d: el.scrollWidth + '/' + W + ' ' + bad.join(' | ') }
    })
    ok('layout: no horizontal scroll in report', r.ok, r.d)
  }
  p.__shot = true
  await page.screenshot({ path: 'R1-log-report.png' })
  p.__shot = false
  // Print media: app hidden, toolbar hidden, report visible → real PDF from headless Chrome
  const phoneW = await p.locator('.report-page .cn0-chart svg').getAttribute('width')
  await p.emulateMedia({ media: 'print' })
  const printState = await p.evaluate(() => ({
    root: getComputedStyle(document.getElementById('root')).display,
    bar: getComputedStyle(document.querySelector('.report-toolbar')).display,
    page: getComputedStyle(document.querySelector('.report-page')).display,
  }))
  ok(
    'print: only the report is printed',
    printState.root === 'none' && printState.bar === 'none' && printState.page !== 'none',
    JSON.stringify(printState),
  )
  // On a 390-px phone screen, printing must still draw the charts at A4 width.
  await p.evaluate(() => {
    window.__bp = 0
    addEventListener('beforeprint', () => {
      window.__bp++
    })
  })
  await p.evaluate(() => dispatchEvent(new Event('beforeprint')))
  const printW = await p.locator('.report-page .cn0-chart svg').getAttribute('width')
  ok(
    'print: charts switch from phone width to A4 width',
    Number(phoneW) < 400 && printW === '690',
    `${phoneW} → ${printW}`,
  )
  await p.evaluate(() => dispatchEvent(new Event('afterprint')))
  await p.evaluate(() => {
    window.__bp = 0
  })
  const pdf = await p.pdf({ format: 'A4', printBackground: true })
  writeFileSync('R-log-report.pdf', pdf)
  ok('print: Chrome fires beforeprint when making the PDF', (await p.evaluate(() => window.__bp)) >= 1)
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  ok(
    'print: PDF produced',
    pdf.length > 50000 && pages >= 2 && pages <= 8,
    `${Math.round(pdf.length / 1024)} KB, ${pages} pages`,
  )
  await p.emulateMedia({ media: 'screen' })
  await p.waitForTimeout(400)
  {
    let back = null
    for (let i = 0; i < 20 && back !== phoneW; i++) {
      await p.waitForTimeout(150)
      back = await p.locator('.report-page .cn0-chart svg').getAttribute('width')
    }
    ok('print: charts return to screen width afterwards', back === phoneW, back + ' (screen ' + phoneW + ')')
  }
  // Without location
  await p.getByLabel('כולל מיקום ומסלול').uncheck()
  const t2 = await page.innerText()
  ok(
    'privacy toggle: no track / distance',
    (await page.locator('.report-track').count()) === 0 && !/מרחק/.test(t2) && /המיקום והמסלול הושמטו/.test(t2),
  )
  // HTML download
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'הורד קובץ' }).click()])
  const path = D + 'out/R-download.html'
  await dl.saveAs(path)
  const html = readFileSync(path, 'utf8')
  ok(
    'download: self-contained HTML',
    /^<!doctype html>/.test(html) &&
      html.includes("default-src 'none'") &&
      !/<script/i.test(html) &&
      html.includes('data:image/png') &&
      dl.suggestedFilename().endsWith('.html'),
    `${dl.suggestedFilename()} ${Math.round(html.length / 1024)} KB`,
  )
  ok('download: charts saved at A4 width, scalable', html.includes('width="690"') && /viewBox="0 0 690 /.test(html))
  ok('download: respects privacy toggle', !/class="[^"]*report-track/.test(html) && !/מרחק</.test(html))
  ok(
    'privacy: nothing left the device',
    [...hosts].every((h) => h === new URL(BASE).host),
    [...hosts].join(','),
  )
  await p.getByRole('button', { name: 'סגור את הדוח' }).click()
  ok(
    'close: back to the app',
    (await p.locator('.report-overlay').count()) === 0 && (await p.locator('.cn0-chart').count()) === 1,
  )
  ok('no JS / CSP errors (log report)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 2. Downloaded file opens on its own (file://), no errors, styled
{
  const b = await chromium.launch({ channel: 'chrome' })
  const p = await b.newPage({ viewport: { width: 800, height: 1000 } })
  const errors = []
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160))
  })
  await p.goto(pathToFileURL(D + 'out/R-download.html').href)
  const styled = await p.locator('.report-page').evaluate((el) => getComputedStyle(el).backgroundColor)
  ok(
    'downloaded file: opens offline and is styled',
    styled === 'rgb(255, 255, 255)' && (await p.locator('img').count()) >= 1,
    styled,
  )
  ok('downloaded file: no errors', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 3. Live-session report (Chrome)
{
  const { b, ctx, p, errors } = await open('chrome', PHONE)
  await p.getByRole('button', { name: 'הפעל מעקב' }).click()
  const cdp = await ctx.newCDPSession(p)
  for (let i = 0; i < 14; i++) {
    await cdp.send('Emulation.setGeolocationOverride', {
      latitude: 32.0853 + i * 2e-5,
      longitude: 34.7818,
      accuracy: 4 + (i % 3),
      altitude: 40,
      altitudeAccuracy: 5,
      speed: 2,
      heading: 0,
    })
    await p.waitForTimeout(700)
  }
  await p.locator('.action-bar').getByRole('button', { name: 'דוח' }).click()
  const page = p.locator('.report-page')
  await page.waitFor({ timeout: 10000 })
  const text = await page.innerText()
  ok('live report: opens', /דוח סשן מעקב חי/.test(text))
  ok('live report: accuracy stats + position', /דיוק אופקי/.test(text) && /32\.08\d{4}, 34\.78\d{4}/.test(text))
  ok('live report: charts', (await page.locator('svg').count()) >= 2)
  await p.getByLabel('כולל מיקום ומסלול').uncheck()
  ok('live report: location hidden on request', !/32\.08\d{4}/.test(await page.innerText()))
  await p.getByLabel('כולל מיקום ומסלול').check()
  p.__shot = true
  await page.screenshot({ path: 'R2-live-report.png' })
  p.__shot = false
  await p.emulateMedia({ media: 'print' })
  writeFileSync('R-live-report.pdf', await p.pdf({ format: 'A4', printBackground: true }))
  ok('no JS / CSP errors (live report)', errors.length === 0, errors.join(' | '))
  await b.close()
}

// 4. iPhone 15 Pro (WebKit): log report from the log tab + download
{
  const { b, p, errors } = await open('webkit', devices['iPhone 15 Pro'])
  await tab(p, 'ניתוח לוג')
  await p.locator('input[type=file]').setInputFiles(D + 'samples/epoch10.txt')
  await p.locator('.log-summary').waitFor({ timeout: 30000 })
  await p.getByRole('button', { name: 'דוח PDF' }).click()
  await p.locator('.report-page').waitFor({ timeout: 15000 })
  await p.waitForTimeout(800)
  ok('iphone: report renders', /דוח ניתוח לוג GNSS/.test(await p.locator('.report-page').innerText()))
  {
    const r = await p.locator('.report-overlay').evaluate((el) => {
      const W = el.clientWidth
      const bad = [...el.querySelectorAll('*')]
        .filter((x) => {
          const r = x.getBoundingClientRect()
          return r.width > 0 && (r.right > W + 1 || r.left < -1)
        })
        .slice(0, 4)
        .map((x) => x.tagName + '.' + (x.className?.baseVal ?? x.className) + ':' + x.textContent.slice(0, 25))
      return { ok: el.scrollWidth <= W + 1, d: el.scrollWidth + '/' + W + ' ' + bad.join(' | ') }
    })
    ok('iphone: no horizontal scroll', r.ok, r.d)
  }
  const small = await p
    .locator('.report-toolbar button')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.height < 43.5).length)
  ok('iphone: toolbar buttons ≥ 44', small === 0)
  await p.getByRole('button', { name: 'איך שומרים?' }).click()
  ok('iphone: how-to-save explains the iPhone path', /שמור בקבצים/.test(await p.locator('.report-how').innerText()))
  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    p.getByRole('button', { name: 'הורד קובץ' }).click(),
  ])
  ok('iphone: HTML download works', !!dl, dl?.suggestedFilename() ?? '')
  p.__shot = true
  await p.screenshot({ path: 'R3-iphone-report.png' })
  p.__shot = false
  ok('no JS / CSP errors (iphone)', errors.length === 0, errors.join(' | '))
  await b.close()
}

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
