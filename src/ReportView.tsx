// Printable analysis report: opens over the app, saves as PDF through the browser's own print
// dialog (no PDF library, nothing uploaded), or downloads as a self-contained HTML file that opens
// anywhere, even offline. Everything is computed on the device from data already loaded.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { ForcedWidth } from './forcedWidth'
import { Download, FileText, Printer, X } from 'lucide-react'
import type { ParsedLog } from './logParser'
import type { CellLog } from './cellParser'
import type { Gap } from './geo'
import type { MotionSecond } from './motion'
import { analyzeLive, analyzeLog, VERDICT_TEXT, type IntegrityReport, type Severity } from './integrity'
import { compareGnssCell } from './cellCompare'
import { liveStats, logStats, richestSkyEpoch, type LivePoint } from './report'
import { SYS_COLOR } from './colors'
import { TimeChart, ScatterPlot } from './LiveCharts'
import { ConstellationChart, Cn0Heatmap } from './SatCharts'
import { SkyPlot } from './SkyPlot'
import { Cn0TimeChart } from './PlotsView'
import { CellChart } from './CellChart'
import { isAndroid, isIOS } from './device'
import { dateTimeLocal, dateTimeUtc, duration as fmtDur, timeLocal, timeUtc } from './format'

export type ReportInput =
  | { kind: 'log'; log: ParsedLog; cell: CellLog | null }
  | { kind: 'live'; fixes: LivePoint[]; gaps: Gap[]; motion: MotionSecond[] }

/** A4 with 12 mm margins is 186 mm ≈ 703 CSS px wide; charts get a little less. */
const PRINT_WIDTH = 690
const SEV_LABEL: Record<Severity, string> = { critical: 'קריטי', serious: 'חמור', warning: 'אזהרה', info: 'מידע' }
const utcClock = timeUtc,
  localClock = timeLocal,
  utcDate = dateTimeUtc,
  localDate = dateTimeLocal
