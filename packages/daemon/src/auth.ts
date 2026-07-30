import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import Database from 'better-sqlite3'
import { z } from 'zod'

const PAIRING_QR_VERSION = 1
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000

export type PairingFailure = 'invalid-input' | 'unknown-challenge' | 'expired' | 'bad-secret'

export class PairingError extends Error {
  constructor(
    readonly reason: PairingFailure,
    message: string,
  ) {
    super(message)
    this.name = 'PairingError'
  }
}

export interface PairingChallenge {
  challengeId: string
  secret: string
  expiresAt: number
  qrPayload: string
}

export interface Device {
  deviceId: string
  name: string
  publicKey: string | null
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

const completePairingInput = z.object({
  challengeId: z.string().min(1),
  secret: z.string().min(1),
  deviceName: z.string().min(1).max(64),
  publicKey: z.string().min(1).optional(),
})
export type CompletePairingInput = z.infer<typeof completePairingInput>

interface DeviceRow {
  device_id: string
  name: string
  token_hash: string
  public_key: string | null
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')
const hashesMatch = (a: string, b: string) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

export class DeviceRegistry {
  readonly rawDb: Database.Database
  private readonly now: () => number
  private readonly challengeTtlMs: number
  // Ephemeral by design: a daemon restart voids pending pairing QR codes.
  private readonly challenges = new Map<string, { secretHash: string; expiresAt: number }>()
  private readonly revokedListeners = new Set<(deviceId: string) => void>()

  constructor(path: string, opts: { now?: () => number; challengeTtlMs?: number } = {}) {
    this.rawDb = new Database(path)
    this.rawDb.pragma('journal_mode = WAL')
    this.rawDb.pragma('synchronous = NORMAL')
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        public_key TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      )
    `)
    this.now = opts.now ?? Date.now
    this.challengeTtlMs = opts.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS
  }

  createPairingChallenge(): PairingChallenge {
    this.sweepExpiredChallenges()
    const challengeId = id('chl')
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.challengeTtlMs
    this.challenges.set(challengeId, { secretHash: sha256Hex(secret), expiresAt })
    return {
      challengeId,
      secret,
      expiresAt,
      qrPayload: JSON.stringify({ v: PAIRING_QR_VERSION, challengeId, secret }),
    }
  }

  completePairing(raw: CompletePairingInput): { device: Device; token: string } {
    const parsed = completePairingInput.safeParse(raw)
    if (!parsed.success) {
      throw new PairingError('invalid-input', parsed.error.message)
    }
    const input = parsed.data

    const challenge = this.challenges.get(input.challengeId)
    if (!challenge) {
      throw new PairingError('unknown-challenge', 'Unknown or already-used pairing challenge')
    }
    if (this.now() > challenge.expiresAt) {
      this.challenges.delete(input.challengeId)
      throw new PairingError('expired', 'Pairing challenge expired — generate a new QR code')
    }
    // A wrong guess does not burn the challenge: the 256-bit secret is unguessable,
    // and burning it would let an attacker deny the legitimate pairing.
    if (!hashesMatch(sha256Hex(input.secret), challenge.secretHash)) {
      throw new PairingError('bad-secret', 'Wrong pairing secret')
    }
    this.challenges.delete(input.challengeId)

    const token = `llt_${randomBytes(32).toString('base64url')}`
    const device: Device = {
      deviceId: id('dev'),
      name: input.deviceName,
      publicKey: input.publicKey ?? null,
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
    }
    this.rawDb
      .prepare(
        'INSERT INTO devices (device_id, name, token_hash, public_key, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
      )
      .run(device.deviceId, device.name, sha256Hex(token), device.publicKey, device.createdAt)
    return { device, token }
  }

  verifyToken(token: string): Device | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const tokenHash = sha256Hex(token)
    const rows = this.rawDb.prepare('SELECT * FROM devices').all() as DeviceRow[]
    for (const row of rows) {
      if (!hashesMatch(tokenHash, row.token_hash)) continue
      if (row.revoked_at !== null) return null
      const seenAt = this.now()
      this.rawDb.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').run(seenAt, row.device_id)
      return this.toDevice({ ...row, last_seen_at: seenAt })
    }
    return null
  }

  revokeDevice(deviceId: string): boolean {
    const result = this.rawDb
      .prepare('UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
      .run(this.now(), deviceId)
    if (result.changes !== 1) return false
    for (const listener of this.revokedListeners) {
      try {
        listener(deviceId)
      } catch {
        // A buggy listener must not block revocation or the remaining listeners.
      }
    }
    return true
  }

  pendingChallengeCount(): number {
    this.sweepExpiredChallenges()
    return this.challenges.size
  }

  onRevoked(listener: (deviceId: string) => void): () => void {
    this.revokedListeners.add(listener)
    return () => this.revokedListeners.delete(listener)
  }

  listDevices(): Device[] {
    const rows = this.rawDb.prepare('SELECT * FROM devices ORDER BY created_at ASC').all() as DeviceRow[]
    return rows.map((row) => this.toDevice(row))
  }

  close(): void {
    this.rawDb.close()
  }

  private sweepExpiredChallenges(): void {
    const now = this.now()
    for (const [challengeId, challenge] of this.challenges) {
      if (now > challenge.expiresAt) this.challenges.delete(challengeId)
    }
  }

  private toDevice(row: DeviceRow): Device {
    return {
      deviceId: row.device_id,
      name: row.name,
      publicKey: row.public_key,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    }
  }
}
