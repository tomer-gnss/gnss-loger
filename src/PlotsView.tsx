// "Plots" tab: C/N0 (dB-Hz) vs time (s), one line per signal, like GnssLogger's PLOTS screen.
// Sources:
//  - External receiver over Web Serial: real measurements, live (updates every second).
//  - A recorded log (GnssLogger / GPSTest / NMEA): replayed in real time (1×) or faster,
//    or shown whole.
// A phone's own browser never gets per-satellite C/N0 (neither iOS nor Android expose it to
// web pages), so the UI says so instead of faking it.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Bluetooth, FileText, FolderOpen, Pause, Play, Plug, SkipForward, Unplug, Upload } from 'lucide-react'
import { satLabel, SYS_ORDER, type Epoch, type ParsedLog, type Sys } from './logParser'
import { SYS_COLOR } from './colors'
import { useWidth } from './useWidth'
import { useLogLoader } from './logLoader'
import type { SerialReceiver } from './serialReceiver'
import { RecordGuide } from './RecordGuide'
import { isIOS } from './device'

const Y_MIN = 10
const REF_CN0 = 25 // dB-Hz: below this a signal is weak and often left out of the fix
const WINDOWS = [{ s: 60, label: '1 דק׳' }, { s: 300, label: '5 דק׳' }, { s: 0, label: 'הכל' }] as const
const SPEEDS = [1, 10, 60] as const
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
const utc = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour12: false, timeZone: 'UTC' })

type Pt = { t: number; v: number }
type Series = { key: string; sys: Sys; label: string; pts: Pt[] }

const sigKey = (s: { sys: Sys; svid: number; band: string | null }) => `${s.sys}|${s.svid}|${s.band ?? ''}`
const sigLabel = (s: { sys: Sys; svid: number; band: string | null; name?: string }) => `${satLabel(s)}${s.band ? ' ' + s.band : ''}`

/** Index of the last epoch with t <= target (binary search); -1 if none. */
function lastAtOrBefore(arr: Epoch[], target: number) {
  let lo = 0, hi = arr.length - 1, ans = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= target) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
  return ans
}

