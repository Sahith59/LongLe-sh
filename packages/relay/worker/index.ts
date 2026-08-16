import { DurableObject } from 'cloudflare:workers'
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_HOST_TAKEN,
  CLOSE_ROOM_FULL,
  CLOSE_TOO_BIG,
  DEFAULT_MAX_GUESTS,
  MAX_FRAME_CHARS,
  RoomTag,
  parseClientMessage,
  type Role,
} from '../src/protocol.js'
import {
  RELAY_PROTOCOL,
  authenticateAccount,
  isHostedApp,
  issueRelayTicket,
  publicAuthConfig,
  ticketFromProtocols,
  verifyRelayTicket,
  websocketRoleForRequest,
} from './auth.js'
import { isPublicSiteHost, publicRoute } from './public-routing.js'

/**
 * The relay as a Cloudflare Worker — a managed deployment with no server process to keep alive.
 * Each room is one Durable Object, addressed by the room tag,
 * so two devices meet in an object that exists only while they are talking.
 *
 * Same protocol and same guarantees as the Node relay in `src/`: opaque room tags, ciphertext
 * frames, nothing stored, nothing logged about content. Both import the rules from one file
 * so the two runtimes cannot drift apart.
 *
 * WebSocket Hibernation is used deliberately: sockets are handed back to the runtime between
 * messages, so an idle room burns no active duration. That keeps an always-on relay efficient;
 * provider plan limits and pricing remain an operational concern documented in docs/DEPLOY.md.
 */

/** Role and room ride the URL because a Durable Object must be chosen before the upgrade. */
const roomFromUrl = (url: URL): string | null => {
  const parsed = RoomTag.safeParse(url.searchParams.get('room') ?? '')
  return parsed.success ? parsed.data : null
}

const JOIN_TIMEOUT_MS = 10_000

function noStoreJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(value), { ...init, headers })
}

function expectedOrigin(env: Env): string | null {
  const host = env.PUBLIC_APP_HOST?.trim().toLowerCase().replace(/\.$/, '')
  return host ? `https://${host}` : null
}

function ipRateKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'local-development'
}

