// "GNSS status center" card: regional interference from aircraft (Stanford), satellite health
// (Galmon), space weather (NOAA). Opt-in; nothing about the user is sent (every file is global and
// analysed here). Live tab: "now" around the phone. Log tab: the log's own day and place.

import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CloudSun, Radar, RefreshCw, Satellite, ShieldAlert } from 'lucide-react'
import {
  loadHealth,
  loadRfi,
  loadSpaceWeather,
  RFI,
  STANFORD_ATTRIBUTION,
  summarizeRfi,
  unhealthyOverhead,
  type HealthSummary,
  type Hotspot,
  type Pos,
  type RfiCell,
  type RfiSummary,
  type SpaceWeather,
  type SpoofEvent,
  type StatusContext,
} from './statusFeeds'
import { SEQ_RED } from './colors'
import { cardinal, dateTimeLocal, timeLocal } from './format'
import { useWidth } from './useWidth'

const CONSENT = 'atlas.statusConsent'
const readConsent = () => {
  try {
    return sessionStorage.getItem(CONSENT) === '1'
  } catch {
    return false
  }
}
const pct = (low: number, total: number) => (total ? Math.round((low / total) * 100) : 0)
const redFor = (ratio: number) =>
  SEQ_RED[Math.min(SEQ_RED.length - 1, Math.floor(Math.min(1, ratio / 0.6) * (SEQ_RED.length - 1)))]
const dayLabel = (iso: string) => iso.split('-').reverse().slice(0, 2).join('.')

const RFI_TEXT: Record<RfiSummary['level'], { label: string; tone: string }> = {
  strong: { label: 'שיבוש פעיל באזור', tone: 'bad' },
  some: { label: 'שיבוש בסביבה', tone: 'warn' },
  clear: { label: 'אין שיבוש מדווח', tone: 'good' },
  'no-data': { label: 'אין מספיק מטוסים באזור', tone: 'off' },
}
const SPACE_TEXT: Record<SpaceWeather['level'], { label: string; tone: string; note: string }> = {
  quiet: { label: 'שקט', tone: 'good', note: 'השמיים לא אמורים להשפיע על הדיוק.' },
  unsettled: { label: 'לא יציב', tone: 'warn', note: 'השפעה קלה אפשרית על הדיוק, בעיקר בקווי רוחב גבוהים.' },
  storm: {
    label: 'סערה גיאומגנטית',
    tone: 'warn',
    note: 'בישראל ההשפעה בדרך כלל קטנה. דיוק ירוד מעט אפשרי, במיוחד במקלט חד-תדרי.',
  },
  severe: {
    label: 'סערה חזקה',
    tone: 'bad',
    note: 'סערה חזקה יכולה להוריד את הדיוק גם בישראל. זה הסבר תמים לסטיות, לפני שחושדים בשיבוש.',
  },
}

