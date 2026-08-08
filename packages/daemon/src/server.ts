import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import type { WebSocket } from 'ws'
import { parseClientMessage, PROTOCOL_VERSION, type SessionEvent } from '@longleash/protocol'
import { timingSafeEqual } from 'node:crypto'
import type { EventLog, AppendInput } from './eventlog.js'
import type { PushNotifier } from './push.js'
import type { ExternalSessions } from './external.js'
import type { DeviceRegistry } from './auth.js'
import { PairingError } from './auth.js'
import { SessionError, type SessionManager } from './sessions.js'
import type { FolderIndex } from './folders.js'
import { RelayLink } from './relay-link.js'

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
/**
 * How many heartbeats a client may miss before it is presumed dead. A phone browser may
 * legitimately go quiet for a moment — throttled timers, a backgrounded tab, a lull in the
 * radio — and terminating on the first miss makes the app reconnect endlessly, which looks
 * like the product losing your sessions.
 */
const MISSED_HEARTBEATS_BEFORE_DROP = 3

export interface ServerOptions {
  eventLog: EventLog
  registry: DeviceRegistry
  host?: string
  port?: number
  heartbeatIntervalMs?: number
  /** Directory holding the built web app. Omitted for a headless daemon. */
  staticRoot?: string
  /** Advertised to clients in hello so a paired phone knows where to find the daemon remotely. */
  relayUrl?: string
  /** Where to report activity; the daemon passes console.log so the terminal shows life. */
  log?: (line: string) => void
}

/**
 * What a Connection needs from whatever carries it. A LAN WebSocket and a relay room differ
 * in every mechanical detail, but the server's obligations — deliver, respect backpressure,
 * detect death — are identical, so everything above this line is transport-blind.
 */
interface ConnectionTransport {
  send(text: string): void
  bufferedAmount(): number
  close(code: number, reason: string): void
  terminate(): void
  ping(): void
  isOpen(): boolean
  /** True when a lower layer (the relay link) owns liveness; the heartbeat skips these. */
  managedLiveness: boolean
}

interface Connection {
  transport: ConnectionTransport
  deviceId: string
  /** Sessions this connection subscribed to; nothing else is ever delivered to it. */
  sessions: Set<string>
  /** True once buffering blew the watermark; cleared by a resync gap when the socket drains. */
  desynced: boolean
  /** Consecutive heartbeats with no sign of life; reset by a pong or any inbound message. */
  missedHeartbeats: number
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
  private sessions: SessionManager | null = null
  private folders: FolderIndex | null = null
  private push: PushNotifier | null = null
  private external: ExternalSessions | null = null
  private hookSecret: string | null = null
  private readonly staticRoot: string | undefined
  private readonly relayUrl: string | undefined
  private readonly log: (line: string) => void

  constructor(opts: ServerOptions) {
    this.eventLog = opts.eventLog
    this.registry = opts.registry
    this.host = opts.host ?? '127.0.0.1'
    this.requestedPort = opts.port ?? 0
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.staticRoot = opts.staticRoot
    this.relayUrl = opts.relayUrl
    this.log = opts.log ?? (() => {})
    this.app = Fastify({ logger: false })
  }