const f1 = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d)
const fmtBytes = (n: number) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} ק״מ` : `${Math.round(m)} מ׳`)
const Num = ({ children }: { children: ReactNode }) => (
  <bdi dir="ltr" className="num">
    {children}
  </bdi>
)

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <tr>
      <th scope="row">{k}</th>
      <td>{v}</td>
    </tr>
  )
}

function Findings({ report, fmt }: { report: IntegrityReport; fmt: (t: number) => string }) {
  return (
    <section className="report-section">
      <h2>ממצאים</h2>
      {!report.findings.length ? (
        <p>לא נמצאו ממצאים.</p>
      ) : (
        <ol className="report-findings">
          {report.findings.map((f, i) => (
            <li key={i} className={`sev-${f.severity}`}>
              <div className="rf-head">
                <span className="rf-sev">{SEV_LABEL[f.severity]}</span>
                <b>{f.title}</b>
                {f.at !== undefined && (
                  <span className="rf-time" dir="ltr">
                    {fmt(f.at)}
                  </span>
                )}
              </div>
              <p>{f.detail}</p>
              <p className="rf-benign">
                <b>הסבר תמים אפשרי:</b> {f.benign}
              </p>
            </li>
          ))}
        </ol>
      )}
      {report.passed.length > 0 && (
        <>
          <h3>בדיקות שעברו ({report.passed.length})</h3>
          <ul className="report-list">
            {report.passed.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {report.unavailable.length > 0 && (
        <>
          <h3>בדיקות שלא היו אפשריות על הנתונים האלה</h3>
          <ul className="report-list muted">
            {report.unavailable.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function Verdict({ report, title }: { report: IntegrityReport; title: string }) {
  const counts = (['critical', 'serious', 'warning', 'info'] as Severity[])
    .map((s) => [s, report.findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
  return (
    <section className={`report-verdict v-${report.verdict}`}>
      <div>
        <span className="rv-label">{title}</span>
        <strong>{VERDICT_TEXT[report.verdict].label}</strong>
        <p>{VERDICT_TEXT[report.verdict].summary}</p>
      </div>
      <div className="rv-score">
        <span>ציון חשד</span>
        <strong dir="ltr">{Math.round(report.score)}</strong>
        <span dir="ltr">/ 100</span>
      </div>
      {counts.length > 0 && <p className="rv-counts">{counts.map(([s, n]) => `${n} ${SEV_LABEL[s]}`).join(' · ')}</p>}
    </section>
  )
}

function LogReport({ log, cell, withLocation }: { log: ParsedLog; cell: CellLog | null; withLocation: boolean }) {
  const integrity = useMemo(() => analyzeLog(log.fixes, log.epochs, log.clock), [log])
  const st = useMemo(() => logStats(log), [log])
  const sky = useMemo(() => richestSkyEpoch(log.epochs), [log])
  const cmp = useMemo(() => (cell ? compareGnssCell(log.epochs, cell.samples) : null), [log, cell])
  const t0 = log.epochs[0]?.t ?? st.t0 ?? 0,
    tEnd = log.epochs[log.epochs.length - 1]?.t ?? st.t1 ?? 0
  const fixes = log.fixes.filter((f) => f.provider === st.provider)
  const track = fixes.map((f) => ({ t: f.t, lat: f.lat, lon: f.lon, acc: f.acc }))
  const center = track.length
    ? {
        lat: track.reduce((a, p) => a + p.lat, 0) / track.length,
        lon: track.reduce((a, p) => a + p.lon, 0) / track.length,
      }
    : null
  return (
    <>
      <Verdict report={integrity} title="שלמות האות (שיבוש / זיוף)" />
      <section className="report-section">
        <h2>פרטי המקור</h2>
        <table className="report-table">
          <tbody>
            <Row k="קובץ" v={<bdi>{log.fileName}</bdi>} />
            {log.fileBytes !== undefined && <Row k="גודל" v={<Num>{fmtBytes(log.fileBytes)}</Num>} />}
            <Row
              k="טביעת אצבע (SHA-256)"
              v={log.sha256 ? <code className="hash">{log.sha256}</code> : '— (לא חושבה)'}
            />
            {log.device && <Row k="מכשיר" v={<bdi>{log.device}</bdi>} />}
            <Row
              k="פורמט"
              v={`${log.kind === 'nmea' ? 'NMEA' : 'Android (GPSTest / GnssLogger)'}${log.satSource ? ` · נתוני לוויינים מ-${log.satSource}` : ''}`}
            />
            {st.t0 !== null && (
              <Row
                k="זמן (UTC)"
                v={
                  <Num>
                    {utcDate(st.t0)} – {st.t1 !== null ? utcClock(st.t1) : ''}
                  </Num>
                }
              />
            )}
            <Row k="משך" v={<Num>{fmtDur(st.durationS)}</Num>} />
            <Row
              k="אפוקים"
              v={
                <>
                  <Num>{log.epochs.length}</Num>
                  {st.epochRateHz ? (
                    <>
                      {' '}
                      · <Num>{f1(st.epochRateHz)} Hz</Num>
                    </>
                  ) : null}
                </>
              }
            />
            <Row
              k="פתרונות מיקום"
              v={
                Object.entries(log.providers)
                  .map(([p, n]) => `${p}: ${n}`)
                  .join(' · ') || '—'
              }
            />
            {(log.badLines > 0 || log.truncated) && (
              <Row
                k="הערות"
                v={[
                  log.badLines > 0 && `${log.badLines} שורות פגומות דולגו`,
                  log.truncated && 'הקובץ חרג ממגבלות הבטיחות, חלק לא נטען',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}
          </tbody>
        </table>
      </section>
      <section className="report-section">
        <h2>מדדים</h2>
        <table className="report-table">
          <tbody>
            <Row
              k="לוויינים במעקב"
              v={
                <>
                  <Num>{f1(st.tracked.mean)}</Num> בממוצע (
                  <Num>
                    {st.tracked.min}–{st.tracked.max}
                  </Num>
                  )
                </>
              }
            />
            {st.used && (
              <Row
                k="לוויינים בפתרון"
                v={
                  <>
                    <Num>{f1(st.used.mean)}</Num> בממוצע
                  </>
                }
              />
            )}
            <Row
              k="C/N₀ ממוצע 4 החזקים"
              v={
                <>
                  חציון <Num>{f1(st.strength.median)}</Num> · עשירון תחתון <Num>{f1(st.strength.p10)}</Num> · מינימום{' '}
                  <Num>{f1(st.strength.min)}</Num> dB-Hz
                </>
              }
            />
            {st.provider && (
              <Row
                k={`דיוק (${st.provider})`}
                v={
                  <>
                    חציון <Num>{f1(st.accuracy.median)}</Num> · 95% <Num>{f1(st.accuracy.p95)}</Num> · הטוב ביותר{' '}
                    <Num>{f1(st.accuracy.best)}</Num> מ׳
                  </>
                }
              />
            )}
            {withLocation && st.distanceM > 0 && <Row k="מרחק" v={<Num>{fmtDist(st.distanceM)}</Num>} />}
            {st.maxSpeed !== null && <Row k="מהירות מרבית" v={<Num>{f1((st.maxSpeed ?? 0) * 3.6)} קמ״ש</Num>} />}
            {st.gaps > 0 && (
              <Row
                k="הפסקות בהקלטה"
                v={
                  <>
                    <Num>{st.gaps}</Num> (סה״כ <Num>{fmtDur(st.gapS)}</Num>)
                  </>
                }
              />
            )}
          </tbody>
        </table>
        {st.systems.length > 0 && (
          <table className="report-table sys">
            <thead>
              <tr>
                <th>מערכת</th>
                <th>מקסימום</th>
                <th>ממוצע</th>
                <th>C/N₀ ממוצע</th>
                <th>תדרים</th>
              </tr>
            </thead>
            <tbody>
              {st.systems.map((s) => (
                <tr key={s.sys}>
                  <th scope="row">
                    <i style={{ background: SYS_COLOR[s.sys].light }} />
                    {s.sys}
                  </th>
                  <td>
                    <Num>{s.maxSats}</Num>
                  </td>
                  <td>
                    <Num>{f1(s.meanSats)}</Num>
                  </td>
                  <td>
                    <Num>{f1(s.meanCn0)}</Num>
                  </td>
                  <td>
                    <Num>{s.bands.join(' ') || '—'}</Num>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Findings report={integrity} fmt={utcClock} />
      <section className="report-section">
        <h2>גרפים</h2>
        {integrity.timeline.length > 1 && !integrity.timeline.some((p) => p.v > 0) && (
          <p>ציון החשד נשאר 0 לאורך כל ההקלטה.</p>
        )}
        {integrity.timeline.some((p) => p.v > 0) && (
          <figure>
            <figcaption>ציון החשד לאורך הלוג (UTC)</figcaption>
            <TimeChart
              data={integrity.timeline}
              kind="line"
              unit=""
              format={(v) => v.toFixed(0)}
              ariaLabel="ציון חשד לאורך הלוג"
              fmtTime={utcClock}
            />
          </figure>
        )}
        {log.epochs.length > 0 && (
          <>
            <figure>
              <figcaption>C/N₀ של כל אות לאורך הלוג (קו לכל אות, צבע לפי מערכת)</figcaption>
              <Cn0TimeChart
                epochs={log.epochs}
                t0={t0}
                tFrom={t0}
                tTo={Math.max(tEnd, t0 + 1000)}
                hidden={new Set()}
                focus={null}
                onFocus={() => {}}
              />
            </figure>
            <figure>
              <figcaption>לוויינים במעקב לפי מערכת</figcaption>
              <ConstellationChart epochs={log.epochs} fmtTime={utcClock} />
            </figure>
            <figure>
              <figcaption>מפת חום של C/N₀ לכל לוויין</figcaption>
              <Cn0Heatmap epochs={log.epochs} fmtTime={utcClock} />
            </figure>
            {sky && (
              <figure className="report-sky">
                <figcaption>
                  מפת שמיים, <bdi dir="ltr">{utcClock(sky.t)} UTC</bdi> (הרגע עם הכי הרבה לוויינים)
                </figcaption>
                <SkyPlot signals={sky.signals} />
              </figure>
            )}
          </>
        )}
        {withLocation && center && track.length > 1 && (
          <figure className="report-track">
            <figcaption>מסלול ({st.provider})</figcaption>
            <ScatterPlot points={track} center={center} mode="track" />
          </figure>
        )}
      </section>
      {cell && cmp && (
        <section className="report-section">
          <h2>סלולר והשוואה ל-GNSS</h2>
          <table className="report-table">
            <tbody>
              <Row
                k="קובץ סלולר"
                v={
                  <>
                    <bdi>{cell.fileName}</bdi> · {cell.format} · <Num>{cell.samples.length}</Num> מדידות
                  </>
                }
              />
              <Row k="חפיפה בזמן" v={<Num>{fmtDur(cmp.overlapS)}</Num>} />
            </tbody>
          </table>
          {cmp.overlapS > 0 && (
            <figure>
              <figcaption>עוצמת האות הסלולרי (dBm)</figcaption>
              <CellChart
                samples={cell.samples}
                t0={t0}
                tFrom={t0}
                tTo={Math.max(tEnd, t0 + 1000)}
                bands={cmp.events.map((e) => ({
                  t0: e.t0,
                  t1: e.t1,
                  tone: e.kind === 'gnss-only' ? 'alert' : 'neutral',
                }))}
              />
            </figure>
          )}
          {!cmp.events.length ? (
            <p>לא היו ירידות משמעותיות בעוצמת ה-GNSS בזמן החפיפה.</p>
          ) : (
            <ol className="report-findings">
              {cmp.events.map((e) => (
                <li key={e.t0} className={e.kind === 'gnss-only' ? 'sev-serious' : 'sev-info'}>
                  <div className="rf-head">
                    <b>
                      {e.kind === 'gnss-only'
                        ? 'GNSS נחלש והסלולר לא'
                        : e.kind === 'both'
                          ? 'GNSS והסלולר נחלשו יחד'
                          : e.kind === 'unclear'
                            ? 'GNSS נחלש, הסלולר השתנה מעט'
                            : 'GNSS נחלש, אין מדידות סלולר'}
                    </b>
                    <span className="rf-time" dir="ltr">
                      {utcClock(e.t0)}–{utcClock(e.t1)}
                    </span>
                  </div>
                  <p>
                    GNSS <Num>−{e.gnssDrop.toFixed(1)} dB</Num> · סלולר{' '}
                    <Num>
                      {e.cellDrop === null
                        ? '—'
                        : Math.abs(e.cellDrop) < 0.05
                          ? '0.0 dB'
                          : `${e.cellDrop > 0 ? '−' : '+'}${Math.abs(e.cellDrop).toFixed(1)} dB`}
                    </Num>
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  )
}

function LiveReport({
  fixes,
  gaps,
  motion,
  withLocation,
}: {
  fixes: LivePoint[]
  gaps: Gap[]
  motion: MotionSecond[]
  withLocation: boolean
}) {
  const integrity = useMemo(
    () =>
      analyzeLive(
        fixes.map((f) => ({
          t: f.wall,
          lat: f.lat,
          lon: f.lon,
          alt: f.alt,
          acc: f.acc,
          speed: f.speed,
          heading: null,
        })),
        motion,
      ),
    [fixes, motion],
  )
  const st = useMemo(() => liveStats(fixes, gaps), [fixes, gaps])
  const step = Math.max(1, Math.ceil(fixes.length / 600))
  const accSeries = useMemo(
    () => fixes.filter((_, i) => i % step === 0).map((f) => ({ t: f.wall, v: f.acc })),
    [fixes, step],
  )
  const track = fixes.map((f) => ({ t: f.wall, lat: f.lat, lon: f.lon, acc: f.acc }))
  const center = track.length
    ? {
        lat: track.reduce((a, p) => a + p.lat, 0) / track.length,
        lon: track.reduce((a, p) => a + p.lon, 0) / track.length,
      }
    : null
  const last = fixes[fixes.length - 1]
  return (
    <>
      <Verdict report={integrity} title="שלמות האות (שיבוש / זיוף)" />
      <section className="report-section">
        <h2>פרטי הסשן</h2>
        <table className="report-table">
          <tbody>
            <Row
              k="מקור"
              v={`Geolocation API של הדפדפן · ${isIOS() ? 'אייפון' : isAndroid() ? 'אנדרואיד' : 'מחשב / אחר'}`}
            />
            {st.t0 !== null && (
              <Row
                k="זמן (שעון המכשיר)"
                v={
                  <Num>
                    {localDate(st.t0)} – {st.t1 !== null ? localClock(st.t1) : ''}
                  </Num>
                }
              />
            )}
            <Row k="משך" v={<Num>{fmtDur(st.durationS)}</Num>} />
            <Row
              k="פתרונות"
              v={
                <>
                  <Num>{st.count}</Num>
                  {st.rateHz ? (
                    <>
                      {' '}
                      · <Num>{f1(st.rateHz)} Hz</Num>
                    </>
                  ) : null}
                </>
              }
            />
            <Row k="חיישני תנועה" v={motion.length ? `פעילים (${motion.length} שניות)` : 'לא הופעלו'} />
            {st.gaps > 0 && (
              <Row
                k="הפסקות (מסך נעול / רקע)"
                v={
                  <>
                    <Num>{st.gaps}</Num> (סה״כ <Num>{fmtDur(st.gapS)}</Num>)
                  </>
                }
              />
            )}
          </tbody>
        </table>
      </section>
      <section className="report-section">
        <h2>מדדים</h2>
        <table className="report-table">
          <tbody>
            <Row
              k="דיוק אופקי"
              v={
                <>
                  חציון <Num>{f1(st.accuracy.median)}</Num> · 95% <Num>{f1(st.accuracy.p95)}</Num> · הטוב{' '}
                  <Num>{f1(st.accuracy.best)}</Num> · הגרוע <Num>{f1(st.accuracy.worst)}</Num> מ׳
                </>
              }
            />
            {withLocation && st.distanceM > 0 && <Row k="מרחק" v={<Num>{fmtDist(st.distanceM)}</Num>} />}
            {st.maxSpeed !== null && <Row k="מהירות מרבית" v={<Num>{f1((st.maxSpeed ?? 0) * 3.6)} קמ״ש</Num>} />}
            {st.alt && (
              <Row
                k="גובה"
                v={
                  <Num>
                    {f1(st.alt.min, 0)} – {f1(st.alt.max, 0)} מ׳
                  </Num>
                }
              />
            )}
            {withLocation && last && (
              <Row
                k="מיקום אחרון (WGS84)"
                v={
                  <Num>
                    {last.lat.toFixed(6)}, {last.lon.toFixed(6)}
                  </Num>
                }
              />
            )}
          </tbody>
        </table>
      </section>
      <Findings report={integrity} fmt={localClock} />
      <section className="report-section">
        <h2>גרפים</h2>
        {integrity.timeline.length > 1 && !integrity.timeline.some((p) => p.v > 0) && (
          <p>ציון החשד נשאר 0 לאורך כל ההקלטה.</p>
        )}
        {integrity.timeline.some((p) => p.v > 0) && (
          <figure>
            <figcaption>ציון החשד לאורך הסשן</figcaption>
            <TimeChart
              data={integrity.timeline}
              kind="line"
              unit=""
              format={(v) => v.toFixed(0)}
              ariaLabel="ציון חשד לאורך הסשן"
              fmtTime={localClock}
            />
          </figure>
        )}
        {accSeries.length > 1 && (
          <figure>
            <figcaption>דיוק אופקי (מ׳)</figcaption>
            <TimeChart
              data={accSeries}
              kind="line"
              unit="m"
              format={(v) => v.toFixed(1)}
              ariaLabel="דיוק אופקי לאורך הסשן"
              fmtTime={localClock}
            />
          </figure>
        )}
        {withLocation && center && track.length > 1 && (
          <figure className="report-track">
            <figcaption>מסלול</figcaption>
            <ScatterPlot points={track} center={center} mode="track" />
          </figure>
        )}
      </section>
    </>
  )
}

/** Serialize the report as one self-contained HTML file (styles inlined, canvases as images). */
function toHtmlFile(page: HTMLElement, title: string) {
  const clone = page.cloneNode(true) as HTMLElement
  const src = page.querySelectorAll('canvas'),
    dst = clone.querySelectorAll('canvas')
  src.forEach((c, i) => {
    const img = document.createElement('img')
    try {
      img.src = c.toDataURL('image/png')
    } catch {
      /* tainted: skip */
    }
    img.style.width = c.style.width || `${c.clientWidth}px`
    img.style.height = 'auto'
    dst[i]?.replaceWith(img)
  })
  // Charts are drawn in pixels; a viewBox lets the saved file shrink them to fit a phone screen.
  clone.querySelectorAll('svg').forEach((svg) => {
    const w = svg.getAttribute('width'),
      h = svg.getAttribute('height')
    if (w && h && !svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  })
  const css: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const r of Array.from(sheet.cssRules)) css.push(r.cssText)
    } catch {
      /* cross-origin sheet */
    }
  }
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
  // The saved file gets its own strict policy: no scripts, no network, only its inline styles and images.
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${css.join('\n')}</style></head><body class="report-file">${clone.outerHTML}</body></html>`
}

