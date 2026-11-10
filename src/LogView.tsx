import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { ChevronDown, FileText, FolderOpen, Gauge, Pause, Play, RotateCcw, Satellite, Upload } from 'lucide-react'
import { parseLogFile, satellitesOf, satLabel, SYS_ORDER, type LogFix, type ParsedLog, type Signal, type Sys } from './logParser'
import { TimeChart } from './LiveCharts'
import { MapView } from './MapView'
import { ErrorBoundary } from './ErrorBoundary'
import { analyzeLog } from './integrity'
import { IntegrityPanel } from './IntegrityPanel'
import { SYS_COLOR } from './colors'
import { ConstellationChart, Cn0Heatmap } from './SatCharts'
import { SkyPlot } from './SkyPlot'

const SAMPLE_URL = 'https://raw.githubusercontent.com/google/gps-measurement-tools/a1667c44a7b46a4ee116f5e3d6c8d464c66fe6c5/NmeaUtils/example/MTV.Local1.ublox-F9K.20200206-181434.nmea'
const SOURCE_TEXT = {
  Status: 'GnssStatus: אזימוט, גובה, C/N₀ ושימוש בפתרון לכל לוויין',
  NMEA: 'NMEA (GSV/GSA): אזימוט, גובה, C/N₀ ושימוש בפתרון',
  Raw: 'מדידות Raw: C/N₀ לכל אות. מיקום בשמיים רק אם המכשיר מדווח מיקום לוויין',
}

const clock = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour12: false, timeZone: 'UTC' })
const dateStr = (t: number) => new Date(t).toLocaleDateString('he-IL', { timeZone: 'UTC' })
const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
const Num = ({ children }: { children: ReactNode }) => <bdi dir="ltr" className="num">{children}</bdi>

/** Fixes worth plotting: receiver (GPS/NMEA) first, fused (FLP) next; network (NLP) only as a last resort. */
function pickFixes(fixes: LogFix[]) {
  for (const p of ['GPS', 'NMEA', 'FLP']) {
    const f = fixes.filter((x) => x.provider === p)
    if (f.length) return { provider: p, fixes: f }
  }
  return { provider: fixes[0]?.provider ?? null, fixes }
}

/** Index of the last element with t <= target (binary search). */
function indexAt<T extends { t: number }>(arr: T[], target: number) {
  let lo = 0, hi = arr.length - 1, ans = 0
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= target) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
  return ans
}

const top4 = (sigs: Signal[]) => {
  const v = satellitesOf(sigs).map((s) => s.cn0 ?? 0).filter((x) => x > 0).sort((a, b) => b - a).slice(0, 4)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0
}


function Help() {
  const [open, setOpen] = useState(false)
  return (
    <div className="help">
      <button className="help-toggle" onClick={() => setOpen(!open)} aria-expanded={open}><span>איך מקליטים לוג?</span><ChevronDown size={18} className={open ? 'flip' : ''} /></button>
      {open && <div className="help-body">
        <p><b>GPSTest</b> (Android, חינם): בהגדרות האפליקציה, בקטגוריית הרישום (Logging), הפעל רישום לקובץ CSV ו/או NMEA. הקלט כמה דקות בשמיים פתוחים, ואז שתף את הקובץ מהאפליקציה או העתק אותו לטלפון.</p>
        <p><b>GnssLogger</b> של Google: בלשונית Settings הפעל Status, Fix, Raw ו-NMEA. בלשונית Log לחץ Start Log, ובסיום Stop &amp; Send ושמור את הקובץ.</p>
        <p><b>מקלט חיצוני</b> (u-blox וכו׳): קובץ NMEA רגיל (‎.nmea / ‎.txt) נתמך.</p>
        <p className="muted">באייפון אין גישה לנתוני לוויינים, ולכן אין אפליקציה שמקליטה אותם.</p>
      </div>}
    </div>
  )
}

