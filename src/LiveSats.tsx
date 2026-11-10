// Live satellites in the "live" tab:
//  A. Predicted: where every GNSS satellite is in the sky above you right now, from public orbits
//     (opt-in download from CelesTrak; works on any phone, including iPhone). Not a measurement.
//  B. External receiver over Web Serial (Bluetooth/USB, Chrome on Android/desktop): real measured
//     satellites, C/N0, sky plot with predicted positions overlaid, and its own integrity analysis
//     including the sky-consistency check (reported sky vs. real orbits).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bluetooth, Orbit, Plug, Unplug } from 'lucide-react'
import { SYS_ORDER, type Epoch, type Signal, type Sys } from './logParser'
import type { OrbitSat } from './orbits'
import type { PredictedSat } from './skyMath'
import { useSerialReceiver } from './serialReceiver'
import { SkyPlot } from './SkyPlot'
import { ConstellationChart, Cn0Heatmap } from './SatCharts'
import { IntegrityPanel } from './IntegrityPanel'
import { ErrorBoundary } from './ErrorBoundary'
import { analyzeLog } from './integrity'
import { SYS_COLOR } from './colors'
import { isIOS } from './device'

const CONSENT = 'atlas.orbitsConsent'
const MASK = 10 // degrees: satellites lower than this are usually blocked by terrain/buildings
const clock = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour12: false })
/** Receiver-vs-phone clock offset: seconds when small, h:mm when a replay/time-shift puts it far off. */
const fmtOffset = (ms: number) => { const s = ms / 1000; if (Math.abs(s) < 60) return `${s.toFixed(1)} s`; const a = Math.abs(s), h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60); return `${s < 0 ? '−' : '+'}${h}h ${String(m).padStart(2, '0')}m` }
const readConsent = () => { try { return sessionStorage.getItem(CONSENT) === '1' } catch { return false } }

/** Predicted satellites shaped like measured signals, so the same charts can draw them. */
const asSignals = (pred: PredictedSat[]): Signal[] => pred.filter((p) => p.el >= 0).map((p) => ({ sys: p.sys, svid: p.svid, name: p.name, band: null, cn0: 1, az: p.az, el: p.el, used: null }))

function CountChips({ pred }: { pred: PredictedSat[] }) {
  const counts: Partial<Record<Sys, number>> = {}
  for (const p of pred) if (p.el >= MASK) counts[p.sys] = (counts[p.sys] ?? 0) + 1
  const systems = SYS_ORDER.filter((s) => counts[s])
  const total = systems.reduce((a, s) => a + counts[s]!, 0)
  return (
    <div className="summary-chips">
      {systems.map((s) => <span key={s} className="chip"><i style={{ background: SYS_COLOR[s].light }} />{s} <b dir="ltr">{counts[s]}</b></span>)}
      <span className="chip on">סה״כ מעל {MASK}° <b dir="ltr">{total}</b></span>
    </div>
  )
}

