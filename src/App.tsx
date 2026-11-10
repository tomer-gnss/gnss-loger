import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Activity, AlertTriangle, Check, Copy, Crosshair, Download, Gauge, Lock, Map as MapIcon, Mountain, Navigation, Pause, Play, Satellite, ScanLine, Sun, Timer, Trash2, Vibrate } from 'lucide-react'
import { gradeAccuracy, stats, toCsv, useGeolocation, useWakeLock, type Fix, type GeoStatus } from './geo'
import { Compass, ScatterPlot, TimeChart } from './LiveCharts'
import { MapView } from './MapView'
import { LogView } from './LogView'
import { ErrorBoundary } from './ErrorBoundary'
import { analyzeLive } from './integrity'
import { IntegrityPanel } from './IntegrityPanel'
import { useMotion } from './motion'
import './dashboard.css'

const fmtCoord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(6)}° ${v >= 0 ? pos : neg}`
const fmtM = (m: number) => (m < 10 ? m.toFixed(1) : Math.round(m).toString())
const clock = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour12: false })
/** Keeps "1.0 Hz" / "±4.4 m" in left-to-right order inside RTL Hebrew text. */
const Num = ({ children }: { children: ReactNode }) => <bdi dir="ltr" className="num">{children}</bdi>
const cardinals =['צפון', 'צפון־מזרח', 'מזרח', 'דרום־מזרח', 'דרום', 'דרום־מערב', 'מערב', 'צפון־מערב']
const cardinal = (deg: number) => cardinals[Math.round(deg / 45) % 8]

/** Ticks ten times a second so "time since last fix" visibly counts up between updates. */
function FixAge({ last, expected }: { last: Fix; expected: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [])
  const age = Math.max(0, now - last.wall)
  const stale = age > Math.max(3000, (expected ?? 1000) * 3)
  return <span className={`fix-age ${stale ? 'stale' : ''}`}><Timer size={14} /> {stale ? 'אין עדכון ' : 'עודכן לפני '}<b>{(age / 1000).toFixed(1)}</b> ש׳</span>
}

function LiveBadge({ status, hz }: { status: GeoStatus; hz: number | null }) {
  const map: Record<GeoStatus, [string, ReactNode]> = {
    active: ['live', hz ? <>חי · <Num>{hz.toFixed(1)} Hz</Num></> : 'חי'],
    waiting: ['warn', 'ממתין לפתרון'],
    requesting: ['warn', 'מתחבר…'],
    idle: ['off', 'מושהה'],
    denied: ['bad', 'אין הרשאה'],
    insecure: ['bad', 'דורש HTTPS'],
    unsupported: ['bad', 'לא נתמך'],
  }
  const [tone, text] = map[status]
  return <span className={`live-badge ${tone}`}><span className="live-dot" />{text}</span>
}

function StatusCard({ status, message, onStart }: { status: GeoStatus; message: string | null; onStart: () => void }) {
  if (status === 'insecure') return (
    <section className="status-card bad"><AlertTriangle size={22} /><div>
      <h2>הדף נפתח בלי HTTPS</h2>
      <p>דפדפן הטלפון חוסם גישה למיקום בחיבור לא מאובטח. פתח את הכתובת שמתחילה ב־<code dir="ltr">https://</code> שמוצגת כשמריצים <code dir="ltr">npm run dev:phone</code>, ואשר את אזהרת האבטחה.</p>
    </div></section>
  )
  if (status === 'unsupported') return (
    <section className="status-card bad"><AlertTriangle size={22} /><div><h2>הדפדפן לא תומך במיקום</h2><p>נסה Chrome או Safari עדכניים.</p></div></section>
  )
  if (status === 'denied') return (
    <section className="status-card bad"><Lock size={22} /><div>
      <h2>אין הרשאת מיקום</h2>
      <p>אפשר מיקום לאתר הזה: לחיצה על סמל המנעול בשורת הכתובת ← הרשאות ← מיקום ← "אפשר". ודא גם ששירותי המיקום בטלפון פועלים ושמוגדר "מיקום מדויק".</p>
      <button className="primary-button" onClick={onStart}><Play size={18} /> נסה שוב</button>
    </div></section>
  )
  if (status === 'requesting' || status === 'waiting') return (
    <section className="status-card warn"><span className="spinner" aria-hidden="true" /><div>
      <h2>ממתין לפתרון ראשון מהמקלט</h2>
      <p>אם זה לוקח זמן, צא לשטח פתוח עם שמיים גלויים. פתרון ראשון יכול לקחת עד דקה אחרי הפעלה קרה.</p>
      {message && <p className="muted" dir="auto">{message}</p>}
    </div></section>
  )
  return (
    <section className="status-card start"><Satellite size={26} /><div>
      <h2>מעקב חי אחרי מקלט ה־GNSS של המכשיר</h2>
      <p>המסך יציג כל פתרון מיקום ברגע שהמקלט מחשב אותו: מיקום, דיוק, גובה, מהירות, כיוון וקצב העדכון בפועל.</p>
      <button className="primary-button" onClick={onStart}><Play size={18} /> הפעל מעקב</button>
    </div></section>
  )
}

function App() {
  const geo = useGeolocation()
  const [keepAwake, setKeepAwake] = useState(true)
  const wake = useWakeLock(keepAwake && geo.running)
  const [tab, setTab] = useState<'live' | 'log'>('live')
  const [copied, setCopied] = useState(false)
  const s = useMemo(() => stats(geo.fixes), [geo.fixes])
  const last = s.last
  const grade = last ? gradeAccuracy(last.acc) : null

  const livePoints = useMemo(() => geo.fixes.map((f) => ({ t: f.wall, lat: f.lat, lon: f.lon, acc: f.acc })), [geo.fixes])
  const motion = useMotion()
  // Integrity analysis every 5th fix / 5th sensor second (and on the first few), so it never
  // competes with 1 Hz rendering.
  const integrityTick = `${geo.fixes.length < 10 ? geo.fixes.length : Math.floor(geo.fixes.length / 5)}:${Math.floor(motion.seconds.length / 5)}`
  const integrity = useMemo(() => analyzeLive(geo.fixes.map((f) => ({ t: f.wall, lat: f.lat, lon: f.lon, alt: f.alt, acc: f.acc, speed: f.speed, heading: f.heading })), motion.seconds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [integrityTick])
  const lastMotion = motion.seconds[motion.seconds.length - 1]
  const liveCurrent = useMemo(() => (last ? { lat: last.lat, lon: last.lon, acc: last.acc } : null), [last])
  const accSeries = useMemo(() => geo.fixes.slice(-120).map((f) => ({ t: f.wall, v: f.acc })), [geo.fixes])
  const intervalSeries = useMemo(() => {
    const f = geo.fixes.slice(-61)
    return f.slice(1).map((x, i) => ({ t: x.wall, v: x.recv - f[i].recv }))
  }, [geo.fixes])

  const copy = async () => {
    if (!last) return
    try {
      await navigator.clipboard.writeText(`${last.lat.toFixed(7)}, ${last.lon.toFixed(7)}`)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked */ }
  }

  const exportCsv = () => {
    const rows = geo.session.current
    if (!rows.length) return
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' })
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
    a.href = URL.createObjectURL(blob)
    a.download = `gnss-log-${stamp}.csv`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand"><span className="brand-mark"><Crosshair size={18} /></span>אטלס<small>GNSS</small></span>
        <LiveBadge status={geo.status} hz={s.hz} />
      </header>
      <nav className="mode-tabs" aria-label="מצב תצוגה">
        <button className={tab === 'live' ? 'active' : ''} aria-pressed={tab === 'live'} onClick={() => setTab('live')}><Activity size={17} /> מעקב חי</button>
        <button className={tab === 'log' ? 'active' : ''} aria-pressed={tab === 'log'} onClick={() => setTab('log')}><Satellite size={17} /> ניתוח לוג</button>
      </nav>

      <main className="dashboard">
        {tab === 'log' ? <ErrorBoundary label="ניתוח הלוג"><LogView /></ErrorBoundary> : <>
        {(!last || geo.status === 'denied' || geo.status === 'insecure') && <StatusCard status={geo.status} message={geo.message} onStart={geo.start} />}

        {last && grade && <>
          <section className="hero" aria-live="off">
            <div className="hero-top">
              <span className="eyebrow">מיקום נוכחי</span>
              <span key={geo.fixes.length} className="fix-pulse" aria-hidden="true" />
              <FixAge last={last} expected={s.meanInterval} />
            </div>
            <div className="coords" dir="ltr">
              <strong>{fmtCoord(last.lat, 'N', 'S')}</strong>
              <strong>{fmtCoord(last.lon, 'E', 'W')}</strong>
            </div>
            <div className="hero-foot">
              <span className={`grade-chip ${grade.key}`}><i /><Num>±{fmtM(last.acc)} m</Num> · {grade.label}</span>
              <span className="hero-actions">
                <button className="ghost-button" onClick={copy} aria-label="העתק קואורדינטות">{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'הועתק' : 'העתק'}</button>
                <a className="ghost-button" href={`https://www.google.com/maps?q=${last.lat},${last.lon}`} target="_blank" rel="noreferrer"><MapIcon size={16} />מפה</a>
              </span>
            </div>
            {geo.status === 'waiting' && <p className="hero-warning"><AlertTriangle size={14} /> המקלט לא החזיר פתרון חדש: {geo.message ?? 'אין קליטה'}</p>}
          </section>

          <ErrorBoundary label="ניטור השלמות"><IntegrityPanel report={integrity} minPoints={30} points={geo.fixes.length} extra={
            <div className={`sensor-row ${motion.state}`}>
              <Vibrate size={18} />
              {motion.state === 'active' ? <>
                <span><b>הצלבה עם חיישני התנועה פעילה.</b> הטלפון כרגע: <b>{!lastMotion ? '…' : lastMotion.accStd < 0.12 ? 'מונח ללא תזוזה' : lastMotion.accStd < 1 ? 'בתנועה קלה' : 'בתנועה / הליכה'}</b>. הנתונים נשארים בזיכרון בלבד.</span>
                <button className="text-button" onClick={motion.stop}>כבה</button>
              </> : motion.state === 'denied' ? <span>הגישה לחיישני התנועה נדחתה. באייפון: הגדרות ← Safari ← "תנועה וכיוון" (Motion &amp; Orientation Access).</span>
                : motion.state === 'no-data' ? <span>המכשיר לא מדווח על חיישני תנועה (למשל במחשב).</span>
                : motion.state === 'unsupported' ? <span>הדפדפן לא תומך בחיישני תנועה.</span>
                : <>
                  <span><b>הצלבה עם חיישני התנועה</b> של הטלפון: מזייף שולט במה שה-GNSS מחשב, אבל לא בתנועה הפיזית של הטלפון. הנתונים לא נשמרים ולא נשלחים.</span>
                  <button className="text-button" onClick={() => void motion.start()} disabled={motion.state === 'requesting'}>{motion.state === 'requesting' ? 'מבקש הרשאה…' : 'הפעל'}</button>
                </>}
            </div>
          } /></ErrorBoundary>

          <section className="panel map-panel">
            <div className="panel-heading"><div><h2>מפה</h2><p>המסלול בסשן · העיגול הכתום: רדיוס הדיוק</p></div></div>
            <ErrorBoundary label="המפה"><MapView track={livePoints} current={liveCurrent} mode="follow" /></ErrorBoundary>
          </section>

          <section className="metrics-grid" aria-label="מדדי המקלט">
            <article className="metric">
              <div className="metric-label"><Crosshair size={16} />דיוק אופקי</div>
              <div className="metric-value">±{fmtM(last.acc)}<span className="metric-unit">m</span></div>
              <div className="metric-foot"><span className={`status-dot ${grade.key}`} />{grade.label}</div>
            </article>
            <article className="metric">
              <div className="metric-label"><Activity size={16} />קצב עדכון</div>
              <div className="metric-value">{s.hz ? s.hz.toFixed(1) : '—'}<span className="metric-unit">Hz</span></div>
              <div className="metric-foot">{s.meanInterval ? <>כל <Num>{Math.round(s.meanInterval)} ms</Num></> : 'מחשב…'}</div>
            </article>
            <article className="metric">
              <div className="metric-label"><Mountain size={16} />גובה</div>
              <div className="metric-value">{last.alt !== null ? fmtM(last.alt) : '—'}<span className="metric-unit">m</span></div>
              <div className="metric-foot">{last.alt === null ? 'המכשיר לא מדווח גובה' : last.altAcc !== null ? <Num>±{fmtM(last.altAcc)} m</Num> : 'ללא הערכת דיוק'}</div>
            </article>
            <article className="metric">
              <div className="metric-label"><Gauge size={16} />מהירות</div>
              <div className="metric-value">{last.speed !== null ? (last.speed * 3.6).toFixed(1) : '—'}<span className="metric-unit">km/h</span></div>
              <div className="metric-foot">{last.speed !== null ? <Num>{last.speed.toFixed(2)} m/s</Num> : 'לא דווחה'}</div>
            </article>
            <article className="metric">
              <div className="metric-label"><Navigation size={16} />כיוון תנועה</div>
              <div className="metric-value metric-with-icon">{last.heading !== null ? `${Math.round(last.heading)}°` : '—'}<Compass heading={last.heading} /></div>
              <div className="metric-foot">{last.heading !== null ? cardinal(last.heading) : 'זמין רק בתנועה'}</div>
            </article>
            <article className="metric">
              <div className="metric-label"><ScanLine size={16} />פיזור (RMS)</div>
              <div className="metric-value">{s.rms !== null ? fmtM(s.rms) : '—'}<span className="metric-unit">m</span></div>
              <div className="metric-foot">{Math.min(60, geo.fixes.length)} פתרונות אחרונים</div>
            </article>
          </section>

          <section className="charts-grid">
            <article className="panel">
              <div className="panel-heading"><div><h2>פיזור פתרונות</h2><p>{Math.min(120, geo.fixes.length)} פתרונות אחרונים סביב המיקום הממוצע. העיגול: רדיוס הדיוק הנוכחי.</p></div></div>
              <ScatterPlot points={livePoints} center={s.center} />
            </article>
            <div className="chart-stack">
              <article className="panel">
                <div className="panel-heading"><div><h2>דיוק אופקי לאורך זמן</h2><p>מטרים · נמוך יותר = טוב יותר</p></div></div>
                <TimeChart data={accSeries} kind="line" unit="m" format={fmtM} ariaLabel="גרף דיוק אופקי במטרים לאורך זמן" />
              </article>
              <article className="panel">
                <div className="panel-heading"><div><h2>מרווח בין עדכונים</h2><p>אלפיות שנייה בין פתרונות עוקבים</p></div></div>
                <TimeChart data={intervalSeries} kind="bars" unit="ms" format={(v) => Math.round(v).toString()} refValue={1000} refLabel="1 Hz" ariaLabel="גרף מרווחי זמן בין עדכוני מיקום" />
              </article>
            </div>
          </section>

          <section className="panel log-panel">
            <div className="panel-heading"><div><h2>יומן פתרונות</h2><p>10 האחרונים · {geo.session.current.length} בסשן</p></div></div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>שעה</th><th>רוחב</th><th>אורך</th><th>דיוק</th><th>מהירות</th></tr></thead>
                <tbody>{geo.fixes.slice(-10).reverse().map((f) => (
                  <tr key={f.recv}><td>{clock(f.wall)}</td><td dir="ltr">{f.lat.toFixed(6)}</td><td dir="ltr">{f.lon.toFixed(6)}</td><td dir="ltr">±{fmtM(f.acc)} m</td><td dir="ltr">{f.speed !== null ? `${(f.speed * 3.6).toFixed(1)} km/h` : '—'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </>}

        <section className="panel sat-panel">
          <div className="panel-heading">
            <div><h2>לוויינים ואותות</h2><p>הדפדפן לא חושף נתוני לוויינים במעקב חי. הקלט לוג ב-GPSTest או ב-GnssLogger וטען אותו כאן כדי לראות מפת שמיים ו-C/N₀ אמיתיים.</p></div>
            <button className="text-button" onClick={() => setTab('log')}>ניתוח לוג</button>
          </div>
        </section>

        <footer className="dashboard-footer">
          <p><b>פרטיות:</b> המיקום נשמר רק בזיכרון של הדף ונמחק כשסוגרים או מרעננים אותו. לאתר אין שרת, אין עוגיות ואין כלי מעקב, והוא לא שולח את המיקום לשום מקום. מידע יוצא מהמכשיר רק במקרים האלה: אם הפעלת את המפה (אריחים מ-OpenStreetMap), אם לחצת "מפה" (Google Maps), ואם ייצאת קובץ CSV.</p>
          <p>מקור: Geolocation API של הדפדפן · דיוק גבוה · ללא מטמון. קצב העדכון נקבע על ידי מערכת ההפעלה, בדרך כלל 1 Hz.</p>
        </footer>
        </>}
      </main>

      {tab === 'live' && <nav className="action-bar" aria-label="פעולות">
        {geo.running
          ? <button className="action primary" onClick={geo.stop}><Pause size={20} /><span>עצור</span></button>
          : <button className="action primary" onClick={geo.start} disabled={geo.status === 'insecure' || geo.status === 'unsupported'}><Play size={20} /><span>הפעל</span></button>}
        {wake.supported && <button className={`action ${keepAwake ? 'on' : ''}`} onClick={() => setKeepAwake(!keepAwake)} aria-pressed={keepAwake}><Sun size={20} /><span>{keepAwake ? 'מסך דולק' : 'מסך רגיל'}</span></button>}
        <button className="action" onClick={exportCsv} disabled={!geo.session.current.length}><Download size={20} /><span>CSV</span></button>
        <button className="action" onClick={() => { geo.clear(); motion.clear() }} disabled={!geo.fixes.length}><Trash2 size={20} /><span>נקה</span></button>
      </nav>}
    </div>
  )
}

export default App
