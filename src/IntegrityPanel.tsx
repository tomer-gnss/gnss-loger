import { useState } from 'react'
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronDown, Info, ShieldAlert, ShieldCheck } from 'lucide-react'
import { VERDICT_TEXT, type Finding, type IntegrityReport, type Severity } from './integrity'

const SEV: Record<Severity, { label: string; Icon: typeof AlertOctagon }> = {
  critical: { label: 'קריטי', Icon: AlertOctagon },
  serious: { label: 'חמור', Icon: AlertTriangle },
  warning: { label: 'אזהרה', Icon: AlertTriangle },
  info: { label: 'מידע', Icon: Info },
}

function FindingRow({ f }: { f: Finding }) {
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
      </div>}
    </li>
  )
}

export function IntegrityPanel({ report, minPoints, points, compact }: {
  report: IntegrityReport
  /** How many fixes are needed before the verdict means anything. */
  minPoints: number
  points: number
  compact?: boolean
}) {
  const [showPassed, setShowPassed] = useState(false)
  const v = VERDICT_TEXT[report.verdict]
  const warming = points < minPoints
  const Icon = report.verdict === 'ok' ? ShieldCheck : ShieldAlert
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
      {!warming && report.findings.length > 0 && <ul className="finding-list">{report.findings.map((f) => <FindingRow key={f.id} f={f} />)}</ul>}
      {!warming && !compact && <div className="integrity-foot">
        <button className="link-button" onClick={() => setShowPassed(!showPassed)}>{showPassed ? 'הסתר' : 'הצג'} בדיקות שעברו ({report.passed.length})</button>
        {showPassed && <ul className="passed-list">{report.passed.map((p) => <li key={p}><CheckCircle2 size={14} />{p}</li>)}</ul>}
        {report.unavailable.length > 0 && <p className="muted"><b>לא נבדק:</b> {report.unavailable.join(' · ')}</p>}
      </div>}
      <p className="muted integrity-note">הערכה היוריסטית. "חשד" אומר שהדפוס מתאים להפרעה, לא שיש התקפה. הסברים תמימים מוצגים ליד כל ממצא.</p>
    </section>
  )
}
