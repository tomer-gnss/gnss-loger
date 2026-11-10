import { useState, type ReactNode } from 'react'
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronDown, Crosshair, Info, ShieldAlert, ShieldCheck } from 'lucide-react'
import { VERDICT_TEXT, type Finding, type IntegrityReport, type Severity } from './integrity'
import { TimeChart } from './LiveCharts'

const SEV: Record<Severity, { label: string; Icon: typeof AlertOctagon }> = {
  critical: { label: 'קריטי', Icon: AlertOctagon },
  serious: { label: 'חמור', Icon: AlertTriangle },
  warning: { label: 'אזהרה', Icon: AlertTriangle },
  info: { label: 'מידע', Icon: Info },
}

function FindingRow({ f, onJump }: { f: Finding; onJump?: (t: number) => void }) {
  const [open, setOpen] = useState(f.severity === 'critical' || f.severity === 'serious')
  const { label, Icon } = SEV[f.severity]
  return (
    <li className={`finding ${f.severity}`}>
      <button className="finding-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon size={18} />
        <span className="finding-title">{f.title}</span>
        <span className="finding-sev">{label}</span>
        <ChevronDown size={16} className={open ? 'flip' : ''} />
      </button>
      {open && <div className="finding-body">
        <p><b>ראיות:</b> {f.detail}</p>
        <p><b>הסבר תמים אפשרי:</b> {f.benign}</p>
        {onJump && f.at !== undefined && <button className="text-button jump-button" onClick={() => onJump(f.at!)}><Crosshair size={15} /> הצג את הרגע הזה</button>}
      </div>}
    </li>
  )
}

/** Index of the last timeline point at or before t. */
function indexAt(arr: { t: number }[], t: number) {
  let lo = 0, hi = arr.length - 1, ans = 0
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
  return ans
}

export function IntegrityPanel({ report, minPoints, points, compact, onJump, markerT, fmtTime, extra }: {
  report: IntegrityReport
  /** How many fixes are needed before the verdict means anything. */
  minPoints: number
  points: number
  compact?: boolean
  /** Log tab: move the playhead to this time. */
  onJump?: (t: number) => void
  /** Log tab: current playhead time, drawn on the timeline. */
  markerT?: number
  fmtTime?: (t: number) => string
  /** Extra controls rendered under the header (e.g. the sensors switch). */
  extra?: ReactNode
}) {
  const [showPassed, setShowPassed] = useState(false)
  const v = VERDICT_TEXT[report.verdict]
  const warming = points < minPoints
  const Icon = report.verdict === 'ok' ? ShieldCheck : ShieldAlert
  const tl = report.timeline
  const peak = tl.reduce((m, p) => Math.max(m, p.v), 0)
  return (
    <section className={`panel integrity ${warming ? 'warming' : report.verdict}`} aria-live="polite">
      <div className="integrity-head">
        <Icon size={26} />
        <div>
          <h2>{warming ? 'בודק שלמות אות…' : v.label}</h2>
          <p>{warming ? `נאספו ${points} מתוך ${minPoints} פתרונות שנדרשים להערכה ראשונה.` : v.summary}</p>
        </div>
        {!warming && <span className="integrity-score" title="ציון חשד, 0–100"><b>{report.score}</b>/100</span>}
      </div>
      {extra}
      {!warming && report.findings.length > 0 && <ul className="finding-list">{report.findings.map((f) => <FindingRow key={f.id} f={f} onJump={onJump} />)}</ul>}
      {!warming && tl.length >= 2 && <div className="integrity-timeline">
        <h3>רמת חשד לאורך זמן</h3>
        <p className="muted">{peak === 0 ? 'שטוח לאורך כל הזמן: אין רגע חשוד.' : onJump ? 'כל עלייה היא רגע שבו נמצאה ראיה. הקש על הגרף כדי לקפוץ אליו.' : 'כל עלייה היא רגע שבו נמצאה ראיה.'}</p>
        <TimeChart data={tl} kind="line" unit="" format={(x) => Math.round(x).toString()} ariaLabel="רמת חשד לשיבוש או זיוף לאורך זמן"
          markerIndex={markerT !== undefined ? indexAt(tl, markerT) : undefined}
          onPick={onJump ? (i) => onJump(tl[i].t) : undefined}
          endLabel={fmtTime ? fmtTime(tl[tl.length - 1].t) : undefined} fmtTime={fmtTime} refValue={45} refLabel="קריטי" />
      </div>}
      {!warming && !compact && <div className="integrity-foot">
        <button className="link-button" onClick={() => setShowPassed(!showPassed)}>{showPassed ? 'הסתר' : 'הצג'} בדיקות שעברו ({report.passed.length})</button>
        {showPassed && <ul className="passed-list">{report.passed.map((p) => <li key={p}><CheckCircle2 size={14} />{p}</li>)}</ul>}
        {report.unavailable.length > 0 && <p className="muted"><b>לא נבדק:</b> {report.unavailable.join(' · ')}</p>}
      </div>}
      <p className="muted integrity-note">הערכה היוריסטית. "חשד" אומר שהדפוס מתאים להפרעה, לא שיש התקפה. הסברים תמימים מוצגים ליד כל ממצא.</p>
    </section>
  )
}
