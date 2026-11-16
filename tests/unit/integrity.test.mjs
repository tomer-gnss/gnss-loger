// The integrity engine on real logs and on attacks built from them (tests/fixtures/generate.mjs).
// Genuine logs must stay clean (no false alarms); every engineered attack must be caught by the
// check designed for it. If a threshold change breaks one of these, recalibrate deliberately.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LogParser } from '../../src/logParser.ts'
import { analyzeLog } from '../../src/integrity'

const GEN = new URL('../.generated/', import.meta.url)
function analyze(path) {
  const p = new LogParser(path)
  for (const line of readFileSync(new URL(path, GEN), 'utf8').split('\n')) p.push(line)
  const log = p.finish()
  return analyzeLog(log.fixes, log.epochs, log.clock)
}
const ids = (r) => r.findings.map((f) => f.id)

for (const genuine of [
  'samples/ublox.nmea',
  'samples/epoch10.txt',
  'samples/pr2016.txt',
  'samples/gpstest_synth.txt',
]) {
  test(`genuine: ${genuine} → ok, score 0`, () => {
    const r = analyze(genuine)
    assert.equal(r.verdict, 'ok')
    assert.equal(r.score, 0)
    assert.ok(
      r.findings.every((f) => f.severity === 'info'),
      ids(r).join(','),
    )
  })
}

const ATTACKS = [
  ['attack/spoof-uniform-cn0.nmea', 'critical', 'cn0-uniform'],
  ['attack/spoof-teleport.nmea', 'critical', 'speed'],
  ['attack/spoof-frozen.nmea', 'critical', 'frozen'],
  ['attack/spoof-common-cn0.nmea', 'critical', 'cn0-correlation'],
  ['attack/jam-agc.txt', 'critical', 'agc'],
  ['attack/spoof-net-mismatch.txt', 'critical', 'gnss-vs-network'],
  ['attack/clock-pull.txt', 'critical', 'clock'],
  ['attack/clock-steps.txt', 'critical', 'clock'],
  ['attack/time-shift.txt', 'degraded', 'time-offset'],
]
for (const [file, verdict, id] of ATTACKS) {
  test(`attack: ${file} → ${verdict} via ${id}`, () => {
    const r = analyze(file)
    assert.equal(r.verdict, verdict, ids(r).join(','))
    assert.ok(ids(r).includes(id), `expected ${id}, got ${ids(r).join(',')}`)
    assert.ok(
      r.timeline.some((p) => p.v > 0),
      'suspicion timeline shows when it happened',
    )
  })
}

// Known gap, kept visible: a slow (2-minute) dip of every satellite together is not flagged yet.
// The GNSS-vs-cellular comparison catches it when a cellular log is loaded. Flip this test when
// the engine learns it.
test('known gap: slow all-satellite dip (jam-stripe) is not flagged by the engine', () => {
  assert.equal(analyze('attack/jam-stripe.nmea').verdict, 'ok')
})