async function relayTicketResponse(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isHostedApp(url, env)) return new Response('not found', { status: 404 })
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } })
  }
  const origin = expectedOrigin(env)
  if (origin === null || request.headers.get('Origin') !== origin) {
    return noStoreJson({ error: 'forbidden' }, { status: 403 })
  }
  const userId = await authenticateAccount(request, env)
  if (userId === null) return noStoreJson({ error: 'unauthorized' }, { status: 401 })
  const allowed = await env.ACCOUNT_API_RATE.limit({ key: userId })
  if (!allowed.success) {
    return noStoreJson({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } })
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return noStoreJson({ error: 'bad_request' }, { status: 400 })
  }
  if (typeof raw !== 'object' || raw === null) {
    return noStoreJson({ error: 'bad_request' }, { status: 400 })
  }
  const input = raw as { room?: unknown; role?: unknown }
  const room = RoomTag.safeParse(input.room)
  // Browsers are guests. Hosts are laptop daemons and never receive account bearer tokens.
  if (!room.success || input.role !== 'guest') {
    return noStoreJson({ error: 'bad_request' }, { status: 400 })
  }
  const secret = env.RELAY_TICKET_SECRET?.trim()
  if (!secret) return noStoreJson({ error: 'service_not_configured' }, { status: 503 })

  try {
    const protocol = await issueRelayTicket(secret, { room: room.data, role: 'guest', userId })
    return noStoreJson({ protocol, expiresIn: 45 })
  } catch {
    return noStoreJson({ error: 'service_not_configured' }, { status: 503 })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    const publicDecision = publicRoute(url, env)
    if (publicDecision.kind === 'redirect') {
      return Response.redirect(publicDecision.location, 308)
    }
    if (publicDecision.kind === 'landing') {
      url.pathname = '/welcome.html'
      return env.ASSETS.fetch(new Request(url, request))
    }

    if (url.pathname === '/health') {
      return noStoreJson({ ok: true, role: 'relay', accountRequired: isHostedApp(url, env) })
    }

    if (url.pathname === '/api/auth/config') {
      return noStoreJson(publicAuthConfig(url, env))
    }

    if (url.pathname === '/api/relay-ticket') {
      return relayTicketResponse(request, env, url)
    }

    if (url.pathname === '/ws') {
      // The brochure origin never doubles as an accountless relay endpoint.
      if (isPublicSiteHost(url, env)) return new Response('not found', { status: 404 })
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      const room = roomFromUrl(url)
      // Refusing here keeps junk from ever creating a Durable Object.
      if (room === null) return new Response('bad room', { status: 400 })
      const role = websocketRoleForRequest(url, request.headers.get('Origin'), env)
      const hosted = isHostedApp(url, env)
      if (hosted && role === null) return new Response('role required', { status: 400 })

      if (hosted && role === 'guest') {
        const secret = env.RELAY_TICKET_SECRET?.trim()
        const ticket = ticketFromProtocols(request.headers.get('Sec-WebSocket-Protocol'))
        if (!secret || !ticket) return new Response('unauthorized', { status: 401 })
        const verified = await verifyRelayTicket(ticket, secret, { room, role })
        if (verified === null) return new Response('unauthorized', { status: 401 })
        const allowed = await env.RELAY_GUEST_RATE.limit({ key: verified.sub })
        if (!allowed.success) return new Response('rate limited', { status: 429 })
      }
      if (hosted && role === 'host') {
        const allowed = await env.RELAY_HOST_RATE.limit({ key: ipRateKey(request) })
        if (!allowed.success) return new Response('rate limited', { status: 429 })
      }

      // Tickets terminate here. The room receives only a pre-validated role, never the account
      // bearer or signed ticket. The ordinary protocol name is safe to echo in the 101 response.
      const headers = new Headers(request.headers)
      headers.delete('Authorization')
      headers.delete('Sec-WebSocket-Protocol')
      if (hosted && role === 'guest') headers.set('Sec-WebSocket-Protocol', RELAY_PROTOCOL)
      if (role !== null) headers.set('X-LongLeash-Expected-Role', role)
      const roomRequest = new Request(request, { headers })
      const id = env.ROOM.idFromName(room)
      return env.ROOM.get(id).fetch(roomRequest)
    }

    // The landing page lives beside the app under a clean URL. Without this
    // rewrite the SPA fallback would swallow /welcome and serve the app.
    if (url.pathname === '/welcome' || url.pathname === '/welcome/') {
      url.pathname = '/welcome.html'
      return env.ASSETS.fetch(new Request(url, request))
    }

    // Everything else is the app shell: public, open-source, static.
    return env.ASSETS.fetch(request)
  },
}

