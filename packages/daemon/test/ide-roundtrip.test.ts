import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { AgentFactory } from '../src/agent.js'
import { ApprovalStore } from '../src/approvals.js'
import { DeviceRegistry } from '../src/auth.js'
import { EventLog } from '../src/eventlog.js'
import { IdeCompanionServer } from '../src/ide-companion.js'
import { IdeControlHub } from '../src/ide-control.js'
import { LongLeashServer } from '../src/server.js'
import { SessionManager } from '../src/sessions.js'

it('routes a managed session through companion control and acknowledged phone handoff', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'longleash-ide-roundtrip-'))
  const project = join(temp, 'project')
  const dataDir = join(temp, 'data')
  mkdirSync(project); mkdirSync(dataDir)
  const root = realpathSync(project)
  const eventLog = new EventLog(':memory:')
  const approvals = new ApprovalStore(':memory:')
  const registry = new DeviceRegistry(':memory:')
  const sent: string[] = []
  let releaseAgent!: () => void
  const stopped = new Promise<void>((resolve) => { releaseAgent = resolve })
  const factory: AgentFactory = () => ({
    events: (async function* () { await stopped })(),
    sendMessage: (text) => { sent.push(text) },
    interrupt: async () => { releaseAgent() },
  })
  const server = new LongLeashServer({ eventLog, registry, host: '127.0.0.1', port: 0 })
  const sessions = new SessionManager({ eventLog, approvals, allowedRoots: [root],
    agentFactories: { claude: factory }, onEvent: (event) => server.broadcastEvent(event) })
  server.attachSessions(sessions)
  const control = new IdeControlHub({
    read: (sessionId, cursor) => eventLog.readPage(sessionId, cursor),
    command: (principal, message) => server.performIdeCommand(principal, message),
    approvals: () => approvals.listPending(),
    returnToPhone: (sessionId) => server.returnIdeToPhone(sessionId),
  })
  const companion = new IdeCompanionServer({ dataDir, allowedRoots: [root], control,
    sessions: () => sessions.listSessions(), latestActivity: (sessionId) => eventLog.latestTimestamp(sessionId),
    pendingApprovals: () => approvals.listPending() })
  server.setIdeControl(control)
  let phone: WebSocket | null = null
  let sessionId: string | undefined
  try {
    const { port } = await server.listen()
    await companion.start()
    const challenge = registry.createPairingChallenge()
    const { token } = registry.completePairing({ challengeId: challenge.challengeId, secret: challenge.secret, deviceName: 'test phone' })
    sessionId = (await sessions.startSession({ agent: 'claude', cwd: root, prompt: 'initial', origin: 'phone' })).sessionId
    phone = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`)
    const inbox: Record<string, unknown>[] = []
    phone.on('message', (raw) => inbox.push(JSON.parse(raw.toString()) as Record<string, unknown>))
    await new Promise<void>((resolve, reject) => { phone!.once('open', resolve); phone!.once('error', reject) })
    const next = async (test: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline) {
        const index = inbox.findIndex(test)
        if (index >= 0) return inbox.splice(index, 1)[0]!
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('Timed out waiting for the phone frame')
    }
    await next((message) => message.type === 'hello')
    phone.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId, fromCursor: eventLog.latestSeq(sessionId), syncId: 'ide-roundtrip' }))
    await next((message) => message.type === 'sync.complete' && message.sessionId === sessionId)

    const endpoint = JSON.parse(readFileSync(join(dataDir, 'ide-endpoint.json'), 'utf8')) as { url: string; secret: string }
    const url = endpoint.url.replace('/snapshot', '/control')
    const hello = { v: 1, type: 'ide.hello', clientInstanceId: 'roundtrip-window', protocol: { min: 1, max: 1 },
      extension: { version: '0.0.3', build: '0.0.3' },
      vscode: { version: '1.94.0', uriScheme: 'vscode', remoteAuthority: null, workspaceTrusted: true,
        windowFocused: true, workspaceFolders: [{ uri: `file://${root}`, canonicalPath: root }] },
      capabilities: ['sessions.read', 'transcripts.read', 'workspace.open', 'sessions.message'] }
    const post = async (operation: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-longleash-ide': endpoint.secret },
        body: JSON.stringify({ hello, operation }) })
      expect(response.status).toBe(200)
      return await response.json() as Record<string, unknown>
    }

    const poll = await post({ type: 'poll' }) as { windowId: string; requests: unknown[] }
    expect(poll.requests).toEqual([])
    const command = await post({ type: 'command', sessionId, operationId: randomUUID(),
      message: { v: 1, type: 'sendMessage', sessionId, text: 'from IDE' } })
    expect(command).toMatchObject({ type: 'ack', of: 'sendMessage', sessionId, outcome: 'sent' })
    expect(sent).toEqual(['from IDE'])
    const phoneEvent = await next((message) => message.type === 'stream.delta' && message.sessionId === sessionId &&
      (message.payload as { text?: string })?.text?.includes('from IDE') === true)
    expect(phoneEvent.sessionId).toBe(sessionId)
    const read = await post({ type: 'read', sessionId, fromCursor: 0 })
    expect((read.events as { sessionId: string }[]).every((event) => event.sessionId === sessionId)).toBe(true)
    expect(read.session).toMatchObject({ sessionId })

    const listId = randomUUID()
    phone.send(JSON.stringify({ v: 1, type: 'ideListWindows', sessionId, requestId: listId }))
    const windows = await next((message) => message.type === 'ideWindows' && message.requestId === listId)
    expect(windows.windows).toMatchObject([{ windowId: poll.windowId }])
    const openId = randomUUID()
    phone.send(JSON.stringify({ v: 1, type: 'ideOpen', sessionId, windowId: poll.windowId, requestId: openId }))
    let requested: Record<string, unknown> | undefined
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      const result = await post({ type: 'poll' })
      requested = (result.requests as Record<string, unknown>[]).find((request) => request.requestId === openId)
      if (requested) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(requested).toMatchObject({ requestId: openId, sessionId })
    expect(await post({ type: 'opened', requestId: openId, sessionId })).toEqual({ outcome: 'confirmed' })
    expect(await next((message) => message.type === 'ideResult' && message.requestId === openId))
      .toMatchObject({ outcome: 'opened', sessionId })

    const returned = post({ type: 'return', sessionId })
    const returnFrame = await next((message) => message.type === 'ideReturn' && message.sessionId === sessionId)
    phone.send(JSON.stringify({ v: 1, type: 'ideReturnAck', sessionId, requestId: returnFrame.requestId }))
    expect(await returned).toMatchObject({ outcome: 'opened', sessionId })
  } finally {
    phone?.close()
    if (phone) await new Promise<void>((resolve) => phone!.once('close', () => resolve()))
    if (sessionId) await sessions.stopSession(sessionId, 'test')
    await companion.stop()
    await server.close()
    eventLog.close(); approvals.close(); registry.close()
    rmSync(temp, { recursive: true, force: true })
  }
}, 15_000)
