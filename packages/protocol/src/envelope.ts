import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * The end-to-end envelope. A phone and a daemon share one 32-byte pairing secret, exchanged
 * over the LAN QR channel — never over the relay. From it both sides derive:
 *
 *   room tag  — where to meet. Opaque to the relay: HKDF is one-way, so the tag reveals
 *               nothing about the secret, and the relay never learns who a room belongs to.
 *   frame key — AES-256-GCM key that seals every frame. The relay routes envelopes it
 *               cannot open; that is the entire security model, so this file must stay
 *               boring and standard.
 *
 * Standard algorithms via noble (audited, pure JS, zero deps) rather than WebCrypto, for one
 * hard-learned reason: browsers expose `crypto.subtle` ONLY on secure contexts, and a phone
 * opening the app over plain http on a LAN address has no subtle at all — the first field
 * test died on exactly that. Same AES-256-GCM, same HKDF-SHA256, same wire format, but it
 * runs identically on every page, secure or not. (`crypto.getRandomValues` is not gated and
 * remains the nonce source.) GCM nonces are 12 random bytes per frame; at phone-conversation
 * message rates, collision odds are astronomically beyond concern.
 */

const VERSION = 1
const IV_BYTES = 12
const SALT = new TextEncoder().encode('longleash-relay-v1')

export interface RelayIdentity {
  /** Safe to hand to the relay: joining a room proves nothing and opens nothing. */
  roomTag: string
  /** Never leaves the device. */
  frameKey: Uint8Array
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  // Chunked: String.fromCharCode(...bytes) overflows the stack on large frames.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

async function deriveIdentity(
  secretBase64Url: string,
  roomInfo: string,
  keyInfo: string,
): Promise<RelayIdentity> {
  const secret = fromBase64Url(secretBase64Url)
  if (secret === null || secret.length < 16) {
    throw new Error('relay secret is not valid base64url')
  }
  const derive = (info: string) => hkdf(sha256, secret, SALT, new TextEncoder().encode(info), 32)
  return { roomTag: toBase64Url(derive(roomInfo)), frameKey: derive(keyInfo) }
}

export async function deriveRelayIdentity(secretBase64Url: string): Promise<RelayIdentity> {
  return deriveIdentity(secretBase64Url, 'room-tag', 'frame-key')
}

/**
 * The short-lived identity both sides derive from a pairing QR's challenge secret, letting a
 * phone that can only reach the relay complete its pairing there — sealed, like everything
 * else. Different HKDF info strings than device rooms: the same bytes can never address both.
 */
export async function derivePairingIdentity(secretBase64Url: string): Promise<RelayIdentity> {
  return deriveIdentity(secretBase64Url, 'pair-room-tag', 'pair-frame-key')
}

/** Seal plaintext into an opaque relay payload: base64url(version ∥ iv ∥ ciphertext+tag). */
export async function seal(identity: RelayIdentity, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = gcm(identity.frameKey, iv).encrypt(new TextEncoder().encode(plaintext))
  const envelope = new Uint8Array(1 + IV_BYTES + ciphertext.length)
  envelope[0] = VERSION
  envelope.set(iv, 1)
  envelope.set(ciphertext, 1 + IV_BYTES)
  return toBase64Url(envelope)
}

/**
 * Open a relay payload. Returns null on ANY failure — wrong key, tampering, truncation,
 * garbage, foreign version — and never throws: everything arriving over the relay is
 * untrusted input, and a hostile relay must not be able to crash either endpoint.
 */
export async function open(identity: RelayIdentity, payload: string): Promise<string | null> {
  const envelope = fromBase64Url(payload)
  if (envelope === null || envelope.length < 1 + IV_BYTES + 16) return null
  if (envelope[0] !== VERSION) return null
  try {
    const plaintext = gcm(identity.frameKey, envelope.subarray(1, 1 + IV_BYTES)).decrypt(
      envelope.subarray(1 + IV_BYTES),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}
