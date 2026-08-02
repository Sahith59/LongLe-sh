import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { RelayServer, CLOSE_BAD_MESSAGE, CLOSE_HOST_TAKEN, CLOSE_TOO_BIG, CLOSE_ROOM_FULL, CLOSE_JOIN_TIMEOUT } from '../src/server.js'

const HOST = '127.0.0.1'
let server: RelayServer
let port: number

beforeEach(async () => {
  server = new RelayServer({ host: HOST, port: 0, joinTimeoutMs: 300, maxGuests: 2 })
  port = await server.listen()
})

afterEach(async () => {
  await server.close()
})

const inbox = new WeakMap<WebSocket, Record<string, unknown>[]>()

function connect(): WebSocket {
  const ws = new WebSocket(`ws://${HOST}:${port}/ws`)
  inbox.set(ws, [])
  ws.on('message', (raw: WebSocket.RawData) => {
    inbox.get(ws)?.push(JSON.parse(String(raw)) as Record<string, unknown>)
  })
  return ws
}

function opened(ws: WebSocket): Promise<void> {
  // Localhost handshakes can finish before this helper runs; a listener attached after the
  // 'open' event already fired would wait forever.
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

async function next(ws: WebSocket, type: string, timeoutMs = 1500): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = inbox.get(ws)?.find((m) => m.type === type)
    if (found) {
      inbox.get(ws)?.splice(inbox.get(ws)!.indexOf(found), 1)
      return found
    }
    if (Date.now() > deadline) throw new Error(`no "${type}" message arrived`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function closedWith(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)))
}

async function join(ws: WebSocket, room: string, role: 'host' | 'guest'): Promise<Record<string, unknown>> {
  await opened(ws)
  ws.send(JSON.stringify({ v: 1, type: 'join', room, role }))
  return next(ws, 'joined')
}

const ROOM = 'a'.repeat(43) // the shape of a real room tag: high-entropy, base64url-ish

describe('joining', () => {
  it('acknowledges a join and reports who else is there', async () => {
    const laptop = connect()
    expect(await join(laptop, ROOM, 'host')).toMatchObject({ role: 'host', host: true, guests: 0 })
    const phone = connect()
    expect(await join(phone, ROOM, 'guest')).toMatchObject({ role: 'guest', host: true, guests: 1 })
    laptop.close()
    phone.close()
  })

  it('tells a guest when its host arrives and leaves — the phone shows "laptop online" from this', async () => {
    const phone = connect()
    expect(await join(phone, ROOM, 'guest')).toMatchObject({ host: false })

    const laptop = connect()
    await join(laptop, ROOM, 'host')
    expect(await next(phone, 'peer')).toMatchObject({ role: 'host', event: 'joined' })

    laptop.close()
    expect(await next(phone, 'peer')).toMatchObject({ role: 'host', event: 'left' })
    phone.close()
  })

  it('rejects a second host without disturbing the first', async () => {
    const laptop = connect()
    await join(laptop, ROOM, 'host')
    const impostor = connect()
    await opened(impostor)
    impostor.send(JSON.stringify({ v: 1, type: 'join', room: ROOM, role: 'host' }))
    expect(await closedWith(impostor)).toBe(CLOSE_HOST_TAKEN)
    expect(laptop.readyState).toBe(WebSocket.OPEN)
    laptop.close()
  })

  it('enforces the guest cap', async () => {
    const laptop = connect()
    await join(laptop, ROOM, 'host')
    const g1 = connect()
    const g2 = connect()
    await join(g1, ROOM, 'guest')
    await join(g2, ROOM, 'guest')
    const g3 = connect()
    await opened(g3)
    g3.send(JSON.stringify({ v: 1, type: 'join', room: ROOM, role: 'guest' }))
    expect(await closedWith(g3)).toBe(CLOSE_ROOM_FULL)
    for (const ws of [laptop, g1, g2]) ws.close()
  })

  it('drops a connection that never joins — parked sockets are not free', async () => {
    const lurker = connect()
    await opened(lurker)
    expect(await closedWith(lurker)).toBe(CLOSE_JOIN_TIMEOUT)
  })
})