  async listen(): Promise<{ port: number }> {
    // Cap frames so one huge message cannot exhaust memory before validation runs.
    await this.app.register(websocket, { options: { maxPayload: 1_000_000 } })

    // Unauthenticated on purpose: a phone must be able to tell "cannot reach the laptop"
    // apart from "not authorized", and this reveals nothing but liveness.
    this.app.get('/health', async () => ({ ok: true, name: 'longleash', protocol: PROTOCOL_VERSION }))

    /**
     * Claude Code's hooks report terminal sessions here. Same-machine callers only,
     * proven by a secret that lives in a 0600 file the phone can never read — so a
     * paired (or hostile) device cannot forge terminal activity or answer as a hook.
     */
    this.app.post('/hook', async (request, reply) => {
      const presented = request.headers['x-longleash-hook']
      if (
        this.external === null ||
        this.hookSecret === null ||
        typeof presented !== 'string' ||
        presented.length !== this.hookSecret.length ||
        !timingSafeEqual(Buffer.from(presented), Buffer.from(this.hookSecret))
      ) {
        return reply.code(401).send({ reason: 'unauthorized' })
      }
      const body = request.body as {
        hook_event_name?: string
        session_id?: string
        cwd?: string
        transcript_path?: string
        tool_name?: string
        tool_input?: unknown
        permission_mode?: string
        ll_pid?: number
      }
      const { session_id: sessionId, cwd, transcript_path: transcript } = body
      if (typeof sessionId !== 'string' || sessionId === '') {
        return reply.code(400).send({ reason: 'missing session_id' })
      }

      if (body.hook_event_name === 'SessionStart') {
        this.external.sessionStart(
          sessionId,
          cwd ?? '',
          transcript ?? '',
          typeof body.ll_pid === 'number' ? body.ll_pid : undefined,
        )
        this.log(`terminal session ${sessionId.slice(0, 8)} started in ${cwd ?? '?'}`)
        return {}
      }
      if (body.hook_event_name === 'PreToolUse') {
        if (typeof body.tool_name !== 'string') return reply.code(400).send({ reason: 'missing tool_name' })
        const decision = await this.external.preToolUse(
          sessionId,
          cwd ?? '',
          transcript ?? '',
          body.tool_name,
          body.tool_input,
          body.permission_mode,
        )
        // Printed so a surprising ask is diagnosable from the daemon terminal rather than
        // guessed at: it names the mode the session claims to be running in.
        this.log(
          `? ${body.tool_name} in ${sessionId.slice(0, 8)} (mode: ${body.permission_mode ?? 'not reported'}) -> ${decision.decision}`,
        )
        return decision
      }
      if (body.hook_event_name === 'SessionEnd') {
        this.external.sessionEnd(sessionId)
        return {}
      }
      return {} // unknown events are tolerated: a newer Claude Code must not break the daemon
    })

    // Pairing is POST-only: link previews and crawlers issue GETs, and must never be able
    // to burn a one-time challenge on the user's behalf.
    this.app.get('/pair', async (_request, reply) => reply.code(405).send({ reason: 'use-post' }))

    this.app.post('/pair', async (request, reply) => {
      const query = request.query as { c?: string; s?: string }
      try {
        const { token, device, relaySecret } = this.registry.completePairing({
          challengeId: query.c ?? '',
          secret: query.s ?? '',
          deviceName: String(request.headers['user-agent'] ?? 'browser').slice(0, 64),
        })
        // The relay secret rides the same LAN-only pairing response as the token: this is
        // the one moment the two devices share a channel the relay is not part of.
        return { token, deviceId: device.deviceId, relaySecret }
      } catch (err) {
        return reply.code(403).send({ reason: err instanceof PairingError ? err.reason : 'error' })
      }
    })

    if (this.staticRoot !== undefined) {
      await this.app.register(fastifyStatic, { root: this.staticRoot })
      const indexPath = join(this.staticRoot, 'index.html')
      // Deep links must land in the app rather than a 404, but only when it exists.
      this.app.setNotFoundHandler((request, reply) => {
        if (request.method !== 'GET' || !existsSync(indexPath)) return reply.code(404).send()
        return reply.type('text/html').sendFile('index.html')
      })
    }

    this.app.get('/ws', { websocket: true }, (socket, request) => {
      const token = (request.query as { token?: string } | undefined)?.token ?? ''
      const device = this.registry.verifyToken(token)
      if (!device) {
        socket.close(CLOSE_UNAUTHORIZED, 'unauthorized')
        return
      }
      this.log(`device ${device.name} connected (${device.deviceId})`)
      this.registerConnection(socket, device.deviceId)
    })

    // Revocation must sever access immediately, not at the next reconnect —
    // including the content-free tap on the shoulder.
    this.unsubscribeRevoked = this.registry.onRevoked((deviceId) => {
      for (const connection of this.byDevice.get(deviceId) ?? []) {
        connection.transport.close(CLOSE_REVOKED, 'device revoked')
      }
      this.push?.removeDevice(deviceId)
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
      // A relay-backed connection's liveness belongs to its link (reconnect/backoff);
      // pinging it here would count silence twice and kill healthy rooms.
      if (connection.transport.managedLiveness) continue
      connection.missedHeartbeats += 1
      if (connection.missedHeartbeats > MISSED_HEARTBEATS_BEFORE_DROP) {
        this.log(`dropping unresponsive connection for ${connection.deviceId}`)
        connection.transport.terminate()
        this.dropConnection(connection)
        continue
      }
      try {
        connection.transport.ping()
      } catch {
        connection.transport.terminate()
        this.dropConnection(connection)
      }
    }
  }

  /** Test seam: simulate a peer that has gone silent. */
  markAllAwaitingPong(): void {
    for (const connection of this.connections) {
      connection.missedHeartbeats = MISSED_HEARTBEATS_BEFORE_DROP
    }
  }

  desyncedCount(): number {
    let count = 0
    for (const connection of this.connections) if (connection.desynced) count += 1
    return count
  }

  maxBufferedBytes(): number {
    return this.peakBufferedBytes
  }

  /** Wire in the session manager so phones can decide approvals and start work remotely. */
  attachSessions(sessions: SessionManager): void {
    this.sessions = sessions
  }

  /** Lets a phone find a project by name instead of typing an absolute path. */
  attachFolders(folders: FolderIndex): void {
    this.folders = folders
  }

  /**
   * Move to a different local address without tearing anything down.
   *
   * A laptop that changes network — home Wi-Fi to a phone hotspot, a cable pulled — keeps
   * a listener bound to an address that no longer exists, so anyone on the new network
   * finds nothing. Only the raw listener is recycled; the Fastify instance, its routes,
   * the event log, and every live session survive untouched. The relay leg is a separate
   * outbound connection and never notices.
   *
   * Returns the port now served, which may differ if the old one is taken over there.
   */
  async rebind(host: string): Promise<number> {
    const wanted = this.boundPort
    await new Promise<void>((resolve) => this.app.server.close(() => resolve()))

    const tryListen = (port: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          this.app.server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = (): void => {
          this.app.server.removeListener('error', onError)
          resolve()
        }
        this.app.server.once('error', onError)
        this.app.server.once('listening', onListening)
        this.app.server.listen(port, host)
      })

    try {
      await tryListen(wanted)
    } catch {
      // That port may belong to something else on the new network; any port beats none.
      await tryListen(0)
    }
    const address = this.app.server.address()
    this.boundPort = typeof address === 'object' && address !== null ? address.port : wanted
    this.log(`rebound to ${host}:${this.boundPort}`)
    return this.boundPort
  }

