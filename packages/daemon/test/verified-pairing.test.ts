import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveVerifiedPairing } from '@longleash/protocol'
import { DeviceRegistry } from '../src/auth.js'

let now: number
let registry: DeviceRegistry
beforeEach(() => { now = 1000; registry = new DeviceRegistry(':memory:', { now: () => now, challengeTtlMs: 5000 }) })
afterEach(() => registry.close())
const start = () => {
  const challenge = registry.createPairingChallenge({ version: 2 })
  const input = { v: 2 as const, challengeId: challenge.challengeId, secret: challenge.secret, deviceName: 'Phone', phoneNonce: 'P'.repeat(43) }
  const transcript = registry.beginVerifiedPairing(input)
  return { challenge, input, transcript }
}

describe('v2 device registration gate', () => {
  it('requires local consent and remote consent before minting a durable device', () => {
    const { challenge, transcript } = start()
    const local = registry.getPairingVerification(challenge.challengeId)
    expect(local?.code).toBe(deriveVerifiedPairing(challenge.secret, transcript).code)
    expect(registry.listDevices()).toEqual([])
    expect(registry.listRelayDevices()).toEqual([])
    expect(() => registry.finishVerifiedPairing(challenge.challengeId, transcript.attemptId)).toThrow(/laptop/i)
    expect(registry.listDevices()).toEqual([])
    registry.confirmPairingLocally(challenge.challengeId, transcript.attemptId)
    expect(registry.listDevices()).toEqual([])
    const result = registry.finishVerifiedPairing(challenge.challengeId, transcript.attemptId)
    expect(registry.verifyToken(result.token)?.deviceId).toBe(result.device.deviceId)
    expect(registry.listRelayDevices()).toEqual([{ deviceId: result.device.deviceId, relaySecret: result.relaySecret }])
    expect(() => registry.finishVerifiedPairing(challenge.challengeId, transcript.attemptId)).toThrow()
    expect(registry.listDevices()).toHaveLength(1)
  })

  it('never allows a legacy caller to redeem a v2 QR', () => {
    const { input } = start()
    expect(() => registry.completePairing(input)).toThrow(/verif/i)
    expect(registry.listDevices()).toEqual([])
  })

  it('refuses a v1 QR in the v2 handshake with an update instruction', () => {
    const challenge = registry.createPairingChallenge()
    expect(() => registry.beginVerifiedPairing({ ...challenge, v: 2, deviceName: 'phone', phoneNonce: 'P'.repeat(43) })).toThrow()
    expect(() => registry.beginVerifiedPairing({ v: 2, challengeId: challenge.challengeId, secret: challenge.secret, deviceName: 'phone', phoneNonce: 'P'.repeat(43) })).toThrow(/new.*QR/i)
  })

  it('burns the challenge on an authenticated competing attempt', () => {
    const { input, transcript } = start()
    expect(registry.beginVerifiedPairing(input)).toEqual(transcript) // retransmission
    expect(() => registry.beginVerifiedPairing({ ...input, phoneNonce: 'Q'.repeat(43) })).toThrow(/competing/i)
    expect(() => registry.confirmPairingLocally(input.challengeId, transcript.attemptId)).toThrow()
    expect(registry.pendingChallengeCount()).toBe(0)
    expect(registry.listDevices()).toEqual([])
  })

  it('does not let a wrong-secret guest cancel a legitimate attempt', () => {
    const { input, transcript } = start()
    expect(() => registry.beginVerifiedPairing({ ...input, secret: 'X'.repeat(43) })).toThrow(/secret/i)
    expect(registry.getPairingVerification(input.challengeId)?.attemptId).toBe(transcript.attemptId)
  })

  it.each(['reject', 'disconnect'] as const)('invalidates both approvals on %s', () => {
    const { input, transcript } = start()
    registry.confirmPairingLocally(input.challengeId, transcript.attemptId)
    registry.cancelVerifiedPairing(input.challengeId, transcript.attemptId)
    expect(() => registry.finishVerifiedPairing(input.challengeId, transcript.attemptId)).toThrow()
    expect(registry.listDevices()).toEqual([])
  })

  it('expires at the exact deadline, even after local confirmation', () => {
    const { input, transcript } = start()
    registry.confirmPairingLocally(input.challengeId, transcript.attemptId)
    now = transcript.expiresAt
    expect(() => registry.finishVerifiedPairing(input.challengeId, transcript.attemptId)).toThrow(/expired/i)
    expect(registry.pendingChallengeCount()).toBe(0)
    expect(registry.listDevices()).toEqual([])
  })

  it('does not let stale attempt IDs confirm or cancel the current attempt', () => {
    const { input, transcript } = start()
    expect(() => registry.confirmPairingLocally(input.challengeId, 'stale')).toThrow()
    expect(() => registry.cancelVerifiedPairing(input.challengeId, 'stale')).toThrow()
    expect(() => registry.finishVerifiedPairing(input.challengeId, 'stale')).toThrow()
    expect(registry.getPairingVerification(input.challengeId)?.attemptId).toBe(transcript.attemptId)
  })

  it('bounds outstanding challenges and reclaims expired capacity', () => {
    for (let i = 0; i < 8; i++) registry.createPairingChallenge({ version: 2 })
    expect(() => registry.createPairingChallenge({ version: 2 })).toThrow(/many/i)
    now += 5000
    expect(() => registry.createPairingChallenge({ version: 2 })).not.toThrow()
  })

  it('rejects extra fields that could smuggle local confirmation', () => {
    const { input } = start()
    expect(() => registry.beginVerifiedPairing({ ...input, localConfirmed: true })).toThrow()
    expect(registry.listDevices()).toEqual([])
  })

  it('does not expose mutable internal state through its transcript', () => {
    const { input, transcript } = start()
    transcript.deviceName = 'changed'
    expect(registry.beginVerifiedPairing(input).deviceName).toBe('Phone')
  })
})

it('fires no paired listener until the one successful commit', () => {
  const events: string[] = []
  registry.onPaired((device) => events.push(device.deviceId))
  const { input, transcript } = start()
  registry.confirmPairingLocally(input.challengeId, transcript.attemptId)
  expect(events).toEqual([])
  const { device } = registry.finishVerifiedPairing(input.challengeId, transcript.attemptId)
  expect(events).toEqual([device.deviceId])
  expect(() => registry.finishVerifiedPairing(input.challengeId, transcript.attemptId)).toThrow()
  expect(events).toHaveLength(1)
})

it('never persists pending secrets, codes, or consent across restart', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'longleash-verified-'))
  const path = join(directory, 'devices.db')
  let persistent = new DeviceRegistry(path)
  try {
    const challenge = persistent.createPairingChallenge({ version: 2 })
    const transcript = persistent.beginVerifiedPairing({ v: 2, challengeId: challenge.challengeId, secret: challenge.secret, phoneNonce: 'R'.repeat(43), deviceName: 'Phone' })
    persistent.confirmPairingLocally(challenge.challengeId, transcript.attemptId)
    expect(persistent.rawDb.prepare('SELECT * FROM devices').all()).toEqual([])
    persistent.close()
    persistent = new DeviceRegistry(path)
    expect(persistent.pendingChallengeCount()).toBe(0)
    expect(persistent.getPairingVerification(challenge.challengeId)).toBeNull()
    expect(() => persistent.finishVerifiedPairing(challenge.challengeId, transcript.attemptId)).toThrow()
    expect(persistent.listDevices()).toEqual([])
  } finally {
    persistent.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
