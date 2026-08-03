import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { EventLog } from '../src/eventlog.js'
import { DeviceRegistry } from '../src/auth.js'
import { ApprovalStore } from '../src/approvals.js'
import { SessionManager } from '../src/sessions.js'
import type { AgentFactory, AgentRunRequest, PermissionDecision } from '../src/agent.js'
import { LongLeashServer, CLOSE_UNAUTHORIZED, CLOSE_REVOKED } from '../src/server.js'
import { PushNotifier } from '../src/push.js'

/** Minimal controllable agent so server tests stay deterministic. */
class DemoAgent {
  private request!: AgentRunRequest
  private queue: unknown[] = []
  private waiter: (() => void) | null = null
  private finished = false

  readonly factory: AgentFactory = (request) => {
    this.request = request
    return { events: this.iterate(), sendMessage: () => {}, interrupt: async () => this.finish() }
  }
  requestTool(name: string, input: unknown = {}): Promise<PermissionDecision> {
    return this.request.canUseTool(name, input)
  }
  say(text: string): void {
    this.queue.push({ type: 'text', text })
    this.wake()
  }
  finish(): void {
    this.finished = true
    this.wake()
  }
  private wake(): void {
    this.waiter?.()
    this.waiter = null
  }
  private async *iterate(): AsyncGenerator<never> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift() as never
      if (this.finished) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

const HOST = '127.0.0.1'

interface Harness {
  server: LongLeashServer
  log: EventLog
  registry: DeviceRegistry
  port: number
  token: string
  deviceId: string
}

const CLIENT_TIMEOUT_MS = 4000

async function startHarness(): Promise<Harness> {
  const log = new EventLog(':memory:')
  const registry = new DeviceRegistry(':memory:')
  const challenge = registry.createPairingChallenge()
  const { device, token } = registry.completePairing({
    challengeId: challenge.challengeId,
    secret: challenge.secret,
    deviceName: 'test phone',
  })
  const server = new LongLeashServer({ eventLog: log, registry, host: HOST, port: 0 })
  const { port } = await server.listen()
  return { server, log, registry, port, token, deviceId: device.deviceId }
}

/**
 * Buffer from the moment the socket exists: the server greets a connection immediately, so a
 * listener attached after `open` can miss messages that already arrived.
 */
const inbox = new WeakMap<WebSocket, Record<string, unknown>[]>()

function connect(port: number, token?: string): WebSocket {
  const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(`ws://${HOST}:${port}/ws${query}`)
  const buffer: Record<string, unknown>[] = []
  inbox.set(ws, buffer)
  ws.on('message', (raw: WebSocket.RawData) => {
    buffer.push(JSON.parse(raw.toString()) as Record<string, unknown>)
  })
  return ws
}

/** The greeting is infrastructure; tests that care about it ask explicitly. */
async function helloOf(ws: WebSocket): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < CLIENT_TIMEOUT_MS) {
    const hello = inbox.get(ws)?.find((m) => m.type === 'hello')
    if (hello) return hello
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('no hello received')
}

/** Resolves on close; rejects if the socket opens successfully instead. */
function expectClosed(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket neither closed nor errored in time')), 4000)
    ws.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    ws.on('error', () => {
      /* a refused upgrade surfaces as an error before close; wait for close */
    })
  })
}

