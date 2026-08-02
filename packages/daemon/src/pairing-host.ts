import { z } from 'zod'
import type { PairingChallenge } from './auth.js'
import { DeviceRegistry, PairingError } from './auth.js'
import { withRoom } from './relay-link.js'
import { derivePairingIdentity, open, seal, type RelayIdentity } from '@longleash/protocol'
import WebSocket from 'ws'

const CompletePairing = z.object({
  v: z.literal(1),
  type: z.literal('completePairing'),
  challengeId: z.string().min(1),
  secret: z.string().min(1),
  deviceName: z.string().min(1).max(64),
})

export interface PairingHostOptions {
  registry: DeviceRegistry
  relayUrl: string
  challenge: PairingChallenge
  log?: (line: string) => void
}

/**
 * Lets a phone that can only reach the relay complete its pairing there. Both sides derive a
 * short-lived room and key from the QR challenge secret (domain-separated from device rooms),
 * so the exchange is sealed end-to-end like everything else; the registry's own checks —
 * hash match, TTL, one-time burn — still decide, exactly as on the LAN path. The room lives
 * only as long as the challenge does and is torn down on success.
 *
 * Deliberately NOT a RelayLink: that class reconnects forever, which is right for a device
 * room and wrong for an ephemeral pairing window.
 */
export function hostPairing(opts: PairingHostOptions): () => void {
  const log = opts.log ?? (() => {})
  let socket: WebSocket | null = null
  let disposed = false

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    socket?.close()
    socket = null
  }

  void (async () => {
    let identity: RelayIdentity
    try {
      identity = await derivePairingIdentity(opts.challenge.secret)
    } catch {
      return
    }
    if (disposed) return

    const ws = new WebSocket(withRoom(opts.relayUrl, identity.roomTag))
    socket = ws
    ws.on('open', () => {
      ws.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'host' }))
    })
    ws.on('error', () => ws.close())
    ws.on('message', (raw: WebSocket.RawData) => {
      let message: { type?: unknown; payload?: unknown }
      try {
        message = JSON.parse(String(raw)) as typeof message
      } catch {
        return
      }
      if (message.type !== 'frame' || typeof message.payload !== 'string') return
      void (async () => {
        const text = await open(identity, message.payload as string)
        if (text === null) return // hostile or corrupt: not our caller
        let request: unknown
        try {
          request = JSON.parse(text)
        } catch {
          return
        }
        const parsed = CompletePairing.safeParse(request)
        if (!parsed.success) return

        let reply: Record<string, unknown>
        let succeeded = false
        try {
          const { device, token, relaySecret } = opts.registry.completePairing({
            challengeId: parsed.data.challengeId,
            secret: parsed.data.secret,
            deviceName: parsed.data.deviceName,
          })
          reply = { v: 1, type: 'paired', token, relaySecret, deviceId: device.deviceId }
          succeeded = true
          log(`paired ${device.deviceId} through the relay`)
        } catch (err) {
          reply = {
            v: 1,
            type: 'pair-error',
            reason: err instanceof PairingError ? err.reason : 'error',
          }
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ v: 1, type: 'frame', payload: await seal(identity, JSON.stringify(reply)) }))
        }
        // Success burns the challenge; keeping the room open would only collect noise.
        // A failed attempt keeps the window open for the honest phone (mirrors the LAN rule:
        // a wrong guess must not let an attacker burn the pairing).
        if (succeeded) setTimeout(dispose, 500)
      })()
    })

    // The room exists exactly as long as the challenge could still be honoured.
    const ttl = Math.max(1000, opts.challenge.expiresAt - Date.now())
    setTimeout(dispose, ttl).unref?.()
  })()

  return dispose
}
