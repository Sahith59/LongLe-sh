import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'

export const REPOSITORY = 'https://github.com/Sahith59/LongLe-sh'
export const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/Sahith59/LongLe-sh/main/scripts/install.sh | bash'

function splitHash(path: string): { pathname: string; hash: string } {
  const index = path.indexOf('#')
  return index === -1
    ? { pathname: path, hash: '' }
    : { pathname: path.slice(0, index), hash: path.slice(index) }
}

interface SiteLocation {
  hostname: string
  pathname: string
  search: string
}

/**
 * Public pages share the Worker with the paired PWA during preview. On the branded apex they use
 * normal URLs; on workers.dev they live below /welcome so / remains the product. The query form is
 * only for Vite's static welcome.html preview, where arbitrary history fallbacks do not exist.
 */
export function siteHref(path: string): string {
  if (typeof window === 'undefined') return path
  return siteHrefForLocation(path, window.location)
}

export function siteHrefForLocation(path: string, location: SiteLocation): string {
  const { pathname, hash } = splitHash(path)
  const host = location.hostname

  if (host.endsWith('.workers.dev')) {
    return `${pathname === '/' ? '/welcome' : `/welcome${pathname}`}${hash}`
  }

  if (location.pathname.endsWith('/welcome.html')) {
    const route = pathname === '/' ? '/' : pathname
    return `/welcome.html?site=${encodeURIComponent(route)}${hash}`
  }

  return `${pathname}${hash}`
}

export function currentSitePath(): string {
  if (typeof window === 'undefined') return '/'
  return currentSitePathForLocation(window.location)
}

export function currentSitePathForLocation(location: SiteLocation): string {
  const previewRoute = new URLSearchParams(location.search).get('site')
  let path = previewRoute ?? location.pathname
  if (path === '/welcome' || path === '/welcome/' || path === '/welcome.html') return '/'
  if (path.startsWith('/welcome/')) path = path.slice('/welcome'.length)
  path = path.replace(/\/+$/, '')
  return path || '/'
}

export function appHref(): string {
  if (typeof window === 'undefined') return '/'
  const configured = import.meta.env.VITE_LONGLEASH_APP_URL?.trim()
  if (configured) return configured

  const { hostname, protocol } = window.location
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.workers.dev') ||
    hostname.startsWith('app.')
  ) {
    return '/'
  }

  const root = hostname.startsWith('www.') ? hostname.slice(4) : hostname
  return `${protocol}//app.${root}`
}

export function SiteHeader() {
  return (
    <header className="land-rail">
      <a className="land-mark" href={siteHref('/')} aria-label="LongLeash home">
        <img src="/icon-192.png" alt="" width={32} height={32} />
        Long<i>Leash</i>
      </a>
      <nav className="land-nav" aria-label="Primary navigation">
        <a href={siteHref('/#product')}>Product</a>
        <a href={siteHref('/#start')}>Setup</a>
        <a href={siteHref('/docs')}>Docs</a>
        <a href={siteHref('/docs/connectivity')}>Connectivity</a>
        <a href={siteHref('/roadmap')}>Roadmap</a>
      </nav>
      <div className="land-actions">
        <a className="land-icon-link" href={REPOSITORY} aria-label="View source on GitHub">
          <ExternalLink size={18} aria-hidden="true" />
        </a>
        <a className="key sm" href={appHref()}>
          Open app
        </a>
      </div>
    </header>
  )
}

export function SiteFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="land-foot">
      <a className="foot-brand" href={siteHref('/')} aria-label="LongLeash home">
        <img src="/icon-192.png" alt="" width={26} height={26} />
        <span>
          Long<i>Leash</i>
        </span>
      </a>
      {children}
      <nav className="foot-links" aria-label="Footer navigation">
        <a href={siteHref('/docs')}>Documentation</a>
        <a href={siteHref('/docs/connectivity')}>Connectivity</a>
        <a href={siteHref('/roadmap')}>Roadmap</a>
        <a href={siteHref('/license')}>License</a>
        <a href={siteHref('/privacy')}>Privacy</a>
        <a href={siteHref('/terms')}>Terms</a>
        <a href={REPOSITORY}>Source on GitHub</a>
        <span className="mono">build {__BUILD__}</span>
      </nav>
    </footer>
  )
}

export function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <div className="land">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      {children}
      <SiteFooter />
    </div>
  )
}