/** Next `count` non-greeting messages, consumed from the buffer so calls compose. */
async function nextMessages(ws: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  const buffer = inbox.get(ws)
  if (!buffer) throw new Error('socket was not created via connect()')
  const start = Date.now()
  for (;;) {
    const index = buffer.findIndex((m) => m.type !== 'hello')
    if (index !== -1) {
      const usable = buffer.filter((m) => m.type !== 'hello')
      if (usable.length >= count) {
        const taken = usable.slice(0, count)
        for (const message of taken) buffer.splice(buffer.indexOf(message), 1)
        return taken
      }
    }
    if (Date.now() - start > CLIENT_TIMEOUT_MS) {
      throw new Error(`timed out waiting for ${count} messages`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

const delta = (text: string) => ({ type: 'stream.delta' as const, payload: { kind: 'text' as const, text } })

describe('auth on connect', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.server.close()
    h.log.close()
    h.registry.close()
  })

  it('accepts a connection carrying a valid token', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('greets every authenticated connection', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    expect(await helloOf(ws)).toMatchObject({ type: 'hello', deviceId: h.deviceId })
    ws.close()
  })

  it('closes a connection with no token', async () => {
    const code = await expectClosed(connect(h.port))
    expect(code).toBe(CLOSE_UNAUTHORIZED)
  })

  it('closes a connection with a bogus token', async () => {
    const code = await expectClosed(connect(h.port, 'llt_not_a_real_token'))
    expect(code).toBe(CLOSE_UNAUTHORIZED)
  })

  it('closes a connection whose device was revoked before connecting', async () => {
    h.registry.revokeDevice(h.deviceId)
    const code = await expectClosed(connect(h.port, h.token))
    expect(code).toBe(CLOSE_UNAUTHORIZED)
  })

  it('drops a LIVE connection the moment its device is revoked', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    const closed = expectClosed(ws)
    h.registry.revokeDevice(h.deviceId)
    expect(await closed).toBe(CLOSE_REVOKED)
  })
})

describe('subscribe: replay then live tail', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.server.close()
    h.log.close()
    h.registry.close()
  })

  it('replays history from cursor 0 and then streams new events', async () => {
    h.server.publish('ses_1', delta('before-1'))
    h.server.publish('ses_1', delta('before-2'))

    const ws = connect(h.port, h.token)
    await opened(ws)
    const replay = nextMessages(ws, 2)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 0 }))
    const history = await replay
    expect(history.map((m) => m.seq)).toEqual([1, 2])

    const live = nextMessages(ws, 1)
    h.server.publish('ses_1', delta('after'))
    const [liveEvent] = await live
    expect(liveEvent?.seq).toBe(3)
    ws.close()
  })

  it('a reconnecting client with a cursor receives only what it missed — no duplicates', async () => {
    h.server.publish('ses_1', delta('one'))
    h.server.publish('ses_1', delta('two'))
    h.server.publish('ses_1', delta('three'))

    const ws = connect(h.port, h.token)
    await opened(ws)
    const messages = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 2 }))
    const received = await messages
    expect(received.map((m) => m.seq)).toEqual([3])
    ws.close()
  })

  it('sends an explicit gap signal when the cursor is ahead of the log', async () => {
    h.server.publish('ses_1', delta('one'))
    const ws = connect(h.port, h.token)
    await opened(ws)
    const messages = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 99 }))
    const [gap] = await messages
    expect(gap).toMatchObject({ type: 'gap', reason: 'cursor-ahead', latestSeq: 1 })
    ws.close()
  })

  it('does not leak events from sessions the client did not subscribe to', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_mine', fromCursor: 0 }))
    const messages = nextMessages(ws, 1)
    h.server.publish('ses_other', delta('secret'))
    h.server.publish('ses_mine', delta('mine'))
    const [only] = await messages
    expect(only).toMatchObject({ sessionId: 'ses_mine' })
    ws.close()
  })

  it('delivers identical ordering to two devices watching the same session', async () => {
    const second = h.registry.createPairingChallenge()
    const other = h.registry.completePairing({
      challengeId: second.challengeId,
      secret: second.secret,
      deviceName: 'ipad',
    })
    const a = connect(h.port, h.token)
    const b = connect(h.port, other.token)
    await Promise.all([opened(a), opened(b)])
    a.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 0 }))
    b.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 0 }))
    await new Promise((r) => setTimeout(r, 50))

    const aMsgs = nextMessages(a, 3)
    const bMsgs = nextMessages(b, 3)
    h.server.publish('ses_1', delta('x'))
    h.server.publish('ses_1', delta('y'))
    h.server.publish('ses_1', delta('z'))
    const [aList, bList] = await Promise.all([aMsgs, bMsgs])
    expect(aList.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(bList.map((m) => m.seq)).toEqual([1, 2, 3])
    a.close()
    b.close()
  })
})

