// Display formatting shared by every screen and the report. Times from the phone's own location
// API are shown in the phone's time zone; times from log files in UTC (what the logs record).

const TIME: Intl.DateTimeFormatOptions = { hour12: false }
const UTC: Intl.DateTimeFormatOptions = { hour12: false, timeZone: 'UTC' }

/** 14:03:22 in this device's time zone. */
export const timeLocal = (t: number) => new Date(t).toLocaleTimeString('he-IL', TIME)
/** 14:03:22 in UTC. */
export const timeUtc = (t: number) => new Date(t).toLocaleTimeString('he-IL', UTC)
/** 16.11.2026, 14:03:22 in this device's time zone. */
export const dateTimeLocal = (t: number) => new Date(t).toLocaleString('he-IL', TIME)
/** 16.11.2026, 14:03:22 in UTC. */
export const dateTimeUtc = (t: number) => new Date(t).toLocaleString('he-IL', UTC)
/** 16.11.2026 in UTC. */
export const dateUtc = (t: number) => new Date(t).toLocaleDateString('he-IL', { timeZone: 'UTC' })

/** Duration in seconds → "m:ss", or "h:mm:ss" from one hour. */
export function duration(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

const CARDINALS = ['צפון', 'צפון־מזרח', 'מזרח', 'דרום־מזרח', 'דרום', 'דרום־מערב', 'מערב', 'צפון־מערב']
/** Compass direction in Hebrew (8 points) for a bearing in degrees. */
export const cardinal = (deg: number) => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