describe('routing ciphertext', () => {
  it('delivers a guest frame to the host byte-for-byte, and never parses it', async () => {
    const laptop = connect()
    const phone = connect()
    await join(laptop, ROOM, 'host')
    await join(phone, ROOM, 'guest')

    // Not JSON, not UTF-8-meaningful — the relay must not care.
    const ciphertext = Buffer.from([0, 255, 12, 254, 99]).toString('base64')
    phone.send(JSON.stringify({ v: 1, type: 'frame', payload: ciphertext }))
    expect(await next(laptop, 'frame')).toMatchObject({ payload: ciphertext })
    laptop.close()
    phone.close()
  })

  it('fans a host frame out to every guest', async () => {
    const laptop = connect()
    const g1 = connect()
    const g2 = connect()
    await join(laptop, ROOM, 'host')
    await join(g1, ROOM, 'guest')
    await join(g2, ROOM, 'guest')

    laptop.send(JSON.stringify({ v: 1, type: 'frame', payload: 'aGVsbG8' }))
    expect(await next(g1, 'frame')).toMatchObject({ payload: 'aGVsbG8' })
    expect(await next(g2, 'frame')).toMatchObject({ payload: 'aGVsbG8' })
    for (const ws of [laptop, g1, g2]) ws.close()
  })

  it('keeps rooms watertight', async () => {
    const laptopA = connect()
    const laptopB = connect()
    const phoneA = connect()
    await join(laptopA, ROOM, 'host')
    await join(laptopB, 'b'.repeat(43), 'host')
    await join(phoneA, ROOM, 'guest')

    phoneA.send(JSON.stringify({ v: 1, type: 'frame', payload: 'c2VjcmV0' }))
    expect(await next(laptopA, 'frame')).toMatchObject({ payload: 'c2VjcmV0' })
    await expect(next(laptopB, 'frame', 300)).rejects.toThrow()
    for (const ws of [laptopA, laptopB, phoneA]) ws.close()
  })

  it('a frame sent to an empty other side is dropped, not queued — the relay stores nothing', async () => {
    const phone = connect()
    await join(phone, ROOM, 'guest')
    phone.send(JSON.stringify({ v: 1, type: 'frame', payload: 'bG9zdA' }))

    const laptop = connect()
    await join(laptop, ROOM, 'host')
    await expect(next(laptop, 'frame', 300)).rejects.toThrow()
    laptop.close()
    phone.close()
  })
})

describe('hostile input', () => {
  it('closes on garbage that is not JSON', async () => {
    const ws = connect()
    await opened(ws)
    ws.send('not json at all')
    expect(await closedWith(ws)).toBe(CLOSE_BAD_MESSAGE)
  })

  it('closes on a frame sent before joining', async () => {
    const ws = connect()
    await opened(ws)
    ws.send(JSON.stringify({ v: 1, type: 'frame', payload: 'aGk' }))
    expect(await closedWith(ws)).toBe(CLOSE_BAD_MESSAGE)
  })

  it('closes on an oversized frame instead of relaying it', async () => {
    const laptop = connect()
    const phone = connect()
    await join(laptop, ROOM, 'host')
    await join(phone, ROOM, 'guest')
    // Over the 256K frame rule but under the transport's own 300K cap, so the protocol —
    // not the websocket library — is what answers.
    phone.send(JSON.stringify({ v: 1, type: 'frame', payload: 'A'.repeat(280_000) }))
    expect(await closedWith(phone)).toBe(CLOSE_TOO_BIG)
    laptop.close()
  })

  it('closes on a join with a laughably short room tag', async () => {
    const ws = connect()
    await opened(ws)
    ws.send(JSON.stringify({ v: 1, type: 'join', room: 'abc', role: 'guest' }))
    expect(await closedWith(ws)).toBe(CLOSE_BAD_MESSAGE)
  })
})

describe('plumbing', () => {
  it('answers an app-level ping — browsers cannot send protocol pings', async () => {
    const ws = connect()
    await join(ws, ROOM, 'guest')
    ws.send(JSON.stringify({ v: 1, type: 'ping' }))
    expect(await next(ws, 'pong')).toBeDefined()
    ws.close()
  })

  it('serves /health for the deploy platform to probe', async () => {
    const res = await fetch(`http://${HOST}:${port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('reports nothing about rooms on /health — the relay is blind and stays blind', async () => {
    const laptop = connect()
    await join(laptop, ROOM, 'host')
    const body = JSON.stringify(await (await fetch(`http://${HOST}:${port}/health`)).json())
    expect(body).not.toContain(ROOM)
    laptop.close()
  })
})

describe('serving the app shell', () => {
  it('declares its role on /health so the app knows which origin it woke up on', async () => {
    const res = await fetch(`http://${HOST}:${port}/health`)
    expect(await res.json()).toMatchObject({ ok: true, role: 'relay' })
  })
})
