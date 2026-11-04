import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// HTTPS is required: mobile browsers only expose the Geolocation API in a secure context.
// `host: true` exposes the dev server on the LAN so a phone on the same Wi-Fi can open it.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true },
  preview: { host: true },
})
