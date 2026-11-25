import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Activity, ChartLine, Crosshair, Satellite } from 'lucide-react'
import { stats, useGeolocation, useWakeLock, type GeoStatus } from './geo'
import { LogView } from './LogView'
import { ErrorBoundary } from './ErrorBoundary'
import { useMotion } from './motion'
import { PlotsView } from './PlotsView'
import { useSerialReceiver } from './serialReceiver'
import type { ParsedLog } from './logParser'
import type { CellLog } from './cellParser'
import { AppInfo, Welcome } from './AppInfo'
import { ReportView, type ReportInput } from './ReportView'
import { welcomeSeen } from './localData'
import { LiveActionBar, LiveView } from './LiveView'
import type { StatusContext } from './statusFeeds'
import './dashboard.css'

/** Keeps "1.0 Hz" / "±4.4 m" in left-to-right order inside RTL Hebrew text. */
const Num = ({ children }: { children: ReactNode }) => (
  <bdi dir="ltr" className="num">
    {children}
  </bdi>
)

function LiveBadge({ status, hz }: { status: GeoStatus; hz: number | null }) {
  const map: Record<GeoStatus, [string, ReactNode]> = {
    active: [
      'live',
      hz ? (
        <>
          חי · <Num>{hz.toFixed(1)} Hz</Num>
        </>
      ) : (
        'חי'
      ),
    ],
    waiting: ['warn', 'ממתין לפתרון'],
    requesting: ['warn', 'מתחבר…'],
    idle: ['off', 'מושהה'],
    denied: ['bad', 'אין הרשאה'],
    insecure: ['bad', 'דורש HTTPS'],
    unsupported: ['bad', 'לא נתמך'],
  }
  const [tone, text] = map[status]
  return (
    <span className={`live-badge ${tone}`}>
      <span className="live-dot" />
      {text}
    </span>
  )
}

function App() {
  // Tracking, sensors, the receiver connection and loaded files live here, so they survive tab switches.
  const geo = useGeolocation()
  const motion = useMotion()
  const [keepAwake, setKeepAwake] = useState(true)
  const wake = useWakeLock(keepAwake && geo.running)
  const [tab, setTab] = useState<'live' | 'log' | 'plots'>('live')
  const rx = useSerialReceiver()
  const [log, setLog] = useState<ParsedLog | null>(null)
  const [cell, setCell] = useState<CellLog | null>(null)
  // First visit on this device: a short welcome (also reopenable from the footer).
  const [welcome, setWelcome] = useState(() => !welcomeSeen())
  const closeWelcome = useCallback(() => setWelcome(false), [])
  const [report, setReport] = useState<ReportInput | null>(null)
  const closeReport = useCallback(() => setReport(null), [])
  // Outside context from the status center (live tab and log tab), included in the report.
  const [liveContext, setLiveContext] = useState<StatusContext | null>(null)
  const [logContext, setLogContext] = useState<StatusContext | null>(null)
  const openLogReport = () => {
    if (log) setReport({ kind: 'log', log, cell, context: logContext })
  }
  const s = useMemo(() => stats(geo.fixes), [geo.fixes])

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark">
            <Crosshair size={18} />
          </span>
          אטלס<small>GNSS</small>
        </span>
        <LiveBadge status={geo.status} hz={s.hz} />
      </header>
      <nav className="mode-tabs" aria-label="מצב תצוגה">
        <button className={tab === 'live' ? 'active' : ''} aria-pressed={tab === 'live'} onClick={() => setTab('live')}>
          <Activity size={17} /> מעקב חי
        </button>
        <button className={tab === 'log' ? 'active' : ''} aria-pressed={tab === 'log'} onClick={() => setTab('log')}>
          <Satellite size={17} /> ניתוח לוג
        </button>
        <button
          className={tab === 'plots' ? 'active' : ''}
          aria-pressed={tab === 'plots'}
          onClick={() => setTab('plots')}
        >
          <ChartLine size={17} /> גרפים
        </button>
      </nav>

      <main className="dashboard">
        {tab === 'log' ? (
          <ErrorBoundary label="ניתוח הלוג">
            <LogView log={log} setLog={setLog} onReport={openLogReport} onContext={setLogContext} />
          </ErrorBoundary>
        ) : tab === 'plots' ? (
          <ErrorBoundary label="גרפים">
            <PlotsView rx={rx} log={log} setLog={setLog} cell={cell} setCell={setCell} onReport={openLogReport} />
          </ErrorBoundary>
        ) : (
          <LiveView
            geo={geo}
            motion={motion}
            rx={rx}
            s={s}
            onShowLog={() => setTab('log')}
            onContext={setLiveContext}
          />
        )}
        <AppInfo onWelcome={() => setWelcome(true)} />
      </main>
      {welcome && <Welcome onClose={closeWelcome} />}
      {report && (
        <ErrorBoundary label="הדוח">
          <ReportView input={report} onClose={closeReport} />
        </ErrorBoundary>
      )}

      {tab === 'live' && (
        <LiveActionBar
          geo={geo}
          motion={motion}
          wake={wake}
          keepAwake={keepAwake}
          setKeepAwake={setKeepAwake}
          onReport={(r) => setReport({ ...r, context: liveContext })}
        />
      )}
    </div>
  )
}

export default App
