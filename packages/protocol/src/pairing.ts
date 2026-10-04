import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import type { RelayIdentity } from './envelope.js'

/** V2 is opt-in until every pairing transport and both user surfaces are integrated. */
export const VERIFIED_PAIRING_VERSION = 2
export const PairingNonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const PairingDeviceName = z.string().min(1).max(64).refine(
  (name) => name.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(name),
  'Device name must be visible text without control characters',
)
export const PairingTranscript = z.object({
  v: z.literal(VERIFIED_PAIRING_VERSION),
  challengeId: z.string().min(1).max(128),
  attemptId: PairingNonce,
  phoneNonce: PairingNonce,
  daemonNonce: PairingNonce,
  deviceName: PairingDeviceName,
  expiresAt: z.number().int().positive().safe(),
}).strict()
export type PairingTranscript = z.infer<typeof PairingTranscript>

const utf8 = (value: string) => new TextEncoder().encode(value)
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Both endpoints compute this locally; never trust a peer-supplied display code.
 * Fixed-order, role-labelled JSON prevents field order/delimiter ambiguity. The full
 * high-entropy QR secret remains the key: the display code is NOT an authenticator.
 * All outputs have distinct HKDF domains, including from v1 rendezvous/device rooms.
 * Nonces and QR secrets use their exact base64url text bytes as HKDF input.
 */
export function deriveVerifiedPairing(secret: string, raw: unknown): { code: string; identity: RelayIdentity } {
  PairingNonce.parse(secret)
  const t = PairingTranscript.parse(raw)
  const transcript = JSON.stringify([
    'longleash-pairing-v2', t.v, t.challengeId, t.attemptId,
    ['phone', t.phoneNonce, t.deviceName], ['daemon', t.daemonNonce], t.expiresAt,
  ])
  const salt = sha256(utf8(transcript))
  const derive = (purpose: string) => hkdf(sha256, utf8(secret), salt, utf8(`longleash-pairing-v2/${purpose}`), 32)
  // Reduce 256 bits, rather than a small integer, to avoid material decimal bias.
  const digits = (BigInt(`0x${hex(derive('display-code'))}`) % 100_000_000n).toString().padStart(8, '0')
  return {
    code: `${digits.slice(0, 4)} ${digits.slice(4)}`,
    identity: { roomTag: hex(derive('room-tag')), frameKey: derive('frame-key') },
  }
}

export const PairingBegin = z.object({
  v: z.literal(2), type: z.literal('pair-begin'),
  challengeId: z.string().min(1).max(128), phoneNonce: PairingNonce, deviceName: PairingDeviceName,
}).strict()
export const PairingDecision = z.object({
  v: z.literal(2), type: z.enum(['pair-confirm', 'pair-reject', 'pair-ping']), attemptId: PairingNonce,
}).strict()
export const PairingReply = z.discriminatedUnion('type', [
  z.object({ v: z.literal(2), type: z.literal('pair-transcript'), transcript: PairingTranscript, remainingMs: z.number().int().min(1).max(300_000) }).strict(),
  z.object({ v: z.literal(2), type: z.literal('pair-waiting'), attemptId: PairingNonce }).strict(),
  z.object({ v: z.literal(2), type: z.literal('paired'), attemptId: PairingNonce,
    token: z.string().regex(/^llt_[A-Za-z0-9_-]{43}$/), relaySecret: PairingNonce,
    deviceId: z.string().min(1).max(128),
  }).strict(),
  z.object({ v: z.literal(2), type: z.literal('pair-error'), reason: z.enum([
    'update-required', 'invalid-input', 'expired', 'competing-attempt', 'cancelled', 'disconnected', 'unavailable',
  ]) }).strict(),
])
export const PAIRING_FRAME_LIMIT = 8192
