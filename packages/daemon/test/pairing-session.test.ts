import { afterEach, expect, it } from 'vitest'
import { derivePairingIdentity, deriveVerifiedPairing, open, seal, type RelayIdentity } from '@longleash/protocol'
import { DeviceRegistry } from '../src/auth.js'
import { createPairingSession } from '../src/pairing-session.js'
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
async function setup() {
  const registry = new DeviceRegistry(':memory:')
  cleanups.push(() => registry.close())
  const challenge = registry.createPairingChallenge({ version: 2 })
  const identity = await derivePairingIdentity(challenge.secret)
  const replies: string[] = []
  const session = createPairingSession({ registry, challenge, send: (payload) => replies.push(payload), close: () => {} })
  cleanups.push(session.dispose)
  const send = async (key: RelayIdentity, body: unknown) => session.receive(await seal(key, JSON.stringify(body)))
  await send(identity, { v: 2, type: 'pair-begin', challengeId: challenge.challengeId, phoneNonce: 'P'.repeat(43), deviceName: 'Phone' })
  const message = JSON.parse((await open(identity, replies.shift()!))!)
  const transcript = message.transcript
  const verified = deriveVerifiedPairing(challenge.secret, transcript)
  return { registry, challenge, session, identity, replies, send, transcript, verified }
}
it('waits for both devices and commits once, encrypted under the attempt key', async () => {
  const h = await setup()
  await h.send(h.verified.identity, { v: 2, type: 'pair-confirm', attemptId: h.transcript.attemptId })
  expect(h.registry.listDevices()).toHaveLength(0)
  h.registry.confirmPairingLocally(h.challenge.challengeId, h.transcript.attemptId)
  await h.session.tick()
  expect(h.registry.listDevices()).toHaveLength(1)
  const paired = h.replies.at(-1)!
  expect(await open(h.identity, paired)).toBeNull()
  expect(JSON.parse((await open(h.verified.identity, paired))!).type).toBe('paired')
  await h.session.tick()
  expect(h.registry.listDevices()).toHaveLength(1)
})
it('cannot confirm using the rendezvous key or a reflected server frame', async () => {
  const h = await setup()
  h.registry.confirmPairingLocally(h.challenge.challengeId, h.transcript.attemptId)
  await h.send(h.identity, { v: 2, type: 'pair-confirm', attemptId: h.transcript.attemptId })
  await h.send(h.verified.identity, { v: 2, type: 'pair-waiting', attemptId: h.transcript.attemptId })
  await h.session.tick()
  expect(h.registry.listDevices()).toHaveLength(0)
})
it.each(['reject', 'disconnect'])('burns pending trust on %s', async (reason) => {
  const h = await setup()
  if (reason === 'reject') await h.send(h.verified.identity, { v: 2, type: 'pair-reject', attemptId: h.transcript.attemptId })
  else h.session.dispose()
  expect(h.registry.hasPairingChallenge(h.challenge.challengeId)).toBe(false)
  expect(h.registry.listDevices()).toHaveLength(0)
})
it('does not let a second transport replay the same begin to inherit consent', async () => {
  const h = await setup()
  h.registry.confirmPairingLocally(h.challenge.challengeId, h.transcript.attemptId)
  const other = createPairingSession({ registry: h.registry, challenge: h.challenge, send: () => {}, close: () => {} })
  cleanups.push(other.dispose)
  await other.receive(await seal(h.identity, JSON.stringify({ v: 2, type: 'pair-begin', challengeId: h.challenge.challengeId, phoneNonce: 'P'.repeat(43), deviceName: 'Phone' })))
  await h.session.tick()
  expect(h.registry.hasPairingChallenge(h.challenge.challengeId)).toBe(false)
  expect(h.registry.listDevices()).toHaveLength(0)
})

it('ignores corrupt encrypted frames without invalidating the honest pending attempt', async () => {
  const h = await setup()
  await h.session.receive('not-an-authenticated-envelope')
  expect(h.registry.hasPairingChallenge(h.challenge.challengeId)).toBe(true)
  expect(h.registry.listDevices()).toEqual([])
})

it('expires an otherwise confirmed attempt without issuing credentials', async () => {
  const h = await setup()
  h.registry.confirmPairingLocally(h.challenge.challengeId, h.transcript.attemptId)
  // Transport deadline can be reached independently of a locally confirmed registry record.
  h.challenge.expiresAt = Date.now() - 1
  await h.session.tick()
  expect(h.registry.hasPairingChallenge(h.challenge.challengeId)).toBe(false)
  expect(h.registry.listDevices()).toEqual([])
})

it('bounds abusive pending frame volume and destroys pending consent', async () => {
  const h = await setup()
  for (let n = 0; n < 61; n++) await h.session.receive('unauthenticated-noise')
  expect(h.registry.hasPairingChallenge(h.challenge.challengeId)).toBe(false)
  expect(h.registry.listDevices()).toEqual([])
})

it('gives old relay clients an encrypted update requirement', async () => {
  const registry = new DeviceRegistry(':memory:')
  cleanups.push(() => registry.close())
  const challenge = registry.createPairingChallenge({ version: 2 })
  const identity = await derivePairingIdentity(challenge.secret)
  const replies: string[] = []
  const session = createPairingSession({ registry, challenge, send: (payload) => replies.push(payload), close: () => {} })
  cleanups.push(session.dispose)
  await session.receive(await seal(identity, JSON.stringify({ v: 1, type: 'completePairing', challengeId: challenge.challengeId, secret: challenge.secret, deviceName: 'Old phone' })))
  expect(JSON.parse((await open(identity, replies[0]!))!)).toEqual({ v: 1, type: 'pair-error', reason: 'update-required' })
  expect(registry.listDevices()).toEqual([])
})
