import { z } from 'zod'

/**
 * The relay's wire protocol, defined once and shared by both runtimes: the Node server
 * (for a VPS or Docker) and the Cloudflare Worker (for the free edge deployment). Two
 * implementations of the same contract must never drift, so neither owns these rules.
 */

/** Application close codes (4000–4999 is the private range). */
export const CLOSE_BAD_MESSAGE = 4400
export const CLOSE_JOIN_TIMEOUT = 4408
export const CLOSE_HOST_TAKEN = 4409
export const CLOSE_OVERLOADED = 4412
export const CLOSE_TOO_BIG = 4413
export const CLOSE_ROOM_FULL = 4429

/** Base64 of a few session events; far above any real frame, far below a memory problem. */
export const MAX_FRAME_CHARS = 262_144
export const MAX_MESSAGE_BYTES = 300_000
export const DEFAULT_MAX_GUESTS = 8

/**
 * A room tag is derived from the pairing secret on the devices (HKDF), so honest tags are
 * long and uniform. A short tag is a probe or a bug; either way it has no business here.
 */
export const RoomTag = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/)

export const JoinMessage = z.object({
  v: z.literal(1),
  type: z.literal('join'),
  room: RoomTag,
  role: z.enum(['host', 'guest']),
})

export const FrameMessage = z.object({
  v: z.literal(1),
  type: z.literal('frame'),
  // Size is judged after parsing so the close code says "too big", not "bad message" —
  // a client that hits the cap needs to know which rule it broke.
  payload: z.string().min(1),
})

export const PingMessage = z.object({ v: z.literal(1), type: z.literal('ping') })

export const ClientMessage = z.discriminatedUnion('type', [JoinMessage, FrameMessage, PingMessage])

export type ClientMessage = z.infer<typeof ClientMessage>
export type Role = z.infer<typeof JoinMessage>['role']

/** Parse an inbound frame defensively. Returns null for anything unrecognised. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = ClientMessage.safeParse(parsed)
  return result.success ? result.data : null
}
