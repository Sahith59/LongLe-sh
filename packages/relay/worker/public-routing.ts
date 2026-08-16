export interface PublicHostConfig {
  /** Marketing/docs hostname, for example longleash.dev. */
  PUBLIC_SITE_HOST?: string
  /** Paired PWA + WebSocket hostname, for example app.longleash.dev. */
  PUBLIC_APP_HOST?: string
  /** Previous workers.dev app. Browser pages redirect; laptop relay sockets remain compatible. */
  PUBLIC_LEGACY_APP_HOST?: string
  /** Optional www alias that permanently redirects to PUBLIC_SITE_HOST. */
  PUBLIC_WWW_HOST?: string
}

export type PublicRouteDecision =
  | { kind: 'continue' }
  | { kind: 'landing' }
  | { kind: 'redirect'; location: string }

function cleanHost(value: string | undefined): string | null {
  const host = value?.trim().toLowerCase().replace(/\.$/, '')
  return host ? host : null
}

export function isPublicSiteHost(url: URL, config: PublicHostConfig): boolean {
  const siteHost = cleanHost(config.PUBLIC_SITE_HOST)
  return siteHost !== null && cleanHost(url.hostname) === siteHost
}

function hasPairingSecret(url: URL): boolean {
  return url.searchParams.has('c') || url.searchParams.has('s')
}

function httpsLocation(host: string, url: URL): string {
  return `https://${host}${url.pathname}${url.search}${url.hash}`
}

function isLegacyPublicPath(path: string): boolean {
  return path === '/welcome' || path === '/welcome/' || path.startsWith('/welcome/')
}

function isPublicAsset(path: string): boolean {
  return (
    path.startsWith('/assets/') ||
    path.startsWith('/fonts/') ||
    path === '/favicon.png' ||
    path === '/apple-touch-icon.png' ||
    path === '/icon-192.png' ||
    path === '/icon-512.png' ||
    path === '/manifest.webmanifest' ||
    path === '/robots.txt'
  )
}

/**
 * Host-aware routing lets one Worker keep the old workers.dev PWA alive while a branded apex
 * domain becomes the public site and app.<domain> becomes the product/relay origin. It never
 * guesses a hostname: until all configured values are present, legacy routing is unchanged.
 */
export function publicRoute(url: URL, config: PublicHostConfig): PublicRouteDecision {
  const host = cleanHost(url.hostname)
  const siteHost = cleanHost(config.PUBLIC_SITE_HOST)
  const appHost = cleanHost(config.PUBLIC_APP_HOST)
  const legacyAppHost = cleanHost(config.PUBLIC_LEGACY_APP_HOST)
  const wwwHost = cleanHost(config.PUBLIC_WWW_HOST)

  if (host !== null && wwwHost !== null && siteHost !== null && host === wwwHost) {
    return { kind: 'redirect', location: httpsLocation(siteHost, url) }
  }

  // Registration must not be optional just because somebody remembers the old workers.dev URL.
  // Keep API, health and WebSocket requests on the legacy host so already-installed laptop daemons
  // can finish the migration; move every browser navigation and static asset to the account-gated
  // branded app. Pairing query parameters are preserved by httpsLocation.
  if (
    host !== null &&
    legacyAppHost !== null &&
    appHost !== null &&
    host === legacyAppHost &&
    url.pathname !== '/health' &&
    url.pathname !== '/ws' &&
    !url.pathname.startsWith('/api/')
  ) {
    return { kind: 'redirect', location: httpsLocation(appHost, url) }
  }

  if (host === null || siteHost === null || host !== siteHost) {
    // The legacy shared workers.dev origin keeps the paired app at / and scopes every public page
    // below /welcome. This also makes docs deep links useful before a custom domain exists.
    return isLegacyPublicPath(url.pathname) ? { kind: 'landing' } : { kind: 'continue' }
  }

  // A pairing link must never strand a user on the brochure hostname. Preserve the complete
  // query—including the temporary secret—and move it directly to the paired app over HTTPS.
  if (appHost !== null && hasPairingSecret(url)) {
    return { kind: 'redirect', location: httpsLocation(appHost, url) }
  }

  if (appHost !== null && (url.pathname === '/app' || url.pathname === '/app/')) {
    const target = new URL(url)
    target.pathname = '/'
    return { kind: 'redirect', location: httpsLocation(appHost, target) }
  }

  // The branded apex is exclusively the public site. Serving its HTML shell for unknown content
  // paths gives React a real first-party 404 while static build assets continue untouched.
  return isPublicAsset(url.pathname) || url.pathname === '/health' || url.pathname === '/ws'
    ? { kind: 'continue' }
    : { kind: 'landing' }
}
