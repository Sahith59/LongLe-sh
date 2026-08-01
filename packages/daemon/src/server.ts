import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { WebSocket } from 'ws'
import { parseClientMessage, PROTOCOL_VERSION, type SessionEvent } from '@longleash/protocol'
import type { EventLog, AppendInput } from './eventlog.js'
import type { DeviceRegistry } from './auth.js'

/** Application close codes (4000-4999 is the private range). */
export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_REVOKED = 4403

/**
 * A phone on a dying signal stops draining TCP while events keep arriving. Rather than
 * buffering without limit (which would let one bad connection exhaust daemon memory), a
 * connection past this watermark is marked desynced: live delivery stops, the event log
 * keeps everything, and once the socket drains the client is told to resync from its cursor.
 */
const MAX_BUFFERED_BYTES = 1_000_000
const RESYNC_BUFFERED_BYTES = 100_000
const HEARTBEAT_INTERVAL_MS = 30_000

export interface ServerOptions {
  eventLog: EventLog
  registry: DeviceRegistry
  host?: string
  port?: number
  heartbeatIntervalMs?: number
}

interface Connection {
  socket: WebSocket
  deviceId: string
  /** Sessions this connection subscribed to; nothing else is ever delivered to it. */
  sessions: Set<string>
  /** True once buffering blew the watermark; cleared by a resync gap when the socket drains. */
  desynced: boolean
  /** Heartbeat liveness: a tick with this still true means the peer never ponged. */
  awaitingPong: boolean
}

export class LongLeashServer {
  private readonly app: FastifyInstance
  private readonly eventLog: EventLog
  private readonly registry: DeviceRegistry
  private readonly host: string
  private readonly requestedPort: number
  private readonly connections = new Set<Connection>()
  private readonly byDevice = new Map<string, Set<Connection>>()
  private readonly heartbeatIntervalMs: number
  private heartbeatTimer: NodeJS.Timeout | null = null
  private unsubscribeRevoked: (() => void) | null = null
  private boundPort = 0
  private peakBufferedBytes = 0

  constructor(opts: ServerOptions) {
    this.eventLog = opts.eventLog
    this.registry = opts.registry
    this.host = opts.host ?? '127.0.0.1'
    this.requestedPort = opts.port ?? 0
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.app = Fastify({ logger: false })
  }

