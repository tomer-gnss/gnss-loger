// Runs the browser suites against the production build: generates fixtures, serves dist/ with
// `vite preview` (HTTPS, like production), runs each suite, prints a summary.
// Usage: npm run build && npm run test:e2e [-- --network] [-- --only=plots,report]
//   --network  also run suites that need the internet (live orbits from CelesTrak)
// Browsers: Google Chrome (installed on the machine) and Playwright's WebKit
// (`npx playwright-core install webkit` once).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request } from 'node:https'
import { fileURLToPath } from 'node:url'
import { GEN } from './lib.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const network = args.includes('--network')
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)
const PORT = 4180,
  BASE = `https://localhost:${PORT}/`

const SUITES = [
  { name: 'regress', what: 'live tab, log tab with every sample, map consent, CSV, clickjacking, desktop' },
  { name: 'security', what: 'hostile files, Trusted Types, reverse tabnabbing' },
  { name: 'iphone13pro', what: 'iPhone 13 Pro (WebKit): live, gaps, approximate location, logs, BigInt clock' },
  { name: 'devices', what: 'first visit on iPhone SE → 15 Pro Max (+landscape) and Android' },
  { name: 'plots', what: 'C/N0 vs time: replay, filters, mocked receiver, iPhone' },
  { name: 'cellular', what: 'cellular logs, GNSS-vs-cellular comparison' },
  { name: 'report', what: 'analysis report: PDF, HTML download, privacy toggle' },
  { name: 'sensors', what: 'motion-sensor cross-check: genuine drive vs. spoofed motion' },
  { name: 'status', what: 'GNSS status center (interference, satellite health, space weather) + orbit backup' },
  { name: 'receiver', what: 'predicted sky (CelesTrak) + mocked external receiver', network: true },
].filter((s) => (only.length ? only.includes(s.name) : !s.network || network))

if (!existsSync(ROOT + 'dist/index.html')) {
  console.error('dist/ missing: run `npm run build` first')
  process.exit(2)
}
spawnSync(process.execPath, [ROOT + 'tests/fixtures/generate.mjs'], { stdio: 'inherit' })
if (SUITES.some((s) => s.network)) {
  const g = spawnSync(
    process.execPath,
    ['--import', ROOT + 'tests/resolve-ts.mjs', ROOT + 'tests/e2e/gen-live-feed.mjs', '70'],
    { stdio: 'inherit' },
  )
  if (g.status) process.exit(g.status)
}

const up = () =>
  new Promise((r) =>
    request(BASE, { rejectUnauthorized: false }, (res) => {
      res.resume()
      r(res.statusCode === 200)
    })
      .on('error', () => r(false))
      .end(),
  )
// Reuse a preview server that is already running on the port (local development), else start one.
let ready = await up()
const server = ready
  ? null
  : spawn(
      process.execPath,
      [ROOT + 'node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
      { cwd: ROOT, stdio: 'ignore' },
    )
for (let i = 0; i < 60 && !ready; i++) {
  ready = await up()
  if (!ready) await new Promise((r) => setTimeout(r, 500))
}
if (!ready) {
  server?.kill()
  console.error('preview server did not start')
  process.exit(2)
}

const summary = []
for (const s of SUITES) {
  console.log(`\n=== ${s.name}: ${s.what}`)
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [ROOT + `tests/e2e/${s.name}.e2e.mjs`, BASE], {
    cwd: GEN + 'out',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const lines = out.split('\n')
  for (const line of lines) if (/^FAIL|passed$|^\S*Error:/.test(line)) console.log('  ' + line)
  const m = /(\d+)\/(\d+) passed/.exec(out)
  // On GitHub Actions, failures become annotations: visible on the run page (and its API) without opening logs.
  if (process.env.GITHUB_ACTIONS && r.status !== 0) {
    const esc = (t) => t.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 900)
    const fails = lines.filter((l) => /^FAIL/.test(l)).slice(0, 4)
    const crash = m
      ? ''
      : lines
          .filter((l) => l.trim())
          .slice(-12)
          .join('\n')
    for (const f of fails) console.log(`::error title=e2e ${s.name}::${esc(f)}`)
    if (crash) console.log(`::error title=e2e ${s.name} crashed::${esc(crash)}`)
  }
  summary.push({
    name: s.name,
    ok: r.status === 0,
    result: m ? `${m[1]}/${m[2]}` : 'crashed',
    s: Math.round((Date.now() - t0) / 1000),
  })
}
server?.kill()

console.log('\nSummary')
for (const s of summary)
  console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(12)} ${s.result.padStart(8)}  ${s.s}s`)
const failed = summary.filter((s) => !s.ok).length
console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed')
process.exit(failed ? 1 : 0)
