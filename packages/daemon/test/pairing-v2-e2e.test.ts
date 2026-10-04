import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { RelayServer } from '@longleash/relay/src/server.js'
import { DeviceRegistry } from '../src/auth.js'
import { EventLog } from '../src/eventlog.js'
import { LongLeashServer } from '../src/server.js'
import { hostPairing } from '../src/pairing-host.js'
import { pairingUrl } from '../src/pairing-url.js'
import { verifiedPairing } from '../../app/src/lib/verified-pairing.js'
import { runVerifiedPairing } from '../../cli/src/pairing.js'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 20))
async function harness(relayMode: boolean, clockOffset = 0) {
  const registry = new DeviceRegistry(':memory:', { now: () => Date.now() + clockOffset })
  const log = new EventLog(':memory:')
  cleanup.push(() => { registry.close(); log.close() })
  const server = new LongLeashServer({ registry, eventLog: log, host: '127.0.0.1', port: 0 })
  server.attachExternal({} as never, 'local-test-secret')
  const { port } = await server.listen()
  cleanup.push(() => server.close())
  const base = `http://127.0.0.1:${port}`
  let endpoint = ''
  if (relayMode) {
    const relay = new RelayServer({ host: '127.0.0.1', port: 0 })
    endpoint = `ws://127.0.0.1:${await relay.listen()}/ws`
    cleanup.push(() => relay.close())
  }
  let challenge: ReturnType<DeviceRegistry['createPairingChallenge']>
  server.attachLocalPairing(() => {
    challenge = registry.createPairingChallenge({ version: 2 })
    server.registerPairingChallenge(challenge)
    if (relayMode) cleanup.push(hostPairing({ registry, relayUrl: endpoint, challenge }))
    return pairingUrl(base, challenge.challengeId, challenge.secret, 2)
  })
  const request = (path: string, init: RequestInit) => fetch(base + path, { ...init, headers: { ...init.headers, 'x-longleash-hook': 'local-test-secret' } })
  return { registry, request, base, endpoint, getChallenge: () => challenge! }
}

describe.each([false, true])('verified pairing end to end (relay=%s)', (relay) => {
  it('pairs through the real CLI/local API/browser protocol with no premature credentials', async () => {
    const h = await harness(relay)
    let phone: Promise<unknown> | undefined
    const output: string[] = []
    await runVerifiedPairing({ interactive: true, request: h.request, signal: new AbortController().signal,
      print: (text) => output.push(text), wait: sleep,
      ask: async () => { expect(h.registry.listDevices()).toHaveLength(0); return 'yes' },
      showQr: () => {
        const c = h.getChallenge()
        phone = verifiedPairing({ challengeId: c.challengeId, secret: c.secret, relay,
          signal: new AbortController().signal,
          socket: async () => new WebSocket(relay ? h.endpoint : h.base.replace('http:', 'ws:') + '/pair/v2?c=' + c.challengeId) as never,
          onProgress: (progress, control) => {
            if (progress.state === 'compare') {
              expect(h.registry.listDevices()).toHaveLength(0)
              expect(progress.code).toBe(h.registry.getPairingVerification(c.challengeId)?.code)
              control.confirm()
            }
          },
        })
      },
    })
    const result = await phone as { token: string }
    expect(h.registry.verifyToken(result.token)).not.toBeNull()
    expect(h.registry.listDevices()).toHaveLength(1)
    expect(output.at(-1)).toContain('phone is paired')
  })

  it('rejects mismatch and burns the QR without granting access', async () => {
    const h = await harness(relay)
    await h.request('/local/pairing', { method: 'POST' })
    const c = h.getChallenge()
    await expect(verifiedPairing({ challengeId: c.challengeId, secret: c.secret, relay,
      signal: new AbortController().signal,
      socket: async () => new WebSocket(relay ? h.endpoint : h.base.replace('http:', 'ws:') + '/pair/v2?c=' + c.challengeId) as never,
      onProgress: (progress, control) => { if (progress.state === 'compare') control.reject() },
    })).rejects.toThrow(/cancelled/i)
    for (let i = 0; i < 50 && h.registry.hasPairingChallenge(c.challengeId); i++) await sleep()
    expect(h.registry.hasPairingChallenge(c.challengeId)).toBe(false)
    expect(h.registry.listDevices()).toEqual([])
  })
})

it('denies browser-origin/wrong-secret local consent, rejects legacy completion, bounds QR requests', async () => {
  const h = await harness(false)
  await h.request('/local/pairing', { method: 'POST' })
  const c = h.getChallenge()
  for (const action of ['status', 'confirm', 'cancel']) {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: c.challengeId }) }
    expect((await fetch(h.base + '/local/pairing/' + action, init)).status).toBe(401)
    expect((await h.request('/local/pairing/' + action, { ...init, headers: { ...init.headers, origin: 'https://evil.invalid' } })).status).toBe(401)
  }
  const legacy = await fetch(h.base + `/pair?c=${c.challengeId}&s=${c.secret}`, { method: 'POST' })
  expect(legacy.status).toBe(403)
  expect(await legacy.json()).toEqual({ reason: 'verification-required' })
  for (let i = 0; i < 9; i++) await h.request('/local/pairing', { method: 'POST' })
  expect((await h.request('/local/pairing', { method: 'POST' })).status).toBe(429)
  expect(h.registry.listDevices()).toEqual([])
})

it('the browser tolerates clock differences and persists nothing until both confirmations', async () => {
  const { vi } = await import('vitest')
  const client = await import('../../app/src/lib/client.js')
  const h = await harness(false, 3_600_000)
  await h.request('/local/pairing', { method: 'POST' })
  const c = h.getChallenge()
  const storage = new Map<string, string>()
  const network = globalThis.fetch
  vi.stubGlobal('WebSocket', WebSocket)
  vi.stubGlobal('location', new URL(h.base))
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => network(new URL(url, h.base), init))
  try {
    client.configureCredentialAccount('test-account')
    await expect(client.pair(c.challengeId, c.secret, { version: 1, signal: new AbortController().signal, onProgress() {} })).rejects.toThrow(/older pairing/)
    const token = await client.pair(c.challengeId, c.secret, { version: 2, signal: new AbortController().signal,
      onProgress: (progress, control) => {
        if (progress.state === 'compare') {
          expect(storage.size).toBe(0)
          expect(progress.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000)
          const verification = h.registry.getPairingVerification(c.challengeId)!
          h.registry.confirmPairingLocally(c.challengeId, verification.attemptId)
          expect(storage.size).toBe(0)
          control.confirm()
        }
      },
    })
    expect(storage.get('longleash.token.account.test-account')).toBe(token)
    expect(storage.get('longleash.relaySecret.account.test-account')).toBeTruthy()
    expect(storage.has('longleash.token')).toBe(false)
  } finally { client.configureCredentialAccount(null); vi.unstubAllGlobals() }
})
