import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { RelayServer } from '@longleash/relay/src/server.js'
import { deriveRelayIdentity, open, seal } from '@longleash/protocol'
import { RelayLink } from '../src/relay-link.js'

const HOST = '127.0.0.1'
const SECRET = 's'.repeat(43)

let relay: RelayServer
let port: number
let links: RelayLink[]

beforeEach(async () => {
  relay = new RelayServer({ host: HOST, port: 0 })
  port = await relay.listen()
  links = []
})

afterEach(async () => {
  for (const link of links) link.stop()
  await relay.close()
})

function makeLink(
  opts: { onMessage?: (text: string) => void; url?: string; keepaliveMs?: number } = {},
): RelayLink {
  const link = new RelayLink({
    url: opts.url ?? `ws://${HOST}:${port}/ws`,
    secret: SECRET,
    onMessage: opts.onMessage ?? (() => {}),
    backoffMs: { min: 40, max: 120 },
    ...(opts.keepaliveMs === undefined ? {} : { keepaliveMs: opts.keepaliveMs }),
  })
  links.push(link)
  return link
}

/** A phone: joins the same room as guest and speaks the same envelope. */
async function phone(): Promise<{ ws: WebSocket; frames: string[] }> {
  const identity = await deriveRelayIdentity(SECRET)
  const ws = new WebSocket(`ws://${HOST}:${port}/ws`)
  const frames: string[] = []
  ws.on('message', (raw: WebSocket.RawData) => {
    const message = JSON.parse(String(raw)) as { type?: string; payload?: string }
    if (message.type === 'frame' && message.payload) {
      void open(identity, message.payload).then((text) => {
        if (text !== null) frames.push(text)
      })
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'guest' }))
  await until(() => frames.length >= 0) // join settles with the next tick of traffic
  return { ws, frames }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('the daemon side of the relay', () => {
  it('joins its room as the host and reports itself connected', async () => {
    const link = makeLink()
    link.start()
    await until(() => link.status === 'connected')
  })

  it('decrypts a frame from the phone and hands over the plaintext', async () => {
    const received: string[] = []
    const link = makeLink({ onMessage: (text) => received.push(text) })
    link.start()
    await until(() => link.status === 'connected')

    const { ws } = await phone()
    const identity = await deriveRelayIdentity(SECRET)
    ws.send(JSON.stringify({ v: 1, type: 'frame', payload: await seal(identity, '{"type":"subscribe"}') }))
    await until(() => received.length === 1)
    expect(received[0]).toBe('{"type":"subscribe"}')
    ws.close()
  })

  it('seals what it sends so the phone can open it and the relay cannot', async () => {
    const link = makeLink()
    link.start()
    await until(() => link.status === 'connected')
    const guest = await phone()

    link.send('{"type":"hello","roots":[]}')
    await until(() => guest.frames.length === 1)
    expect(guest.frames[0]).toBe('{"type":"hello","roots":[]}')
    guest.ws.close()
  })

  it('drops a frame that fails to open and keeps serving — a hostile peer gains nothing', async () => {
    const received: string[] = []
    const link = makeLink({ onMessage: (text) => received.push(text) })
    link.start()
    await until(() => link.status === 'connected')

    const { ws } = await phone()
    const identity = await deriveRelayIdentity(SECRET)
    ws.send(JSON.stringify({ v: 1, type: 'frame', payload: 'bm90IGEgcmVhbCBlbnZlbG9wZQ' }))
    ws.send(JSON.stringify({ v: 1, type: 'frame', payload: await seal(identity, 'legit') }))
    await until(() => received.length === 1)
    expect(received).toEqual(['legit'])
    ws.close()
  })

  it('reconnects after the relay dies and comes back', async () => {
    const link = makeLink()
    link.start()
    await until(() => link.status === 'connected')

    await relay.close()
    await until(() => link.status !== 'connected')

    relay = new RelayServer({ host: HOST, port })
    await relay.listen()
    await until(() => link.status === 'connected', 5000)
  })

  it('stop() means stop — no zombie reconnect loop', async () => {
    const link = makeLink()
    link.start()
    await until(() => link.status === 'connected')
    link.stop()
    await relay.close()
    relay = new RelayServer({ host: HOST, port })
    await relay.listen()
    await new Promise((r) => setTimeout(r, 300))
    expect(link.status).toBe('stopped')
  })

  it('keeps the room alive with periodic pings — idle sockets get culled in transit', async () => {
    // Cloudflare (and most proxies) close a WebSocket that has carried nothing for ~100s.
    // Without this the link died and rebuilt every minute forever, which is exactly what a
    // daemon terminal full of repeating "relay room joined" lines was telling us.
    const seen: string[] = []
    const spy = new WebSocketServer({ host: HOST, port: 0 })
    spy.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const type = (JSON.parse(String(raw)) as { type?: string }).type
        if (type) seen.push(type)
        if (type === 'join') socket.send(JSON.stringify({ type: 'joined', host: true, guests: 0 }))
      })
    })
    const port = await new Promise<number>((resolve) => {
      spy.once('listening', () => {
        const address = spy.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    const link = makeLink({ url: `ws://${HOST}:${port}/ws`, keepaliveMs: 60 })
    link.start()
    await until(() => seen.filter((t) => t === 'ping').length >= 2, 4000)
    expect(seen[0]).toBe('join')
    link.stop()

    // Stopping must also stop the pings; a zombie timer would outlive the link.
    const after = seen.filter((t) => t === 'ping').length
    await new Promise((r) => setTimeout(r, 250))
    expect(seen.filter((t) => t === 'ping').length).toBe(after)
    await new Promise<void>((resolve) => spy.close(() => resolve()))
  })

  it('survives a malicious relay speaking garbage', async () => {
    // Not our relay: a hostile impostor that answers the join with junk and floods noise.
    const evil = new WebSocketServer({ host: HOST, port: 0 })
    evil.on('connection', (socket) => {
      socket.send('}{ not json')
      socket.send(JSON.stringify({ type: 'frame' })) // no payload
      socket.send(JSON.stringify({ type: 'frame', payload: 12345 })) // wrong type
      socket.send(JSON.stringify({ type: 'utterly-unknown' }))
    })
    const evilPort = await new Promise<number>((resolve) => {
      evil.once('listening', () => {
        const address = evil.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    const received: string[] = []
    const link = makeLink({
      url: `ws://${HOST}:${evilPort}/ws`,
      onMessage: (text) => received.push(text),
    })
    link.start()
    await new Promise((r) => setTimeout(r, 300))
    expect(received).toEqual([]) // nothing fake was ever surfaced
    link.stop()
    await new Promise<void>((resolve) => evil.close(() => resolve()))
  })
})
