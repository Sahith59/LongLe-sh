import { describe, expect, it } from 'vitest'
import {
  issueRelayTicket,
  publicAuthConfig,
  ticketFromProtocols,
  verifyRelayTicket,
  websocketRole,
  websocketRoleForRequest,
} from '../worker/auth.js'

const SECRET = 'release-secret-'.repeat(4)
const ROOM = 'r'.repeat(43)

describe('hosted relay authorization', () => {
  it('fails closed on the canonical app until Clerk is configured', () => {
    expect(publicAuthConfig(new URL('https://app.longleash.dev/'), {
      PUBLIC_APP_HOST: 'app.longleash.dev',
    })).toEqual({ required: true, ready: false })
    expect(publicAuthConfig(new URL('http://192.168.1.7:4321/'), {
      PUBLIC_APP_HOST: 'app.longleash.dev',
    })).toEqual({ required: false, ready: true })
    expect(publicAuthConfig(new URL('https://longleash-relay.example.workers.dev/'), {
      PUBLIC_APP_HOST: 'app.longleash.dev',
      PUBLIC_LEGACY_APP_HOST: 'longleash-relay.example.workers.dev',
    })).toEqual({ required: true, ready: false })
  })

  it('issues a short-lived ticket bound to one room and one role', async () => {
    const ticket = await issueRelayTicket(SECRET, {
      room: ROOM,
      role: 'guest',
      userId: 'user_private_clerk_id',
    }, 1_000)
    const valid = await verifyRelayTicket(ticket, SECRET, { room: ROOM, role: 'guest' }, 1_020)
    expect(valid).toMatchObject({ room: ROOM, role: 'guest', iat: 1_000, exp: 1_045 })
    expect(JSON.stringify(valid)).not.toContain('user_private_clerk_id')
    expect(await verifyRelayTicket(ticket, SECRET, { room: 'x'.repeat(43), role: 'guest' }, 1_020)).toBeNull()
    expect(await verifyRelayTicket(ticket, SECRET, { room: ROOM, role: 'host' }, 1_020)).toBeNull()
    expect(await verifyRelayTicket(ticket, SECRET, { room: ROOM, role: 'guest' }, 1_060)).toBeNull()
  })

  it('rejects tampering and extracts only the dedicated websocket protocol', async () => {
    const ticket = await issueRelayTicket(SECRET, { room: ROOM, role: 'guest', userId: 'user_1' }, 10)
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`
    expect(await verifyRelayTicket(tampered, SECRET, { room: ROOM, role: 'guest' }, 20)).toBeNull()
    expect(ticketFromProtocols(`longleash-v1, ${ticket}`)).toBe(ticket)
    expect(ticketFromProtocols('longleash-v1, unrelated')).toBeNull()
  })

  it('accepts only explicit host and guest URL roles', () => {
    expect(websocketRole(new URL(`https://app.longleash.dev/ws?room=${ROOM}&role=host`))).toBe('host')
    expect(websocketRole(new URL(`https://app.longleash.dev/ws?room=${ROOM}&role=guest`))).toBe('guest')
    expect(websocketRole(new URL(`https://app.longleash.dev/ws?room=${ROOM}&role=admin`))).toBeNull()
  })

  it('keeps pre-migration laptop sockets without reopening a browser bypass', () => {
    const env = {
      PUBLIC_APP_HOST: 'app.longleash.dev',
      PUBLIC_LEGACY_APP_HOST: 'longleash-relay.example.workers.dev',
    }
    const legacy = new URL(`https://longleash-relay.example.workers.dev/ws?room=${ROOM}`)
    expect(websocketRoleForRequest(legacy, null, env)).toBe('host')
    expect(websocketRoleForRequest(legacy, 'https://longleash-relay.example.workers.dev', env)).toBeNull()
    expect(websocketRoleForRequest(new URL(`https://app.longleash.dev/ws?room=${ROOM}`), null, env)).toBeNull()
  })
})
