// Phone motion sensors (accelerometer + gyroscope) as an independent witness for GNSS.
//
// A spoofer controls what the GNSS receiver computes, but not how the phone physically moves.
// So: GNSS says "moving at 40 km/h" while the accelerometer says "lying perfectly still on a
// table" → strong evidence. GNSS says "turned 90°" while the gyroscope felt no rotation → same.
//
// Privacy: samples are reduced to one small summary per second, kept in memory only
// (last 20 minutes), never stored or sent. Nothing starts until the user opts in, and on
// iPhone Safari asks for permission separately.

import { useCallback, useEffect, useRef, useState } from 'react'

export type MotionSecond = {
  /** Start of the second, ms since epoch (same clock as Fix.wall). */
  t: number
  /** Standard deviation of linear acceleration magnitude, m/s². Still ≈ 0.02–0.08; walking ≈ 1–3. */
  accStd: number
  /** Rotation about the vertical axis during this second, degrees (sign not reliable across devices). */
  yawDeg: number
  samples: number
}

export type MotionState = 'off' | 'requesting' | 'active' | 'denied' | 'unsupported' | 'no-data'

const KEEP_SECONDS = 20 * 60

type DeviceMotionEventIOS = typeof DeviceMotionEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }

export function useMotion() {
  const supported = typeof window !== 'undefined' && 'DeviceMotionEvent' in window
  const [state, setState] = useState<MotionState>(supported ? 'off' : 'unsupported')
  const [seconds, setSeconds] = useState<MotionSecond[]>([])
  const store = useRef<MotionSecond[]>([])
  const listener = useRef<((e: DeviceMotionEvent) => void) | null>(null)
  const watchdog = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (listener.current) window.removeEventListener('devicemotion', listener.current)
    listener.current = null
    if (watchdog.current !== null) window.clearTimeout(watchdog.current)
    watchdog.current = null
    setState((s) => (s === 'unsupported' || s === 'denied' ? s : 'off'))
  }, [])

  const start = useCallback(async () => {
    if (!supported || listener.current) return
    setState('requesting')
    // iOS 13+: must be called directly from the tap that triggered start().
    const DME = DeviceMotionEvent as DeviceMotionEventIOS
    if (typeof DME.requestPermission === 'function') {
      try {
        if ((await DME.requestPermission()) !== 'granted') { setState('denied'); return }
      } catch { setState('denied'); return }
    }

    // Per-second accumulator (an object, so the event handler mutates fields rather than rebinding).
    const s = { bucket: -1, n: 0, sum: 0, sumSq: 0, yaw: 0, gx: 0, gy: 0, gz: 0, gInit: false, lastTs: 0 }

    const flush = () => {
      if (s.bucket < 0 || s.n === 0) return
      const m = s.sum / s.n
      const sec: MotionSecond = { t: s.bucket * 1000, accStd: Math.sqrt(Math.max(0, s.sumSq / s.n - m * m)), yawDeg: s.yaw, samples: s.n }
      store.current.push(sec)
      if (store.current.length > KEEP_SECONDS) store.current.splice(0, store.current.length - KEEP_SECONDS)
      setSeconds(store.current.slice())
    }

    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity
      if (!a || a.x === null || a.y === null || a.z === null) return
      const now = Date.now()
      const k = Math.floor(now / 1000)
      if (k !== s.bucket) { flush(); s.bucket = k; s.n = 0; s.sum = 0; s.sumSq = 0; s.yaw = 0 }

      // Gravity by low-pass filter; linear acceleration = total − gravity.
      if (!s.gInit) { s.gx = a.x; s.gy = a.y; s.gz = a.z; s.gInit = true }
      s.gx = s.gx * 0.9 + a.x * 0.1; s.gy = s.gy * 0.9 + a.y * 0.1; s.gz = s.gz * 0.9 + a.z * 0.1
      const lin = e.acceleration && e.acceleration.x !== null && e.acceleration.y !== null && e.acceleration.z !== null
        ? e.acceleration as { x: number; y: number; z: number }
        : { x: a.x - s.gx, y: a.y - s.gy, z: a.z - s.gz }
      const mag = Math.hypot(lin.x, lin.y, lin.z)
      if (Number.isFinite(mag)) { s.n++; s.sum += mag; s.sumSq += mag * mag }

      // Rotation about the vertical: project the gyro vector (device frame) onto gravity.
      const r = e.rotationRate
      const dt = s.lastTs ? Math.min(0.2, (now - s.lastTs) / 1000) : (e.interval || 16) / 1000
      s.lastTs = now
      const gNorm = Math.hypot(s.gx, s.gy, s.gz)
      if (r && r.alpha !== null && r.beta !== null && r.gamma !== null && gNorm > 1) {
        // rotationRate: beta = about x, gamma = about y, alpha = about z (deg/s)
        const yawRate = (r.beta * s.gx + r.gamma * s.gy + r.alpha * s.gz) / gNorm
        if (Number.isFinite(yawRate)) s.yaw += yawRate * dt
      }
      if (watchdog.current !== null) { window.clearTimeout(watchdog.current); watchdog.current = null; setState('active') }
    }

    listener.current = onMotion
    window.addEventListener('devicemotion', onMotion)
    // Desktops expose the API but never fire events.
    watchdog.current = window.setTimeout(() => {
      watchdog.current = null
      if (listener.current) window.removeEventListener('devicemotion', listener.current)
      listener.current = null
      setState('no-data')
    }, 3000)
  }, [supported])

  const clear = useCallback(() => { store.current = []; setSeconds([]) }, [])

  useEffect(() => () => {
    if (listener.current) window.removeEventListener('devicemotion', listener.current)
    if (watchdog.current !== null) window.clearTimeout(watchdog.current)
  }, [])

  return { state, seconds, start, stop, clear, supported }
}
