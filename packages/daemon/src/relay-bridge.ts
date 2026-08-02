import type { DeviceRegistry } from './auth.js'
import type { LongLeashServer } from './server.js'

/**
 * Keeps the daemon's relay presence in lockstep with the device registry: one room per paired
 * device, opened at startup and the moment a pairing completes, closed the moment a device is
 * revoked. The server owns the connections; the registry owns the truth about devices; this
 * is only the wiring between them.
 */
export class RelayBridge {
  private readonly disposers = new Map<string, () => void>()
  private offPaired: (() => void) | null = null
  private offRevoked: (() => void) | null = null

  constructor(
    private readonly opts: {
      url: string
      registry: DeviceRegistry
      server: LongLeashServer
      log?: (line: string) => void
    },
  ) {}

  /** Open rooms for every currently paired device; returns how many. */
  start(): number {
    for (const { deviceId, relaySecret } of this.opts.registry.listRelayDevices()) {
      this.add(deviceId, relaySecret)
    }
    this.offPaired = this.opts.registry.onPaired((device, relaySecret) => {
      this.add(device.deviceId, relaySecret)
      this.opts.log?.(`relay: opened room for newly paired ${device.deviceId}`)
    })
    this.offRevoked = this.opts.registry.onRevoked((deviceId) => {
      this.remove(deviceId)
      this.opts.log?.(`relay: closed room for revoked ${deviceId}`)
    })
    return this.disposers.size
  }

  stop(): void {
    this.offPaired?.()
    this.offRevoked?.()
    this.offPaired = null
    this.offRevoked = null
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
  }

  private add(deviceId: string, secret: string): void {
    if (this.disposers.has(deviceId)) return
    this.disposers.set(deviceId, this.opts.server.attachRelay(deviceId, { url: this.opts.url, secret }))
  }

  private remove(deviceId: string): void {
    this.disposers.get(deviceId)?.()
    this.disposers.delete(deviceId)
  }
}

/** Accepts "wss://relay.example" or a full /ws endpoint; returns the /ws endpoint. */
export function normalizeRelayUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws'
  return url.toString()
}
