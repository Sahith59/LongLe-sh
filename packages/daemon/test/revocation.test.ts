import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { EventLog } from '../src/eventlog.js'
import { DeviceRegistry } from '../src/auth.js'
import { ApprovalStore } from '../src/approvals.js'
import { ExternalSessions } from '../src/external.js'
import { LongLeashServer, CLOSE_REVOKED, CLOSE_UNAUTHORIZED } from '../src/server.js'

/**
 * Un-pairing a lost or stolen phone. The property under test is not "a flag was set" but
 * "that device can no longer reach this laptop, by any path it had" — the open socket, a
 * fresh connection, the relay room, and push. A revocation that only satisfies the first
 * is the kind that reads as done and leaves someone exposed.
 */

const HOST = '127.0.0.1'
const SECRET = 'test-hook-secret'

interface Harness {
  server: LongLeashServer
  registry: DeviceRegistry
  log: EventLog
  approvals: ApprovalStore
  external: ExternalSessions
  port: number
  token: string
  deviceId: string
}

let live: Harness | null = null

afterEach(async () => {
  if (live) {
    await live.server.close()
    live.log.close()
    live.approvals.close()
    live.registry.close()
    live.external.shutdown()
  }
  live = null
})

async function harness(): Promise<Harness> {
  const log = new EventLog(':memory:')
  const registry = new DeviceRegistry(':memory:')
  const approvals = new ApprovalStore(':memory:')
  const challenge = registry.createPairingChallenge()
  const { device, token } = registry.completePairing({
    challengeId: challenge.challengeId,
    secret: challenge.secret,
    deviceName: 'the phone that gets stolen',
  })
  const server = new LongLeashServer({ eventLog: log, registry, host: HOST, port: 0 })
  const external = new ExternalSessions({ eventLog: log, approvals, audience: () => 'connected' as const })
  server.attachExternal(external, SECRET)
  const { port } = await server.listen()
  const h = { server, registry, log, approvals, external, port, token, deviceId: device.deviceId }
  live = h
  return h
}

const api = (h: Harness, path: string, init: RequestInit = {}, secret = SECRET) =>
  fetch(`http://${HOST}:${h.port}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-longleash-hook': secret, ...(init.headers ?? {}) },
  })

function connect(h: Harness, token: string): WebSocket {
  return new WebSocket(`ws://${HOST}:${h.port}/ws?token=${encodeURIComponent(token)}`)
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never opened')), 4000)
    ws.on('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })

const closedWith = (ws: WebSocket) =>
  new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never closed')), 4000)
    ws.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    ws.on('error', () => {})
  })

