import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { derivePairingIdentity } from '@longleash/protocol'
import { issueRelayTicket } from '../../relay/worker/auth.js'
import { DeviceRegistry } from '../src/auth.js'
import { hostPairing } from '../src/pairing-host.js'
import { verifiedPairing } from '../../app/src/lib/verified-pairing.js'
const { Miniflare, convertV4MiniflareOptions } = createRequire(new URL('../../relay/package.json', import.meta.url))('miniflare')
const { build } = createRequire(new URL('../../cli/package.json', import.meta.url))('esbuild')
const cleanup: (() => unknown)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const secret = 'local-test-ticket-secret-'.repeat(3)

describe.each([false, true])('v2 over actual workerd Durable Object (hosted=%s)', (hosted) => {
  it('commits through the production relay implementation and enforces guest tickets', async () => {
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../relay/worker/index.ts', import.meta.url))], bundle: true, write: false,
      format: 'esm', platform: 'node', target: 'es2022', external: ['cloudflare:*'], logLevel: 'silent' })
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-08-17', compatibilityFlags: ['nodejs_compat'],
      script: bundle.outputFiles[0].text, durableObjects: { ROOM: { className: 'Room', useSQLite: true } },
      bindings: hosted ? { PUBLIC_APP_HOST: '127.0.0.1', RELAY_TICKET_SECRET: secret } : {},
      ratelimits: { RELAY_GUEST_RATE: { namespace_id: '1', simple: { limit: 120, period: 60 } }, RELAY_HOST_RATE: { namespace_id: '2', simple: { limit: 60, period: 60 } } },
    }))
    cleanup.push(() => runtime.dispose())
    const url = await runtime.ready
    const endpoint = `ws://${url.host}/ws`
    const registry = new DeviceRegistry(':memory:')
    cleanup.push(() => registry.close())
    const challenge = registry.createPairingChallenge({ version: 2 })
    const identity = await derivePairingIdentity(challenge.secret)
    if (hosted) {
      const denied = new WebSocket(`${endpoint}?room=${identity.roomTag}&role=guest`)
      const status = await new Promise<number>((resolve) => {
        denied.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); denied.terminate() })
        denied.on('error', () => {})
      })
      expect(status).toBe(401)
    }
    cleanup.push(hostPairing({ registry, relayUrl: endpoint, challenge }))
    const result = await verifiedPairing({ challengeId: challenge.challengeId, secret: challenge.secret, relay: true,
      signal: new AbortController().signal,
      socket: async (room) => {
        const ticket = hosted ? await issueRelayTicket(secret, { room, role: 'guest', userId: 'synthetic-test-user' }) : undefined
        return new WebSocket(`${endpoint}?room=${room}&role=guest`, ticket ? ['longleash-v1', ticket] : undefined) as never
      },
      onProgress: (progress, control) => {
        if (progress.state === 'compare') {
          expect(registry.listDevices()).toHaveLength(0)
          const local = registry.getPairingVerification(challenge.challengeId)!
          expect(local.code).toBe(progress.code)
          registry.confirmPairingLocally(challenge.challengeId, local.attemptId)
          control.confirm()
        }
      },
    })
    expect(registry.verifyToken(result.token)?.deviceId).toBe(result.deviceId)
    expect(registry.listDevices()).toHaveLength(1)
  }, 30_000)
})
