import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Content-Security-Policy for the production build. GitHub Pages can't set HTTP headers,
// so it goes in a <meta> tag. Only applied to `vite build`: the dev server injects inline
// scripts for hot reload that this policy would (correctly) block.
//  - scripts/styles only from this site: no third-party code can run
//  - network only to the OpenStreetMap tile server (images) and the sample log (fetch)
//  - no plugins, no <base> hijack, no form posts anywhere
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self' https://raw.githubusercontent.com",
  "font-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
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
// `host: true` exposes the dev server on the LAN so a phone on the same Wi-Fi can open it.
export default defineConfig({
  plugins: [react(), basicSsl(), securityHeaders()],
  server: { host: true },
  preview: { host: true },
})
