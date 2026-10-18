import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// After a deploy the previous build's hashed chunks disappear, so a lazy route import fails and
// Vite fires `vite:preloadError`. Reload ONCE to pick up the new build; the sessionStorage guard
// (1 minute) prevents a reload loop — if it fails again, the ErrorBoundary shows "reload" UI.
const PRELOAD_RELOAD_KEY = 'reguard:preload-error-reload-at'
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY)) || 0
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()))
  } catch {
    return // no sessionStorage → can't guard against loops; let the ErrorBoundary handle it
  }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)