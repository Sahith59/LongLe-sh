import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const selfHostedConfig = readFileSync(new URL('../wrangler.selfhost.jsonc', import.meta.url), 'utf8')

describe('public Worker configuration', () => {
  it('keeps exact branded domains and the workers.dev rollback together', () => {
    for (const host of ['longleash.dev', 'www.longleash.dev', 'app.longleash.dev']) {
      expect(config).toContain(`"pattern": "${host}"`)
    }
    expect(config).toContain('"workers_dev": true')
    expect(config).toContain('"preview_urls": false')
    expect(config).toContain('"PUBLIC_LEGACY_APP_HOST"')
  })

  it('requires every account secret without committing a value', () => {
    for (const secret of ['CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'RELAY_TICKET_SECRET']) {
      expect(config).toContain(`"${secret}"`)
      expect(config).not.toMatch(new RegExp(`"${secret}"\\s*:\\s*".+"`))
    }
  })

  it('binds separate account, guest, and host storm limits', () => {
    expect(config).toContain('"ACCOUNT_API_RATE"')
    expect(config).toContain('"RELAY_GUEST_RATE"')
    expect(config).toContain('"RELAY_HOST_RATE"')
  })
})

describe('self-hosted Worker configuration', () => {
  it('keeps the accountless operator boundary separate from LongLeash production', () => {
    expect(selfHostedConfig).toContain('"name": "longleash-relay-selfhost"')
    expect(selfHostedConfig).toContain('"compatibility_date": "2026-08-17"')
    expect(selfHostedConfig).toContain('"compatibility_flags": ["nodejs_compat"]')
    expect(selfHostedConfig).toContain('"workers_dev": true')
    expect(selfHostedConfig).toContain('"ROOM"')
    expect(selfHostedConfig).toContain('"ASSETS"')
    for (const productionOnly of [
      'longleash.dev',
      'PUBLIC_APP_HOST',
      'PUBLIC_SITE_HOST',
      'CLERK_PUBLISHABLE_KEY',
      'CLERK_SECRET_KEY',
      'RELAY_TICKET_SECRET',
      'ACCOUNT_API_RATE',
      'RELAY_GUEST_RATE',
      'RELAY_HOST_RATE',
    ]) {
      expect(selfHostedConfig).not.toContain(`"${productionOnly}"`)
    }
  })
})