export function ReportView({ input, onClose }: { input: ReportInput; onClose: () => void }) {
  const [withLocation, setWithLocation] = useState(true)
  const [showHow, setShowHow] = useState(false)
  const page = useRef<HTMLElement>(null)
  const [generated] = useState(() => Date.now())
  const title = input.kind === 'log' ? 'דוח ניתוח לוג GNSS' : 'דוח סשן מעקב חי'
  const stamp = new Date(generated).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  const baseName =
    input.kind === 'log'
      ? `gnss-report-${input.log.fileName
          .replace(/\.[^.]+$/, '')
          .replace(/[^\w.-]+/g, '_')
          .slice(0, 60)}-${stamp}`
      : `gnss-live-report-${stamp}`

  // While printing (our button or the browser's own menu) and while saving the file, charts are
  // drawn at A4 content width, so a report opened on a phone still fills the page.
  const [printW, setPrintW] = useState<number | null>(null)
  useEffect(() => {
    document.body.classList.add('report-open')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const before = () => flushSync(() => setPrintW(PRINT_WIDTH))
    const after = () => setPrintW(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      document.body.classList.remove('report-open')
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [onClose])

  const print = () => {
    // The PDF's default file name comes from the page title.
    const old = document.title
    document.title = baseName
    const restore = () => {
      document.title = old
      window.removeEventListener('afterprint', restore)
    }
    window.addEventListener('afterprint', restore)
    window.print()
    window.setTimeout(restore, 60000)
  }
  const download = () => {
    if (!page.current) return
    flushSync(() => setPrintW(PRINT_WIDTH))
    const html = toHtmlFile(page.current, title)
    setPrintW(null)
    const blob = new Blob([html], { type: 'text/html' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${baseName}.html`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  return createPortal(
    <div className="report-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="report-toolbar">
        <button className="primary-button" onClick={print}>
          <Printer size={18} /> שמור PDF
        </button>
        <button className="text-button" onClick={download}>
          <Download size={16} /> הורד קובץ
        </button>
        <label className="report-toggle">
          <input
            type="checkbox"
            checked={withLocation}
            onChange={(e) => setWithLocation(e.target.checked)}
            aria-label="כולל מיקום ומסלול"
          />{' '}
          מיקום
        </label>
        <button
          className="text-button"
          onClick={() => setShowHow(!showHow)}
          aria-expanded={showHow}
          aria-label="איך שומרים?"
        >
          <FileText size={16} /> איך?
        </button>
        <button className="text-button report-close" onClick={onClose} aria-label="סגור את הדוח">
          <X size={18} />
        </button>
        {showHow && (
          <div className="report-how">
            <p>
              <b>שמור כ-PDF</b> פותח את מסך ההדפסה של הטלפון:
            </p>
            <ul>
              <li>
                <b>אייפון:</b> במסך ההדפסה לוחצים על כפתור השיתוף למעלה, ואז <b>"שמור בקבצים"</b>. אפשר גם לשלוח ישר
                בוואטסאפ או במייל.
              </li>
              <li>
                <b>אנדרואיד:</b> בוחרים מדפסת <b>"שמירה כ-PDF"</b> ולוחצים על כפתור ההורדה.
              </li>
              <li>
                <b>מחשב:</b> ביעד בוחרים <b>"שמירה כ-PDF"</b>.
              </li>
            </ul>
            <p>
              <b>הורד קובץ</b> שומר את הדוח כקובץ HTML. הוא נפתח בכל דפדפן, גם בלי אינטרנט, ואפשר להדפיס ממנו PDF. זו
              הדרך אם מסך ההדפסה לא נפתח, למשל כשהאתר פתוח ממסך הבית באייפון.
            </p>
            <p>
              כשמשתפים את הדוח עם מישהו אחר, אפשר לבטל את <b>"כולל מיקום ומסלול"</b>. אז הקואורדינטות, המסלול והמרחק לא
              ייכללו.
            </p>
          </div>
        )}
      </div>
      <ForcedWidth.Provider value={printW}>
        <article ref={page} className="report-page">
          <header className="report-header">
            <h1>{title}</h1>
            <p>
              אטלס GNSS ·{' '}
              <bdi dir="ltr">
                v{__APP_VERSION__} ({__BUILD_SHA__})
              </bdi>{' '}
              · נוצר <bdi dir="ltr">{localDate(generated)}</bdi>
            </p>
          </header>
          {input.kind === 'log' ? (
            <LogReport log={input.log} cell={input.cell} withLocation={withLocation} />
          ) : (
            <LiveReport fixes={input.fixes} gaps={input.gaps} motion={input.motion} withLocation={withLocation} />
          )}
          <footer className="report-foot">
            <p>
              <b>שיטה:</b> הממצאים הם הערכה היוריסטית. "חשד" אומר שהדפוס מתאים להפרעה, לא שהוכחה התקפה. לכל ממצא מופיע
              גם הסבר תמים אפשרי.
            </p>
            <p>
              <b>פרטיות:</b> הדוח נוצר במכשיר מנתונים שכבר היו בו. שום דבר לא נשלח לשרת.
              {withLocation ? '' : ' המיקום והמסלול הושמטו מהדוח הזה.'}
            </p>
          </footer>
        </article>
      </ForcedWidth.Provider>
    </div>,
    document.body,
  )
}
