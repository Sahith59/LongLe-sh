import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')

describe('public Worker configuration', () => {
  it('keeps exact branded domains and the workers.dev rollback together', () => {
    for (const host of ['longleash.dev', 'www.longleash.dev', 'app.longleash.dev']) {
      expect(config).toContain(`"pattern": "${host}"`)
    }
    expect(config).not.toContain('"workers_dev": false')
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
