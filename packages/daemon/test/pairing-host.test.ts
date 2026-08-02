import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { RelayServer } from '@longleash/relay/src/server.js'
import { derivePairingIdentity, open, seal } from '@longleash/protocol'
import { DeviceRegistry } from '../src/auth.js'
import { hostPairing } from '../src/pairing-host.js'

const HOST = '127.0.0.1'
let relay: RelayServer
let relayUrl: string
let registry: DeviceRegistry
let disposers: (() => void)[]

beforeEach(async () => {
  relay = new RelayServer({ host: HOST, port: 0 })
  relayUrl = `ws://${HOST}:${await relay.listen()}/ws`
  registry = new DeviceRegistry(':memory:')
  disposers = []
})

afterEach(async () => {
  for (const dispose of disposers) dispose()
  registry.close()
  await relay.close()
})

/** A phone that can only see the relay, completing its pairing there. */
async function phoneAttempt(challengeSecret: string, message: Record<string, unknown>) {
  const identity = await derivePairingIdentity(challengeSecret)
  const ws = new WebSocket(relayUrl)
  const replies: Record<string, unknown>[] = []
  ws.on('message', (raw: WebSocket.RawData) => {
    const parsed = JSON.parse(String(raw)) as { type?: string; payload?: string }
    if (parsed.type === 'frame' && parsed.payload) {
      void open(identity, parsed.payload).then((text) => {
        if (text !== null) replies.push(JSON.parse(text) as Record<string, unknown>)
      })
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'guest' }))
  await new Promise((r) => setTimeout(r, 150))
  ws.send(JSON.stringify({ v: 1, type: 'frame', payload: await seal(identity, JSON.stringify(message)) }))
  const deadline = Date.now() + 4000
  while (replies.length === 0) {
    if (Date.now() > deadline) {
      ws.close()
      throw new Error('no sealed reply arrived')
    }
    await new Promise((r) => setTimeout(r, 15))
  }
  ws.close()
  return replies[0] as Record<string, unknown>
}

describe('pairing through the relay', () => {
  it('completes a pairing entirely over sealed frames and returns token + relay secret', async () => {
    const challenge = registry.createPairingChallenge()
    disposers.push(hostPairing({ registry, relayUrl, challenge }))

    const reply = await phoneAttempt(challenge.secret, {
      v: 1,
      type: 'completePairing',
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'iPhone afar',
    })
    expect(reply.type).toBe('paired')
    expect(String(reply.token)).toMatch(/^llt_/)
    expect(String(reply.relaySecret)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // And the registry agrees this device now exists.
    expect(registry.verifyToken(String(reply.token))?.name).toBe('iPhone afar')
  })

  it('answers a wrong inner secret with a sealed refusal, and issues nothing', async () => {
    const challenge = registry.createPairingChallenge()
    disposers.push(hostPairing({ registry, relayUrl, challenge }))

    const reply = await phoneAttempt(challenge.secret, {
      v: 1,
      type: 'completePairing',
      challengeId: challenge.challengeId,
      secret: 'x'.repeat(43),
      deviceName: 'impostor',
    })
    expect(reply.type).toBe('pair-error')
    expect(registry.listDevices()).toHaveLength(0)
  })

  it('a frame sealed with the wrong pairing key is dropped silently', async () => {
    const challenge = registry.createPairingChallenge()
    disposers.push(hostPairing({ registry, relayUrl, challenge }))

    await expect(
      phoneAttempt('w'.repeat(43), {
        v: 1,
        type: 'completePairing',
        challengeId: challenge.challengeId,
        secret: challenge.secret,
        deviceName: 'wrong room key',
      }),
    ).rejects.toThrow('no sealed reply')
    expect(registry.listDevices()).toHaveLength(0)
  })

  it('a burnt challenge can never issue a second device, and the room then dies', async () => {
    const challenge = registry.createPairingChallenge()
    disposers.push(hostPairing({ registry, relayUrl, challenge }))
    await phoneAttempt(challenge.secret, {
      v: 1,
      type: 'completePairing',
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'first',
    })

    // Inside the brief reply-flush window a retry is sealed-refused, never double-issued…
    const retry = await phoneAttempt(challenge.secret, {
      v: 1,
      type: 'completePairing',
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'second',
    }).catch(() => ({ type: 'silence' }))
    expect(retry.type === 'pair-error' || retry.type === 'silence').toBe(true)
    expect(registry.listDevices()).toHaveLength(1)

    // …and once the window passes, the room is gone entirely.
    await new Promise((r) => setTimeout(r, 700))
    await expect(
      phoneAttempt(challenge.secret, {
        v: 1,
        type: 'completePairing',
        challengeId: challenge.challengeId,
        secret: challenge.secret,
        deviceName: 'third',
      }),
    ).rejects.toThrow('no sealed reply')
    expect(registry.listDevices()).toHaveLength(1)
  }, 15_000) // three sequential attempts, one of which must wait out a silence window
})