describe('hello: telling the client what it may do', () => {
  let h: Harness
  let sessions: SessionManager
  let approvals: ApprovalStore
  let root: string
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'longleash-hello-'))
    root = realpathSync(dir)
    h = await startHarness()
    approvals = new ApprovalStore(':memory:')
    sessions = new SessionManager({
      eventLog: h.log,
      approvals,
      allowedRoots: [root],
      agentFactories: { claude: new DemoAgent().factory },
    })
    h.server.attachSessions(sessions)
  })
  afterEach(async () => {
    await h.server.close()
    h.log.close()
    h.registry.close()
    approvals.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('greets a reconnecting client with the sessions it should rebuild', async () => {
    const agent = new DemoAgent()
    const manager = new SessionManager({
      eventLog: h.log,
      approvals,
      allowedRoots: [root],
      agentFactories: { claude: agent.factory },
    })
    h.server.attachSessions(manager)
    const { sessionId } = await manager.startSession({ agent: 'claude', cwd: root, prompt: 'earlier' })

    const ws = connect(h.port, h.token)
    await opened(ws)
    const hello = await helloOf(ws)
    const listed = (hello.sessions as { sessionId: string; title: string }[]) ?? []
    expect(listed.map((s) => s.sessionId)).toContain(sessionId)
    expect(listed[0]?.title).toBe('earlier')
    ws.close()
  })

  it('greets a new connection with the directories agents may use', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    const hello = await helloOf(ws)
    expect(hello.roots).toEqual([root])
    expect(hello.capabilities).toMatchObject({ startSession: true, stopSession: true })
    ws.close()
  })

  it('reports no start capability when the daemon is headless', async () => {
    const bare = await startHarness()
    try {
      const ws = connect(bare.port, bare.token)
      await opened(ws)
      const hello = await helloOf(ws)
      expect(hello.roots).toEqual([])
      expect(hello.capabilities).toMatchObject({ startSession: false })
      ws.close()
    } finally {
      await bare.server.close()
      bare.log.close()
      bare.registry.close()
    }
  })
})

describe('typed operations: decisions and remote start', () => {
  let h: Harness
  let sessions: SessionManager
  let approvals: ApprovalStore
  let agent: DemoAgent
  let root: string
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'longleash-server-sessions-'))
    root = realpathSync(dir)
    h = await startHarness()
    approvals = new ApprovalStore(':memory:')
    agent = new DemoAgent()
    sessions = new SessionManager({
      eventLog: h.log,
      approvals,
      allowedRoots: [root],
      agentFactories: { claude: agent.factory },
      onEvent: (event) => h.server.broadcastEvent(event),
    })
    h.server.attachSessions(sessions)
  })
  afterEach(async () => {
    await h.server.close()
    h.log.close()
    h.registry.close()
    approvals.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a phone decision unblocks the waiting agent and is attributed to that device', async () => {
    const { sessionId } = await sessions.startSession({ agent: 'claude', cwd: root, prompt: 'x' })
    const pending = agent.requestTool('Write', { file_path: 'a.ts' })
    await sessions.waitForApproval(sessionId)
    const approvalId = sessions.listPendingApprovals()[0]!.approvalId

    const ws = connect(h.port, h.token)
    await opened(ws)
    const ack = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'decision', approvalId, verdict: 'allow' }))
    expect(await ack).toMatchObject([{ type: 'ack', outcome: 'decided' }])
    expect(await pending).toMatchObject({ behavior: 'allow' })

    const decided = h.log.replay(sessionId, 0)
    if (decided.gap) expect.unreachable('no gap')
    const event = decided.events.find((e) => e.type === 'approval.decided')
    expect((event?.payload as { decidedBy: string }).decidedBy).toBe(h.deviceId)
    ws.close()
  })

  it('session events reach a subscribed phone live, without polling', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    const { sessionId } = await sessions.startSession({ agent: 'claude', cwd: root, prompt: 'x' })
    // Subscribe from where the log already is, so nothing replays and no gap is signalled.
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId, fromCursor: h.log.latestSeq(sessionId) }))
    await new Promise((r) => setTimeout(r, 50))

    const streamed = nextMessages(ws, 1)
    agent.say('thinking out loud')
    expect((await streamed)[0]).toMatchObject({ type: 'stream.delta', sessionId })

    const approval = nextMessages(ws, 1)
    void agent.requestTool('Bash', { command: 'ls' })
    expect((await approval)[0]).toMatchObject({ type: 'approval.requested', sessionId })
    ws.close()
  })

  it('deciding an unknown approval answers with an error instead of failing silently', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    const messages = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'decision', approvalId: 'apr_ghost', verdict: 'allow' }))
    expect(await messages).toMatchObject([{ type: 'ack', outcome: 'unknown' }])
    ws.close()
  })

  it('starts a session remotely inside an allowlisted root', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    const messages = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'startSession', agent: 'claude', root, prompt: 'build it' }))
    const [ack] = await messages
    expect(ack).toMatchObject({ type: 'ack', outcome: 'started' })
    expect(String(ack?.sessionId)).toMatch(/^ses_/)
    ws.close()
  })

  it('refuses a remote start outside the allowlist over the wire, without crashing the daemon', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    const messages = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'startSession', agent: 'claude', root: '/etc', prompt: 'oops' }))
    expect(await messages).toMatchObject([{ type: 'error', code: 'cwd-not-allowed' }])
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})

