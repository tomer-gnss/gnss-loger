import { useState } from 'react'
import { parseLogFile, type ParsedLog } from './logParser'

/** Public sample (Apache-2.0), pinned to a commit. Also whitelisted in the CSP connect-src. */
export const SAMPLE_URL = 'https://raw.githubusercontent.com/google/gps-measurement-tools/a1667c44a7b46a4ee116f5e3d6c8d464c66fe6c5/NmeaUtils/example/MTV.Local1.ublox-F9K.20200206-181434.nmea'

/** Load a log file (or the sample) into the shared log state. The file is read only in this page. */
export function useLogLoader(setLog: (l: ParsedLog) => void) {
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (file: File) => {
    setError(null); setBusy(0)
    try {
      const parsed = await parseLogFile(file, (f) => setBusy(f))
      if (!parsed.epochs.length && !parsed.fixes.length) throw new Error('לא נמצאו בקובץ רשומות GNSS מוכרות (Status / Fix / Raw / NMEA).')
      setLog(parsed)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  const loadSample = async () => {
    setError(null); setBusy(0)
    try {
      const res = await fetch(SAMPLE_URL)
      if (!res.ok) throw new Error(`הורדת הדוגמה נכשלה (${res.status})`)
      const blob = await res.blob()
      await load(new File([blob], 'ublox-F9K-sample.nmea'))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(null) }
  }

  return { busy, error, load, loadSample }
}