export function LogView() {
  const [log, setLog] = useState<ParsedLog | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(10)
  const [dragOver, setDragOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const load = async (file: File) => {
    setError(null); setBusy(0); setPlaying(false)
    try {
      const parsed = await parseLogFile(file, (f) => setBusy(f))
      if (!parsed.epochs.length && !parsed.fixes.length) throw new Error('לא נמצאו בקובץ רשומות GNSS מוכרות (Status / Fix / Raw / NMEA).')
      setLog(parsed); setIdx(0)
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

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) void load(f)
  }

  const epochs = useMemo(() => log?.epochs ?? [], [log])
  const { provider, fixes } = useMemo(() => pickFixes(log?.fixes ?? []), [log])
  // Logs with fixes only (no satellite records) still get a timeline.
  const timeline: { t: number }[] = useMemo(() => (epochs.length ? epochs : fixes), [epochs, fixes])
  const cur = timeline[Math.min(idx, timeline.length - 1)]
  const curT = cur?.t ?? 0
  const epoch = epochs.length ? epochs[Math.min(idx, epochs.length - 1)] : null
  const fixIdx = fixes.length ? indexAt(fixes, curT) : -1
  const fix = fixIdx >= 0 ? fixes[fixIdx] : null

  // Playback: advance through the log in (scaled) real time.
  const playT = useRef(0)
  useEffect(() => {
    if (!playing || !timeline.length) return
    playT.current = timeline[Math.min(idx, timeline.length - 1)].t
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now()
      playT.current += (now - last) * speed
      last = now
      const next = indexAt(timeline, playT.current)
      setIdx(next)
      if (next >= timeline.length - 1) setPlaying(false)
    }, 100)
    return () => window.clearInterval(id)
    // idx intentionally omitted: playback owns the playhead while running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, timeline])

  const series = useMemo(() => {
    const tracked = epochs.map((e) => ({ t: e.t, v: satellitesOf(e.signals).filter((s) => (s.cn0 ?? 0) > 0).length }))
    const cn0 = epochs.map((e) => ({ t: e.t, v: top4(e.signals) }))
    const acc = fixes.filter((f) => f.acc !== null).map((f) => ({ t: f.t, v: f.acc! }))
    const agc: { t: number; v: number }[] = []
    for (const e of epochs) {
      let sum = 0, n = 0
      for (const s of e.signals) if (s.agc !== null && s.agc !== undefined) { sum += s.agc; n++ }
      if (n) agc.push({ t: e.t, v: sum / n })
    }
    return { tracked, cn0, acc, agc }
  }, [epochs, fixes])

  const integrity = useMemo(() => (log ? analyzeLog(log.fixes, epochs, log.clock) : null), [log, epochs])
  // Timeline / finding "show this moment": stop playback and move the playhead there.
  const jumpTo = (t: number) => {
    setPlaying(false)
    setIdx(indexAt(timeline, t))
    document.querySelector('.epoch-head')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const summary = useMemo(() => {
    if (!log) return null
    const maxBySys: Partial<Record<Sys, number>> = {}
    for (const e of epochs) {
      const counts: Partial<Record<Sys, number>> = {}
      for (const s of satellitesOf(e.signals)) if ((s.cn0 ?? 0) > 0) counts[s.sys] = (counts[s.sys] ?? 0) + 1
      for (const k of Object.keys(counts) as Sys[]) maxBySys[k] = Math.max(maxBySys[k] ?? 0, counts[k]!)
    }
    const t0 = timeline[0]?.t ?? 0, t1 = timeline[timeline.length - 1]?.t ?? 0
    return { maxBySys, t0, t1 }
  }, [log, epochs, timeline])

  const mapCurrent = useMemo(() => (fix ? { lat: fix.lat, lon: fix.lon, acc: fix.acc } : null), [fix])

  if (!log) return (
    <>
      <section className={`drop-zone ${dragOver ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <FileText size={30} />
        <h2>ניתוח לוג GNSS</h2>
        <p>טען קובץ שהוקלט ב-GPSTest, ב-GnssLogger או ממקלט NMEA, וראה מפת שמיים ו-C/N₀ אמיתיים לכל לוויין. הקובץ נקרא רק בדפדפן ולא נשלח לשום מקום.</p>
        <input ref={input} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = '' }} />
        <button className="primary-button" onClick={() => input.current?.click()} disabled={busy !== null}><FolderOpen size={18} /> בחר קובץ לוג</button>
        <button className="link-button" onClick={loadSample} disabled={busy !== null}>או נסה קובץ לדוגמה (u-blox F9K, 29 דקות)</button>
        {busy !== null && <div className="progress"><span style={{ width: `${Math.round(busy * 100)}%` }} /></div>}
        {error && <p className="error-text">{error}</p>}
      </section>
      <Help />
    </>
  )

  const sats = epoch ? satellitesOf(epoch.signals) : []
  const trackedSats = sats.filter((s) => (s.cn0 ?? 0) > 0)
  const usedSats = sats.filter((s) => s.used)
  const signalRows = (epoch?.signals ?? []).filter((s) => (s.cn0 ?? 0) > 0).sort((a, b) => (b.cn0 ?? 0) - (a.cn0 ?? 0))
  const presentSys = SYS_ORDER.filter((s) => summary?.maxBySys[s])

  return (
    <>
      <section className="panel log-summary">
        <div className="panel-heading">
          <div><h2 dir="auto">{log.fileName}</h2><p>{[log.device, summary && `${dateStr(summary.t0)} · משך ${fmtDur(summary.t1 - summary.t0)}`].filter(Boolean).join(' · ')}</p></div>
          <button className="text-button" onClick={() => { setLog(null); setPlaying(false) }}><Upload size={16} /> קובץ אחר</button>
        </div>
        <div className="summary-chips">
          <span className="chip"><Num>{epochs.length}</Num> אפוקים</span>
          {Object.entries(log.providers).map(([p, n]) => <span key={p} className={`chip ${p === provider ? 'on' : ''}`}><Num>{n}</Num> פתרונות {p}</span>)}
          {presentSys.map((s) => <span key={s} className="chip"><i style={{ background: SYS_COLOR[s].light }} />{s} <Num>{summary!.maxBySys[s]}</Num></span>)}
        </div>
        {log.satSource && <p className="muted source-note"><Satellite size={14} /> {SOURCE_TEXT[log.satSource]}</p>}
        {provider && provider !== 'GPS' && provider !== 'NMEA' && <p className="muted source-note">אין פתרונות GPS בלוג. מוצגים פתרונות {provider}.</p>}
        {log.badLines > 0 && <p className="muted source-note">{log.badLines} שורות פגומות דולגו.</p>}
        {log.truncated && <p className="muted source-note">הקובץ חרג ממגבלות הבטיחות (מספר אפוקים, אותות או פתרונות). חלק מהנתונים לא נטען.</p>}
      </section>

      {integrity && <ErrorBoundary label="ניטור השלמות" resetKey={log}><IntegrityPanel report={integrity} minPoints={10} points={Math.max(fixes.length, epochs.length)} onJump={jumpTo} markerT={curT} fmtTime={clock} /></ErrorBoundary>}

      <section className="epoch-head">
        <div><span className="eyebrow-dark">שעה (UTC)</span><strong dir="ltr">{clock(curT)}</strong></div>
        <div><span className="eyebrow-dark">במעקב</span><strong>{trackedSats.length}</strong></div>
        <div><span className="eyebrow-dark">בפתרון</span><strong>{epoch && sats.some((s) => s.used !== null) ? usedSats.length : '—'}</strong></div>
        <div><span className="eyebrow-dark">C/N₀ ממוצע</span><strong dir="ltr">{epoch ? top4(epoch.signals).toFixed(1) : '—'}</strong></div>
      </section>

      {epochs.length > 0 && <section className="log-grid">
        <article className="panel sky-card">
          <div className="panel-heading"><div><h2>מפת שמיים</h2><p>{sats.some((s) => s.used !== null) ? 'מלא = בשימוש בפתרון · ריק = לא בשימוש · שקוף = לא במעקב' : 'הלוג לא מציין אילו לוויינים שימשו בפתרון · שקוף = לא במעקב'}</p></div></div>
          <div className="sky-panel"><SkyPlot signals={epoch?.signals ?? []} />
            <div className="constellation-legend">{presentSys.map((s) => <span key={s}><i style={{ backgroundColor: SYS_COLOR[s].dark }} />{s}</span>)}</div>
          </div>
        </article>
        <article className="panel">
          <div className="panel-heading"><div><h2>C/N₀ לכל אות</h2><p>{signalRows.length} אותות באפוק · ממוין מהחזק לחלש</p></div><span className="unit-pill">dB-Hz</span></div>
          <div className="cn0-list">{signalRows.map((s, i) => (
            <div key={`${s.sys}-${s.svid}-${s.band}-${i}`} className="cn0-row">
              <span className="signal-id"><i style={{ background: SYS_COLOR[s.sys].light }} />{satLabel(s)}</span>
              <span className="band">{s.band ?? ''}</span>
              <div className="signal-track"><span style={{ width: `${Math.max(4, Math.min(100, (((s.cn0 ?? 0) - 10) / 45) * 100))}%`, background: SYS_COLOR[s.sys].light }} /></div>
              <span className="signal-value">{(s.cn0 ?? 0).toFixed(0)}</span>
              <span className={`used-tag ${s.used ? 'yes' : ''}`}>{s.used === null ? '' : s.used ? 'בפתרון' : '—'}</span>
            </div>
          ))}</div>
        </article>
      </section>}

      {epochs.length > 1 && <section className="sat-charts">
        <article className="panel">
          <div className="panel-heading"><div><h2>לוויינים במעקב לפי מערכת</h2><p>ירידה פתאומית של כל המערכות יחד היא החתימה הקלאסית של שיבוש. הקש כדי לקפוץ לזמן.</p></div></div>
          <ErrorBoundary label="הגרף" resetKey={log}><ConstellationChart epochs={epochs} markerT={curT} onPick={jumpTo} fmtTime={clock} /></ErrorBoundary>
        </article>
        <article className="panel">
          <div className="panel-heading"><div><h2>עוצמת אות לכל לוויין לאורך זמן</h2><p>שורה לכל לוויין, צבע כהה יותר = אות חזק יותר. שיבוש נראה כפס אנכי של היחלשות בכל השורות; משדר מזייף יחיד, כשורות שנראות זהות.</p></div><span className="unit-pill">C/N₀</span></div>
          <ErrorBoundary label="מפת החום" resetKey={log}><Cn0Heatmap epochs={epochs} markerT={curT} onPick={jumpTo} fmtTime={clock} /></ErrorBoundary>
        </article>
      </section>}

      <section className="charts-grid">
        {fixes.length > 0 && <article className="panel">
          <div className="panel-heading"><div><h2>מסלול על המפה</h2><p>{fixes.length} פתרונות {provider}{fix && <> · כעת <Num>{fix.lat.toFixed(6)}, {fix.lon.toFixed(6)}</Num>{fix.acc !== null && <> · <Num>±{fix.acc.toFixed(1)} m</Num></>}</>}</p></div></div>
          <ErrorBoundary label="המפה" resetKey={log}><MapView track={fixes} current={mapCurrent} mode="fit" fitKey={`${log.fileName}:${fixes.length}`} /></ErrorBoundary>
        </article>}
        <div className="chart-stack">
          {series.tracked.length > 0 && <article className="panel">
            <div className="panel-heading"><div><h2>לוויינים במעקב</h2><p>הקש על הגרף כדי לקפוץ לזמן</p></div></div>
            <TimeChart data={series.tracked} kind="line" unit="sats" format={(v) => Math.round(v).toString()} ariaLabel="מספר לוויינים במעקב לאורך הלוג" markerIndex={idx} onPick={(i) => { setPlaying(false); setIdx(i) }} endLabel={clock(series.tracked[series.tracked.length - 1].t)} fmtTime={clock} />
          </article>}
          {series.cn0.length > 0 && <article className="panel">
            <div className="panel-heading"><div><h2>C/N₀ ממוצע, 4 החזקים</h2><p>dB-Hz · מדד מקובל לאיכות הקליטה</p></div></div>
            <TimeChart data={series.cn0} kind="line" unit="dB-Hz" format={(v) => v.toFixed(0)} ariaLabel="ממוצע C/N0 של ארבעת הלוויינים החזקים לאורך הלוג" markerIndex={idx} onPick={(i) => { setPlaying(false); setIdx(i) }} endLabel={clock(series.cn0[series.cn0.length - 1].t)} fmtTime={clock} />
          </article>}
          {series.agc.length > 0 && <article className="panel">
            <div className="panel-heading"><div><h2>AGC: בקרת ההגבר של המקלט</h2><p>dB · קפיצה חדה = אנרגיית RF זרה בתדר (שיבוש)</p></div></div>
            <TimeChart data={series.agc} kind="line" unit="dB" format={(v) => v.toFixed(1)} ariaLabel="רמת AGC לאורך הלוג" markerIndex={indexAt(series.agc, curT)} endLabel={clock(series.agc[series.agc.length - 1].t)} fmtTime={clock} />
          </article>}
          {series.acc.length > 0 && <article className="panel">
            <div className="panel-heading"><div><h2>דיוק אופקי מדווח</h2><p>מטרים · פתרונות {provider}</p></div></div>
            <TimeChart data={series.acc} kind="line" unit="m" format={(v) => (v < 10 ? v.toFixed(1) : Math.round(v).toString())} ariaLabel="דיוק אופקי מדווח לאורך הלוג" markerIndex={indexAt(series.acc, curT)} endLabel={clock(series.acc[series.acc.length - 1].t)} fmtTime={clock} />
          </article>}
        </div>
      </section>

      <nav className="action-bar player" aria-label="ניגון הלוג">
        <button className="action primary" onClick={() => { if (idx >= timeline.length - 1) setIdx(0); setPlaying(!playing) }} aria-label={playing ? 'השהה' : 'נגן'}>{playing ? <Pause size={20} /> : <Play size={20} />}<span>{playing ? 'השהה' : 'נגן'}</span></button>
        <div className="scrub">
          <input type="range" min={0} max={Math.max(0, timeline.length - 1)} value={Math.min(idx, timeline.length - 1)} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)) }} aria-label="מיקום בלוג" dir="ltr" />
          <div className="scrub-times" dir="ltr"><span>{summary && clock(summary.t0)}</span><b>{clock(curT)}</b><span>{summary && clock(summary.t1)}</span></div>
        </div>
        <button className="action" onClick={() => setSpeed(speed === 1 ? 10 : speed === 10 ? 60 : 1)} aria-label="מהירות ניגון"><Gauge size={20} /><span dir="ltr">{speed}×</span></button>
        <button className="action" onClick={() => { setPlaying(false); setIdx(0) }} aria-label="להתחלה"><RotateCcw size={20} /><span>התחלה</span></button>
      </nav>
    </>
  )
}
