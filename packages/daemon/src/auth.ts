import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { ensureColumns } from './migrate.js'
import { deriveVerifiedPairing, PairingNonce, PairingDeviceName, type PairingTranscript } from '@longleash/protocol'

const PAIRING_QR_VERSION = 1
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000

export type PairingFailure = 'invalid-input' | 'unknown-challenge' | 'expired' | 'bad-secret'
  | 'verification-required' | 'update-required' | 'competing-attempt' | 'pending-limit' | 'unknown-attempt' | 'local-confirmation-required'

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

const beginVerifiedInput = z.object({
  v: z.literal(2),
  challengeId: z.string().min(1).max(128),
  secret: PairingNonce,
  deviceName: PairingDeviceName,
  phoneNonce: PairingNonce,
}).strict()

interface ChallengeRecord {
  secretHash: string
  expiresAt: number
  version: 1 | 2
  pending?: { transcript: PairingTranscript; code: string; localConfirmed: boolean; owner?: string }
}

interface DeviceRow {
  device_id: string
  name: string
  token_hash: string
  public_key: string | null
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
  relay_secret: string | null
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')
const hashesMatch = (a: string, b: string) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

export class DeviceRegistry {
  readonly rawDb: Database.Database
  private readonly now: () => number
  private readonly challengeTtlMs: number
  // Ephemeral by design: a daemon restart voids pending pairing QR codes.
  private readonly challenges = new Map<string, ChallengeRecord>()
  private readonly pairingResults = new Map<string, { deviceId: string; expiresAt: number }>()
  private readonly revokedListeners = new Set<(deviceId: string) => void>()
  private readonly pairedListeners = new Set<(device: Device, relaySecret: string) => void>()

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
        revoked_at INTEGER,
        relay_secret TEXT
      )
    `)
    // Installs that paired devices before the relay existed lack the column.
    ensureColumns(this.rawDb, 'devices', [{ name: 'relay_secret', definition: 'TEXT' }])
    this.now = opts.now ?? Date.now
    this.challengeTtlMs = opts.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS
  }

  createPairingChallenge(opts: { version?: 1 | 2 } = {}): PairingChallenge {
    this.sweepExpiredChallenges()
    const version = opts.version ?? PAIRING_QR_VERSION
    if (version !== 1 && version !== 2) throw new PairingError('invalid-input', 'Unsupported pairing version')
    if (version === 2 && [...this.challenges.values()].filter((c) => c.version === 2).length >= 8) {
      throw new PairingError('pending-limit', 'Too many pending verifications — finish or wait for expiry')
    }
    const challengeId = id('chl')
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.challengeTtlMs
    this.challenges.set(challengeId, { secretHash: sha256Hex(secret), expiresAt, version })
    return {
      challengeId,
      secret,
      expiresAt,
      qrPayload: JSON.stringify({ v: version, challengeId, secret }),
    }
  }

  completePairing(raw: CompletePairingInput): { device: Device; token: string; relaySecret: string } {
    const parsed = completePairingInput.safeParse(raw)
    if (!parsed.success) {
      throw new PairingError('invalid-input', parsed.error.message)
    }
    const input = parsed.data

    const challenge = this.authorizeChallenge(input.challengeId, input.secret)
    if (challenge.version !== 1) {
      throw new PairingError('verification-required', 'This QR requires verification on the phone and laptop')
    }
    this.challenges.delete(input.challengeId)
    return this.commitDevice(input.deviceName, input.publicKey)
  }

  /** Foundation only: transport adapters must authenticate/decrypt BEFORE calling this. */
  beginVerifiedPairing(raw: unknown, owner?: string): PairingTranscript {
    const parsed = beginVerifiedInput.safeParse(raw)
    if (!parsed.success) throw new PairingError('invalid-input', 'Invalid v2 pairing request')
    const input = parsed.data
    const challenge = this.authorizeChallenge(input.challengeId, input.secret)
    if (challenge.version !== 2) {
      throw new PairingError('update-required', 'Update LongLeash and generate a new verified QR code')
    }
    if (challenge.pending) {
      const previous = challenge.pending.transcript
      if (challenge.pending.owner === owner && previous.phoneNonce === input.phoneNonce && previous.deviceName === input.deviceName) {
        return { ...previous }
      }
      this.challenges.delete(input.challengeId)
      throw new PairingError('competing-attempt', 'A competing pairing attempt was detected — generate a new QR code')
    }
    const transcript: PairingTranscript = {
      v: 2, challengeId: input.challengeId,
      attemptId: randomBytes(32).toString('base64url'),
      phoneNonce: input.phoneNonce, daemonNonce: randomBytes(32).toString('base64url'),
      deviceName: input.deviceName, expiresAt: challenge.expiresAt,
    }
    const { code } = deriveVerifiedPairing(input.secret, transcript)
    challenge.pending = { transcript, code, localConfirmed: false, ...(owner ? { owner } : {}) }
    return { ...transcript }
  }

  getPairingResult(challengeId: string): { deviceId: string } | null {
    this.sweepExpiredChallenges()
    const result = this.pairingResults.get(challengeId)
    return result ? { deviceId: result.deviceId } : null
  }

  hasPairingChallenge(challengeId: string): boolean {
    this.sweepExpiredChallenges()
    return this.challenges.has(challengeId)
  }

  /** Local operator cancellation also works before a phone has connected. */
  cancelPairingChallenge(challengeId: string): void {
    this.challenges.delete(challengeId)
  }

  /** LOCAL ONLY. Never expose the laptop display code through a phone-facing route. */
  getPairingVerification(challengeId: string): { attemptId: string; code: string; deviceName: string; expiresAt: number } | null {
    this.sweepExpiredChallenges()
    const pending = this.challenges.get(challengeId)?.pending
    if (!pending) return null
    const { attemptId, deviceName, expiresAt } = pending.transcript
    return { attemptId, code: pending.code, deviceName, expiresAt }
  }

  /** LOCAL ONLY: a secret-authenticated loopback/CLI action, never a remote message. */
  confirmPairingLocally(challengeId: string, attemptId: string): void {
    this.requireAttempt(challengeId, attemptId).localConfirmed = true
  }

  /** Call only for an explicit phone 'Codes match' on this attempt's encrypted channel. */
  finishVerifiedPairing(challengeId: string, attemptId: string): { device: Device; token: string; relaySecret: string } {
    const pending = this.requireAttempt(challengeId, attemptId)
    if (!pending.localConfirmed) {
      throw new PairingError('local-confirmation-required', 'Compare and confirm the code on your laptop first')
    }
    // Burn before persistence/listeners: reentrancy and retries cannot mint a second device.
    this.challenges.delete(challengeId)
    const result = this.commitDevice(pending.transcript.deviceName)
    this.pairingResults.set(challengeId, { deviceId: result.device.deviceId, expiresAt: this.now() + 60_000 })
    return result
  }

  /** Rejection and transport disconnect share the same terminal transition. */
  cancelVerifiedPairing(challengeId: string, attemptId: string): void {
    this.requireAttempt(challengeId, attemptId)
    this.challenges.delete(challengeId)
  }

  private requireAttempt(challengeId: string, attemptId: string): NonNullable<ChallengeRecord['pending']> {
    const challenge = this.requireChallenge(challengeId)
    if (!challenge.pending || challenge.pending.transcript.attemptId !== attemptId) {
      throw new PairingError('unknown-attempt', 'Unknown pairing attempt')
    }
    return challenge.pending
  }

  private requireChallenge(challengeId: string): ChallengeRecord {
    const challenge = this.challenges.get(challengeId)
    if (!challenge) throw new PairingError('unknown-challenge', 'Unknown or already-used pairing challenge')
    if (this.now() >= challenge.expiresAt) {
      this.challenges.delete(challengeId)
      throw new PairingError('expired', 'Pairing challenge expired — generate a new QR code')
    }
    return challenge
  }

  private authorizeChallenge(challengeId: string, secret: string): ChallengeRecord {
    const challenge = this.requireChallenge(challengeId)
    if (!hashesMatch(sha256Hex(secret), challenge.secretHash)) {
      throw new PairingError('bad-secret', 'Wrong pairing secret')
    }
    return challenge
  }

  private commitDevice(deviceName: string, publicKey?: string): { device: Device; token: string; relaySecret: string } {
    const token = `llt_${randomBytes(32).toString('base64url')}`
    // The E2E root for this device: both sides derive the relay room and frame key from it.
    // It is exchanged here — over the LAN pairing channel — and never travels via the relay.
    // Stored as-is: unlike the token (which we only ever need to VERIFY, so a hash suffices),
    // the daemon must re-derive keys from this secret on every restart.
    const relaySecret = randomBytes(32).toString('base64url')
    const device: Device = {
      deviceId: id('dev'),
      name: deviceName,
      publicKey: publicKey ?? null,
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
    }
    this.rawDb
      .prepare(
        'INSERT INTO devices (device_id, name, token_hash, public_key, created_at, last_seen_at, revoked_at, relay_secret) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)',
      )
      .run(device.deviceId, device.name, sha256Hex(token), device.publicKey, device.createdAt, relaySecret)
    for (const listener of this.pairedListeners) {
      try {
        listener(device, relaySecret)
      } catch {
        // A buggy listener must not fail the pairing that already committed.
      }
    }
    return { device, token, relaySecret }
  }

  /** Fired after a pairing commits — how the relay bridge learns to hold a new room. */
  onPaired(listener: (device: Device, relaySecret: string) => void): () => void {
    this.pairedListeners.add(listener)
    return () => this.pairedListeners.delete(listener)
  }

  /**
   * One relay room per paired device. Revoked devices are simply absent: the daemon stops
   * joining their room, and nothing the phone still holds can reach the laptop again.
   */
  listRelayDevices(): { deviceId: string; relaySecret: string }[] {
    const rows = this.rawDb
      .prepare(
        'SELECT device_id, relay_secret FROM devices WHERE revoked_at IS NULL AND relay_secret IS NOT NULL ORDER BY created_at ASC',
      )
      .all() as { device_id: string; relay_secret: string }[]
    return rows.map((row) => ({ deviceId: row.device_id, relaySecret: row.relay_secret }))
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
    this.challenges.clear()
    this.pairingResults.clear()
    this.rawDb.close()
  }

  private sweepExpiredChallenges(): void {
    const now = this.now()
    for (const [id, result] of this.pairingResults) if (now >= result.expiresAt) this.pairingResults.delete(id)
    for (const [challengeId, challenge] of this.challenges) {
      if (now >= challenge.expiresAt) this.challenges.delete(challengeId)
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
