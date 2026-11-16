// Connect panel for an external GNSS receiver (Web Serial), shared by the live tab and the plots
// tab. Shows why it can't work on this browser, or the baud selector + connect button. Renders
// nothing once connected: each tab shows its own status row then.

import { useState, type ReactNode } from 'react'
import { Plug } from 'lucide-react'
import type { SerialReceiver } from './serialReceiver'
import { isIOS } from './device'

const BAUDS = [4800, 9600, 38400, 57600, 115200]

export function ReceiverConnect({
  rx,
  intro,
  iosNote = '',
  children,
}: {
  rx: SerialReceiver
  intro: ReactNode
  iosNote?: string
  children?: ReactNode
}) {
  const [baud, setBaud] = useState(9600)
  if (rx.state === 'connected') return null
  if (rx.state === 'unsupported')
    return (
      <p className="muted">
        {isIOS()
          ? `באייפון אין לדפדפנים אפשרות להתחבר למקלט חיצוני (Apple לא תומכת ב-Web Serial).${iosNote}`
          : 'הדפדפן הזה לא תומך בחיבור למקלט. צריך Chrome לאנדרואיד בגרסה 138 ומעלה (Bluetooth), או Chrome/Edge במחשב (USB).'}
      </p>
    )
  return (
    <>
      <p className="muted">{intro}</p>
      <div className="rx-connect">
        <label>
          קצב (baud)
          <select value={baud} onChange={(e) => setBaud(Number(e.target.value))}>
            {BAUDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button" onClick={() => void rx.connect(baud)} disabled={rx.state === 'connecting'}>
          <Plug size={18} /> {rx.state === 'connecting' ? 'מתחבר…' : 'חבר מקלט'}
        </button>
      </div>
      {rx.error && <p className="error-text">{rx.error}</p>}
      {children}
    </>
  )
}