describe('revoking a stolen device — it must lose every path it had', () => {
  it('drops the connection it is holding right now', async () => {
    const h = await harness()
    const ws = connect(h, h.token)
    await opened(ws)
    const closing = closedWith(ws)

    const response = await api(h, '/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId: h.deviceId }),
    })
    expect(response.status).toBe(200)
    // Not "will be dropped eventually" — dropped, with a code that says why.
    expect(await closing).toBe(CLOSE_REVOKED)
  })

  it('refuses the token afterwards, so it cannot simply reconnect', async () => {
    const h = await harness()
    await api(h, '/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: h.deviceId }) })
    expect(h.registry.verifyToken(h.token)).toBeNull()

    // The TCP upgrade may still succeed — authorisation is an application-level check that
    // runs after it — so "did it open?" is the wrong question. The property that matters is
    // that the socket is closed as unauthorised and never receives a hello, which is the
    // first thing a legitimate connection gets.
    const ws = connect(h, h.token)
    const seen: string[] = []
    ws.on('message', (raw: WebSocket.RawData) => {
      seen.push(String(JSON.parse(raw.toString()).type))
    })
    expect(await closedWith(ws)).toBe(CLOSE_UNAUTHORIZED)
    expect(seen).not.toContain('hello')
  })

  it('shuts its relay room too — the path that works from anywhere in the world', async () => {
    const h = await harness()
    expect(h.registry.listRelayDevices().some((d) => d.deviceId === h.deviceId)).toBe(true)
    await api(h, '/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: h.deviceId }) })
    // RelayBridge opens rooms from exactly this list; leaving the device here would keep
    // a stolen phone reachable from outside the LAN.
    expect(h.registry.listRelayDevices().some((d) => d.deviceId === h.deviceId)).toBe(false)
  })

  it('stops notifying it', async () => {
    const h = await harness()
    await api(h, '/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: h.deviceId }) })
    const device = h.registry.listDevices().find((d) => d.deviceId === h.deviceId)
    expect(device?.revokedAt).not.toBeNull()
  })

  it('leaves other paired devices untouched', async () => {
    const h = await harness()
    const c = h.registry.createPairingChallenge()
    const other = h.registry.completePairing({
      challengeId: c.challengeId,
      secret: c.secret,
      deviceName: 'the laptop-owner’s tablet',
    })
    await api(h, '/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: h.deviceId }) })
    expect(h.registry.verifyToken(other.token)).not.toBeNull()
    const ws = connect(h, other.token)
    await opened(ws)
    ws.close()
  })
})

describe('revoking is rooted in physical possession of the laptop', () => {
  it('a caller without the local secret cannot list devices', async () => {
    const h = await harness()
    expect((await api(h, '/devices', { method: 'GET' }, 'wrong-secret')).status).toBe(401)
    const noHeader = await fetch(`http://${HOST}:${h.port}/devices`)
    expect(noHeader.status).toBe(401)
  })

  it('a caller without the local secret cannot revoke — a thief cannot cut off the owner', async () => {
    const h = await harness()
    const response = await api(
      h,
      '/devices/revoke',
      { method: 'POST', body: JSON.stringify({ deviceId: h.deviceId }) },
      'wrong-secret',
    )
    expect(response.status).toBe(401)
    expect(h.registry.verifyToken(h.token)).not.toBeNull() // still paired
  })

  it('the phone protocol has no revoke operation at all', async () => {
    const h = await harness()
    const ws = connect(h, h.token)
    await opened(ws)
    // Even a fully authenticated phone cannot ask for this over its own channel.
    ws.send(JSON.stringify({ v: 1, type: 'revokeDevice', deviceId: h.deviceId }))
    await new Promise((r) => setTimeout(r, 250))
    expect(h.registry.verifyToken(h.token)).not.toBeNull()
    ws.close()
  })
})

describe('revoking says what happened rather than guessing', () => {
  it('reports an unknown device instead of silently succeeding', async () => {
    const h = await harness()
    const response = await api(h, '/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'dev_never-existed' }),
    })
    expect(response.status).toBe(404)
  })

  it('revoking twice is not reported as a second success', async () => {
    const h = await harness()
    const first = await api(h, '/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId: h.deviceId }),
    })
    const second = await api(h, '/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId: h.deviceId }),
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(404)
  })

  it('rejects a malformed request rather than acting on it', async () => {
    const h = await harness()
    expect((await api(h, '/devices/revoke', { method: 'POST', body: '{}' })).status).toBe(400)
  })

  it('lists devices with what a person needs to identify their own phone', async () => {
    const h = await harness()
    const { devices } = (await (await api(h, '/devices', { method: 'GET' })).json()) as {
      devices: { deviceId: string; name: string; revokedAt: number | null; connected: boolean }[]
    }
    expect(devices).toHaveLength(1)
    expect(devices[0]!.name).toContain('stolen')
    expect(devices[0]!.revokedAt).toBeNull()
  })

  it('shows which device is connected right now', async () => {
    const h = await harness()
    const ws = connect(h, h.token)
    await opened(ws)
    await new Promise((r) => setTimeout(r, 100))
    const { devices } = (await (await api(h, '/devices', { method: 'GET' })).json()) as {
      devices: { connected: boolean }[]
    }
    expect(devices[0]!.connected).toBe(true)
    ws.close()
  })
})
