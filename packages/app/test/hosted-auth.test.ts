import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { credentialKey } from '../src/lib/client.js'
import {
  loadHostedAuthConfig,
  rememberPairingLocation,
  restorePairingLocation,
} from '../src/HostedAuth.js'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('hosted account boundary', () => {
  it('uses different credential slots for different signed-in accounts', () => {
    expect(credentialKey('longleash.token', null)).toBe('longleash.token')
    expect(credentialKey('longleash.token', 'user_one')).toBe('longleash.token.account.user_one')
    expect(credentialKey('longleash.token', 'user_two')).not.toBe(credentialKey('longleash.token', 'user_one'))
  })

  it('preserves a one-time pairing fragment through the OAuth redirect', () => {
    const storage = new MemoryStorage()
    const before = {
      href: 'https://app.longleash.dev/#c=chl_123&s=secret_value',
      origin: 'https://app.longleash.dev',
    } as Location
    rememberPairingLocation(storage, before)
    let restored = ''
    restorePairingLocation(
      storage,
      { href: 'https://app.longleash.dev/', origin: before.origin } as Location,
      { replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => { restored = String(url) } } as History,
    )
    expect(restored).toBe('/#c=chl_123&s=secret_value')
  })

  it('fails closed on the canonical host but keeps a daemon-served app accountless', async () => {
    const offline = (() => Promise.reject(new Error('offline'))) as typeof fetch
    await expect(loadHostedAuthConfig(offline, 'app.longleash.dev')).resolves.toEqual({
      required: true,
      ready: false,
    })
    await expect(loadHostedAuthConfig(offline, '192.168.1.71')).resolves.toEqual({
      required: false,
      ready: true,
    })
  })

  it('rejects a malformed publishable key even when a response claims readiness', async () => {
    const fetcher = (() => Promise.resolve(Response.json({
      required: true,
      ready: true,
      publishableKey: 'not-a-clerk-key',
    }))) as typeof fetch
    await expect(loadHostedAuthConfig(fetcher, 'app.longleash.dev')).resolves.toEqual({
      required: true,
      ready: false,
    })
  })

  it('ships a Clerk-compatible CSP without opening scripts to unsafe evaluation', () => {
    const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
    expect(headers).toContain('https://clerk.longleash.dev')
    expect(headers).toContain('https://accounts.longleash.dev')
    expect(headers).toContain('https://*.protect.clerk.com')
    expect(headers).toContain('frame-src https://challenges.cloudflare.com')
    expect(headers).toContain('Referrer-Policy: no-referrer')
    expect(headers).not.toContain("script-src *")
    expect(headers).not.toContain("'unsafe-eval'")
  })
})
