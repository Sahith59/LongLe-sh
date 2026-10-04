import {
  derivePairingIdentity, deriveVerifiedPairing, PairingReply, open, seal,
  PAIRING_FRAME_LIMIT, type PairingTranscript, type RelayIdentity,
} from '@longleash/protocol'

export interface PairingProgress {
  state: 'connecting' | 'compare' | 'waiting'
  code?: string
  expiresAt?: number
}
export interface PairingControl { confirm(): void; reject(): void }
export interface PairedCredentials { token: string; relaySecret: string; deviceId: string }

/** Transport injected for real browser/LAN/reference-relay integration tests. No storage here. */
export async function verifiedPairing(opts: {
  challengeId: string; secret: string; relay: boolean;
  socket: (room: string) => Promise<WebSocket>;
  onProgress: (progress: PairingProgress, control: PairingControl) => void;
  signal: AbortSignal;
}): Promise<PairedCredentials> {
  const rendezvous = await derivePairingIdentity(opts.secret)
  const phoneNonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  if (opts.signal.aborted) throw new Error('Pairing cancelled. Generate a fresh QR.')
  const socket = await opts.socket(rendezvous.roomTag)
  return new Promise((resolve, reject) => {
    let ended = false
    let started = false
    let confirmed = false
    let displayCode: string | undefined
    let displayExpiresAt: number | undefined
    let transcript: PairingTranscript | null = null
    let identity: RelayIdentity | null = null
    let chain = Promise.resolve()
    let queued = 0
    let timeout = setTimeout(() => finish(new Error('Laptop did not answer. Update LongLeash on both devices and generate a fresh QR.')), 15_000)
    const finish = (result: PairedCredentials | Error) => {
      if (ended) return
      ended = true
      clearTimeout(timeout)
      clearInterval(heartbeat)
      opts.signal.removeEventListener('abort', abort)
      socket.close()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const transmit = async (body: unknown, key = identity) => {
      const payload = await seal(key ?? rendezvous, JSON.stringify(body))
      if (!ended && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'frame', payload }))
    }
    const decide = (type: 'pair-confirm' | 'pair-reject' | 'pair-ping') => {
      if (!transcript || ended) return
      void transmit({ v: 2, type, attemptId: transcript.attemptId }).catch(() => finish(new Error('Pairing connection failed. Generate a fresh QR.')))
    }
    const controls: PairingControl = {
      confirm() {
        if (!transcript || confirmed || ended) return
        confirmed = true
        opts.onProgress({ state: 'waiting', ...(displayCode ? { code: displayCode } : {}), expiresAt: displayExpiresAt! }, controls)
        decide('pair-confirm')
      },
      reject() {
        if (!transcript || ended) return
        void transmit({ v: 2, type: 'pair-reject', attemptId: transcript.attemptId }).catch(() => {}).finally(() =>
          finish(new Error('Pairing cancelled. Generate a fresh QR. If both devices were already confirmed, check longleash devices before retrying.')),
        )
      },
    }
    const abort = () => finish(new Error('Pairing cancelled. Generate a fresh QR.'))
    opts.signal.addEventListener('abort', abort, { once: true })
    const heartbeat = setInterval(() => {
      if (identity) decide('pair-ping')
      if (opts.relay && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'ping' }))
    }, 5000)
    const begin = () => {
      if (started || ended) return
      started = true
      void transmit({ v: 2, type: 'pair-begin', challengeId: opts.challengeId, phoneNonce, deviceName: 'Phone browser' }, rendezvous)
        .catch(() => finish(new Error('Pairing could not start. Generate a fresh QR.')))
    }
    socket.onopen = () => {
      if (opts.relay) socket.send(JSON.stringify({ v: 1, type: 'join', room: rendezvous.roomTag, role: 'guest' }))
    }
    socket.onerror = () => finish(new Error('Could not reach your laptop. Generate a fresh QR when the connection returns.'))
    socket.onclose = () => finish(new Error(confirmed
      ? 'Connection ended before pairing was saved. Check longleash devices on your laptop; revoke any incomplete pairing before trying again.'
      : 'Pairing connection ended. Keep both devices open and generate a fresh QR.'))
    socket.onmessage = (event) => {
      if (ended) return
      if (String(event.data).length > PAIRING_FRAME_LIMIT + 200 || queued >= 8) { finish(new Error('Invalid pairing response. Generate a fresh QR.')); return }
      queued++
      chain = chain.then(async () => {
        if (ended) return
        let message: { type?: string; payload?: string; host?: boolean; role?: string; event?: string; v?: number }
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (message.type === 'pair-ready' && message.v === 2 && !opts.relay) begin()
        if (opts.relay && ((message.type === 'joined' && message.host) || (message.type === 'peer' && message.role === 'host' && message.event === 'joined'))) begin()
        if (message.type === 'peer' && message.role === 'host' && message.event === 'left') { socket.onclose?.(new Event('close') as CloseEvent); return }
        if (message.type !== 'frame' || typeof message.payload !== 'string') return
        const text = await open(identity ?? rendezvous, message.payload)
        if (ended || text === null) return
        const parsed = PairingReply.safeParse(JSON.parse(text))
        if (!parsed.success) throw new Error('Unsupported pairing response. Update both devices and generate a fresh QR.')
        const reply = parsed.data
        if (reply.type === 'pair-error') throw new Error(`Pairing ended (${reply.reason}). Generate a fresh QR; update both devices if their versions differ.`)
        if (reply.type === 'pair-transcript' && !transcript) {
          const t = reply.transcript
          if (t.challengeId !== opts.challengeId || t.phoneNonce !== phoneNonce || t.deviceName !== 'Phone browser') {
            throw new Error('Pairing verification did not match this phone. Generate a fresh QR.')
          }
          transcript = t
          const derived = deriveVerifiedPairing(opts.secret, t)
          identity = derived.identity
          displayCode = derived.code
          // Use authenticated remaining lifetime: laptop and phone clocks may differ.
          displayExpiresAt = Date.now() + reply.remainingMs
          clearTimeout(timeout)
          timeout = setTimeout(() => finish(new Error('Pairing expired. Generate a fresh QR.')), reply.remainingMs)
          opts.onProgress({ state: 'compare', code: derived.code, expiresAt: displayExpiresAt }, controls)
        } else if (reply.type === 'paired') {
          if (!confirmed || !transcript || reply.attemptId !== transcript.attemptId) throw new Error('Unconfirmed pairing response rejected.')
          finish({ token: reply.token, relaySecret: reply.relaySecret, deviceId: reply.deviceId })
        }
      }).catch((error: unknown) => finish(error instanceof Error ? error : new Error('Pairing failed.'))).finally(() => { queued-- })
    }
    opts.onProgress({ state: 'connecting' }, controls)
    if (opts.signal.aborted) abort()
  })
}
