import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The shell must open even when the daemon cannot serve it — away from home, the cached app
// plus the relay IS the product. Production only: a service worker in dev serves stale code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
  // When an updated worker takes control, reload once so the new shell appears without
  // asking anyone to perform close-and-reopen rituals. Guarded: on the very first install
  // there was no controller, and reloading then would loop.
  const hadController = navigator.serviceWorker.controller !== null
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !sessionStorage.getItem('ll.reloaded')) {
      sessionStorage.setItem('ll.reloaded', '1')
      location.reload()
    }
  })
}