/** Mean of the 4 strongest signals: the standard single-number C/N0 summary. */
function top4(e: Epoch | undefined) {
  if (!e) return null
  const v = e.signals.map((s) => s.cn0 ?? 0).filter((x) => x > 0).sort((a, b) => b - a).slice(0, 4)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

// ------------------------------------------------------------------
// The chart
// ------------------------------------------------------------------

function Cn0TimeChart({ epochs, t0, tFrom, tTo, hidden, focus, onFocus }: {
  epochs: Epoch[]; t0: number; tFrom: number; tTo: number; hidden: Set<Sys>
  focus: string | null; onFocus: (key: string | null) => void
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ key: string; label: string; sys: Sys; t: number; v: number } | null>(null)
  const H = 260, m = { top: 14, right: 10, bottom: 8, left: 32 }
  const w = Math.max(10, width - m.left - m.right), h = H - m.top - m.bottom

  const data = useMemo(() => {
    // Keep about one sample per 1.5 px: a whole 30-minute log stays light on a phone.
    const stride = Math.max(1, Math.ceil(epochs.length / Math.max(60, w / 1.5)))
    const sampled = stride === 1 ? epochs : epochs.filter((_, i) => i % stride === 0 || i === epochs.length - 1)
    const dts: number[] = []
    for (let i = 1; i < Math.min(sampled.length, 300); i++) dts.push(sampled[i].t - sampled[i - 1].t)
    dts.sort((a, b) => a - b)
    // A signal missing for longer than this breaks its line (lost lock, satellite set, blocked).
    const gap = Math.max(2500, (dts[dts.length >> 1] ?? 1000) * 3)
    const map = new Map<string, Series>()
    let max = 0
    for (const e of sampled) for (const s of e.signals) {
      const v = s.cn0 ?? 0
      if (!(v > 0) || hidden.has(s.sys)) continue
      const key = sigKey(s)
      let ser = map.get(key)
      if (!ser) { ser = { key, sys: s.sys, label: sigLabel(s), pts: [] }; map.set(key, ser) }
      const last = ser.pts[ser.pts.length - 1]
      if (last && last.t === e.t) last.v = v; else ser.pts.push({ t: e.t, v })
      if (v > max) max = v
    }
    // Fixed constellation order, so lines of one system are drawn together.
    const series = [...map.values()].sort((a, b) => SYS_ORDER.indexOf(a.sys) - SYS_ORDER.indexOf(b.sys) || a.label.localeCompare(b.label))
    return { series, gap, max }
  }, [epochs, hidden, w])

  const yMax = Math.min(70, Math.max(50, Math.ceil(data.max / 5) * 5))
  const span = Math.max(1000, tTo - tFrom)
  const x = (t: number) => m.left + ((t - tFrom) / span) * w
  const y = (v: number) => m.top + h - ((Math.min(yMax, Math.max(Y_MIN, v)) - Y_MIN) / (yMax - Y_MIN)) * h

  const pathOf = (pts: Pt[]) => {
    let d = '', prev: Pt | null = null
    for (const p of pts) {
      d += `${!prev || p.t - prev.t > data.gap ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`
      prev = p
    }
    return d
  }

  // X ticks in elapsed seconds since the start of the source.
  const maxTicks = Math.max(2, Math.floor(w / 64))
  const spanS = span / 1000
  const step = TICK_STEPS.find((s) => spanS / s <= maxTicks) ?? Math.ceil(spanS / maxTicks / 3600) * 3600
  const ticks: number[] = []
  for (let s = Math.ceil((tFrom - t0) / 1000 / step) * step; s <= (tTo - t0) / 1000 + 1e-6; s += step) ticks.push(s)
  const yTicks: number[] = []
  for (let v = Y_MIN; v <= yMax; v += 10) yTicks.push(v)

  const active = hover?.key ?? focus

  /** Nearest signal to the pointer: closest in time, then closest in C/N0. */
  const pick = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const t = tFrom + ((e.clientX - r.left - m.left) / w) * span
    const v = Y_MIN + ((m.top + h - (e.clientY - r.top)) / h) * (yMax - Y_MIN)
    let best: { ser: Series; p: Pt; score: number } | null = null
    for (const ser of data.series) {
      const pts = ser.pts
      let lo = 0, hi = pts.length - 1
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid + 1; else hi = mid }
      for (const p of [pts[lo - 1], pts[lo]]) {
        if (!p || Math.abs(p.t - t) > data.gap) continue
        const score = Math.abs(p.v - v) + (Math.abs(p.t - t) / span) * 20
        if (!best || score < best.score) best = { ser, p, score }
      }
    }
    if (!best) { setHover(null); return }
    setHover({ key: best.ser.key, label: best.ser.label, sys: best.ser.sys, t: best.p.t, v: best.p.v })
    if (e.type === 'pointerdown') onFocus(best.ser.key)
  }

  const tipX = hover ? Math.max(70, Math.min(width - 70, x(hover.t))) : 0

  return (
    <div ref={ref} className="sat-chart cn0-chart" dir="ltr">
      <div className="axis-title"><span>C/N₀ (dB-Hz)</span></div>
      <svg width={width} height={H} role="img" aria-label="C/N₀ של כל אות לאורך הזמן, קו לכל אות, צבע לפי מערכת לוויינים"
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null) }}>
        {yTicks.map((v) => <g key={v}><line x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} className={v === Y_MIN ? 'baseline' : 'grid-line'} /><text x={m.left - 6} y={y(v) + 4} className="axis-text" textAnchor="end">{v}</text></g>)}
        {ticks.map((s) => <line key={s} x1={x(t0 + s * 1000)} x2={x(t0 + s * 1000)} y1={m.top} y2={m.top + h} className="grid-line" />)}
        <line x1={m.left} x2={m.left + w} y1={y(REF_CN0)} y2={y(REF_CN0)} className="ref-line" />
        <g fill="none" strokeLinejoin="round" strokeLinecap="round">
          {data.series.filter((s) => s.key !== active).map((s) => <path key={s.key} d={pathOf(s.pts)} stroke={SYS_COLOR[s.sys].light} strokeWidth={1.4} strokeOpacity={active ? 0.18 : 0.9} />)}
          {data.series.filter((s) => s.key === active).map((s) => <path key={s.key} d={pathOf(s.pts)} stroke={SYS_COLOR[s.sys].light} strokeWidth={3} />)}
        </g>
        {data.series.filter((s) => s.key === active).map((s) => { const p = s.pts[s.pts.length - 1]; return p && <circle key={s.key} cx={x(p.t)} cy={y(p.v)} r={4} fill={SYS_COLOR[s.sys].light} stroke="#fff" strokeWidth={1.5} /> })}
        {hover && <>
          <line x1={x(hover.t)} x2={x(hover.t)} y1={m.top} y2={m.top + h} className="crosshair-line" />
          <circle cx={x(hover.t)} cy={y(hover.v)} r={4.5} fill="#fff" stroke={SYS_COLOR[hover.sys].light} strokeWidth={2.5} />
        </>}
        {!data.series.length && <text x={m.left + w / 2} y={m.top + h / 2} textAnchor="middle" className="axis-text">אין עדיין נתוני C/N₀</text>}
      </svg>
      {hover && <div className="chart-tip" style={{ left: tipX }}><b style={{ color: '#fff' }}>{hover.label}</b><b>{hover.v.toFixed(1)}</b><span>dB-Hz · {((hover.t - t0) / 1000).toFixed(0)} s</span></div>}
      <div className="x-ticks" style={{ marginLeft: m.left, width: w }}>
        {ticks.map((s) => <span key={s} style={{ left: `${((t0 + s * 1000 - tFrom) / span) * 100}%` }}>{s}</span>)}
      </div>
      <div className="axis-title x"><span>time (s)</span></div>
    </div>
  )
}

