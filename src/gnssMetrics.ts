// GNSS quantities computed in more than one place (screens, report, analysis). One definition each,
// so the report and the screen always show the same number for the same moment.

import { satellitesOf, type LogFix, type Signal } from './logParser'

/**
 * Signal strength of an epoch: mean C/N0 of the 4 strongest satellites (dB-Hz), the usual
 * one-number summary (Android's GnssMetrics uses the same idea). Per satellite, its strongest
 * signal: a dual-frequency satellite counts once, not twice. null when nothing is tracked.
 */
export function top4Cn0(signals: Signal[]): number | null {
  const v = satellitesOf(signals)
    .map((s) => s.cn0 ?? 0)
    .filter((x) => x > 0)
    .sort((a, b) => b - a)
    .slice(0, 4)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

/** Fixes worth plotting and reporting: receiver (GPS/NMEA) first, fused (FLP) next, network (NLP) last. */
export function primaryFixes(fixes: LogFix[]): { provider: string | null; fixes: LogFix[] } {
  for (const p of ['GPS', 'NMEA', 'FLP']) {
    const f = fixes.filter((x) => x.provider === p)
    if (f.length) return { provider: p, fixes: f }
  }
  return { provider: fixes[0]?.provider ?? null, fixes }
}