export function LiveSats({ phonePos }: { phonePos: { lat: number; lon: number; alt: number | null } | null }) {
  // ---------- A. predicted ----------
  const [consent, setConsent] = useState(readConsent)
  // The SGP4 module (and its library) is downloaded only after the user opts in.
  const [orbits, setOrbits] = useState<{ sats: OrbitSat[]; fetchedAt: number; lookAngles: typeof import('./orbits').lookAngles } | null>(null)
  const [orbitErr, setOrbitErr] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const history = useRef<Epoch[]>([])

  useEffect(() => {
    if (!consent || orbits) return
    let cancelled = false
    import('./orbits').then((m) => m.loadOrbits().then((o) => ({ ...o, lookAngles: m.lookAngles }))).then((o) => { if (!cancelled) setOrbits(o) }).catch((e) => { if (!cancelled) setOrbitErr(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [consent, orbits])
  useEffect(() => {
    if (!orbits) return
    const id = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [orbits])

  // ---------- B. external receiver ----------
  const rx = useSerialReceiver()
  const [baud, setBaud] = useState(9600)
  const rxFix = rx.data.fixes[rx.data.fixes.length - 1] ?? null
  const rxEpoch = rx.data.epochs[rx.data.epochs.length - 1] ?? null

  // Where to predict the sky for: the external receiver's position if connected, else the phone's.
  const ref = rx.state === 'connected' && rxFix ? { lat: rxFix.lat, lon: rxFix.lon, alt: rxFix.alt } : phonePos
  const pred = useMemo(() => (orbits && ref ? orbits.lookAngles(orbits.sats, ref.lat, ref.lon, ref.alt ?? 0, now) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orbits, now, ref?.lat.toFixed(3), ref?.lon.toFixed(3)])

  // Session history of predicted visible counts, one point per 5 s, for the stacked chart.
  const [hist, setHist] = useState<Epoch[]>([])
  useEffect(() => {
    if (!pred) return
    history.current = [...history.current.slice(-720), { t: now, signals: asSignals(pred.filter((p) => p.el >= MASK)) }]
    setHist(history.current)
  }, [pred, now])

  // Receiver integrity, including sky consistency (reported vs. predicted) when orbits are loaded.
  const rxReport = useMemo(() => {
    if (rx.state !== 'connected' && !rx.data.epochs.length) return null
    const predictAt = orbits ? (e: Epoch, f: { lat: number; lon: number; alt: number | null } | null) => {
      const p = f ?? phonePos
      // Live: predict for the phone's own clock, so a receiver that was fed a shifted time shows up.
      return p ? orbits.lookAngles(orbits.sats, p.lat, p.lon, p.alt ?? 0, Date.now() - (rxEpoch ? rxEpoch.t - e.t : 0)) : null
    } : undefined
    return analyzeLog(rx.data.fixes, rx.data.epochs, [], { predictAt, rxTimeOffsetMs: rx.timeOffsetMs, localTime: true })
    // Recompute every ~5 epochs, not on every byte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(rx.data.epochs.length / 5), rx.state, orbits, rx.timeOffsetMs])

  return (
    <section className="panel live-sats">
      <div className="panel-heading"><div><h2>לוויינים בזמן אמת</h2><p>הדפדפן לא חושף את נתוני הלוויינים של מקלט הטלפון. כאן אפשר לראות איפה הלוויינים נמצאים מעליך עכשיו, או לחבר מקלט חיצוני ולראות מה הוא קולט בפועל.</p></div></div>

      {/* ---------- A. predicted ---------- */}
      <article className="live-sats-card">
        <h3><Orbit size={18} /> לוויינים מעליך עכשיו <span className="tag">חזוי</span></h3>
        {!consent ? <div className="map-consent">
          <p>מחושב מהמסלולים הציבוריים של כל לווייני ה-GNSS בעולם. ההורדה מ-<b>CelesTrak</b> כוללת את כל הלוויינים בבת אחת, ו<b>המיקום שלך לא נשלח</b>. החישוב נעשה בטלפון. הנתונים נשמרים בטלפון ל-6 שעות.</p>
          <button className="primary-button" onClick={() => { try { sessionStorage.setItem(CONSENT, '1') } catch { /* blocked */ } setConsent(true) }}>הצג לוויינים חזויים</button>
        </div>
          : orbitErr ? <p className="error-text">{orbitErr}</p>
          : !orbits ? <p className="muted">מוריד מסלולי לוויינים…</p>
          : !ref ? <p className="muted">הפעל מעקב (או חבר מקלט) כדי לחשב את השמיים מעל המיקום שלך.</p>
          : pred && <>
            <CountChips pred={pred} />
            <div className="sky-panel"><SkyPlot signals={asSignals(pred)} emptyText="אין לוויינים מעל האופק" />
              <div className="constellation-legend">{SYS_ORDER.filter((s) => pred.some((p) => p.sys === s && p.el >= 0)).map((s) => <span key={s}><i style={{ backgroundColor: SYS_COLOR[s].dark }} />{s}</span>)}</div>
            </div>
            <p className="muted source-note">חזוי מהמסלולים, לא מדידה של המקלט. מקור: CelesTrak, עודכן ב-{clock(orbits.fetchedAt)}. מוצגים כל הלוויינים מעל האופק. במספרים נספרים רק אלה שמעל {MASK}°.</p>
            {hist.length >= 3 && <>
              <h4>לוויינים מעל {MASK}° לאורך הסשן (חזוי)</h4>
              <ErrorBoundary label="הגרף"><ConstellationChart epochs={hist} fmtTime={clock} /></ErrorBoundary>
            </>}
          </>}
      </article>

      {/* ---------- B. external receiver ---------- */}
      <article className="live-sats-card">
        <h3><Bluetooth size={18} /> מקלט GNSS חיצוני <span className="tag measured">נמדד</span></h3>
        {rx.state === 'unsupported' ? <p className="muted">
          {isIOS() ? 'באייפון אין לדפדפנים אפשרות להתחבר למקלט חיצוני (Apple לא תומכת ב-Web Serial).' : 'הדפדפן הזה לא תומך בחיבור למקלט. צריך Chrome לאנדרואיד בגרסה 138 ומעלה (Bluetooth), או Chrome/Edge במחשב (USB).'}
        </p> : rx.state !== 'connected' ? <>
          <p className="muted">מקלט שמוציא NMEA (u-blox, Bad Elf, Garmin GLO ועוד). ב-Bluetooth: קודם צריך לצמד אותו בהגדרות הטלפון. הנתונים נשארים בדף ולא נשלחים לשום מקום.</p>
          <div className="rx-connect">
            <label>קצב (baud)
              <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
                {[4800, 9600, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <button className="primary-button" onClick={() => void rx.connect(baud)} disabled={rx.state === 'connecting'}><Plug size={18} /> {rx.state === 'connecting' ? 'מתחבר…' : 'חבר מקלט'}</button>
          </div>
          {rx.error && <p className="error-text">{rx.error}</p>}
          {rx.data.epochs.length > 0 && <p className="muted">החיבור הקודם הסתיים. הנתונים שנקלטו עדיין מוצגים למטה.</p>}
        </> : <div className="rx-status">
          <span className="live-dot-inline" /> מחובר ({rx.info}) · <b dir="ltr">{rx.data.lines}</b> שורות · {rx.data.badLines} פגומות
          {rxEpoch && <> · אפוק אחרון {clock(rxEpoch.t)}</>}
          {rx.timeOffsetMs !== null && <> · שעון המקלט מול הטלפון <b dir="ltr">{fmtOffset(rx.timeOffsetMs)}</b></>}
          <button className="text-button" onClick={() => void rx.disconnect()}><Unplug size={16} /> נתק</button>
        </div>}

        {rx.data.epochs.length > 0 && <>
          <div className="sky-panel"><SkyPlot signals={rxEpoch?.signals ?? []} ghosts={pred ?? []} emptyText="ממתין לנתוני לוויינים מהמקלט" />
            <div className="constellation-legend"><span><i className="ghost-dot" />עיגול מקווקו = איפה הלוויין אמור להיות לפי המסלול</span></div>
          </div>
          <ErrorBoundary label="הגרף"><ConstellationChart epochs={rx.data.epochs} fmtTime={clock} /></ErrorBoundary>
          <ErrorBoundary label="מפת החום"><Cn0Heatmap epochs={rx.data.epochs} fmtTime={clock} /></ErrorBoundary>
          {rxReport && <ErrorBoundary label="ניטור המקלט"><h4>שלמות האות במקלט החיצוני</h4><IntegrityPanel report={rxReport} minPoints={10} points={Math.max(rx.data.fixes.length, rx.data.epochs.length)} fmtTime={clock} /></ErrorBoundary>}
        </>}
      </article>
    </section>
  )
}