  /** Wire in lock-screen notifications so an approval can tap a pocket, not just a screen. */
  attachPush(push: PushNotifier): void {
    this.push = push
  }

  /** Wire in terminal-started sessions, reported by Claude Code's own hooks. */
  attachExternal(external: ExternalSessions, hookSecret: string): void {
    this.external = external
    this.hookSecret = hookSecret
  }


  /** Persist an event, then fan it out to every subscriber of that session. */
  publish(sessionId: string, input: AppendInput): SessionEvent {
    const event = this.eventLog.append(sessionId, input)
    this.broadcast(event)
    return event
  }

  /** Fan out an event that some other component already persisted (e.g. SessionManager). */
  broadcastEvent(event: SessionEvent): void {
    this.broadcast(event)
  }

  connectionCount(): number {
    return this.connections.size
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.unsubscribeRevoked?.()
    this.unsubscribeRevoked = null
    for (const connection of this.connections) connection.transport.terminate()
    this.connections.clear()
    this.byDevice.clear()
    await this.app.close()
  }

  private registerConnection(socket: WebSocket, deviceId: string): void {
    const connection: Connection = {
      transport: {
        send: (text) => socket.send(text),
        bufferedAmount: () => socket.bufferedAmount,
        close: (code, reason) => socket.close(code, reason),
        terminate: () => socket.terminate(),
        ping: () => socket.ping(),
        isOpen: () => socket.readyState === socket.OPEN,
        managedLiveness: false,
      },
      deviceId,
      sessions: new Set(),
      desynced: false,
      missedHeartbeats: 0,
    }
    this.track(connection)

    socket.on('close', () => this.dropConnection(connection))
    socket.on('error', () => this.dropConnection(connection))
    socket.on('pong', () => {
      connection.missedHeartbeats = 0
    })

    socket.on('message', (raw: Buffer) => {
      // Traffic is proof of life, whatever the browser does about ping frames.
      connection.missedHeartbeats = 0
      this.handleMessage(connection, raw.toString())
    })

    this.sendHello(connection)
  }

