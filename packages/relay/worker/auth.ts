import { createClerkClient } from '@clerk/backend'
import { RoomTag, type Role } from '../src/protocol.js'

const TICKET_PREFIX = 'll-ticket'
const TICKET_VERSION = 1
export const RELAY_PROTOCOL = 'longleash-v1'
export const TICKET_TTL_SECONDS = 45
const CLOCK_SKEW_SECONDS = 5

export interface HostedAuthEnv {
  PUBLIC_APP_HOST?: string
  PUBLIC_LEGACY_APP_HOST?: string
  CLERK_PUBLISHABLE_KEY?: string
  CLERK_SECRET_KEY?: string
  RELAY_TICKET_SECRET?: string
}

interface RelayTicketPayload {
  v: typeof TICKET_VERSION
  room: string
  role: Role
  /** A one-way account tag, not the Clerk user id. */
  sub: string
  iat: number
  exp: number
  nonce: string
}

const encoder = new TextEncoder()

function cleanHost(value: string | undefined): string | null {
  const host = value?.trim().toLowerCase().replace(/\.$/, '')
  return host ? host : null
}

export function isHostedApp(url: URL, env: HostedAuthEnv): boolean {
  const appHost = cleanHost(env.PUBLIC_APP_HOST)
  const legacyHost = cleanHost(env.PUBLIC_LEGACY_APP_HOST)
  const requestHost = cleanHost(url.hostname)
  return requestHost !== null && (requestHost === appHost || requestHost === legacyHost)
}

export function isLegacyHostedApp(url: URL, env: HostedAuthEnv): boolean {
  const legacyHost = cleanHost(env.PUBLIC_LEGACY_APP_HOST)
  return legacyHost !== null && cleanHost(url.hostname) === legacyHost
}

export function authorizedParties(env: HostedAuthEnv): string[] {
  const appHost = cleanHost(env.PUBLIC_APP_HOST)
  return appHost === null ? [] : [`https://${appHost}`]
}

export function publicAuthConfig(url: URL, env: HostedAuthEnv): {
  required: boolean
  ready: boolean
  publishableKey?: string
} {
  if (!isHostedApp(url, env)) return { required: false, ready: true }
  const publishableKey = env.CLERK_PUBLISHABLE_KEY?.trim()
  return publishableKey
    ? { required: true, ready: true, publishableKey }
    : { required: true, ready: false }
}

export async function authenticateAccount(request: Request, env: HostedAuthEnv): Promise<string | null> {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY?.trim()
  const secretKey = env.CLERK_SECRET_KEY?.trim()
  const parties = authorizedParties(env)
  if (!publishableKey || !secretKey || parties.length === 0) return null

  try {
    const state = await createClerkClient({ publishableKey, secretKey }).authenticateRequest(request, {
      acceptsToken: 'session_token',
      authorizedParties: parties,
    })
    if (!state.isAuthenticated) return null
    return state.toAuth().userId
  } catch {
    // Authentication errors are deliberately indistinguishable to callers.
    return null
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padding = '='.repeat((4 - (value.length % 4)) % 4)
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    // Reject alternate spellings that only change unused trailing bits. They decode to the same
    // bytes and do not defeat HMAC, but accepting two strings for one ticket complicates audit,
    // replay, and tamper semantics. Issued tickets always use this canonical representation.
    return base64Url(bytes) === value ? bytes : null
  } catch {
    return null
  }
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

async function verifyHmac(secret: string, value: string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, new Uint8Array(signature).buffer, encoder.encode(value))
}

async function accountTag(secret: string, userId: string): Promise<string> {
  return base64Url((await hmac(secret, `account\0${userId}`)).slice(0, 18))
}

export async function issueRelayTicket(
  secret: string,
  input: { room: string; role: Role; userId: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (secret.length < 32) throw new Error('relay ticket secret must contain at least 32 characters')
  const room = RoomTag.parse(input.room)
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12))
  const payload: RelayTicketPayload = {
    v: TICKET_VERSION,
    room,
    role: input.role,
    sub: await accountTag(secret, input.userId),
    iat: nowSeconds,
    exp: nowSeconds + TICKET_TTL_SECONDS,
    nonce: base64Url(nonceBytes),
  }
  const encoded = base64Url(encoder.encode(JSON.stringify(payload)))
  const unsigned = `${TICKET_PREFIX}.${encoded}`
  return `${unsigned}.${base64Url(await hmac(secret, unsigned))}`
}

export async function verifyRelayTicket(
  ticket: string,
  secret: string,
  expected: { room: string; role: Role },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<RelayTicketPayload | null> {
  if (secret.length < 32) return null
  const [prefix, encoded, signatureText, extra] = ticket.split('.')
  if (prefix !== TICKET_PREFIX || !encoded || !signatureText || extra !== undefined) return null
  const signature = decodeBase64Url(signatureText)
  const payloadBytes = decodeBase64Url(encoded)
  if (signature === null || payloadBytes === null) return null
  if (!(await verifyHmac(secret, `${prefix}.${encoded}`, signature))) return null

  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const payload = raw as Partial<RelayTicketPayload>
  if (
    payload.v !== TICKET_VERSION ||
    payload.room !== expected.room ||
    payload.role !== expected.role ||
    typeof payload.sub !== 'string' ||
    !/^[A-Za-z0-9_-]{24}$/.test(payload.sub) ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    typeof payload.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(payload.nonce) ||
    payload.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    payload.exp < nowSeconds - CLOCK_SKEW_SECONDS ||
    payload.exp - payload.iat !== TICKET_TTL_SECONDS
  ) return null
  return payload as RelayTicketPayload
}

export function ticketFromProtocols(value: string | null): string | null {
  if (value === null) return null
  return value
    .split(',')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${TICKET_PREFIX}.`)) ?? null
}

export function websocketRole(url: URL): Role | null {
  const value = url.searchParams.get('role')
  return value === 'host' || value === 'guest' ? value : null
}

/**
 * Builds before the branded migration did not put a role in the laptop URL. Node WebSockets do
 * not send a browser Origin header, so that exact legacy shape can be treated as a host without
 * reopening the old browser guest path. Explicit roles remain mandatory everywhere else.
 */
export function websocketRoleForRequest(
  url: URL,
  origin: string | null,
  env: HostedAuthEnv,
): Role | null {
  const explicit = websocketRole(url)
  if (explicit !== null) return explicit
  return isLegacyHostedApp(url, env) && origin === null ? 'host' : null
}
