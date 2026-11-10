import { useCallback, useEffect, useRef, useState } from 'react'

export type Fix = {
  /** Receive time (ms since epoch) — when the browser handed us the fix. */
  wall: number
  /** Monotonic receive time, used for update-rate math. */
  recv: number
  lat: number
  lon: number
  /** Horizontal accuracy radius, metres (95% per spec, but device dependent). */
  acc: number
  alt: number | null
  altAcc: number | null
  /** m/s */
  speed: number | null
  /** degrees clockwise from true north */
  heading: number | null
}

export type GeoStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'waiting' // watch is running but the last attempt timed out / had no fix
  | 'denied'
  | 'unsupported'
  | 'insecure'

const HISTORY = 600 // ~10 minutes at 1 Hz kept in memory for charts
const SESSION_CAP = 200_000

/** A stretch of time with no tracking because the page was in the background / screen locked. */
export type Gap = { from: number; to: number }

/** Sanitise one browser value: iOS (CoreLocation) uses −1 for "unknown" speed/heading/accuracy. */
const finite = (v: number | null, min = 0) => (v !== null && Number.isFinite(v) && v >= min ? v : null)

export function useGeolocation() {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator
  const secure = typeof window !== 'undefined' && window.isSecureContext
  const initial: GeoStatus = !supported ? 'unsupported' : !secure ? 'insecure' : 'idle'

  const [status, setStatus] = useState<GeoStatus>(initial)
  const [message, setMessage] = useState<string | null>(null)
  const [fixes, setFixes] = useState<Fix[]>([])
  const [gaps, setGaps] = useState<Gap[]>([])
  const watchId = useRef<number | null>(null)
  const session = useRef<Fix[]>([])
  const wanted = useRef(false) // the user pressed start and hasn't pressed stop
  const lastFixAt = useRef(0)

  const clearWatch = () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
    watchId.current = null
  }

  const beginWatch = useCallback(() => {
    clearWatch()
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords
        const acc = finite(c.accuracy)
        if (acc === null || acc === 0 || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return
        const fix: Fix = {
          wall: Date.now(),
          recv: performance.now(),
          lat: c.latitude,
          lon: c.longitude,
          acc,
          alt: c.altitude !== null && Number.isFinite(c.altitude) ? c.altitude : null,
          altAcc: finite(c.altitudeAccuracy),
          speed: finite(c.speed),
          heading: finite(c.heading) !== null && c.heading! <= 360 ? c.heading : null,
        }
        lastFixAt.current = fix.wall
        if (session.current.length < SESSION_CAP) session.current.push(fix)
        setFixes((prev) => {
          const next = prev.length >= HISTORY ? prev.slice(prev.length - HISTORY + 1) : prev.slice()
          next.push(fix)
          return next
        })
        setStatus('active')
        setMessage(null)
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          wanted.current = false
          clearWatch()
          setStatus('denied')
        } else {
          // POSITION_UNAVAILABLE / TIMEOUT: the watch keeps running, we just have no fresh fix.
          setStatus('waiting')
        }
        setMessage(err.message || null)
      },
      // maximumAge 0 = never hand back a cached position; every callback is a fresh fix.
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    )
  }, [])

  const stop = useCallback(() => {
    wanted.current = false
    clearWatch()
    setStatus((s) => (s === 'denied' || s === 'unsupported' || s === 'insecure' ? s : 'idle'))
  }, [])

  const start = useCallback(() => {
    if (!supported || !secure || watchId.current !== null) return
    wanted.current = true
    setStatus('requesting')
    setMessage(null)
    beginWatch()
  }, [secure, supported, beginWatch])

  // iOS (and mobile browsers generally) give web pages no location while the screen is locked or
  // the page is in the background. Record those gaps so they're visible and not mistaken for a
  // receiver problem, and restart the watch if it doesn't come back by itself on return.
  useEffect(() => {
    const v: { hiddenAt: number | null; resumeCheck: number | null } = { hiddenAt: null, resumeCheck: null }
    const onVisibility = () => {
      if (!wanted.current) return
      if (document.visibilityState === 'hidden') { v.hiddenAt = Date.now(); return }
      const from = v.hiddenAt ?? lastFixAt.current
      v.hiddenAt = null
      if (from && Date.now() - from > 2000) setGaps((g) => [...g.slice(-49), { from, to: Date.now() }])
      if (v.resumeCheck !== null) window.clearTimeout(v.resumeCheck)
      const backAt = Date.now()
      v.resumeCheck = window.setTimeout(() => {
        v.resumeCheck = null
        if (wanted.current && lastFixAt.current < backAt) beginWatch()
      }, 6000)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (v.resumeCheck !== null) window.clearTimeout(v.resumeCheck)
    }
  }, [beginWatch])

  const clear = useCallback(() => {
    session.current = []
    setFixes([])
    setGaps([])
  }, [])

  useEffect(() => () => clearWatch(), [])

  const running = status === 'active' || status === 'waiting' || status === 'requesting'
  return { status, message, fixes, gaps, session, start, stop, clear, running }
}

