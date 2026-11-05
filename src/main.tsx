import './trustedTypes' // must stay first: registers the policy before any library touches the DOM
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// Anti-clickjacking: a hostile page could load this site in an invisible frame and trick
// the user into tapping "allow location". GitHub Pages can't send frame-blocking headers
// (and CSP frame-ancestors is ignored in <meta>), so refuse to run when framed.
const framed = (() => { try { return window.self !== window.top } catch { return true } })()

// Reverse-tabnabbing: a page that opened this one with window.open() keeps a handle and could
// later swap this tab for a lookalike that asks for location. We can't cut that handle from
// inside (COOP needs an HTTP header), so tell the user to open the site from their own bookmark.
const openedByOtherPage = (() => { try { return window.opener !== null } catch { return true } })()

const root = document.getElementById('root')!
if (framed) {
  root.textContent = 'האתר הזה לא פועל בתוך מסגרת של אתר אחר. פתח אותו ישירות בדפדפן.'
} else if (openedByOtherPage) {
  const box = document.createElement('div')
  box.className = 'opener-warning'
  const p = document.createElement('p')
  p.textContent = 'האתר נפתח על ידי אתר אחר. מטעמי אבטחה, פתח אותו מהסימנייה או מהאייקון במסך הבית, ולא דרך קישור.'
  const go = document.createElement('button')
  go.className = 'primary-button'
  go.textContent = 'המשך בכל זאת'
  go.addEventListener('click', () => { box.remove(); mount() })
  box.append(p, go)
  root.append(box)
} else {
  mount()
}

function mount() {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