  async listen(): Promise<{ port: number }> {
    await this.app.register(websocket)

    this.app.get('/ws', { websocket: true }, (socket, request) => {
      const token = (request.query as { token?: string } | undefined)?.token ?? ''
      const device = this.registry.verifyToken(token)
      if (!device) {
        socket.close(CLOSE_UNAUTHORIZED, 'unauthorized')
        return
      }
      this.registerConnection(socket, device.deviceId)
    })

    // Revocation must sever access immediately, not at the next reconnect.
    this.unsubscribeRevoked = this.registry.onRevoked((deviceId) => {
      for (const connection of this.byDevice.get(deviceId) ?? []) {
        connection.socket.close(CLOSE_REVOKED, 'device revoked')
      }
    })

    await this.app.listen({ host: this.host, port: this.requestedPort })
    const address = this.app.server.address()
    this.boundPort = typeof address === 'object' && address !== null ? address.port : this.requestedPort

    this.heartbeatTimer = setInterval(() => this.runHeartbeatTick(), this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
    return { port: this.boundPort }
  }

  /**
   * A phone that loses signal leaves a half-open socket that never emits close. Ping every
   * connection; any that failed to pong since the previous tick is dead and gets terminated.
   */
  runHeartbeatTick(): void {
    for (const connection of [...this.connections]) {
      if (connection.awaitingPong) {
        connection.socket.terminate()
        this.dropConnection(connection)
        continue
      }
      connection.awaitingPong = true
      try {
        connection.socket.ping()
      } catch {
        connection.socket.terminate()
        this.dropConnection(connection)
      }
    }
  }

  /** Test seam: force every connection into the "never ponged" state. */
  markAllAwaitingPong(): void {
    for (const connection of this.connections) connection.awaitingPong = true
  }

  desyncedCount(): number {
    let count = 0
    for (const connection of this.connections) if (connection.desynced) count += 1
    return count
  }

  maxBufferedBytes(): number {
    return this.peakBufferedBytes
  }

  /** Persist an event, then fan it out to every subscriber of that session. */
  publish(sessionId: string, input: AppendInput): SessionEvent {
    const event = this.eventLog.append(sessionId, input)
    this.broadcast(event)
    return event
  }

  connectionCount(): number {
    return this.connections.size
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.unsubscribeRevoked?.()
    this.unsubscribeRevoked = null
    for (const connection of this.connections) connection.socket.terminate()
    this.connections.clear()
    this.byDevice.clear()
    await this.app.close()
  }

  private registerConnection(socket: WebSocket, deviceId: string): void {
    const connection: Connection = {
      socket,
      deviceId,
      sessions: new Set(),
      desynced: false,
      awaitingPong: false,
    }
    this.connections.add(connection)
    const forDevice = this.byDevice.get(deviceId) ?? new Set<Connection>()
    forDevice.add(connection)
    this.byDevice.set(deviceId, forDevice)

    socket.on('close', () => this.dropConnection(connection))
    socket.on('error', () => this.dropConnection(connection))
    socket.on('pong', () => {
      connection.awaitingPong = false
    })

    socket.on('message', (raw: Buffer) => {
      this.handleMessage(connection, raw.toString())
    })
  }

  private dropConnection(connection: Connection): void {
    this.connections.delete(connection)
    const set = this.byDevice.get(connection.deviceId)
    set?.delete(connection)
    if (set && set.size === 0) this.byDevice.delete(connection.deviceId)
  }

  private handleMessage(connection: Connection, raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.send(connection.socket, { v: PROTOCOL_VERSION, type: 'error', code: 'bad-json', message: 'Message was not valid JSON' })
      return
    }

    let message
    try {
      message = parseClientMessage(parsed)
    } catch (err) {
      this.send(connection.socket, {
        v: PROTOCOL_VERSION,
        type: 'error',
        code: 'bad-message',
        message: err instanceof Error ? err.message.slice(0, 300) : 'Invalid message',
      })
      return
    }

    if (message.type === 'subscribe') {
      connection.sessions.add(message.sessionId)
      // A resubscribe is how a desynced client recovers, so clear the flag here.
      connection.desynced = false
      const replay = this.eventLog.replay(message.sessionId, message.fromCursor)
      if (replay.gap) {
        this.send(connection.socket, { v: PROTOCOL_VERSION, type: 'gap', sessionId: message.sessionId, ...replay })
        return
      }
      for (const event of replay.events) this.send(connection.socket, event)
      return
    }

    // Slices A5+ own the remaining verbs; acknowledge explicitly rather than dropping silently.
    this.send(connection.socket, {
      v: PROTOCOL_VERSION,
      type: 'error',
      code: 'not-implemented',
      message: `"${message.type}" is not handled yet`,
    })
  }

  private broadcast(event: SessionEvent): void {
    for (const connection of this.connections) {
      if (!connection.sessions.has(event.sessionId)) continue

      const buffered = connection.socket.bufferedAmount
      if (buffered > this.peakBufferedBytes) this.peakBufferedBytes = buffered

      if (connection.desynced) {
        // Wait for the socket to drain, then tell the client to resync rather than
        // pretending it saw everything.
        if (buffered <= RESYNC_BUFFERED_BYTES) {
          connection.desynced = false
          this.send(connection.socket, {
            v: PROTOCOL_VERSION,
            type: 'gap',
            sessionId: event.sessionId,
            reason: 'overflow',
            latestSeq: this.eventLog.latestSeq(event.sessionId),
          })
        }
        continue
      }

      if (buffered > MAX_BUFFERED_BYTES) {
        connection.desynced = true
        continue
      }

      this.send(connection.socket, event)
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== socket.OPEN) return
    try {
      socket.send(JSON.stringify(payload))
    } catch {
      // A socket that died between the readyState check and the write is not an error worth
      // propagating: the close handler will clean it up.
    }
  }
}
