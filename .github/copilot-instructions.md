# Project Instructions

- Hebrew, right-to-left, mobile-first GNSS app built with React, TypeScript and Vite. Keep every change responsive (360px phones up) and RTL; wrap numbers with units in `<bdi dir="ltr">` so they don't flip.
- **Live tab** (`src/App.tsx`, `src/geo.ts`): real position data from the browser Geolocation API (`watchPosition`, high accuracy, `maximumAge: 0`). Browsers do not expose satellite data, so do not add fake satellite readings to the live view.
- **Log tab** (`src/LogView.tsx`, `src/logParser.ts`): parses GPSTest / GnssLogger CSV logs (`Status`, `Fix`, `Raw`, `NMEA` records, header-driven columns) and plain NMEA 0183 files, entirely in the browser.
- Charts are hand-written SVG in `src/LiveCharts.tsx`; styles are in `src/dashboard.css`. Constellation colours follow the fixed order in `SYS_ORDER`.
- The dev server runs over HTTPS (`@vitejs/plugin-basic-ssl`) and on the LAN (`host: true`) because phones only allow geolocation in a secure context.
- Verify changes with `npm run build` and `npm run lint`.
- Deployment: GitHub Pages via `.github/workflows/deploy.yml` on push to `main`.
