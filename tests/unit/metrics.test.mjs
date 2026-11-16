// Shared GNSS quantities: one definition, used by the screens, the report and the analysis.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { top4Cn0, primaryFixes } from '../../src/gnssMetrics.ts'
import { duration } from '../../src/format.ts'

const sig = (svid, band, cn0, sys = 'GPS') => ({ sys, svid, band, cn0, az: null, el: null, used: null })

test('top-4 C/N0: mean of the 4 strongest satellites', () => {
  assert.equal(
    top4Cn0([sig(1, 'L1', 40), sig(2, 'L1', 30), sig(3, 'L1', 20), sig(4, 'L1', 10), sig(5, 'L1', 50)]),
    (50 + 40 + 30 + 20) / 4,
  )
})

test('top-4 C/N0: a dual-frequency satellite counts once (its strongest signal)', () => {
  // Per signal this would be (45+44+30+29)/4 = 37; per satellite it is (45+30+20)/3 = 31.67.
  const v = top4Cn0([sig(1, 'L1', 45), sig(1, 'L5', 44), sig(2, 'L1', 30), sig(2, 'L5', 29), sig(3, 'L1', 20)])
  assert.ok(Math.abs(v - (45 + 30 + 20) / 3) < 1e-9, String(v))
})

test('top-4 C/N0: nothing tracked → null', () => {
  assert.equal(top4Cn0([]), null)
  assert.equal(top4Cn0([sig(1, 'L1', 0), sig(2, 'L1', null)]), null)
})

test('primary fixes: GPS, then NMEA, then FLP, network last', () => {
  const f = (provider) => ({ t: 0, lat: 0, lon: 0, alt: null, acc: null, speed: null, heading: null, provider })
  assert.equal(primaryFixes([f('NLP'), f('FLP'), f('GPS')]).provider, 'GPS')
  assert.equal(primaryFixes([f('NLP'), f('FLP')]).provider, 'FLP')
  assert.equal(primaryFixes([f('NLP')]).provider, 'NLP')
  assert.equal(primaryFixes([]).provider, null)
})

test('duration formatting', () => {
  assert.equal(duration(0), '0:00')
  assert.equal(duration(65), '1:05')
  assert.equal(duration(3725), '1:02:05')
})
