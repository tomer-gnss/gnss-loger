// Shared time axis for the stacked charts in the Plots tab: same ticks, same x mapping, so a
// moment on the C/N0 chart lines up with the same moment on the cellular chart.

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]

/** Chart margins shared by every time chart in the tab (the y labels fit in `left`). */
export const TIME_MARGIN = { left: 32, right: 10 }

/** Tick positions in elapsed seconds since t0, for a plot `w` px wide showing [tFrom, tTo]. */
export function timeTicks(t0: number, tFrom: number, tTo: number, w: number) {
  const span = Math.max(1000, tTo - tFrom)
  const maxTicks = Math.max(2, Math.floor(w / 64))
  const spanS = span / 1000
  const step = TICK_STEPS.find((s) => spanS / s <= maxTicks) ?? Math.ceil(spanS / maxTicks / 3600) * 3600
  const ticks: number[] = []
  for (let s = Math.ceil((tFrom - t0) / 1000 / step) * step; s <= (tTo - t0) / 1000 + 1e-6; s += step) ticks.push(s)
  return ticks
}

/** Index of the last element with t <= target (binary search); -1 if none. */
export function lastAtOrBefore(arr: { t: number }[], target: number) {
  let lo = 0, hi = arr.length - 1, ans = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= target) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
  return ans
}

/** A highlighted time range drawn behind the lines (GNSS-vs-cellular events). */
export type TimeBand = { t0: number; t1: number; tone: 'alert' | 'neutral' }
export const BAND_FILL = { alert: 'rgba(179, 38, 30, 0.10)', neutral: 'rgba(95, 109, 101, 0.12)' }
