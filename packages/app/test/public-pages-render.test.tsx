import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PublicPageRouter } from '../src/landing/PublicPages.js'

const routes = [
  '/docs',
  '/docs/getting-started',
  '/docs/connectivity',
  '/docs/background-service',
  '/docs/daily-use',
  '/docs/troubleshooting',
  '/docs/security',
  '/docs/session-portability',
  '/docs/faq',
  '/roadmap',
  '/privacy',
  '/terms',
  '/license',
]

describe('rendered public pages', () => {
  it.each(routes)('renders %s with the shared navigation and one main content region', (path) => {
    const html = renderToStaticMarkup(<PublicPageRouter path={path} />)

    expect(html).toContain('<main')
    expect(html).toContain('<h1>')
    expect(html).toContain('aria-label="Primary navigation"')
    expect(html).toContain('aria-label="Footer navigation"')
    expect((html.match(/<main/g) ?? [])).toHaveLength(1)
  })

  it('renders a semantic, keyboard-reachable connectivity comparison', () => {
    const html = renderToStaticMarkup(<PublicPageRouter path="/docs/connectivity" />)

    expect(html).toContain('aria-label="Connectivity mode comparison"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('<table')
    expect(html).toContain('<th scope="col">Hosted relay</th>')
    expect(html).toContain('<th scope="row">Internet service operator</th>')
    expect(html).toContain('Got no time? Let your agent wire it.')
  })

  it('renders the public roadmap without internal milestone names', () => {
    const html = renderToStaticMarkup(<PublicPageRouter path="/roadmap" />)

    expect(html).toContain('Available now')
    expect(html).toContain('Building')
    expect(html).toContain('Exploring')
    expect(html).not.toMatch(/Phase 1|Phase 2A/)
  })

  it('documents service ownership, health, foreground exclusion, and preserved data', () => {
    const html = renderToStaticMarkup(<PublicPageRouter path="/docs/background-service" />)
    expect(html).toContain('per-user LaunchAgent')
    expect(html).toContain('systemd user unit')
    expect(html).toContain('longleash service status')
    expect(html).toContain('cannot become competing database writers')
    expect(html).toContain('preserve settings, paired devices, audit history')
  })
})
