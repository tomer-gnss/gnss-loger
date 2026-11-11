import { useState } from 'react'
import { ChevronDown, Smartphone } from 'lucide-react'
import { isAndroid, isIOS } from './device'

/**
 * How to record a GNSS log on the phone so the site gets the most out of it.
 * On Android it's shown open with full steps (that's where recording is possible);
 * elsewhere it's a collapsed help box.
 */
export function RecordGuide() {
  const android = isAndroid()
  const [open, setOpen] = useState(android)
  return (
    <div className={`help record-guide ${android ? 'android' : ''}`}>
      <button className="help-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span><Smartphone size={17} className="inline-icon" /> {android ? 'מדריך הקלטה לאנדרואיד' : 'איך מקליטים לוג?'}</span>
        <ChevronDown size={18} className={open ? 'flip' : ''} />
      </button>
      {open && <div className="help-body">
        {isIOS() && <p className="muted">באייפון אין גישה לנתוני לוויינים, ולכן אין אפליקציה שמקליטה אותם. הקלטה אפשרית רק באנדרואיד או ממקלט חיצוני.</p>}

        <h4>שלב 1: מדידה רציפה (פעם אחת)</h4>
        <p>כדי לחסוך בסוללה, אנדרואיד מודד GNSS לסירוגין. כדי לקבל מדידה בכל שנייה:</p>
        <ol className="steps">
          <li>הגדרות ← <b>מידע על הטלפון</b> ← ללחוץ 7 פעמים על <b>מספר Build</b> (מפעיל את "אפשרויות למפתחים").</li>
          <li>הגדרות ← מערכת ← <b>אפשרויות למפתחים</b> ← להפעיל <b>Force full GNSS measurements</b>.</li>
        </ol>
        <p className="muted">זה משפיע על הסוללה. אחרי ההקלטה אפשר לכבות את האפשרות.</p>

        <h4>שלב 2: הקלטה ב-GnssLogger (של Google, מומלץ)</h4>
        <ol className="steps">
          <li>להתקין את <b>GnssLogger</b> מ-Google Play.</li>
          <li>בלשונית <b>Settings</b>: להפעיל את המתגים של <b>Location</b> (כולל מיקום מהרשת, Network), <b>Measurements</b> (Raw), <b>GnssStatus</b> ו-<b>NMEA</b>. שמות המתגים יכולים להשתנות מעט בין גרסאות.</li>
          <li>לצאת לשמיים פתוחים, ובלשונית <b>Log</b> ללחוץ <b>Start Log</b>. להקליט לפחות 3–5 דקות.</li>
          <li><b>Stop &amp; Send</b> ← לשמור את הקובץ בטלפון.</li>
          <li>באתר, בלשונית <b>"ניתוח לוג"</b>, לבחור את הקובץ. או בלשונית <b>"גרפים"</b> כדי להפעיל אותו מחדש בזמן אמת.</li>
        </ol>

        <h4>חלופה: GPSTest</h4>
        <p>בהגדרות האפליקציה, בקטגוריית <b>Logging</b>: להפעיל רישום לקובץ <b>CSV</b> (ואם רוצים, גם NMEA), להקליט, ולשתף את הקובץ מהאפליקציה.</p>

        <h4>מה כל הפעלה נותנת באתר</h4>
        <ul className="steps">
          <li><b>Measurements (Raw)</b>: C/N₀ לכל אות, AGC (שיבוש), שעון המקלט (זיוף), ופער אנטנה/בייסבנד.</li>
          <li><b>GnssStatus</b>: מפת שמיים ומי משמש בפתרון.</li>
          <li><b>Location + Network</b>: השוואה בין GNSS למיקום מהרשת הסלולרית.</li>
          <li><b>NMEA</b>: גיבוי למפת השמיים ולמספר הלוויינים.</li>
        </ul>
        <p className="muted">הקובץ נשאר בטלפון. האתר קורא אותו בדפדפן ולא מעלה אותו לשום מקום.</p>
      </div>}
    </div>
  )
}
