import WebSocket from 'ws'
import { derivePairingIdentity } from '@longleash/protocol'
import type { PairingHostOptions } from './pairing-host.js'
import { withRoom } from './relay-link.js'
import { createPairingSession } from './pairing-session.js'

export function hostVerifiedPairing(opts: PairingHostOptions): () => void {
  let socket: WebSocket | null = null
  let session: ReturnType<typeof createPairingSession> | null = null
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    clearTimeout(deadline)
    clearInterval(keepalive)
    session?.dispose()
    opts.registry.cancelPairingChallenge(opts.challenge.challengeId)
    socket?.close()
  }
  const deadline = setTimeout(dispose, Math.max(0, opts.challenge.expiresAt - Date.now()))
  deadline.unref?.()
  const keepalive = setInterval(() => {
    if (!opts.registry.hasPairingChallenge(opts.challenge.challengeId)) { dispose(); return }
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'ping' }))
  }, 10_000)
  keepalive.unref?.()
  void derivePairingIdentity(opts.challenge.secret).then((identity) => {
    if (disposed) return
    const ws = new WebSocket(withRoom(opts.relayUrl, identity.roomTag, 'host'), { maxPayload: 10_000 })
    socket = ws
    session = createPairingSession({ registry: opts.registry, challenge: opts.challenge,
      send: (payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: 'frame', payload })) },
      close: dispose,
    })
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'host' })))
    ws.on('close', dispose)
    ws.on('error', dispose)
    ws.on('message', (raw) => {
      if (disposed) return
      try {
        const message = JSON.parse(String(raw)) as { type?: unknown; payload?: unknown; role?: unknown; event?: unknown }
        if (message.type === 'frame' && typeof message.payload === 'string') void session?.receive(message.payload)
        if (message.type === 'peer' && message.role === 'guest' && message.event === 'left') dispose()
      } catch { /* drop corrupt envelopes */ }
    })
  }).catch(dispose)
  return dispose
}