/**
 * iOS "Precise Location" off (or Android approximate permission): the browser returns a
 * deliberately coarse position, typically 1–10 km uncertainty. Nothing GNSS-related is
 * meaningful then, so the UI should say so instead of grading the receiver.
 */
export function isApproximate(fixes: Fix[]) {
  const recent = fixes.slice(-5)
  return recent.length >= 3 && recent.every((f) => f.acc >= 1000)
}

/** Keeps the screen on while `enabled` (re-acquires after the tab becomes visible again). */
export function useWakeLock(enabled: boolean) {
  const [held, setHeld] = useState(false)
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  useEffect(() => {
    if (!enabled || !supported) return
    const lock: { sentinel: WakeLockSentinel | null; cancelled: boolean } = { sentinel: null, cancelled: false }
    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (lock.cancelled) { void sentinel.release(); return }
        lock.sentinel = sentinel
        setHeld(true)
        sentinel.addEventListener('release', () => setHeld(false))
      } catch {
        setHeld(false)
      }
    }
    // The OS drops the lock whenever the tab is hidden; take it again when the user comes back.
    const onVisible = () => { if (document.visibilityState === 'visible' && (lock.sentinel === null || lock.sentinel.released)) void acquire() }
    void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      lock.cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock.sentinel?.release()
      setHeld(false)
    }
  }, [enabled, supported])
  return { supported, held }
}

const R = 6371008.8
const rad = Math.PI / 180

/** Local east/north metres of each fix relative to a reference point. */
export function toLocal(fixes: { lat: number; lon: number }[], lat0: number, lon0: number) {
  const k = Math.cos(lat0 * rad)
  return fixes.map((f) => ({ e: (f.lon - lon0) * rad * R * k, n: (f.lat - lat0) * rad * R }))
}

export function stats(fixes: Fix[]) {
  const last = fixes[fixes.length - 1]
  // Update rate from the last 10 receive intervals.
  const recent = fixes.slice(-11)
  const intervals: number[] = []
  for (let i = 1; i < recent.length; i++) intervals.push(recent[i].recv - recent[i - 1].recv)
  const meanInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null
  const hz = meanInterval ? 1000 / meanInterval : null

  // Spread of the last 60 fixes around their mean (RMS horizontal distance).
  const win = fixes.slice(-60)
  let rms: number | null = null
  let lat0 = last?.lat ?? 0
  let lon0 = last?.lon ?? 0
  if (win.length >= 2) {
    lat0 = win.reduce((a, f) => a + f.lat, 0) / win.length
    lon0 = win.reduce((a, f) => a + f.lon, 0) / win.length
    const pts = toLocal(win, lat0, lon0)
    rms = Math.sqrt(pts.reduce((a, p) => a + p.e * p.e + p.n * p.n, 0) / pts.length)
  }

  const allIntervals: number[] = []
  for (let i = 1; i < fixes.length; i++) allIntervals.push(fixes[i].recv - fixes[i - 1].recv)

  return { last, hz, meanInterval, rms, intervals: allIntervals, center: { lat: lat0, lon: lon0 } }
}

export type AccuracyGrade = { key: 'good' | 'warning' | 'serious' | 'critical'; label: string }

export function gradeAccuracy(acc: number): AccuracyGrade {
  if (acc <= 5) return { key: 'good', label: 'מצוין' }
  if (acc <= 15) return { key: 'warning', label: 'סביר' }
  if (acc <= 50) return { key: 'serious', label: 'חלש' }
  return { key: 'critical', label: 'גס מאוד' }
}

export function toCsv(fixes: Fix[]) {
  const head = 'time_iso,lat,lon,accuracy_m,altitude_m,altitude_accuracy_m,speed_mps,heading_deg'
  const n = (v: number | null, d = 2) => (v === null ? '' : v.toFixed(d))
  const rows = fixes.map((f) => [new Date(f.wall).toISOString(), f.lat.toFixed(8), f.lon.toFixed(8), n(f.acc), n(f.alt), n(f.altAcc), n(f.speed), n(f.heading, 1)].join(','))
  return [head, ...rows].join('\n')
}
