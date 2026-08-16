import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import HostedAuth from './HostedAuth.js'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <HostedAuth />
  </StrictMode>,
)

// The shell must open even when the daemon cannot serve it — away from home, the cached app
// plus the relay IS the product. Production only: a service worker in dev serves stale code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const reloadKey = 'll.reloaded'
  // The guard belongs to one controller change, not the whole browser tab. Leaving it set
  // forever meant the first update reloaded correctly and every later one silently did not.
  if (sessionStorage.getItem(reloadKey)) sessionStorage.removeItem(reloadKey)
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
  // When an updated worker takes control, reload once so the new shell appears without
  // asking anyone to perform close-and-reopen rituals. Guarded: on the very first install
  // there was no controller, and reloading then would loop.
  const hadController = navigator.serviceWorker.controller !== null
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !sessionStorage.getItem(reloadKey)) {
      sessionStorage.setItem(reloadKey, '1')
      location.reload()
    }
  })
}