  /**
   * A paired device's standing presence via the relay. The link carries ciphertext; by the
   * time text reaches handleMessage it has passed AES-GCM authentication, which is a stronger
   * claim to be this device than the LAN token check — only the paired phone holds the key.
   * Returns a dispose that tears the room down (used on revocation and shutdown).
   */
  attachRelay(deviceId: string, opts: { url: string; secret: string }): () => void {
    let link: RelayLink | null = null
    const connection: Connection = {
      transport: {
        send: (text) => link?.send(text),
        bufferedAmount: () => link?.bufferedAmount() ?? 0,
        close: () => link?.stop(),
        terminate: () => link?.stop(),
        ping: () => {},
        isOpen: () => link?.status === 'connected',
        managedLiveness: true,
      },
      deviceId,
      sessions: new Set(),
      desynced: false,
      missedHeartbeats: 0,
    }
    link = new RelayLink({
      url: opts.url,
      secret: opts.secret,
      onMessage: (plaintext) => this.handleMessage(connection, plaintext),
      // Whenever the room becomes whole — the daemon reconnects, or a phone walks in —
      // re-offer hello. Clients treat it idempotently, so repetition is harmless.
      onPeer: (event) => {
        if (event === 'joined') this.sendHello(connection)
      },
      onStatus: (status) => {
        if (status === 'connected') this.sendHello(connection)
      },
      log: (line) => this.log(`relay ${deviceId}: ${line}`),
    })
    this.track(connection)
    link.start()
    return () => {
      link.stop()
      this.dropConnection(connection)
    }
  }

  private track(connection: Connection): void {
    this.connections.add(connection)
    const forDevice = this.byDevice.get(connection.deviceId) ?? new Set<Connection>()
    forDevice.add(connection)
    this.byDevice.set(connection.deviceId, forDevice)
  }