describe('hostile input', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.server.close()
    h.log.close()
    h.registry.close()
  })

  it('answers malformed JSON with an error and keeps the socket usable', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    const messages = nextMessages(ws, 1)
    ws.send('this is not json{{{')
    const [err] = await messages
    expect(err).toMatchObject({ type: 'error' })
    expect(ws.readyState).toBe(WebSocket.OPEN)

    const after = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 0 }))
    h.server.publish('ses_1', delta('still working'))
    const [ok] = await after
    expect(ok).toMatchObject({ type: 'stream.delta' })
    ws.close()
  })

  it('rejects a schema-invalid message without killing the connection', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    const messages = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: '', fromCursor: -1 }))
    const [err] = await messages
    expect(err).toMatchObject({ type: 'error' })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})

describe('resilience', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.server.close()
    h.log.close()
    h.registry.close()
  })

  it('survives a reconnect storm and still delivers a correct replay', async () => {
    for (let i = 0; i < 20; i++) {
      const ws = connect(h.port, h.token)
      await opened(ws)
      ws.terminate()
    }
    h.server.publish('ses_1', delta('after the storm'))
    const ws = connect(h.port, h.token)
    await opened(ws)
    const messages = nextMessages(ws, 1)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 0 }))
    const [event] = await messages
    expect(event).toMatchObject({ seq: 1, type: 'stream.delta' })
    expect(h.server.connectionCount()).toBe(1)
    ws.close()
  })

  it('publishing to a session with no subscribers still persists the event', () => {
    h.server.publish('ses_nobody', delta('tree falls in forest'))
    const replay = h.log.replay('ses_nobody', 0)
    if (replay.gap) expect.unreachable('no gap expected')
    expect(replay.events).toHaveLength(1)
  })

  it('a dead socket is cleaned up and does not break delivery to healthy ones', async () => {
    const healthy = connect(h.port, h.token)
    const doomed = connect(h.port, h.token)
    await Promise.all([opened(healthy), opened(doomed)])
    healthy.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 0 }))
    doomed.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 0 }))
    await new Promise((r) => setTimeout(r, 50))

    doomed.terminate()
    await new Promise((r) => setTimeout(r, 100))

    const messages = nextMessages(healthy, 1)
    h.server.publish('ses_1', delta('still delivered'))
    const [event] = await messages
    expect(event).toMatchObject({ seq: 1 })
    healthy.close()
  })

  it('a stalled reader cannot balloon daemon memory: buffering is capped and a gap is signalled', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_slow', fromCursor: 0 }))
    await new Promise((r) => setTimeout(r, 50))

    // Simulate a phone on a dying signal: TCP stops draining, writes pile up.
    const underlying = (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket
    underlying.pause()

    const big = 'x'.repeat(20_000)
    for (let i = 0; i < 500; i++) h.server.publish('ses_slow', delta(`${i}-${big}`))

    expect(h.server.desyncedCount()).toBe(1)
    expect(h.server.maxBufferedBytes()).toBeLessThan(4_000_000)

    // Every event still persisted — the client resyncs from its cursor, nothing is lost.
    const replay = h.log.replay('ses_slow', 0)
    if (replay.gap) expect.unreachable('log should hold everything')
    expect(replay.events).toHaveLength(500)

    underlying.resume()
    ws.terminate()
  }, 20000)

  it('reaps a connection that stops responding to heartbeats (phone loses signal)', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    expect(h.server.connectionCount()).toBe(1)

    h.server.markAllAwaitingPong()
    h.server.runHeartbeatTick()

    await new Promise((r) => setTimeout(r, 100))
    expect(h.server.connectionCount()).toBe(0)
  })

  it('tolerates a phone that goes briefly quiet instead of dropping it', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)

    // Two missed beats must not be fatal: mobile browsers throttle timers all the time.
    h.server.runHeartbeatTick()
    h.server.runHeartbeatTick()
    await new Promise((r) => setTimeout(r, 50))
    expect(h.server.connectionCount()).toBe(1)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('treats any inbound message as proof of life', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    h.server.runHeartbeatTick()
    h.server.runHeartbeatTick()
    h.server.runHeartbeatTick()

    // The client speaks; that alone should clear the strikes against it.
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_x', fromCursor: 0 }))
    await new Promise((r) => setTimeout(r, 80))

    h.server.runHeartbeatTick()
    await new Promise((r) => setTimeout(r, 50))
    expect(h.server.connectionCount()).toBe(1)
    ws.close()
  })

  it('keeps a healthy connection alive across heartbeat ticks', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    h.server.runHeartbeatTick()
    await new Promise((r) => setTimeout(r, 150))
    h.server.runHeartbeatTick()
    await new Promise((r) => setTimeout(r, 100))
    expect(h.server.connectionCount()).toBe(1)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('bounds memory for a burst: 2000 events arrive in order without loss', async () => {
    const ws = connect(h.port, h.token)
    await opened(ws)
    ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_burst', fromCursor: 0 }))
    await new Promise((r) => setTimeout(r, 50))

    const messages = nextMessages(ws, 2000)
    for (let i = 0; i < 2000; i++) h.server.publish('ses_burst', delta(`chunk ${i}`))
    const received = await messages
    expect(received).toHaveLength(2000)
    expect(received[0]?.seq).toBe(1)
    expect(received[1999]?.seq).toBe(2000)
    ws.close()
  }, 15000)
})

