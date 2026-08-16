import WebSocket from 'ws'
import { deriveRelayIdentity, open, seal, type RelayIdentity } from '@longleash/protocol'

export type RelayLinkStatus = 'stopped' | 'connecting' | 'connected'

/** Both relay implementations accept it; only the Worker one needs it. */
export function withRoom(endpoint: string, roomTag: string, role?: 'host' | 'guest'): string {
  const url = new URL(endpoint)
  url.searchParams.set('room', roomTag)
  if (role !== undefined) url.searchParams.set('role', role)
  return url.toString()
}

export interface RelayLinkOptions {
  /** ws:// or wss:// endpoint of the relay's /ws path. */
  url: string
  /** The per-device pairing secret; room and key are derived, never sent. */
  secret: string
  /** Called with each decrypted inbound frame. Anything that fails to open never arrives. */
  onMessage: (plaintext: string) => void
  onStatus?: (status: RelayLinkStatus) => void
  /** Guests arriving and leaving this room — how the daemon knows a phone is listening. */
  onPeer?: (event: 'joined' | 'left') => void
  log?: (line: string) => void
  backoffMs?: { min: number; max: number }
  /**
   * How often to send an application-level ping. Cloudflare and most proxies cull a
   * WebSocket that has carried nothing for roughly 100 seconds, so a quiet room must
   * still say something or it is torn down and rebuilt every minute, forever.
   */
  keepaliveMs?: number
}

/**
 * The daemon's outbound leg of a relay room — one per paired device. It joins as the host,
 * seals every outbound message, and opens every inbound one; a frame that fails to open is
 * dropped on the floor, because everything the relay delivers is untrusted by definition
 * (the relay itself could be hostile, and the crypto — not the transport — is what vouches
 * for a peer). Outbound while disconnected is dropped too: the event log's cursor replay
 * already heals gaps end-to-end, so buffering here would only duplicate that with a worse
 * consistency story.
 */
export class RelayLink {
  private readonly opts: RelayLinkOptions
  private readonly log: (line: string) => void
  private readonly backoff: { min: number; max: number }
  private identity: RelayIdentity | null = null
  private socket: WebSocket | null = null
  private currentStatus: RelayLinkStatus = 'stopped'
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private readonly keepaliveMs: number

  constructor(opts: RelayLinkOptions) {
    this.opts = opts
    this.log = opts.log ?? (() => {})
    this.backoff = opts.backoffMs ?? { min: 500, max: 15_000 }
    this.keepaliveMs = opts.keepaliveMs ?? 30_000
  }

  get status(): RelayLinkStatus {
    return this.currentStatus
  }

  /** Bytes queued on the underlying socket — feeds the server's backpressure watermarks. */
  bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0
  }

  start(): void {
    if (this.currentStatus !== 'stopped') return
    this.setStatus('connecting')
    void this.connect()
  }

  stop(): void {
    this.setStatus('stopped')
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopKeepalive()
    this.socket?.close()
    this.socket = null
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  /** Seal and send. Quietly drops when the room is unreachable — replay covers the gap. */
  send(plaintext: string): void {
    const socket = this.socket
    const identity = this.identity
    if (this.currentStatus !== 'connected' || !socket || !identity) return
    void seal(identity, plaintext).then((payload) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ v: 1, type: 'frame', payload }))
      }
    })
  }

  private async connect(): Promise<void> {
    if (this.currentStatus === 'stopped') return
    try {
      this.identity ??= await deriveRelayIdentity(this.opts.secret)
    } catch (err) {
      // A malformed secret can never connect; retrying would loop forever on a constant.
      this.log(`relay link dead: ${err instanceof Error ? err.message : 'bad secret'}`)
      this.setStatus('stopped')
      return
    }
    const identity = this.identity

    // The room tag rides the URL too: the Worker relay picks its Durable Object from it,
    // and the Node relay ignores the query string entirely.
    const socket = new WebSocket(withRoom(this.opts.url, identity.roomTag, 'host'))
    this.socket = socket

    socket.on('open', () => {
      socket.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'host' }))
    })

    socket.on('message', (raw: WebSocket.RawData) => {
      // The relay is outside the trust boundary: parse defensively, verify cryptographically.
      let message: { type?: unknown; payload?: unknown }
      try {
        message = JSON.parse(String(raw)) as { type?: unknown; payload?: unknown }
      } catch {
        return
      }
      if (message.type === 'joined') {
        this.attempt = 0
        this.setStatus('connected')
        this.log('relay room joined')
        this.stopKeepalive()
        this.keepaliveTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ v: 1, type: 'ping' }))
          }
        }, this.keepaliveMs)
        this.keepaliveTimer.unref?.()
        return
      }
      if (message.type === 'frame' && typeof message.payload === 'string') {
        void open(identity, message.payload).then((plaintext) => {
          if (plaintext !== null) this.opts.onMessage(plaintext)
          else this.log('dropped a relay frame that failed to open')
        })
        return
      }
      if (
        message.type === 'peer' &&
        (message as { role?: unknown }).role === 'guest' &&
        ((message as { event?: unknown }).event === 'joined' ||
          (message as { event?: unknown }).event === 'left')
      ) {
        // Presence only — the crypto still decides whether any frame is believed.
        this.opts.onPeer?.((message as { event: 'joined' | 'left' }).event)
        return
      }
      // 'pong' and anything unknown: nothing to do, nothing to trust.
    })

    socket.on('close', () => {
      this.stopKeepalive()
      this.scheduleReconnect()
    })
    socket.on('error', () => socket.close())
  }

  private scheduleReconnect(): void {
    if (this.currentStatus === 'stopped') return
    this.setStatus('connecting')
    const delay = Math.min(this.backoff.min * 2 ** this.attempt, this.backoff.max)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => void this.connect(), delay)
    this.reconnectTimer.unref?.()
  }

  private setStatus(status: RelayLinkStatus): void {
    if (this.currentStatus === status) return
    this.currentStatus = status
    this.opts.onStatus?.(status)
  }
}