  /** Tell the client what it may do, so it never has to guess a project path. */
  private sendHello(connection: Connection): void {
    this.sendTo(connection, {
      v: PROTOCOL_VERSION,
      type: 'hello',
      deviceId: connection.deviceId,
      roots: this.sessions?.listAllowedRoots() ?? [],
      // Everything the daemon knows about, so a reloaded phone rebuilds instead of showing
      // nothing — including sessions the human started in a terminal.
      sessions: [...(this.sessions?.listSessions() ?? []), ...(this.external?.listSessions() ?? [])],
      capabilities: { startSession: this.sessions !== null, stopSession: this.sessions !== null },
      // Where this daemon can be reached when the LAN cannot see it.
      relay: this.relayUrl === undefined ? null : { url: this.relayUrl },
      // The VAPID public key a phone needs to subscribe for lock-screen alerts.
      push: this.push === null ? null : { publicKey: this.push.publicKey },
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
      this.sendTo(connection, { v: PROTOCOL_VERSION, type: 'error', code: 'bad-json', message: 'Message was not valid JSON' })
      return
    }

    let message
    try {
      message = parseClientMessage(parsed)
    } catch (err) {
      this.sendTo(connection, {
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
        this.sendTo(connection, { v: PROTOCOL_VERSION, type: 'gap', sessionId: message.sessionId, ...replay })
        return
      }
      for (const event of replay.events) this.sendTo(connection, event)
      return
    }

    if (message.type === 'pushSubscribe') {
      if (this.push === null) {
        this.sendTo(connection, {
          v: PROTOCOL_VERSION,
          type: 'error',
          code: 'not-implemented',
          message: 'Push notifications are not enabled on this daemon',
        })
        return
      }
      // Subscriptions belong to the device that sent them; revoking it revokes these.
      this.push.register(connection.deviceId, message.subscription)
      this.log(`push subscription registered for ${connection.deviceId}`)
      this.sendTo(connection, { v: PROTOCOL_VERSION, type: 'ack', of: 'pushSubscribe', outcome: 'registered' })
      return
    }

    if (message.type === 'pushUnsubscribe') {
      this.push?.remove(message.endpoint)
      this.sendTo(connection, { v: PROTOCOL_VERSION, type: 'ack', of: 'pushUnsubscribe', outcome: 'removed' })
      return
    }

    if (message.type === 'pushTest') {
      const targets = this.push?.count() ?? 0
      if (this.push === null || targets === 0) {
        this.sendTo(connection, { v: PROTOCOL_VERSION, type: 'ack', of: 'pushTest', outcome: 'no-subscription' })
        return
      }
      // Delayed on purpose: the notification is suppressed while the app is on screen,
      // so the person needs a moment to lock the phone and actually see it land.
      const deviceId = connection.deviceId
      setTimeout(() => this.push?.notifyTest(deviceId), 4000)
      this.log(`push test scheduled for ${deviceId}`)
      this.sendTo(connection, { v: PROTOCOL_VERSION, type: 'ack', of: 'pushTest', outcome: 'scheduled' })
      return
    }

    if (message.type === 'findFolders') {
      this.sendTo(connection, {
        v: PROTOCOL_VERSION,
        type: 'folders',
        query: message.query,
        results: this.folders?.search(message.query) ?? [],
      })
      return
    }

    if (message.type === 'decision') {
      // Attribution matters for the audit log: decisions are recorded per device.
      // Each manager recognises exactly its own approval ids, so routing is a fallback
      // chain — and terminal-only daemons decide external approvals with no SessionManager.
      let outcome = this.sessions
        ? this.sessions.decide(message.approvalId, message.verdict, connection.deviceId, message.reply)
        : ('unknown' as const)
      if (outcome === 'unknown' && this.external !== null) {
        outcome = this.external.decide(
          message.approvalId,
          message.verdict,
          connection.deviceId,
          // A freeform reply and a question's typed response arrive on different fields;
          // the manager treats either as the words that accompany the decision.
          message.reply ?? message.response,
          message.answers,
        )
      }
      this.log(`decision ${message.verdict} on ${message.approvalId} -> ${outcome}`)
      this.sendTo(connection, {
        v: PROTOCOL_VERSION,
        type: 'ack',
        of: 'decision',
        approvalId: message.approvalId,
        outcome,
      })
      return
    }

    if (!this.sessions) {
      this.sendTo(connection, {
        v: PROTOCOL_VERSION,
        type: 'error',
        code: 'not-implemented',
        message: `"${message.type}" needs a session manager attached`,
      })
      return
    }

    if (message.type === 'sendMessage') {
      const delivered = this.sessions.sendMessage(message.sessionId, message.text, connection.deviceId)
      this.sendTo(connection, {
        v: PROTOCOL_VERSION,
        type: 'ack',
        of: 'sendMessage',
        sessionId: message.sessionId,
        outcome: delivered ? 'sent' : 'not-running',
      })
      if (!delivered) {
        this.sendTo(connection, {
          v: PROTOCOL_VERSION,
          type: 'error',
          code: 'session-not-running',
          message:
            'This conversation cannot be continued — it left no resume point. Start a new session.',
        })
      }
      return
    }

    if (message.type === 'resumeSession') {
      void this.sessions.resumeSession(message.sessionId, connection.deviceId).then((reopened) => {
        this.log(`resume ${message.sessionId} -> ${reopened ? 'reopened' : 'refused'}`)
        this.sendTo(connection, {
          v: PROTOCOL_VERSION,
          type: 'ack',
          of: 'resumeSession',
          sessionId: message.sessionId,
          outcome: reopened ? 'reopened' : 'cannot-reopen',
        })
        if (!reopened) {
          this.sendTo(connection, {
            v: PROTOCOL_VERSION,
            type: 'error',
            code: 'cannot-reopen',
            message: 'This session cannot be reopened — its project directory may no longer be allowed.',
          })
        }
      })
      return
    }

    if (message.type === 'setGate') {
      const applied =
        this.external !== null && message.sessionId.startsWith('ext_')
          ? this.external.setGate(message.sessionId, message.gate)
          : false
      this.log(`gate ${message.sessionId} -> ${message.gate}${applied ? '' : ' (unknown session)'}`)
      this.sendTo(connection, {
        v: PROTOCOL_VERSION,
        type: 'ack',
        of: 'setGate',
        sessionId: message.sessionId,
        outcome: applied ? 'set' : 'unknown-session',
      })
      return
    }

    if (message.type === 'takeOver') {
      // The baton pass: if the terminal process still runs, end it (verified pid),
      // which adopts the conversation; then wake it through the SDK with this text.
      if (this.external !== null && message.sessionId.startsWith('ext_')) {
        this.external.stop(message.sessionId, connection.deviceId)
      }
      const delivered = this.sessions.sendMessage(message.sessionId, message.text, connection.deviceId)
      this.log(`takeOver ${message.sessionId} -> ${delivered ? 'taken' : 'refused'}`)
      this.sendTo(connection, {
        v: PROTOCOL_VERSION,
        type: 'ack',
        of: 'takeOver',
        sessionId: message.sessionId,
        outcome: delivered ? 'taken-over' : 'cannot-take-over',
      })
      if (!delivered) {
        this.sendTo(connection, {
          v: PROTOCOL_VERSION,
          type: 'error',
          code: 'cannot-take-over',
          message:
            'Could not take this session over — its terminal may still be closing, or its folder is not in the allowed roots. Try again in a moment.',
        })
      }
      return
    }

    if (message.type === 'stopSession') {
      // Terminal sessions are stopped by ending their process, not an agent handle.
      if (message.sessionId.startsWith('ext_') && this.external !== null) {
        const stopped = this.external.stop(message.sessionId, connection.deviceId)
        this.log(`stop terminal ${message.sessionId} -> ${stopped ? 'stopped' : 'refused'}`)
        this.sendTo(connection, {
          v: PROTOCOL_VERSION,
          type: 'ack',
          of: 'stopSession',
          sessionId: message.sessionId,
          outcome: stopped ? 'stopped' : 'not-running',
        })
        return
      }
      void this.sessions.stopSession(message.sessionId, connection.deviceId).then((stopped) => {
        this.sendTo(connection, {
          v: PROTOCOL_VERSION,
          type: 'ack',
          of: 'stopSession',
          sessionId: message.sessionId,
          outcome: stopped ? 'stopped' : 'not-running',
        })
      })
      return
    }

    if (message.type === 'startSession') {
      void this.sessions
        .startSession({
          agent: message.agent,
          cwd: message.root,
          prompt: message.prompt,
          origin: 'phone',
          actor: connection.deviceId,
        })
        .then(({ sessionId }) => {
          this.log(`session ${sessionId} started by ${connection.deviceId}`)
          this.sendTo(connection, {
            v: PROTOCOL_VERSION,
            type: 'ack',
            of: 'startSession',
            outcome: 'started',
            sessionId,
          })
        })
        .catch((err: unknown) => {
          this.log(`start refused: ${err instanceof Error ? err.message : 'unknown'}`)
          // A refused directory is a normal answer, not a daemon failure.
          this.sendTo(connection, {
            v: PROTOCOL_VERSION,
            type: 'error',
            code: err instanceof SessionError ? err.reason : 'start-failed',
            message: err instanceof Error ? err.message.slice(0, 300) : 'Could not start session',
          })
        })
      return
    }

    this.sendTo(connection, {
      v: PROTOCOL_VERSION,
      type: 'error',
      code: 'not-implemented',
      message: `"${message.type}" is not handled yet`,
    })
  }

  private broadcast(event: SessionEvent): void {
    for (const connection of this.connections) {
      if (!connection.sessions.has(event.sessionId)) continue

      const buffered = connection.transport.bufferedAmount()
      if (buffered > this.peakBufferedBytes) this.peakBufferedBytes = buffered

      if (connection.desynced) {
        // Wait for the socket to drain, then tell the client to resync rather than
        // pretending it saw everything.
        if (buffered <= RESYNC_BUFFERED_BYTES) {
          connection.desynced = false
          this.sendTo(connection, {
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

      this.sendTo(connection, event)
    }
  }

  private sendTo(connection: Connection, payload: unknown): void {
    if (!connection.transport.isOpen()) return
    try {
      connection.transport.send(JSON.stringify(payload))
    } catch {
      // A transport that died between the check and the write is not an error worth
      // propagating: its close path will clean it up.
    }
  }
}
