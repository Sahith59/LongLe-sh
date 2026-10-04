import { randomBytes } from 'node:crypto'
import {
  derivePairingIdentity, deriveVerifiedPairing, open, seal, PairingBegin, PairingDecision,
  PAIRING_FRAME_LIMIT, type PairingTranscript, type RelayIdentity,
} from '@longleash/protocol'
import { DeviceRegistry, PairingError, type PairingChallenge } from './auth.js'

/** One non-reconnecting, encrypted conversation. Shared by LAN and both relay runtimes. */
export function createPairingSession(opts: {
  registry: DeviceRegistry; challenge: PairingChallenge;
  send: (payload: string) => void; close: () => void;
}) {
  const owner = randomBytes(32).toString('base64url')
  const rendezvous = derivePairingIdentity(opts.challenge.secret)
  let transcript: PairingTranscript | null = null
  let identity: RelayIdentity | null = null
  let confirmed = false
  let disposed = false
  let committed = false
  let lastSeen = Date.now()
  let windowAt = Date.now()
  let frames = 0
  let queued = 0
  let chain = Promise.resolve()
  let closing: NodeJS.Timeout | undefined
  const dispose = () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    clearTimeout(closing)
    if (transcript && !committed) opts.registry.cancelPairingChallenge(opts.challenge.challengeId)
    opts.close()
  }
  const send = async (body: unknown, key = identity) => {
    const payload = await seal(key ?? await rendezvous, JSON.stringify(body))
    if (!disposed) opts.send(payload)
  }
  const fail = async (reason: 'expired' | 'competing-attempt' | 'cancelled' | 'disconnected' | 'invalid-input' | 'unavailable') => {
    await send({ v: 2, type: 'pair-error', reason })
    dispose()
  }
  const tick = async () => {
    if (disposed || committed) return
    if (Date.now() >= opts.challenge.expiresAt) return fail('expired')
    if (!opts.registry.hasPairingChallenge(opts.challenge.challengeId)) return fail('cancelled')
    if (transcript && Date.now() - lastSeen > 30_000) return fail('disconnected')
    if (!confirmed || !transcript) return
    try {
      const { device, token, relaySecret } = opts.registry.finishVerifiedPairing(opts.challenge.challengeId, transcript.attemptId)
      committed = true
      await send({ v: 2, type: 'paired', attemptId: transcript.attemptId, deviceId: device.deviceId, token, relaySecret })
      clearInterval(timer)
      closing = setTimeout(dispose, 500)
      closing.unref?.()
    } catch (err) {
      if (err instanceof PairingError && err.reason === 'local-confirmation-required') return
      await fail('unavailable')
    }
  }
  const processFrame = async (payload: string) => {
    if (disposed || committed) return
    const text = await open(identity ?? await rendezvous, payload)
    if (disposed || committed) return
    if (text === null) {
      if (identity) {
        const competing = await open(await rendezvous, payload)
        if (competing !== null) {
          try {
            const begin = PairingBegin.safeParse(JSON.parse(competing))
            if (begin.success && begin.data.challengeId === opts.challenge.challengeId) {
              opts.registry.cancelPairingChallenge(opts.challenge.challengeId)
              await fail('competing-attempt')
            }
          } catch { /* ignore corrupt authenticated input */ }
        }
      }
      return
    } // unauthenticated corruption never grants or cancels consent
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return }
    if (!transcript) {
      // Old clients get a precise refusal, encrypted in the channel they understand.
      if ((raw as { v?: number })?.v === 1) {
        await send({ v: 1, type: 'pair-error', reason: 'update-required' })
        dispose()
        return
      }
      const parsed = PairingBegin.safeParse(raw)
      if (!parsed.success || parsed.data.challengeId !== opts.challenge.challengeId) return
      try {
        transcript = opts.registry.beginVerifiedPairing({
          v: 2, challengeId: parsed.data.challengeId, secret: opts.challenge.secret,
          deviceName: parsed.data.deviceName, phoneNonce: parsed.data.phoneNonce,
        }, owner)
        await send({ v: 2, type: 'pair-transcript', transcript, remainingMs: Math.max(1, Math.min(300_000, opts.challenge.expiresAt - Date.now())) }, await rendezvous)
        identity = deriveVerifiedPairing(opts.challenge.secret, transcript).identity
        lastSeen = Date.now()
      } catch (err) {
        await fail(err instanceof PairingError && err.reason === 'competing-attempt' ? 'competing-attempt' : 'unavailable')
      }
      return
    }
    const parsed = PairingDecision.safeParse(raw)
    if (!parsed.success || parsed.data.attemptId !== transcript.attemptId) return
    lastSeen = Date.now()
    if (parsed.data.type === 'pair-reject') return fail('cancelled')
    if (parsed.data.type === 'pair-confirm') {
      confirmed = true
      await send({ v: 2, type: 'pair-waiting', attemptId: transcript.attemptId })
      await tick()
    }
  }
  const receive = (payload: string): Promise<void> => {
    if (disposed || committed) return Promise.resolve()
    if (Date.now() - windowAt >= 60_000) { windowAt = Date.now(); frames = 0 }
    if (payload.length > PAIRING_FRAME_LIMIT || ++frames > 60 || queued >= 8) {
      dispose()
      return Promise.resolve()
    }
    queued++
    chain = chain.then(() => processFrame(payload)).catch(() => dispose()).finally(() => { queued-- })
    return chain
  }
  const timer = setInterval(() => { chain = chain.then(tick).catch(() => dispose()) }, 250)
  timer.unref?.()
  return { receive, dispose, tick }
}
