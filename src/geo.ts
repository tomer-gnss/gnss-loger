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

export function useGeolocation() {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator
  const secure = typeof window !== 'undefined' && window.isSecureContext
  const initial: GeoStatus = !supported ? 'unsupported' : !secure ? 'insecure' : 'idle'

  const [status, setStatus] = useState<GeoStatus>(initial)
  const [message, setMessage] = useState<string | null>(null)
  const [fixes, setFixes] = useState<Fix[]>([])
  const watchId = useRef<number | null>(null)
  const session = useRef<Fix[]>([])

  const stop = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
    watchId.current = null
    setStatus((s) => (s === 'denied' || s === 'unsupported' || s === 'insecure' ? s : 'idle'))
  }, [])

  const start = useCallback(() => {
    if (!supported || !secure || watchId.current !== null) return
    setStatus('requesting')
    setMessage(null)
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords
        const fix: Fix = {
          wall: Date.now(),
          recv: performance.now(),
          lat: c.latitude,
          lon: c.longitude,
          acc: c.accuracy,
          alt: c.altitude,
          altAcc: c.altitudeAccuracy,
          speed: c.speed !== null && Number.isFinite(c.speed) ? c.speed : null,
          heading: c.heading !== null && Number.isFinite(c.heading) ? c.heading : null,
        }
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
          if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
          watchId.current = null
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
  }, [secure, supported])

  const clear = useCallback(() => {
    session.current = []
    setFixes([])
  }, [])

  useEffect(() => () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
  }, [])

  const running = status === 'active' || status === 'waiting' || status === 'requesting'
  return { status, message, fixes, session, start, stop, clear, running }
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