interface Attachment {
  role?: Role
  expectedRole?: Role
  joined: boolean
  connectedAt: number
  expired?: boolean
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]] as [WebSocket, WebSocket]
    // Hibernatable: the runtime holds the socket, so an idle room costs nothing.
    this.ctx.acceptWebSocket(server)
    const expected = request.headers.get('X-LongLeash-Expected-Role')
    server.serializeAttachment({
      joined: false,
      connectedAt: Date.now(),
      ...(expected === 'host' || expected === 'guest' ? { expectedRole: expected } : {}),
    } satisfies Attachment)
    await this.scheduleJoinAlarm()
    const protocols = request.headers.get('Sec-WebSocket-Protocol')
    const headers = new Headers()
    if (protocols?.split(',').map((value) => value.trim()).includes(RELAY_PROTOCOL)) {
      headers.set('Sec-WebSocket-Protocol', RELAY_PROTOCOL)
    }
    return new Response(null, { status: 101, webSocket: client, headers })
  }

  async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    const message = parseClientMessage(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    if (message === null) {
      ws.close(CLOSE_BAD_MESSAGE, 'unrecognised message')
      return
    }

    if (message.type === 'ping') {
      this.send(ws, { type: 'pong' })
      return
    }

    const self = this.attachmentOf(ws)

    if (message.type === 'join') {
      if (self?.joined) {
        ws.close(CLOSE_BAD_MESSAGE, 'already joined')
        return
      }
      if (self?.expectedRole !== undefined && message.role !== self.expectedRole) {
        ws.close(CLOSE_BAD_MESSAGE, 'role mismatch')
        return
      }
      const peers = this.joinedPeers(ws)
      if (message.role === 'host') {
        // One daemon owns a pairing. A second is a reconnect race at best, a squatter at worst.
        if (peers.some((p) => p.attachment.role === 'host')) {
          ws.close(CLOSE_HOST_TAKEN, 'host-taken')
          return
        }
      } else if (peers.filter((p) => p.attachment.role === 'guest').length >= DEFAULT_MAX_GUESTS) {
        ws.close(CLOSE_ROOM_FULL, 'room-full')
        return
      }

      ws.serializeAttachment({
        role: message.role,
        ...(self?.expectedRole === undefined ? {} : { expectedRole: self.expectedRole }),
        joined: true,
        connectedAt: self?.connectedAt ?? Date.now(),
      } satisfies Attachment)
      await this.scheduleJoinAlarm()
      const after = this.joinedPeers(ws)
      // Occupancy counts the joiner too — a lone host must be told a host is present.
      this.send(ws, { type: 'joined', role: message.role, ...this.occupancy(ws) })
      // How a phone learns its laptop is present, and vice versa.
      for (const peer of after) {
        this.send(peer.socket, {
          type: 'peer',
          role: message.role,
          event: 'joined',
          ...this.occupancy(peer.socket),
        })
      }
      return
    }

    // frame
    if (!self?.joined) {
      ws.close(CLOSE_BAD_MESSAGE, 'frame before join')
      return
    }
    if (message.payload.length > MAX_FRAME_CHARS) {
      ws.close(CLOSE_TOO_BIG, 'frame too large')
      return
    }
    // Guests speak to the host; the host speaks to every guest; guests never see each other.
    const wanted: Role = self.role === 'guest' ? 'host' : 'guest'
    for (const peer of this.joinedPeers(ws)) {
      if (peer.attachment.role !== wanted) continue
      this.send(peer.socket, { type: 'frame', payload: message.payload })
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const self = this.attachmentOf(ws)
    if (!self?.joined) return
    for (const peer of this.joinedPeers(ws)) {
      this.send(peer.socket, {
        type: 'peer',
        role: self.role,
        event: 'left',
        ...this.occupancy(peer.socket),
      })
    }
    await this.scheduleJoinAlarm()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'socket error')
    } catch {
      // Already gone; the close handler has nothing left to tell anyone.
    }
  }

  private attachmentOf(ws: WebSocket): Attachment | null {
    const raw = ws.deserializeAttachment() as Attachment | null | undefined
    return raw ?? null
  }

  /** Everyone else in this room who has actually joined. */
  private joinedPeers(exclude: WebSocket): { socket: WebSocket; attachment: Attachment }[] {
    const peers: { socket: WebSocket; attachment: Attachment }[] = []
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue
      const attachment = this.attachmentOf(socket)
      if (attachment?.joined && attachment.role !== undefined) peers.push({ socket, attachment })
    }
    return peers
  }

  private occupancy(viewer: WebSocket): { host: boolean; guests: number } {
    const everyone = [
      ...this.joinedPeers(viewer),
      ...(this.attachmentOf(viewer)?.joined
        ? [{ socket: viewer, attachment: this.attachmentOf(viewer) as Attachment }]
        : []),
    ]
    return {
      host: everyone.some((p) => p.attachment.role === 'host'),
      guests: everyone.filter((p) => p.attachment.role === 'guest').length,
    }
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // A socket that died between the lookup and the write is not worth propagating.
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(socket)
      if (
        attachment !== null &&
        !attachment.joined &&
        !attachment.expired &&
        attachment.connectedAt + JOIN_TIMEOUT_MS <= now
      ) {
        try {
          socket.serializeAttachment({ ...attachment, expired: true } satisfies Attachment)
          socket.close(CLOSE_BAD_MESSAGE, 'join timeout')
        } catch {
          // The socket disappeared while the alarm was running.
        }
      }
    }
    await this.scheduleJoinAlarm()
  }

  private async scheduleJoinAlarm(): Promise<void> {
    let next: number | null = null
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(socket)
      if (attachment === null || attachment.joined || attachment.expired) continue
      const deadline = attachment.connectedAt + JOIN_TIMEOUT_MS
      if (next === null || deadline < next) next = deadline
    }
    if (next === null) {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    const current = await this.ctx.storage.getAlarm()
    if (current === null || next < current) await this.ctx.storage.setAlarm(Math.max(Date.now(), next))
  }
}
