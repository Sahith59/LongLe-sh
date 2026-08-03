import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Landing } from './Landing.js'
import '../styles.css'
import './landing.css'

// Deliberately no service worker here: the landing page is a brochure, not the
// product. Only the app shell earns offline caching.
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
)