/** Interference radar: the user in the centre, hotspots and spoofing events by direction and distance. */
function InterferenceRadar({ rfi }: { rfi: RfiSummary }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [pick, setPick] = useState<{ kind: 'h'; h: Hotspot } | { kind: 's'; s: SpoofEvent } | null>(null)
  const size = Math.min(width, 380)
  const c = size / 2,
    R = c - 22,
    maxKm = RFI.regionKm
  const xy = (distKm: number, bearing: number) => {
    const r = (Math.min(distKm, maxKm) / maxKm) * R,
      a = (bearing * Math.PI) / 180
    return [c + r * Math.sin(a), c - r * Math.cos(a)] as const
  }
  const spoof = rfi.spoofing.filter((s) => s.distKm <= maxKm)
  const onPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left,
      py = e.clientY - r.top
    let best: typeof pick = null,
      bestD = 22
    for (const h of rfi.hotspots) {
      const [x, y] = xy(h.distKm, h.bearing)
      const d = Math.hypot(x - px, y - py)
      if (d < bestD) {
        bestD = d
        best = { kind: 'h', h }
      }
    }
    for (const s of spoof) {
      const [x, y] = xy(s.distKm, s.bearing)
      const d = Math.hypot(x - px, y - py)
      if (d < bestD) {
        bestD = d
        best = { kind: 's', s }
      }
    }
    setPick(best)
  }
  return (
    <div ref={ref} className="radar-wrap">
      <svg
        width={size}
        height={size}
        className="radar"
        role="img"
        aria-label={`מכ״ם שיבושים: ${rfi.hotspots.length} מוקדים ברדיוס ${maxKm} ק״מ`}
        onPointerDown={onPointer}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse') onPointer(e)
        }}
      >
        <circle cx={c} cy={c} r={R} className="radar-bg" />
        {[100, 200, 300, 400].map((km) => (
          <g key={km}>
            <circle cx={c} cy={c} r={(km / maxKm) * R} className="radar-ring" />
            <text x={c + (km / maxKm) * R * 0.71 + 3} y={c + (km / maxKm) * R * 0.71 - 3} className="radar-label">
              {km} ק״מ
            </text>
          </g>
        ))}
        <line x1={c} y1={c - R} x2={c} y2={c + R} className="radar-axis" />
        <line x1={c - R} y1={c} x2={c + R} y2={c} className="radar-axis" />
        {[
          ['N', 0],
          ['E', 90],
          ['S', 180],
          ['W', 270],
        ].map(([l, b]) => {
          const [x, y] = xy(maxKm * 1.06, b as number)
          return (
            <text key={l} x={x} y={y + 4} className="radar-card" textAnchor="middle">
              {l}
            </text>
          )
        })}
        {[...rfi.hotspots].reverse().map((h, i) => {
          const [x, y] = xy(h.distKm, h.bearing)
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={4 + Math.min(10, Math.sqrt(h.total))}
              fill={redFor(h.ratio)}
              fillOpacity={0.85}
              stroke="#fff"
              strokeWidth={1}
            />
          )
        })}
        {spoof.map((s) => {
          const [x, y] = xy(s.distKm, s.bearing)
          return (
            <path
              key={s.id + s.start}
              d={`M${x} ${y - 8}L${x + 7} ${y + 5}L${x - 7} ${y + 5}Z`}
              className="radar-spoof"
            />
          )
        })}
        {pick &&
          (() => {
            const [x, y] = pick.kind === 'h' ? xy(pick.h.distKm, pick.h.bearing) : xy(pick.s.distKm, pick.s.bearing)
            return <circle cx={x} cy={y} r={15} className="radar-pick" />
          })()}
        <circle cx={c} cy={c} r={5} className="radar-me" />
      </svg>
      <p className="radar-tip">
        {pick?.kind === 'h' ? (
          <>
            מוקד: <b>{Math.round(pick.h.ratio * 100)}%</b> מ-{pick.h.total} מטוסים עם GNSS ירוד ·{' '}
            {Math.round(pick.h.distKm)} ק״מ {cardinal(pick.h.bearing)}
          </>
        ) : pick?.kind === 's' ? (
          <>
            אירוע זיוף: {pick.s.flights} טיסות · {Math.round(pick.s.distKm)} ק״מ {cardinal(pick.s.bearing)} ·{' '}
            <bdi dir="ltr">{dateTimeLocal(pick.s.start)}</bdi>
          </>
        ) : (
          'נגיעה בנקודה מציגה פרטים. עיגול: מוקד שיבוש (גודל = מספר מטוסים, צבע = אחוז עם GNSS ירוד). משולש: אירוע זיוף.'
        )}
      </p>
    </div>
  )
}

