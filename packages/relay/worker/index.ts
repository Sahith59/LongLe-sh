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

/**
 * The relay as a Cloudflare Worker — the deployment that costs nothing, needs no card, and
 * has no server to keep alive. Each room is one Durable Object, addressed by the room tag,
 * so two devices meet in an object that exists only while they are talking.
 *
 * Same protocol and same guarantees as the Node relay in `src/`: opaque room tags, ciphertext
 * frames, nothing stored, nothing logged about content. Both import the rules from one file
 * so the two runtimes cannot drift apart.
 *
 * WebSocket Hibernation is used deliberately: sockets are handed back to the runtime between
 * messages, so an idle room burns no duration. That is what keeps a always-on relay inside
 * a free allowance instead of quietly exhausting it.
 */

interface Env {
  ROOM: DurableObjectNamespace
  ASSETS: Fetcher
}

/** Role and room ride the URL because a Durable Object must be chosen before the upgrade. */
const roomFromUrl = (url: URL): string | null => {
  const parsed = RoomTag.safeParse(url.searchParams.get('room') ?? '')
  return parsed.success ? parsed.data : null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ ok: true, role: 'relay' })
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 })
      }
      const room = roomFromUrl(url)
      // Refusing here keeps junk from ever creating a Durable Object.
      if (room === null) return new Response('bad room', { status: 400 })
      const id = env.ROOM.idFromName(room)
      return env.ROOM.get(id).fetch(request)
    }

    // Everything else is the app shell: public, open-source, static.
    return env.ASSETS.fetch(request)
  },
}

interface Attachment {
  role: Role
  joined: boolean
}

export class Room implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]] as [WebSocket, WebSocket]
    // Hibernatable: the runtime holds the socket, so an idle room costs nothing.
    this.ctx.acceptWebSocket(server)
    void request
    return new Response(null, { status: 101, webSocket: client })
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

      ws.serializeAttachment({ role: message.role, joined: true } satisfies Attachment)
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
      if (attachment?.joined) peers.push({ socket, attachment })
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
}
