# אטלס GNSS

כלי דפדפן למעקב אחרי מקלט ה-GNSS של הטלפון ולניתוח לוגים של GNSS. מותאם לטלפון, עובד גם במחשב.

## מה יש בו

**מעקב חי** (Geolocation API של הדפדפן)
- מיקום WGS84, דיוק, גובה, מהירות וכיוון. כל פתרון מוצג ברגע שמגיע, בלי מטמון.
- קצב העדכון בפועל, פיזור הפתרונות (RMS) וגרפים חיים.
- ייצוא הסשן ל-CSV, ואפשרות להשאיר את המסך דולק.

**ניתוח לוג** (הקובץ נקרא רק בדפדפן ולא נשלח לשום מקום)
- מפת שמיים ו-C/N₀ לכל אות, מי בשימוש בפתרון, מסלול, וניגון לאורך זמן.
- פורמטים נתמכים:
  - [GPSTest](https://github.com/barbeau/gpstest) ו-[GnssLogger](https://github.com/google/gps-measurement-tools): רשומות `Status`, `Fix`, `Raw` ו-`NMEA`
  - קובצי NMEA 0183 ממקלטים חיצוניים (u-blox וכו׳), כולל מזהי אותות של NMEA 4.1

> דפדפנים לא חושפים נתוני לוויינים בזמן אמת. לכן מפת השמיים זמינה רק דרך לוג.

## הרצה מקומית

```bash
npm install
npm run dev
```

שרת הפיתוח רץ ב-HTTPS עם תעודה שנוצרת מקומית, כי דפדפן בטלפון חוסם מיקום בלי HTTPS. פותחים בטלפון את כתובת ה-`Network` שמודפסת, מאותה רשת Wi-Fi, ומאשרים את אזהרת האבטחה.

## פרסום

כל push ל-`main` בונה את האתר ומפרסם אותו ב-GitHub Pages דרך [.github/workflows/deploy.yml](.github/workflows/deploy.yml). צריך להגדיר פעם אחת בריפו: Settings ← Pages ← Source: **GitHub Actions**.

## טכנולוגיה

React 19, TypeScript ו-Vite. בלי שרת ובלי ספריות גרפים: הכל SVG.

הקובץ לדוגמה בלשונית "ניתוח לוג" נטען בזמן ריצה מהריפו [google/gps-measurement-tools](https://github.com/google/gps-measurement-tools) (רישיון Apache-2.0).