export function StatusCenter({
  pos,
  day,
  mode,
  onContext,
}: {
  pos: (Pos & { alt?: number | null }) | null
  day?: number
  mode: 'live' | 'log'
  onContext?: (ctx: StatusContext | null) => void
}) {
  const [consent, setConsent] = useState(readConsent)
  const [h3, setH3] = useState<typeof import('h3-js') | null>(null)
  const [rfiData, setRfiData] = useState<{
    date: string
    cells: RfiCell[]
    events: Omit<SpoofEvent, 'distKm' | 'bearing'>[]
  } | null>(null)
  const [health, setHealth] = useState<HealthSummary | null>(null)
  const [space, setSpace] = useState<SpaceWeather | null>(null)
  const [errors, setErrors] = useState<Partial<Record<'rfi' | 'health' | 'space', string>>>({})
  const [tick, setTick] = useState(0)
  const live = mode === 'live'
  const hasPos = pos !== null

  const fail = (k: 'rfi' | 'health' | 'space') => (e: unknown) =>
    setErrors((x) => ({ ...x, [k]: e instanceof Error ? e.message : String(e) }))

  // Interference data: needs a position (only to pick the area here, on the device).
  useEffect(() => {
    if (!consent || !hasPos) return
    let cancelled = false
    Promise.all([import('h3-js'), loadRfi(day)])
      .then(([h, d]) => {
        if (!cancelled) {
          setH3(h)
          setRfiData(d)
        }
      })
      .catch((e) => {
        if (!cancelled) fail('rfi')(e)
      })
    return () => {
      cancelled = true
    }
  }, [consent, hasPos, day, tick])
  // Satellite health and space weather are "now": live tab only, refreshed every 5 / 15 minutes.
  useEffect(() => {
    if (!consent || !live) return
    const getHealth = () => loadHealth().then(setHealth).catch(fail('health'))
    const getSpace = () => loadSpaceWeather().then(setSpace).catch(fail('space'))
    void getHealth()
    void getSpace()
    const a = window.setInterval(getHealth, 5 * 60_000),
      b = window.setInterval(getSpace, 15 * 60_000)
    return () => {
      window.clearInterval(a)
      window.clearInterval(b)
    }
  }, [consent, live, tick])

  const rfi = useMemo(
    () => (h3 && rfiData && pos ? summarizeRfi(rfiData.cells, rfiData.events, pos, rfiData.date, h3) : null),
    // Re-analyse when the user moves ~1 km, not on every fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [h3, rfiData, pos?.lat.toFixed(2), pos?.lon.toFixed(2)],
  )
  const overhead = useMemo(
    () => (health && pos ? unhealthyOverhead(health, pos).map((s) => s.name) : []),
    [health, pos],
  )

  useEffect(() => {
    if (!onContext) return
    onContext(
      consent && pos && (rfi || health || space)
        ? { pos: { lat: pos.lat, lon: pos.lon }, rfi, health, overheadUnhealthy: overhead, space, mode }
        : null,
    )
  }, [consent, pos, rfi, health, space, overhead, mode, onContext])

  const enable = () => {
    try {
      sessionStorage.setItem(CONSENT, '1')
    } catch {
      /* blocked */
    }
    setConsent(true)
  }
  const disable = () => {
    try {
      sessionStorage.removeItem(CONSENT)
    } catch {
      /* blocked */
    }
    setConsent(false)
    setRfiData(null)
    setHealth(null)
    setSpace(null)
    setErrors({})
  }

  return (
    <section className="panel status-center">
      <div className="panel-heading">
        <div>
          <h2>
            <Radar size={19} className="inline-icon" /> מרכז מצב GNSS
          </h2>
          <p>
            {live
              ? 'האם זו התקפה, הלוויינים, השמיים, או הסביבה שלי?'
              : 'הקשר חיצוני ליום ולמקום של הלוג: האם מטוסים דיווחו על שיבוש באזור באותו יום?'}
          </p>
        </div>
        {consent && (
          <button
            className="text-button"
            onClick={() => {
              setErrors({})
              setTick((t) => t + 1)
            }}
            aria-label="רענן"
          >
            <RefreshCw size={16} /> רענן
          </button>
        )}
      </div>

      {!consent ? (
        <div className="map-consent">
          <p>
            {live ? 'שלושה מקורות ציבוריים' : 'מקור ציבורי'}, שמורדים <b>כקבצים עולמיים שלמים</b>.{' '}
            <b>המיקום שלך לא נשלח</b>: האזור שלך נבחר בטלפון.
          </p>
          <ul className="steps">
            <li>
              <b>Stanford GPS Lab</b>: מטוסים שדיווחו על GNSS ירוד, לפי אזור, ואירועי זיוף. מתעדכן יומית, באיחור של 2–3
              ימים.
            </li>
            {live && (
              <li>
                <b>Galmon</b>: מצב כל לוויין ואות בזמן אמת, ואילו לווייני Galileo משדרים אימות OSNMA.
              </li>
            )}
            {live && (
              <li>
                <b>NOAA</b>: מזג אוויר חללי: סערות גיאומגנטיות, מדד Kp ותחזית.
              </li>
            )}
          </ul>
          <button className="primary-button" onClick={enable}>
            <Radar size={18} /> הפעל מרכז מצב
          </button>
        </div>
      ) : (
        <>
          <div className="status-tiles">
            <article className={`status-tile ${rfi ? RFI_TEXT[rfi.level].tone : 'off'}`}>
              <h3>
                <ShieldAlert size={17} /> שיבושים באזור
              </h3>
              {!hasPos ? (
                <p className="muted">{live ? 'הפעל מעקב כדי לבחור את האזור שלך.' : 'אין מיקום בלוג.'}</p>
              ) : errors.rfi ? (
                <p className="error-text">
                  {errors.rfi === '404'
                    ? 'אין נתוני Stanford לתאריך הזה (הנתונים מתחילים ב-2024).'
                    : `לא זמין: ${errors.rfi}`}
                </p>
              ) : !rfi ? (
                <p className="muted">טוען…</p>
              ) : (
                <>
                  <strong>{RFI_TEXT[rfi.level].label}</strong>
                  <p>
                    {rfi.near.total ? (
                      <>
                        ב-{RFI.nearKm} הק״מ סביבך: <b>{pct(rfi.near.low, rfi.near.total)}%</b> מ-
                        {rfi.near.total.toLocaleString('he-IL')} מעברי מטוסים עם GNSS ירוד.
                      </>
                    ) : (
                      `כמעט אין מטוסים ב-${RFI.nearKm} הק״מ סביבך.`
                    )}
                    {rfi.hotspots[0] && (
                      <>
                        {' '}
                        המוקד החזק ב-{RFI.regionKm} ק״מ: <b>{Math.round(rfi.hotspots[0].ratio * 100)}%</b>,{' '}
                        {Math.round(rfi.hotspots[0].distKm)} ק״מ {cardinal(rfi.hotspots[0].bearing)}.
                      </>
                    )}
                  </p>
                  <p className="muted">
                    נתוני {dayLabel(rfi.date)}
                    {live ? ' (הזמינים האחרונים)' : ''}.
                    {rfi.spoofing.length ? ` ${rfi.spoofing.length} אירועי זיוף זוהו ב-${RFI.spoofKm} ק״מ.` : ''}
                  </p>
                </>
              )}
            </article>

            {live && (
              <article className={`status-tile ${health ? (overhead.length ? 'warn' : 'good') : 'off'}`}>
                <h3>
                  <Satellite size={17} /> מצב הלוויינים
                </h3>
                {errors.health ? (
                  <p className="error-text">לא זמין: {errors.health}</p>
                ) : !health ? (
                  <p className="muted">טוען…</p>
                ) : (
                  (() => {
                    const bad = health.bySys.flatMap((g) => g.unhealthy)
                    return (
                      <>
                        <strong>{bad.length ? `${bad.length} לוויינים לא תקינים` : 'כל הלוויינים תקינים'}</strong>
                        {bad.length > 0 && (
                          <p>
                            {health.bySys
                              .filter((g) => g.unhealthy.length)
                              .map((g) => `${g.sys}: ${g.unhealthy.map((s) => s.name).join(', ')}`)
                              .join(' · ')}
                            .
                          </p>
                        )}
                        {hasPos && bad.length > 0 && (
                          <p>
                            {overhead.length ? (
                              <>
                                מעליך עכשיו: <b dir="ltr">{overhead.join(', ')}</b>. מקלט תקין מתעלם מהם.
                              </>
                            ) : (
                              'אף אחד מהם לא מעליך עכשיו.'
                            )}
                          </p>
                        )}
                        <p className="muted">
                          OSNMA (אימות Galileo): {health.osnma} מתוך {health.galileo} לווייני Galileo. מעודכן{' '}
                          {timeLocal(health.fetchedAt)}.
                        </p>
                      </>
                    )
                  })()
                )}
              </article>
            )}

            {live && (
              <article className={`status-tile ${space ? SPACE_TEXT[space.level].tone : 'off'}`}>
                <h3>
                  <CloudSun size={17} /> מזג אוויר חללי
                </h3>
                {errors.space ? (
                  <p className="error-text">לא זמין: {errors.space}</p>
                ) : !space ? (
                  <p className="muted">טוען…</p>
                ) : (
                  <>
                    <strong>
                      {SPACE_TEXT[space.level].label}
                      {space.kp !== null && (
                        <>
                          {' '}
                          · Kp <bdi dir="ltr">{space.kp.toFixed(1)}</bdi>
                        </>
                      )}
                    </strong>
                    <p>{SPACE_TEXT[space.level].note}</p>
                    {space.kpForecastMax !== null && space.kpForecastMax >= 5 && (
                      <p>
                        צפוי Kp עד <b dir="ltr">{space.kpForecastMax.toFixed(1)}</b> ב-72 השעות הקרובות (סערה G
                        {Math.min(5, Math.floor(space.kpForecastMax) - 4)}).
                      </p>
                    )}
                    <p className="muted">
                      סולמות NOAA: G{space.g} · S{space.s} · R{space.r}
                      {space.notices[0] ? ` · ${space.notices[0].text}` : ''}
                    </p>
                  </>
                )}
              </article>
            )}
          </div>

          {rfi && (rfi.hotspots.length > 0 || rfi.spoofing.length > 0) && (
            <>
              <h3 className="plots-sub">מכ״ם שיבושים ({RFI.regionKm} ק״מ)</h3>
              <InterferenceRadar rfi={rfi} />
            </>
          )}
          {rfi && rfi.hotspots.length > 0 && (
            <ul className="hotspot-list">
              {rfi.hotspots.slice(0, 5).map((h, i) => (
                <li key={i}>
                  <i style={{ background: redFor(h.ratio) }} />
                  <b>{Math.round(h.ratio * 100)}%</b> מ-{h.total} מטוסים · {Math.round(h.distKm)} ק״מ{' '}
                  {cardinal(h.bearing)}
                </li>
              ))}
            </ul>
          )}

          <p className="muted source-note">
            הערכה: מטוס שמדווח על GNSS ירוד מעיד על שיבוש באזור, אבל המטוס בגובה, ולכן משבש קרוב לקרקע יכול להשפיע עליו
            אחרת מאשר עליך. {STANFORD_ATTRIBUTION}
            {live ? ' · galmon.eu · NOAA SWPC' : ''}.{' '}
            <button className="link-button" onClick={disable}>
              כבה
            </button>
          </p>
        </>
      )}
    </section>
  )
}

