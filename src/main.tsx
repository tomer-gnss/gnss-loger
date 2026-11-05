import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// Anti-clickjacking: a hostile page could load this site in an invisible frame and trick
// the user into tapping "allow location". GitHub Pages can't send frame-blocking headers
// (and CSP frame-ancestors is ignored in <meta>), so refuse to run when framed.
const framed = (() => { try { return window.self !== window.top } catch { return true } })()

const root = document.getElementById('root')!
if (framed) {
  root.textContent = 'האתר הזה לא פועל בתוך מסגרת של אתר אחר. פתח אותו ישירות בדפדפן.'
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
