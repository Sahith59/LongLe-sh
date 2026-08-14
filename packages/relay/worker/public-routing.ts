export interface PublicHostConfig {
  /** Marketing/docs hostname, for example longleash.dev. */
  PUBLIC_SITE_HOST?: string
  /** Paired PWA + WebSocket hostname, for example app.longleash.dev. */
  PUBLIC_APP_HOST?: string
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

function hasPairingSecret(url: URL): boolean {
  return url.searchParams.has('c') || url.searchParams.has('s')
}

function httpsLocation(host: string, url: URL): string {
  return `https://${host}${url.pathname}${url.search}${url.hash}`
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
  const wwwHost = cleanHost(config.PUBLIC_WWW_HOST)

  if (host !== null && wwwHost !== null && siteHost !== null && host === wwwHost) {
    return { kind: 'redirect', location: httpsLocation(siteHost, url) }
  }

  if (host === null || siteHost === null || host !== siteHost) return { kind: 'continue' }

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

  return url.pathname === '/' || url.pathname === '/welcome' || url.pathname === '/welcome/'
    ? { kind: 'landing' }
    : { kind: 'continue' }
}
