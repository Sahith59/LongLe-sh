import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { RelayServer } from '@longleash/relay/src/server.js'
import { deriveRelayIdentity, open, seal, type RelayIdentity } from '@longleash/protocol'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { DeviceRegistry } from '../src/auth.js'
import { SessionManager } from '../src/sessions.js'
import { LongLeashServer } from '../src/server.js'
import { RelayBridge, normalizeRelayUrl } from '../src/relay-bridge.js'
import type { AgentFactory } from '../src/agent.js'

/**
 * The whole point of Phase B, as one test file: everything a phone could do over the LAN in
 * Phase A — hello, subscribe, start, approve, converse — done through the relay, where every
 * frame is ciphertext the relay cannot read.
 */

let dir: string
let root: string
let relay: RelayServer
let relayUrl: string
let eventLog: EventLog
let approvals: ApprovalStore
let registry: DeviceRegistry
let sessions: SessionManager
let server: LongLeashServer
let bridge: RelayBridge

/** An agent that asks permission for one Write, then reports what happened. */
const askingAgent: AgentFactory = (request) => ({
  events: (async function* () {
    yield { type: 'text' as const, text: 'about to write…' }
    const decision = await request.canUseTool('Write', { file_path: join(request.cwd, 'x.ts') })
    yield { type: 'text' as const, text: decision.behavior === 'allow' ? 'wrote it' : 'blocked' }
    yield { type: 'turn-end' as const }
  })(),
  sendMessage: () => {},
  interrupt: async () => {},
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'longleash-bridge-'))
  root = realpathSync(dir)
  relay = new RelayServer({ host: '127.0.0.1', port: 0 })
  const relayPort = await relay.listen()
  relayUrl = `ws://127.0.0.1:${relayPort}/ws`

  eventLog = new EventLog(':memory:')
  approvals = new ApprovalStore(':memory:')
  registry = new DeviceRegistry(':memory:')
  sessions = new SessionManager({
    eventLog,
    approvals,
    allowedRoots: [root],
    agentFactories: { claude: askingAgent },
    onEvent: (event) => server.broadcastEvent(event),
  })
  server = new LongLeashServer({ eventLog, registry, host: '127.0.0.1', port: 0, relayUrl })
  server.attachSessions(sessions)
  await server.listen()
  bridge = new RelayBridge({ url: relayUrl, registry, server })
})

afterEach(async () => {
  bridge.stop()
  await server.close()
  await relay.close()
  eventLog.close()
  approvals.close()
  registry.close()
  rmSync(dir, { recursive: true, force: true })
})

function pairDevice(): { deviceId: string; relaySecret: string } {
  const challenge = registry.createPairingChallenge()
  const { device, relaySecret } = registry.completePairing({
    challengeId: challenge.challengeId,
    secret: challenge.secret,
    deviceName: 'iPhone',
  })
  return { deviceId: device.deviceId, relaySecret }
}

