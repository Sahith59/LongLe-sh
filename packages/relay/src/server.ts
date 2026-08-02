import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { Rooms } from './rooms.js'
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_HOST_TAKEN,
  CLOSE_JOIN_TIMEOUT,
  CLOSE_OVERLOADED,
  CLOSE_ROOM_FULL,
  CLOSE_TOO_BIG,
  DEFAULT_MAX_GUESTS,
  MAX_FRAME_CHARS,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
} from './protocol.js'

/**
 * The relay: a rendezvous point for a phone and a laptop that cannot reach each other
 * directly. It routes opaque frames between the two sides of a room and forgets them in the
 * same breath. By construction it cannot read anything — payloads are ciphertext encrypted on
 * the devices with keys the relay never sees — and it must never try: no database, no payload
 * logging, no residue. That property is the product (the Happy #680 lesson as a design rule).
 *
 * TLS is terminated by the deploy platform (Fly, Caddy, nginx); the relay itself speaks ws.
 */

export {
  CLOSE_BAD_MESSAGE,
  CLOSE_JOIN_TIMEOUT,
  CLOSE_HOST_TAKEN,
  CLOSE_OVERLOADED,
  CLOSE_TOO_BIG,
  CLOSE_ROOM_FULL,
} from './protocol.js'

/** A slow consumer buffers here before we cut it loose rather than hoard its backlog. */
const MAX_BUFFERED_BYTES = 1_000_000
const HEARTBEAT_INTERVAL_MS = 30_000
const MISSED_HEARTBEATS_BEFORE_DROP = 3

export interface RelayServerOptions {
  host: string
  port: number
  maxGuests?: number
  joinTimeoutMs?: number
  /**
   * Directory holding the built web app. The relay serving the shell is what makes the
   * away-from-home entry exist at all: service workers demand HTTPS, a LAN daemon origin
   * cannot honestly provide it, and the deploy platform gives the relay TLS for free. The
   * shell is the public open-source bundle — serving it reveals nothing about anyone.
   */
  staticDir?: string
  /** Wire it to stdout in the bin; silent in tests. Never handed payload contents. */
  log?: (line: string) => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
}

interface ConnectionState {
  joined: boolean
  /** Sweeps since this peer last showed life. Phones on hotel Wi-Fi miss pings; one is not death. */
  missedHeartbeats: number
}

export class RelayServer {
  private readonly http: Server
  private readonly wss: WebSocketServer
  private readonly rooms: Rooms<WebSocket>
  private readonly state = new WeakMap<WebSocket, ConnectionState>()
  private readonly joinTimeoutMs: number
  private readonly log: (line: string) => void
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private readonly opts: RelayServerOptions

