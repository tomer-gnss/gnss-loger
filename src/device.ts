// What kind of device/browser we're on, for platform-specific guidance.
// Nothing here is sent anywhere; it only picks which instructions to show.

/** iPhone / iPad (iPadOS reports itself as a Mac, but with touch). All iOS browsers are WebKit. */
export function isIOS() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function isAndroid() {
  return typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent)
}

/** Launched from a home-screen icon (no browser UI around the page). */
export function isStandalone() {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
}

/** Safari itself (not Chrome/Firefox/Edge for iOS, which can't add to the home screen the same way on older iOS). */
export function isIOSSafari() {
  if (!isIOS()) return false
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent)
}

const HINT_KEY = 'atlas.installHintDismissed'
export const installHintDismissed = () => { try { return localStorage.getItem(HINT_KEY) === '1' } catch { return false } }
export const dismissInstallHint = () => { try { localStorage.setItem(HINT_KEY, '1') } catch { /* storage blocked */ } }