describe('push over the wire — the whole laptop side of Phase C', () => {
  it('advertises the key in hello, registers a phone, and taps it when an approval lands', async () => {
    const h = await startHarness()
    const dir = mkdtempSync(join(tmpdir(), 'll-push-wire-'))
    const sent: string[] = []
    const notifier = new PushNotifier({
      dbPath: ':memory:',
      keysPath: join(dir, 'vapid.json'),
      subject: 'https://relay.example.dev',
      send: async (_subscription, payload) => {
        sent.push(payload)
      },
    })
    h.server.attachPush(notifier)

    // 1. The phone learns the VAPID key from hello — no key, no Alerts offer in the UI.
    const ws = connect(h.port, h.token)
    const hello = await helloOf(ws)
    expect((hello.push as { publicKey?: string }).publicKey).toBe(notifier.publicKey)

    // 2. Subscribing over the socket lands in the notifier, attributed to this device.
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'pushSubscribe',
        subscription: {
          endpoint: 'https://web.push.apple.com/wire-test',
          keys: { p256dh: 'pk', auth: 'au' },
        },
      }),
    )
    const [ack] = await nextMessages(ws, 1)
    expect(ack).toMatchObject({ type: 'ack', of: 'pushSubscribe', outcome: 'registered' })
    expect(notifier.count()).toBe(1)

    // 3. An approval triggers the tap, and the payload is IDs only.
    notifier.notifyApproval('ses_wire', 'apr_wire')
    await new Promise((r) => setTimeout(r, 30))
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!)).toEqual({ t: 'approval', sessionId: 'ses_wire', approvalId: 'apr_wire' })

    // 4. Revoking the device silences it — no orphaned endpoints for an unpaired phone.
    h.registry.revokeDevice(h.deviceId)
    expect(notifier.count()).toBe(0)

    ws.close()
    notifier.close()
    await h.server.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
