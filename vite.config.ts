import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The only third-party data the app ever fetches, each on explicit user action:
// a sample log pinned to an exact commit, and the public GNSS orbit catalogue (no user data sent).
const SAMPLE_LOG = 'https://raw.githubusercontent.com/google/gps-measurement-tools/a1667c44a7b46a4ee116f5e3d6c8d464c66fe6c5/NmeaUtils/example/MTV.Local1.ublox-F9K.20200206-181434.nmea'
const ORBITS = 'https://celestrak.org/NORAD/elements/gp.php'

// Content-Security-Policy for the production build. GitHub Pages can't set HTTP headers,
// so it goes in a <meta> tag. Only applied to `vite build`: the dev server injects inline
// scripts for hot reload that this policy would (correctly) block.
//  - scripts/styles only from this site: no third-party code can run
//  - images only from this site and the OpenStreetMap tile server (after the user opts in)
//  - network only to the pinned sample file and the CelesTrak orbit endpoint (both opt-in)
//  - Trusted Types: no raw strings into HTML sinks (see src/trustedTypes.ts)
//  - no plugins, workers, frames, fonts, manifests, <base> hijack or form posts
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://tile.openstreetmap.org",
  `connect-src 'self' ${SAMPLE_LOG} ${ORBITS}`,
  "font-src 'none'",
  "manifest-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types default',
  'upgrade-insecure-requests',
].join('; ')

function securityHeaders(): Plugin {
  return {
    name: 'security-meta',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  }
}

// https://vite.dev/config/
// HTTPS is required: mobile browsers only expose the Geolocation API in a secure context.
// The dev server listens on this computer only. To test on a phone, run `npm run dev:phone`
// (adds --host) — and only on a network you trust.
export default defineConfig({
  plugins: [react(), basicSsl(), securityHeaders()],
})
