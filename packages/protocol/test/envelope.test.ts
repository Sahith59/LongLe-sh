import { describe, expect, it } from 'vitest'
import { deriveRelayIdentity, open, seal } from '../src/envelope.js'

const SECRET = 'u'.repeat(43) // stand-in for randomBytes(32).toString('base64url')
const OTHER = 'v'.repeat(43)

describe('deriving the relay identity from the pairing secret', () => {
  it('derives the same room tag on both devices — that is how they find each other', async () => {
    const a = await deriveRelayIdentity(SECRET)
    const b = await deriveRelayIdentity(SECRET)
    expect(a.roomTag).toBe(b.roomTag)
  })

  it('produces a tag the relay will accept and cannot reverse', async () => {
    const { roomTag } = await deriveRelayIdentity(SECRET)
    expect(roomTag).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes, base64url, no padding
    expect(roomTag).not.toContain(SECRET.slice(0, 8))
  })

  it('different pairings land in different rooms', async () => {
    const a = await deriveRelayIdentity(SECRET)
    const b = await deriveRelayIdentity(OTHER)
    expect(a.roomTag).not.toBe(b.roomTag)
  })
})

describe('sealing and opening frames', () => {
  it('round-trips a message', async () => {
    const identity = await deriveRelayIdentity(SECRET)
    const sealed = await seal(identity, '{"type":"subscribe","sessionId":"ses_1"}')
    expect(await open(identity, sealed)).toBe('{"type":"subscribe","sessionId":"ses_1"}')
  })

  it('never produces the plaintext or the room tag inside the envelope', async () => {
    const identity = await deriveRelayIdentity(SECRET)
    const sealed = await seal(identity, 'the-laptop-is-at-home')
    expect(sealed).not.toContain('the-laptop-is-at-home')
    expect(sealed).not.toContain(identity.roomTag)
  })

  it('two seals of the same message differ — nonces are never reused', async () => {
    const identity = await deriveRelayIdentity(SECRET)
    expect(await seal(identity, 'same')).not.toBe(await seal(identity, 'same'))
  })

  it('handles multi-kilobyte frames and non-ASCII text', async () => {
    const identity = await deriveRelayIdentity(SECRET)
    const big = `héllo → ${'x'.repeat(150_000)} ✓`
    expect(await open(identity, await seal(identity, big))).toBe(big)
  })
})

describe('what open() refuses — relay-delivered data is hostile by definition', () => {
  it('rejects a tampered ciphertext', async () => {
    const identity = await deriveRelayIdentity(SECRET)
    const sealed = await seal(identity, 'important')
    const bytes = sealed.split('')
    const at = 20
    bytes[at] = bytes[at] === 'A' ? 'B' : 'A'
    expect(await open(identity, bytes.join(''))).toBeNull()
  })

  it('rejects a frame sealed under a different pairing', async () => {
    const theirs = await deriveRelayIdentity(OTHER)
    const mine = await deriveRelayIdentity(SECRET)
    expect(await open(mine, await seal(theirs, 'not for you'))).toBeNull()
  })

  it('rejects garbage, truncation, and the empty string without throwing', async () => {
    const identity = await deriveRelayIdentity(SECRET)
    expect(await open(identity, 'not base64 at all!!!')).toBeNull()
    expect(await open(identity, '')).toBeNull()
    expect(await open(identity, 'AAAA')).toBeNull()
    const sealed = await seal(identity, 'x')
    expect(await open(identity, sealed.slice(0, 10))).toBeNull()
  })

  it('rejects an envelope from a future version instead of misreading it', async () => {
    const identity = await deriveRelayIdentity(SECRET)
    const sealed = await seal(identity, 'x')
    // The version byte is the first byte; flip it and the whole envelope is foreign.
    const raw = Buffer.from(sealed.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    raw[0] = 9
    const forged = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(await open(identity, forged)).toBeNull()
  })
})

describe('the pairing identity', () => {
  it('never lands in the same room as the device identity for the same bytes', async () => {
    const { derivePairingIdentity } = await import('../src/envelope.js')
    const device = await deriveRelayIdentity(SECRET)
    const pairing = await derivePairingIdentity(SECRET)
    expect(pairing.roomTag).not.toBe(device.roomTag)
    expect(pairing.roomTag).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('cannot open frames sealed for the device identity, nor vice versa', async () => {
    const { derivePairingIdentity } = await import('../src/envelope.js')
    const device = await deriveRelayIdentity(SECRET)
    const pairing = await derivePairingIdentity(SECRET)
    expect(await open(pairing, await seal(device, 'device talk'))).toBeNull()
    expect(await open(device, await seal(pairing, 'pairing talk'))).toBeNull()
  })
})

describe('insecure contexts — the exact condition that broke the first field test', () => {
  it('works with crypto.subtle entirely absent, as on a plain-http page on a phone', async () => {
    const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle')
    // iOS Safari on http://<lan-ip> exposes crypto.getRandomValues but NO crypto.subtle.
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true })
    try {
      const identity = await deriveRelayIdentity(SECRET)
      const sealed = await seal(identity, 'sealed without subtle')
      expect(await open(identity, sealed)).toBe('sealed without subtle')
    } finally {
      if (subtle) Object.defineProperty(globalThis.crypto, 'subtle', subtle)
    }
  })
})