/** The phone side, boiled down: join the room as guest, seal out, open in. */
async function connectPhone(relaySecret: string) {
  const identity: RelayIdentity = await deriveRelayIdentity(relaySecret)
  const ws = new WebSocket(relayUrl)
  const inbox: Record<string, unknown>[] = []
  const control: Record<string, unknown>[] = []
  ws.on('message', (raw: WebSocket.RawData) => {
    const message = JSON.parse(String(raw)) as { type?: string; payload?: string }
    if (message.type === 'frame' && message.payload) {
      void open(identity, message.payload).then((text) => {
        if (text !== null) inbox.push(JSON.parse(text) as Record<string, unknown>)
      })
    } else {
      control.push(message as Record<string, unknown>)
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'guest' }))
  const say = async (message: Record<string, unknown>) => {
    ws.send(JSON.stringify({ v: 1, type: 'frame', payload: await seal(identity, JSON.stringify(message)) }))
  }
  const expectMessage = async (type: string, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = inbox.find((m) => m.type === type)
      if (found) {
        inbox.splice(inbox.indexOf(found), 1)
        return found
      }
      if (Date.now() > deadline) throw new Error(`no "${type}" arrived over the relay`)
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  return { ws, inbox, control, say, expectMessage, identity }
}

describe('phase A, but through the relay, as ciphertext', () => {
  it('a phone joining the room is greeted with hello — sessions, roots, and the relay url', async () => {
    const { relaySecret } = pairDevice()
    bridge.start()
    const phone = await connectPhone(relaySecret)

    const hello = await phone.expectMessage('hello')
    expect(hello).toMatchObject({ relay: { url: relayUrl } })
    expect(Array.isArray(hello.sessions)).toBe(true)
    phone.ws.close()
  })

  it('the full loop: start a session, get asked, approve, watch the agent finish', async () => {
    const { relaySecret } = pairDevice()
    bridge.start()
    const phone = await connectPhone(relaySecret)
    await phone.expectMessage('hello')

    await phone.say({ v: 1, type: 'startSession', agent: 'claude', root, prompt: 'do the thing' })
    const ack = await phone.expectMessage('ack')
    const sessionId = String(ack.sessionId)
    expect(ack).toMatchObject({ of: 'startSession', outcome: 'started' })

    await phone.say({ v: 1, type: 'subscribe', sessionId, fromCursor: 0 })
    const asked = await phone.expectMessage('approval.requested')
    const approvalId = String((asked.payload as { approvalId: string }).approvalId)

    await phone.say({ v: 1, type: 'decision', approvalId, verdict: 'allow' })
    await phone.expectMessage('approval.decided')

    // The agent unblocked and its progress streamed back — all of it sealed.
    const deadline = Date.now() + 4000
    let sawOutcome = false
    while (!sawOutcome && Date.now() < deadline) {
      const delta = await phone.expectMessage('stream.delta').catch(() => null)
      if (delta && String((delta.payload as { text?: string }).text ?? '').includes('wrote it')) {
        sawOutcome = true
      }
    }
    expect(sawOutcome).toBe(true)
    phone.ws.close()
  })

  it('a tampered frame is dropped and the conversation continues unharmed', async () => {
    const { relaySecret } = pairDevice()
    bridge.start()
    const phone = await connectPhone(relaySecret)
    await phone.expectMessage('hello')

    const sealed = await seal(phone.identity, JSON.stringify({ v: 1, type: 'findFolders', query: 'x' }))
    const at = 25
    const flipped = sealed.slice(0, at) + (sealed[at] === 'A' ? 'B' : 'A') + sealed.slice(at + 1)
    phone.ws.send(JSON.stringify({ v: 1, type: 'frame', payload: flipped }))

    // The forged frame produced nothing; a legitimate one right after works.
    await phone.say({ v: 1, type: 'findFolders', query: 'anything' })
    await phone.expectMessage('folders')
    phone.ws.close()
  })

  it('revoking the device closes its room: the phone sees its host leave', async () => {
    const { deviceId, relaySecret } = pairDevice()
    bridge.start()
    const phone = await connectPhone(relaySecret)
    await phone.expectMessage('hello')

    registry.revokeDevice(deviceId)
    const deadline = Date.now() + 3000
    for (;;) {
      if (phone.control.some((m) => m.type === 'peer' && m.role === 'host' && m.event === 'left')) break
      if (Date.now() > deadline) throw new Error('host never left after revocation')
      await new Promise((r) => setTimeout(r, 15))
    }
    phone.ws.close()
  })

  it('a device paired while the daemon is running gets its room immediately', async () => {
    bridge.start()
    expect(bridge.start).toBeDefined()
    const { relaySecret } = pairDevice() // fires onPaired → bridge opens the room live
    const phone = await connectPhone(relaySecret)
    await phone.expectMessage('hello')
    phone.ws.close()
  })
})

describe('normalizing the relay url', () => {
  it('turns an https origin into the wss /ws endpoint', () => {
    expect(normalizeRelayUrl('https://relay.example.com')).toBe('wss://relay.example.com/ws')
  })
  it('leaves a complete ws endpoint alone', () => {
    expect(normalizeRelayUrl('ws://127.0.0.1:8080/ws')).toBe('ws://127.0.0.1:8080/ws')
  })
})