/** The same context as a printable report section (no network: uses what the card already loaded). */
export function StatusReportSection({ ctx, withLocation }: { ctx: StatusContext; withLocation: boolean }) {
  const { rfi, health, space } = ctx
  const bad = health ? health.bySys.flatMap((g) => g.unhealthy) : []
  return (
    <section className="report-section">
      <h2>הקשר חיצוני</h2>
      <table className="report-table">
        <tbody>
          {rfi && (
            <tr>
              <th scope="row">שיבושים באזור (Stanford, {dayLabel(rfi.date)})</th>
              <td>
                <b>{RFI_TEXT[rfi.level].label}</b>
                {rfi.near.total > 0 && (
                  <>
                    {' '}
                    · ב-{RFI.nearKm} ק״מ: {pct(rfi.near.low, rfi.near.total)}% מ-{rfi.near.total} מעברי מטוסים עם GNSS
                    ירוד
                  </>
                )}
                {withLocation && rfi.hotspots[0] && (
                  <>
                    {' '}
                    · מוקד חזק: {Math.round(rfi.hotspots[0].ratio * 100)}%, {Math.round(rfi.hotspots[0].distKm)} ק״מ{' '}
                    {cardinal(rfi.hotspots[0].bearing)}
                  </>
                )}
                {rfi.spoofing.length > 0 && (
                  <>
                    {' '}
                    · {rfi.spoofing.length} אירועי זיוף ב-{RFI.spoofKm} ק״מ
                  </>
                )}
              </td>
            </tr>
          )}
          {health && (
            <tr>
              <th scope="row">מצב הלוויינים (Galmon, {timeLocal(health.fetchedAt)})</th>
              <td>
                {bad.length ? `${bad.length} לא תקינים: ${bad.map((s) => s.name).join(', ')}` : 'כל הלוויינים תקינים'}
                {ctx.overheadUnhealthy.length > 0 && <> · מעל האופק: {ctx.overheadUnhealthy.join(', ')}</>} · OSNMA:{' '}
                {health.osnma}/{health.galileo} לווייני Galileo
              </td>
            </tr>
          )}
          {space && (
            <tr>
              <th scope="row">מזג אוויר חללי (NOAA)</th>
              <td>
                {SPACE_TEXT[space.level].label}
                {space.kp !== null && <> · Kp {space.kp.toFixed(1)}</>} · G{space.g} S{space.s} R{space.r}
                {space.kpForecastMax !== null && space.kpForecastMax >= 5 && (
                  <> · צפוי Kp עד {space.kpForecastMax.toFixed(1)}</>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {withLocation && rfi && (rfi.hotspots.length > 0 || rfi.spoofing.length > 0) && (
        <figure className="report-radar">
          <figcaption>מכ״ם שיבושים: מוקדים ברדיוס {RFI.regionKm} ק״מ ממקום ההקלטה</figcaption>
          <InterferenceRadar rfi={rfi} />
        </figure>
      )}
      <p className="muted">
        {STANFORD_ATTRIBUTION}
        {health ? ' · galmon.eu' : ''}
        {space ? ' · NOAA SWPC' : ''}.
      </p>
    </section>
  )
}
