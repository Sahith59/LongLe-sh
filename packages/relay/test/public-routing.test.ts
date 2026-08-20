import { describe, expect, it } from 'vitest'
import { isPublicSiteHost, publicRoute } from '../worker/public-routing.js'

const config = {
  PUBLIC_SITE_HOST: 'longleash.dev',
  PUBLIC_APP_HOST: 'app.longleash.dev',
  PUBLIC_LEGACY_APP_HOST: 'longleash-relay.example.workers.dev',
  PUBLIC_WWW_HOST: 'www.longleash.dev',
}

describe('public host routing', () => {
  it('serves the landing page at the branded apex', () => {
    expect(publicRoute(new URL('https://longleash.dev/'), config)).toEqual({ kind: 'landing' })
    expect(publicRoute(new URL('https://longleash.dev/welcome'), config)).toEqual({
      kind: 'landing',
    })
    expect(publicRoute(new URL('https://longleash.dev/docs/troubleshooting'), config)).toEqual({
      kind: 'landing',
    })
    expect(publicRoute(new URL('https://longleash.dev/docs/connectivity'), config)).toEqual({
      kind: 'landing',
    })
    expect(publicRoute(new URL('https://longleash.dev/license'), config)).toEqual({
      kind: 'landing',
    })
    expect(publicRoute(new URL('https://longleash.dev/not-a-real-page'), config)).toEqual({
      kind: 'landing',
    })
  })

  it('leaves the paired app active and migrates legacy browser pages', () => {
    expect(publicRoute(new URL('https://app.longleash.dev/'), config)).toEqual({
      kind: 'continue',
    })
    expect(
      publicRoute(new URL('https://longleash-relay.example.workers.dev/'), config),
    ).toEqual({ kind: 'redirect', location: 'https://app.longleash.dev/' })
    expect(
      publicRoute(new URL('https://longleash-relay.example.workers.dev/welcome/docs/security'), config),
    ).toEqual({
      kind: 'redirect',
      location: 'https://app.longleash.dev/welcome/docs/security',
    })
  })

  it('preserves legacy laptop relay paths while closing the accountless browser route', () => {
    expect(publicRoute(
      new URL('https://longleash-relay.example.workers.dev/?c=challenge&s=secret'),
      config,
    )).toEqual({
      kind: 'redirect',
      location: 'https://app.longleash.dev/?c=challenge&s=secret',
    })
    expect(publicRoute(
      new URL('https://longleash-relay.example.workers.dev/ws?room=room'),
      config,
    )).toEqual({ kind: 'continue' })
    expect(publicRoute(
      new URL('https://longleash-relay.example.workers.dev/api/auth/config'),
      config,
    )).toEqual({ kind: 'continue' })
  })

  it('does not rewrite public-site assets or relay endpoints', () => {
    expect(publicRoute(new URL('https://longleash.dev/assets/welcome.js'), config)).toEqual({
      kind: 'continue',
    })
    expect(publicRoute(new URL('https://longleash.dev/icon-192.png'), config)).toEqual({
      kind: 'continue',
    })
    expect(publicRoute(new URL('https://longleash.dev/favicon.png'), config)).toEqual({
      kind: 'continue',
    })
    expect(publicRoute(new URL('https://longleash.dev/apple-touch-icon.png'), config)).toEqual({
      kind: 'continue',
    })
    expect(publicRoute(new URL('https://longleash.dev/health'), config)).toEqual({
      kind: 'continue',
    })
    expect(publicRoute(new URL('https://longleash.dev/ws'), config)).toEqual({
      kind: 'continue',
    })
  })

  it('moves pairing secrets from the public site to the app without changing them', () => {
    expect(
      publicRoute(new URL('https://longleash.dev/?c=chl_123&s=secret_value'), config),
    ).toEqual({
      kind: 'redirect',
      location: 'https://app.longleash.dev/?c=chl_123&s=secret_value',
    })
    expect(
      publicRoute(new URL('https://longleash.dev/welcome?c=chl_456&s=other'), config),
    ).toEqual({
      kind: 'redirect',
      location: 'https://app.longleash.dev/welcome?c=chl_456&s=other',
    })
  })

  it('redirects www and the explicit app path to their canonical hosts', () => {
    expect(publicRoute(new URL('https://www.longleash.dev/docs?q=1'), config)).toEqual({
      kind: 'redirect',
      location: 'https://longleash.dev/docs?q=1',
    })
    expect(publicRoute(new URL('https://longleash.dev/app'), config)).toEqual({
      kind: 'redirect',
      location: 'https://app.longleash.dev/',
    })
  })

  it('does nothing until a real branded host is configured', () => {
    expect(publicRoute(new URL('https://anything.example/'), {})).toEqual({ kind: 'continue' })
  })

  it('identifies only the brochure host so its /ws route can be refused', () => {
    expect(isPublicSiteHost(new URL('https://longleash.dev/ws'), config)).toBe(true)
    expect(isPublicSiteHost(new URL('https://app.longleash.dev/ws'), config)).toBe(false)
    expect(isPublicSiteHost(new URL('https://longleash-relay.example.workers.dev/ws'), config)).toBe(false)
  })
})
