import { describe, expect, it } from 'vitest'
import { deriveVerifiedPairing, PairingTranscript } from '../src/pairing.js'
import { derivePairingIdentity, deriveRelayIdentity, open, seal } from '../src/envelope.js'

const secret = 'A'.repeat(43)
const transcript = {
  v: 2 as const, challengeId: 'chl_test', attemptId: 'B'.repeat(43),
  phoneNonce: 'C'.repeat(43), daemonNonce: 'D'.repeat(43),
  deviceName: 'My phone', expiresAt: 123456,
}

describe('verified pairing transcript', () => {
  it('matches an independent Node crypto HKDF-SHA256 compatibility vector', () => {
    const result = deriveVerifiedPairing(secret, transcript)
    expect(result.code).toBe('8232 8349')
    expect(result.identity.roomTag).toBe('e42b96482ce8d26f4a7b4c47fc2bc3385454d3a740297a6cae6df26163cf7193')
    expect(Array.from(result.identity.frameKey, (b) => b.toString(16).padStart(2, '0')).join(''))
      .toBe('539bf68bb25753380283deeb716ca9ced53dea92b0125a77702fddacc289be9d')
  })

  it('derives the same readable code and encrypted channel on both devices', async () => {
    const phone = deriveVerifiedPairing(secret, transcript)
    const laptop = deriveVerifiedPairing(secret, { ...transcript })
    expect(phone.code).toMatch(/^\d{4} \d{4}$/)
    expect(phone).toEqual(laptop)
    expect(await open(laptop.identity, await seal(phone.identity, 'confirm'))).toBe('confirm')
  })

  it('ignores object insertion order, but binds each field and role', () => {
    const original = deriveVerifiedPairing(secret, transcript)
    const reversed = Object.fromEntries(Object.entries(transcript).reverse())
    expect(deriveVerifiedPairing(secret, reversed)).toEqual(original)
    for (const change of [
      { challengeId: 'chl_other' }, { attemptId: 'E'.repeat(43) },
      { phoneNonce: 'F'.repeat(43) }, { daemonNonce: 'G'.repeat(43) },
      { phoneNonce: transcript.daemonNonce, daemonNonce: transcript.phoneNonce },
      { deviceName: 'Another phone' }, { expiresAt: 123457 },
    ]) {
      expect(deriveVerifiedPairing(secret, { ...transcript, ...change }).identity)
        .not.toEqual(original.identity)
    }
    expect(deriveVerifiedPairing('H'.repeat(43), transcript)).not.toEqual(original)
  })

  it('separates the v2 channel from QR rendezvous and durable device channels', async () => {
    const v2 = deriveVerifiedPairing(secret, transcript)
    const payload = await seal(v2.identity, 'decision')
    for (const identity of [await derivePairingIdentity(secret), await deriveRelayIdentity(secret)]) {
      expect(identity.roomTag).not.toEqual(v2.identity.roomTag)
      expect(await open(identity, payload)).toBeNull()
    }
  })

  it.each([
    { v: 1 }, { v: 3 }, { deviceName: '\x1b[2J' }, { deviceName: '\u202ephone' }, { deviceName: '  ' }, { deviceName: '' }, { deviceName: 'x'.repeat(65) },
    { phoneNonce: 'short' }, { daemonNonce: '!'.repeat(43) }, { expiresAt: Infinity },
    { expiresAt: 1.5 }, { challengeId: 'x'.repeat(129) }, { unexpected: true },
  ])('rejects malformed or ambiguous transcripts: %j', (change) => {
    expect(() => deriveVerifiedPairing(secret, { ...transcript, ...change })).toThrow()
  })

  it.each(['', 'short', '!'.repeat(43), 'A'.repeat(44)])('rejects invalid QR secret %s', (bad) => {
    expect(() => deriveVerifiedPairing(bad, transcript)).toThrow()
  })

  it('does not accept credentials inside a transcript', () => {
    expect(PairingTranscript.safeParse({ ...transcript, token: 'llt_secret' }).success).toBe(false)
  })
})