// ------------------------------------------------------------------
// The tab
// ------------------------------------------------------------------

export function PlotsView({ rx, log, setLog }: { rx: SerialReceiver; log: ParsedLog | null; setLog: (l: ParsedLog | null) => void }) {
  const [source, setSource] = useState<'rx' | 'log'>(rx.state === 'connected' ? 'rx' : 'log')
  const [windowS, setWindowS] = useState<number>(60)
  const [hidden, setHidden] = useState<Set<Sys>>(() => new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const [baud, setBaud] = useState(9600)
  const [showAll, setShowAll] = useState(false)

  // Replay state belongs to one log: a different log starts again from its beginning.
  const [replay, setReplay] = useState<{ log: ParsedLog | null; t: number; playing: boolean }>(() => ({ log, t: log?.epochs[0]?.t ?? 0, playing: false }))
  const [speed, setSpeed] = useState<number>(1)
  const loader = useLogLoader((l) => { setLog(l); setReplay({ log: l, t: l.epochs[0]?.t ?? 0, playing: true }) })
  const input = useRef<HTMLInputElement>(null)
  const logEpochs = useMemo(() => log?.epochs ?? [], [log])
  const rp = replay.log === log ? replay : { log, t: logEpochs[0]?.t ?? 0, playing: false }
  const logEnd = logEpochs[logEpochs.length - 1]?.t ?? 0

  useEffect(() => {
    if (source !== 'log' || !rp.playing || !logEpochs.length) return
    const clk = { last: performance.now() }
    const id = window.setInterval(() => {
      const now = performance.now()
      const dt = (now - clk.last) * speed
      clk.last = now
      setReplay((r) => {
        const t = Math.min(logEnd, (r.log === log ? r.t : logEpochs[0].t) + dt)
        return { log, t, playing: t < logEnd }
      })
    }, 200)
    return () => window.clearInterval(id)
  }, [source, rp.playing, speed, log, logEpochs, logEnd])

  // What the chart shows: all epochs up to "now" (receiver: latest; log: the replay head).
  const all = source === 'rx' ? rx.data.epochs : logEpochs
  const tNow = source === 'rx' ? (all[all.length - 1]?.t ?? 0) : rp.t
  const t0 = all[0]?.t ?? 0
  const tFrom = windowS ? Math.max(t0, tNow - windowS * 1000) : t0
  // A sliding window keeps its full width from the start, so the line grows from the left like a live plot.
  const tTo = windowS ? Math.max(tNow, t0 + windowS * 1000) : Math.max(tNow, t0 + 1000)
  const iEnd = lastAtOrBefore(all, tNow)
  const visible = useMemo(() => {
    if (iEnd < 0) return []
    let i = iEnd
    while (i > 0 && all[i - 1].t >= tFrom) i--
    return all.slice(i, iEnd + 1)
  }, [all, iEnd, tFrom])
  const cur = iEnd >= 0 ? all[iEnd] : undefined
  const present = useMemo(() => {
    const c: Partial<Record<Sys, number>> = {}
    for (const s of cur?.signals ?? []) if ((s.cn0 ?? 0) > 0) c[s.sys] = (c[s.sys] ?? 0) + 1
    return c
  }, [cur])
  const systems = SYS_ORDER.filter((s) => present[s] || hidden.has(s))
  const nowSignals = (cur?.signals ?? []).filter((s) => (s.cn0 ?? 0) > 0 && !hidden.has(s.sys)).sort((a, b) => (b.cn0 ?? 0) - (a.cn0 ?? 0))
  const mean4 = top4(cur)

  const toggleSys = (s: Sys) => setHidden((h) => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n })

  const sourceNote = isIOS()
    ? 'הדפדפן באייפון לא מקבל C/N₀ מהמקלט של הטלפון: Apple לא חושפת אותו לאף אתר או אפליקציה. כאן רואים C/N₀ אמיתי מלוג שהוקלט באנדרואיד או ממקלט חיצוני.'
    : 'דפדפנים לא מקבלים C/N₀ מהמקלט של הטלפון (באנדרואיד הוא זמין רק לאפליקציות). בזמן אמת באתר: ממקלט חיצוני. אחרת: לוג מ-GnssLogger, בניגון בקצב אמיתי.'

  return (
    <>
      <section className="panel plots">
        <div className="panel-heading">
          <div><h2>C/N₀ לאורך זמן</h2><p>עוצמת האות של כל לוויין, בכל שנייה. קו לכל אות, צבע לפי מערכת.</p></div>
        </div>
        <div className="seg" role="group" aria-label="מקור הנתונים">
          <button className={source === 'rx' ? 'active' : ''} aria-pressed={source === 'rx'} onClick={() => setSource('rx')}><Bluetooth size={16} /> מקלט חיצוני (חי)</button>
          <button className={source === 'log' ? 'active' : ''} aria-pressed={source === 'log'} onClick={() => setSource('log')}><FileText size={16} /> לוג מוקלט</button>
        </div>
        <p className="muted source-note">{sourceNote}</p>

        {source === 'rx' && (rx.state === 'unsupported' ? <p className="muted">
          {isIOS() ? 'באייפון אין לדפדפנים אפשרות להתחבר למקלט חיצוני (Apple לא תומכת ב-Web Serial). אפשר לבחור "לוג מוקלט".' : 'הדפדפן הזה לא תומך בחיבור למקלט. צריך Chrome לאנדרואיד בגרסה 138 ומעלה (Bluetooth), או Chrome/Edge במחשב (USB).'}
        </p> : rx.state !== 'connected' ? <>
          <p className="muted">מקלט שמוציא NMEA עם הודעות GSV (u-blox, Bad Elf, Garmin GLO ועוד). ב-Bluetooth: קודם צריך לצמד אותו בהגדרות הטלפון. החיבור נשאר פעיל גם במעבר בין הלשוניות.</p>
          <div className="rx-connect">
            <label>קצב (baud)
              <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
                {[4800, 9600, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <button className="primary-button" onClick={() => void rx.connect(baud)} disabled={rx.state === 'connecting'}><Plug size={18} /> {rx.state === 'connecting' ? 'מתחבר…' : 'חבר מקלט'}</button>
          </div>
          {rx.error && <p className="error-text">{rx.error}</p>}
        </> : <div className="rx-status">
          <span className="live-dot" /> מחובר{rx.info ? ` · ${rx.info}` : ''} · <bdi dir="ltr">{rx.data.lines}</bdi> שורות
          <button className="text-button" onClick={() => void rx.disconnect()}><Unplug size={16} /> נתק</button>
        </div>)}

        {source === 'log' && (!log ? <div className="plots-load">
          <input ref={input} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loader.load(f); e.target.value = '' }} />
          <button className="primary-button" onClick={() => input.current?.click()} disabled={loader.busy !== null}><FolderOpen size={18} /> בחר קובץ לוג</button>
          <button className="link-button" onClick={() => void loader.loadSample()} disabled={loader.busy !== null}>או נסה קובץ לדוגמה (u-blox F9K, 29 דקות)</button>
          {loader.busy !== null && <div className="progress"><span style={{ width: `${Math.round(loader.busy * 100)}%` }} /></div>}
          {loader.error && <p className="error-text">{loader.error}</p>}
        </div> : !logEpochs.length ? <p className="muted">בלוג <bdi>{log.fileName}</bdi> אין רשומות לוויינים (Status / Raw / GSV), ולכן אין C/N₀ להציג.
          <button className="text-button" onClick={() => setLog(null)}><Upload size={16} /> קובץ אחר</button></p>
          : <div className="replay-bar">
            <button className="icon-button" aria-label={rp.playing ? 'השהה' : 'נגן'} onClick={() => setReplay({ log, t: rp.t >= logEnd ? logEpochs[0].t : rp.t, playing: !rp.playing })}>{rp.playing ? <Pause size={18} /> : <Play size={18} />}</button>
            <div className="seg small" role="group" aria-label="מהירות ניגון">
              {SPEEDS.map((s) => <button key={s} className={speed === s ? 'active' : ''} aria-pressed={speed === s} onClick={() => setSpeed(s)}><bdi dir="ltr">{s}×</bdi></button>)}
            </div>
            <button className="text-button" onClick={() => { setReplay({ log, t: logEnd, playing: false }); setWindowS(0) }}><SkipForward size={16} /> כל הלוג</button>
            <input type="range" className="scrub" aria-label="מיקום בלוג" min={0} max={Math.max(1, Math.round((logEnd - logEpochs[0].t) / 1000))} value={Math.round((rp.t - logEpochs[0].t) / 1000)}
              onChange={(e) => setReplay({ log, t: logEpochs[0].t + Number(e.target.value) * 1000, playing: rp.playing })} />
            <span className="muted" dir="ltr"><bdi>{Math.round((rp.t - logEpochs[0].t) / 1000)} / {Math.round((logEnd - logEpochs[0].t) / 1000)} s</bdi></span>
            <button className="text-button" onClick={() => setLog(null)}><Upload size={16} /> קובץ אחר</button>
          </div>)}
      </section>

      {(source === 'rx' ? rx.state === 'connected' || rx.data.epochs.length > 0 : logEpochs.length > 0) && <section className="panel plots">
        <div className="plots-stats">
          <div><span className="stat-label">זמן</span><strong dir="ltr">{cur ? `${Math.round((tNow - t0) / 1000)} s` : '—'}</strong><small dir="ltr">{cur ? `${utc(cur.t)} UTC` : ''}</small></div>
          <div><span className="stat-label">אותות</span><strong>{nowSignals.length}</strong></div>
          <div><span className="stat-label">ממוצע 4 חזקים</span><strong dir="ltr">{mean4 !== null ? mean4.toFixed(1) : '—'}</strong><small>dB-Hz</small></div>
        </div>
        <div className="seg small" role="group" aria-label="חלון זמן">
          {WINDOWS.map((o) => <button key={o.s} className={windowS === o.s ? 'active' : ''} aria-pressed={windowS === o.s} onClick={() => setWindowS(o.s)}>{o.label}</button>)}
        </div>
        {source === 'rx' && !all.length && <p className="muted">ממתין להודעות GSV עם C/N₀ מהמקלט…</p>}
        <Cn0TimeChart epochs={visible} t0={t0} tFrom={tFrom} tTo={tTo} hidden={hidden} focus={focus} onFocus={setFocus} />
        <div className="sys-filter" role="group" aria-label="סינון לפי מערכת">
          {systems.map((s) => <button key={s} className={`chip ${hidden.has(s) ? 'off' : ''}`} aria-pressed={!hidden.has(s)} onClick={() => toggleSys(s)}><i style={{ background: SYS_COLOR[s].light }} />{s} <b dir="ltr">{present[s] ?? 0}</b></button>)}
          <span className="ref-key"><i /> מתחת ל-<bdi dir="ltr">{REF_CN0} dB-Hz</bdi> האות חלש</span>
        </div>
        {nowSignals.length > 0 && <>
          <h3 className="plots-sub">ערכים עכשיו <span className="muted">(נגיעה מדגישה את הקו)</span></h3>
          <div className="sig-chips">
            {(showAll ? nowSignals : nowSignals.slice(0, 12)).map((s) => { const k = sigKey(s); return (
              <button key={k} className={`sig-chip ${focus === k ? 'focus' : ''}`} aria-pressed={focus === k} onClick={() => setFocus(focus === k ? null : k)}>
                <i style={{ background: SYS_COLOR[s.sys].light }} /><bdi dir="ltr">{sigLabel(s)}</bdi><b dir="ltr">{(s.cn0 ?? 0).toFixed(1)}</b>
              </button>) })}
          </div>
          {nowSignals.length > 12 && <button className="link-button" onClick={() => setShowAll(!showAll)}>{showAll ? 'הצג רק את 12 החזקים' : `הצג את כל ${nowSignals.length} האותות`}</button>}
        </>}
      </section>}

      {source === 'log' && !log && <RecordGuide />}
    </>
  )
}
