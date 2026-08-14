import { describe, expect, it } from 'vitest'
import { pairingUrl } from '../src/pairing-url.js'

describe('browser-safe pairing URLs', () => {
  it('keeps the complete temporary credential out of the HTTP request target', () => {
    const value = pairingUrl('https://app.longleash.dev/', 'chl_123', 'secret/value+with spaces')
    const parsed = new URL(value)

    expect(parsed.origin + parsed.pathname + parsed.search).toBe('https://app.longleash.dev/')
    expect(parsed.search).toBe('')
    expect(new URLSearchParams(parsed.hash.slice(1)).get('c')).toBe('chl_123')
    expect(new URLSearchParams(parsed.hash.slice(1)).get('s')).toBe('secret/value+with spaces')
  })

  it('removes an accidental origin query before adding the fragment', () => {
    expect(pairingUrl('http://192.168.1.20:4321/?old=1', 'challenge', 'secret')).toBe(
      'http://192.168.1.20:4321/#c=challenge&s=secret',
    )
  })
})
