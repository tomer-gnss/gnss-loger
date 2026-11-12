// First-visit welcome (what the site does, what stays on the phone, how to start on this
// device) and the footer strip on every tab (version, reopen the welcome, erase local data).

import { useEffect, useRef } from 'react'
import { Activity, ChartLine, Info, Lock, Satellite, Trash2 } from 'lucide-react'
import { isAndroid, isIOS } from './device'
import { eraseLocalData, markWelcomeSeen } from './localData'

export function Welcome({ onClose }: { onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const close = () => { markWelcomeSeen(); onClose() }
  useEffect(() => {
    button.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { markWelcomeSeen(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const ios = isIOS(), android = isAndroid()
  return (
    <div className="welcome-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <section className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <h2 id="welcome-title">ברוכים הבאים לאטלס GNSS</h2>
        <p>כלי לבדיקת מקלט הלוויינים (GNSS) של הטלפון: איפה הוא ממקם אותך, כמה הוא מדויק, והאם יש סימנים לשיבוש או לזיוף.</p>
        <ul className="welcome-tabs">
          <li><Activity size={18} /><span><b>מעקב חי:</b> מיקום, דיוק וקצב עדכון בזמן אמת, וניטור שיבוש וזיוף.</span></li>
          <li><Satellite size={18} /><span><b>ניתוח לוג:</b> מפת שמיים ועוצמת אות לכל לוויין, מקובץ שהוקלט באנדרואיד.</span></li>
          <li><ChartLine size={18} /><span><b>גרפים:</b> C/N₀ לאורך זמן, מנתונים שנמדדו או מלוג, ונתוני סלולר.</span></li>
        </ul>
        <div className="welcome-privacy"><Lock size={18} /><p><b>הכל נשאר בטלפון שלך.</b> לאתר אין שרת, אין חשבונות ואין מעקב. המיקום נשמר רק בזיכרון של הדף. כל מי שפותח את האתר עובד לבד על המכשיר שלו, ואף אחד לא רואה את הנתונים של אחרים.</p></div>
        {ios ? <>
          <h3>להתחלה באייפון</h3>
          <ol className="steps">
            <li>ללחוץ <b>הפעל מעקב</b> ולאשר גישה למיקום.</li>
            <li>לוודא שמיקום מדויק פועל: הגדרות ← פרטיות ואבטחה ← שירותי מיקום ← <b>אתרי Safari</b> ← <b>"מיקום מדויק"</b>.</li>
            <li>מומלץ: כפתור השיתוף ← <b>הוסף למסך הבית</b>. האתר ייפתח במסך מלא, כמו אפליקציה.</li>
          </ol>
          <p className="muted">באייפון הדפדפן מקבל רק את המיקום. נתוני לוויינים לכל לוויין אפשר לראות מלוג שהוקלט באנדרואיד, או מהמסלולים הציבוריים (בלשונית "מעקב חי").</p>
        </> : android ? <>
          <h3>להתחלה באנדרואיד</h3>
          <ol className="steps">
            <li>ללחוץ <b>הפעל מעקב</b> ולאשר מיקום <b>מדויק</b>.</li>
            <li>לנתוני לוויינים מלאים: להקליט ב-GnssLogger. המדריך נמצא בלשונית <b>ניתוח לוג</b>.</li>
          </ol>
        </> : <p className="muted">באתר אפשר להשתמש גם מהמחשב, אבל המיקום שלו פחות מדויק משל טלפון.</p>}
        <button ref={button} className="primary-button" onClick={close}>הבנתי, מתחילים</button>
      </section>
    </div>
  )
}

export function AppInfo({ onWelcome }: { onWelcome: () => void }) {
  const erase = () => {
    if (!window.confirm('למחוק את כל מה שהאתר שמר במכשיר הזה?\n\nזה כולל הסכמות למפה ולמסלולים, המסלולים ששמורים במטמון, והגדרות תצוגה. המיקום עצמו אף פעם לא נשמר. הדף ייטען מחדש.')) return
    eraseLocalData()
    window.location.reload()
  }
  return (
    <footer className="app-info">
      <span dir="ltr" className="app-version">אטלס GNSS · v{__APP_VERSION__} · {__BUILD_SHA__} · {__BUILD_DATE__}</span>
      <div className="app-info-actions">
        <button className="text-button" onClick={onWelcome}><Info size={16} /> מדריך פתיחה</button>
        <button className="text-button" onClick={erase}><Trash2 size={16} /> מחיקת נתונים מהמכשיר</button>
      </div>
    </footer>
  )
}