  constructor(opts: RelayServerOptions) {
    this.opts = opts
    this.joinTimeoutMs = opts.joinTimeoutMs ?? 10_000
    this.log = opts.log ?? (() => {})
    this.rooms = new Rooms<WebSocket>({ maxGuests: opts.maxGuests ?? DEFAULT_MAX_GUESTS })
    this.http = createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({
      server: this.http,
      path: '/ws',
      maxPayload: MAX_MESSAGE_BYTES,
    })
    this.wss.on('connection', (socket) => this.handleConnection(socket))
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.http.listen(this.opts.port, this.opts.host, resolve))
    this.heartbeat = setInterval(() => this.sweepDead(), HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
    const address = this.http.address()
    return typeof address === 'object' && address !== null ? address.port : this.opts.port
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const client of this.wss.clients) client.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
  }

  /**
   * /health says the process is up and what it is — and nothing else. Room tags, counts per
   * room, or member addresses would turn a blind pipe into a directory of who is reachable
   * where. The `role` field is how the app tells a relay origin from a daemon origin.
   */
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, role: 'relay' }))
      return
    }
    if (req.method === 'GET' && this.opts.staticDir !== undefined) {
      this.serveStatic(req, res, this.opts.staticDir)
      return
    }
    res.writeHead(404)
    res.end()
  }

  /** The app shell, nothing clever: files from one directory, SPA fallback for navigations. */
  private serveStatic(req: IncomingMessage, res: ServerResponse, dir: string): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    // normalize() collapses ../ so a crafted path cannot climb out of the bundle.
    const relative = normalize(path === '/' ? '/index.html' : path).replace(/^([.][.][/\\])+/, '')
    const file = join(dir, relative)
    if (!file.startsWith(dir)) {
      res.writeHead(404)
      res.end()
      return
    }
    const target = existsSync(file) ? file : join(dir, 'index.html')
    try {
      const body = readFileSync(target)
      res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        // The shell updates whenever the network allows; the service worker owns offline.
        'cache-control': 'no-cache',
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  }

  private handleConnection(socket: WebSocket): void {
    this.state.set(socket, { joined: false, missedHeartbeats: 0 })

    // A socket that never joins is a parked resource; honest clients join immediately.
    const joinTimer = setTimeout(() => {
      if (!this.state.get(socket)?.joined) socket.close(CLOSE_JOIN_TIMEOUT, 'join timeout')
    }, this.joinTimeoutMs)
    joinTimer.unref()

    socket.on('pong', () => {
      const state = this.state.get(socket)
      if (state) state.missedHeartbeats = 0
    })

    socket.on('message', (raw) => {
      const state = this.state.get(socket)
      if (!state) return
      // Any inbound traffic proves the peer is alive; pongs are just the fallback.
      state.missedHeartbeats = 0

      const message = parseClientMessage(String(raw))
      if (message === null) {
        socket.close(CLOSE_BAD_MESSAGE, 'unrecognised message')
        return
      }

      if (message.type === 'ping') {
        this.send(socket, { type: 'pong' })
        return
      }

      if (message.type === 'join') {
        if (state.joined) {
          socket.close(CLOSE_BAD_MESSAGE, 'already joined')
          return
        }
        const result = this.rooms.join(message.room, message.role, socket)
        if (!result.ok) {
          socket.close(
            result.reason === 'host-taken' ? CLOSE_HOST_TAKEN : CLOSE_ROOM_FULL,
            result.reason,
          )
          return
        }
        state.joined = true
        clearTimeout(joinTimer)
        this.send(socket, {
          type: 'joined',
          role: message.role,
          host: result.host,
          guests: result.guests,
        })
        // Tell the other side someone arrived — this is how a phone knows its laptop is on.
        this.notifyPeers(socket, 'joined')
        this.log(`join ${message.role} (${result.guests} guests)`)
        return
      }

      // frame
      if (!state.joined) {
        socket.close(CLOSE_BAD_MESSAGE, 'frame before join')
        return
      }
      if (message.payload.length > MAX_FRAME_CHARS) {
        socket.close(CLOSE_TOO_BIG, 'frame too large')
        return
      }
      for (const target of this.rooms.targetsFor(socket)) {
        // A receiver that cannot keep up must not become the relay's memory problem —
        // drop it; it will reconnect with a fresh cursor and catch up end-to-end.
        if (target.bufferedAmount > MAX_BUFFERED_BYTES) {
          target.close(CLOSE_OVERLOADED, 'too slow')
          continue
        }
        this.send(target, { type: 'frame', payload: message.payload })
      }
    })

    socket.on('close', () => {
      clearTimeout(joinTimer)
      const departure = this.rooms.leave(socket)
      if (departure) {
        for (const peer of departure.peers) {
          this.send(peer, {
            type: 'peer',
            role: departure.role,
            event: 'left',
            ...this.rooms.occupancy(peer),
          })
        }
        this.log(`leave ${departure.role}`)
      }
    })

    socket.on('error', () => socket.terminate())
  }

  private notifyPeers(socket: WebSocket, event: 'joined' | 'left'): void {
    const role = this.rooms.roleOf(socket)
    if (!role) return
    for (const peer of this.rooms.peersOf(socket)) {
      this.send(peer, { type: 'peer', role, event, ...this.rooms.occupancy(peer) })
    }
  }

  private send(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  private sweepDead(): void {
    for (const client of this.wss.clients) {
      const state = this.state.get(client)
      if (!state) continue
      state.missedHeartbeats += 1
      // The daemon once dropped peers on a single missed pong and phones reconnect-looped
      // every 32 seconds; tolerance is part of the correctness here, not a nicety.
      if (state.missedHeartbeats > MISSED_HEARTBEATS_BEFORE_DROP) {
        client.terminate()
        continue
      }
      client.ping()
    }
  }
}
