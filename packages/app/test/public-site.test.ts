import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { currentSitePathForLocation, siteHrefForLocation } from '../src/landing/SiteChrome.js'

const landing = readFileSync(new URL('../src/landing/Landing.tsx', import.meta.url), 'utf8')
const pages = readFileSync(new URL('../src/landing/PublicPages.tsx', import.meta.url), 'utf8')
const chrome = readFileSync(new URL('../src/landing/SiteChrome.tsx', import.meta.url), 'utf8')

describe('first-party public site', () => {
  it('routes every landing documentation card to a LongLeash page', () => {
    expect(landing).toContain("href: '/docs/getting-started'")
    expect(landing).toContain("href: '/docs/troubleshooting'")
    expect(landing).toContain("href: '/docs/security'")
    expect(landing).toContain("href: '/docs/session-portability'")
    expect(landing).not.toMatch(/href: `\$\{REPOSITORY\}\/blob\/main\/docs/)
  })

  it('ships guides, legal pages, a roadmap, and an honest internal 404', () => {
    for (const path of [
      '/docs',
      '/docs/getting-started',
      '/docs/daily-use',
      '/docs/troubleshooting',
      '/docs/security',
      '/docs/session-portability',
      '/docs/faq',
      '/roadmap',
      '/privacy',
      '/terms',
      '/license',
    ]) {
      expect(pages).toContain(`case '${path}'`)
    }
    expect(pages).toContain('<NotFound />')
  })

  it('installs the iPhone PWA before pairing so credentials land in the right browser', () => {
    const addToHome = pages.indexOf('Share → Add to')
    const signIn = pages.indexOf('Sign in inside that installed app')
    const scanInside = pages.indexOf('Choose <b>Scan the QR</b> inside the installed app')

    expect(addToHome).toBeGreaterThan(-1)
    expect(signIn).toBeGreaterThan(addToHome)
    expect(scanInside).toBeGreaterThan(signIn)
    expect(landing).toContain('add it to your home screen first')
    expect(landing).toContain('then use its')
    expect(landing).toContain('scanner on the fresh QR')
  })

  it('uses the canonical product icon and first-party footer navigation', () => {
    expect(chrome).toContain('<img src="/icon-192.png"')
    expect(chrome).not.toContain('LeashGlyph')
    expect(chrome).toContain("siteHref('/docs')")
    expect(chrome).toContain("siteHref('/license')")
    expect(chrome).toContain("siteHref('/privacy')")
    expect(chrome).toContain("siteHref('/terms')")
    expect(chrome).toContain('Source on GitHub')
  })

  it('keeps public routes separate from the paired app on every supported host shape', () => {
    expect(
      siteHrefForLocation('/docs/troubleshooting', {
        hostname: 'longleash-relay.example.workers.dev',
        pathname: '/welcome',
        search: '',
      }),
    ).toBe('/welcome/docs/troubleshooting')
    expect(
      siteHrefForLocation('/docs#mental-model', {
        hostname: '127.0.0.1',
        pathname: '/welcome.html',
        search: '',
      }),
    ).toBe('/welcome.html?site=%2Fdocs#mental-model')
    expect(
      siteHrefForLocation('/license', {
        hostname: 'longleash.dev',
        pathname: '/docs',
        search: '',
      }),
    ).toBe('/license')

    expect(
      currentSitePathForLocation({
        hostname: 'longleash-relay.example.workers.dev',
        pathname: '/welcome/docs/security/',
        search: '',
      }),
    ).toBe('/docs/security')
    expect(
      currentSitePathForLocation({
        hostname: '127.0.0.1',
        pathname: '/welcome.html',
        search: '?site=%2Froadmap',
      }),
    ).toBe('/roadmap')
  })
})
