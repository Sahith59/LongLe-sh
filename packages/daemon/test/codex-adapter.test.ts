import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createCodexAgentFactory } from '../src/adapters/codex.js'
import type { SessionSettings } from '@longleash/protocol'
import type { AgentStreamMessage, PermissionDecision } from '../src/agent.js'

/**
 * The Codex adapter, driven against a scripted app-server. Every method name and every
 * decision word below was taken from Codex's own generated schema and confirmed against a live
 * server — so if Codex changes them, these tests fail loudly rather than the product going
 * quiet in someone's pocket.
 */

/** A stand-in for `codex app-server`: records what we send, replays what we script. */
class FakeAppServer extends EventEmitter {
  readonly sent: Record<string, unknown>[] = []
  // A real child's streams are Readables. Only the two members the adapter touches matter,
  // but they must behave like the real thing or the fake proves nothing.
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  killedWith: string | null = null
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') this.sent.push(JSON.parse(line) as Record<string, unknown>)
      }
      return true
    },
  }
  kill(signal: string): boolean {
    this.killedWith = signal
    this.emit('exit', 0)
    return true
  }
  /** Push a line from the server to us. */
  say(message: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(message)}\n`)
  }
  sentMethod(method: string): Record<string, unknown> | undefined {
    return this.sent.find((m) => m.method === method)
  }
  replyTo(method: string, result: unknown): void {
    const call = this.sentMethod(method)
    if (call) this.say({ id: call.id, result })
  }
}

interface Harness {
  server: FakeAppServer
  events: AgentStreamMessage[]
  approvals: { toolName: string; input: unknown }[]
  autoApproved: string[]
  agentSessionIds: string[]
  handle: ReturnType<ReturnType<typeof createCodexAgentFactory>>
}

function start(
  decide: (toolName: string) => PermissionDecision = () => ({ behavior: 'allow' }),
  opts: { prompt?: string; resume?: string; settings?: SessionSettings } = {},
): Harness {
  const server = new FakeAppServer()
  const events: AgentStreamMessage[] = []
  const approvals: Harness['approvals'] = []
  const autoApproved: string[] = []
  const agentSessionIds: string[] = []

  const factory = createCodexAgentFactory({
    spawnServer: () => server as unknown as ChildProcessWithoutNullStreams,
  })
  const handle = factory({
    sessionId: 'sess-1',
    cwd: '/tmp/project',
    prompt: opts.prompt ?? 'do the thing',
    canUseTool: async (toolName, input) => {
      approvals.push({ toolName, input })
      return decide(toolName)
    },
    onAutoApprovedTool: (toolName) => autoApproved.push(toolName),
    onAgentSession: (id) => agentSessionIds.push(id),
    ...(opts.resume === undefined ? {} : { resume: opts.resume }),
    ...(opts.settings === undefined ? {} : { settings: opts.settings }),
  })
  void (async () => {
    try {
      for await (const event of handle.events) events.push(event)
    } catch {
      // SessionManager is the production owner of this stream and records the error. Individual
      // adapter tests only assert transport behavior, so consume terminal failures here.
    }
  })()
  return { server, events, approvals, autoApproved, agentSessionIds, handle }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

/** Walk the handshake to a live thread, the state most tests start from. */
async function handshake(h: Harness, threadId = 'thr-1'): Promise<void> {
  await settle()
  h.server.replyTo('initialize', { userAgent: 'codex/0.147.0' })
  await settle()
  h.server.replyTo('thread/start', { thread: { id: threadId } })
  await settle()
  h.server.replyTo('turn/start', {})
  await settle()
}

describe('the Codex adapter — the handshake Codex actually requires', () => {
  it('initializes, announces itself, opens a thread, then starts the turn', async () => {
    const h = start()
    await handshake(h)
    const order = h.server.sent.filter((m) => m.method !== undefined).map((m) => m.method)
    expect(order).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
  })

  it('sends newline-delimited JSON-RPC 2.0, one message per line', async () => {
    const h = start()
    await settle()
    const first = h.server.sent[0]!
    expect(first.jsonrpc).toBe('2.0')
    expect(first.method).toBe('initialize')
    expect(typeof first.id).toBe('number')
  })

  it('opens the thread in the session’s own folder, asking about everything', async () => {
    const h = start()
    await settle()
    h.server.replyTo('initialize', {})
    await settle()
    const params = h.server.sentMethod('thread/start')!.params as Record<string, unknown>
    expect(params.cwd).toBe('/tmp/project')
    // A session started from a phone must route decisions BACK to that phone, not decide alone.
    expect(params.approvalPolicy).toBe('untrusted')
  })

  it('sends the prompt in the shape turn/start declares', async () => {
    const h = start(undefined, { prompt: 'fix the retry logic' })
    await handshake(h)
    const params = h.server.sentMethod('turn/start')!.params as Record<string, unknown>
    expect(params.threadId).toBe('thr-1')
    expect(params.input).toEqual([{ type: 'text', text: 'fix the retry logic' }])
  })

  it('pins model and reasoning effort on both the thread and every turn', async () => {
    const h = start(undefined, { settings: { model: 'gpt-5.6', effort: 'high' } })
    await handshake(h)
    expect(h.server.sentMethod('thread/start')?.params).toMatchObject({ model: 'gpt-5.6' })
    expect(h.server.sentMethod('turn/start')?.params).toMatchObject({
      model: 'gpt-5.6',
      effort: 'high',
    })
  })

  it('captures the thread id so the conversation can be reopened later', async () => {
    const h = start()
    await handshake(h, 'thr-remember-me')
    expect(h.agentSessionIds).toEqual(['thr-remember-me'])
  })

  it('resumes an existing conversation instead of starting a new one', async () => {
    const h = start(undefined, { resume: 'thr-old' })
    await settle()
    h.server.replyTo('initialize', {})
    await settle()
    expect(h.server.sentMethod('thread/start')).toBeUndefined()
    const resumed = h.server.sentMethod('thread/resume')!.params as Record<string, unknown>
    expect(resumed.threadId).toBe('thr-old')
  })
})

describe('the Codex adapter — approvals reach the human and answer in Codex’s own words', () => {
  const approvalCases = [
    { method: 'item/commandExecution/requestApproval', allow: 'accept', deny: 'decline', tool: 'Bash' },
    { method: 'item/fileChange/requestApproval', allow: 'accept', deny: 'decline', tool: 'Edit' },
    // These answer with ReviewDecision, whose refusal is `abort`. Sending `decline` or `denied`
    // is rejected and the turn stalls silently — the failure this table exists to prevent.
    { method: 'execCommandApproval', allow: 'approved', deny: 'abort', tool: 'Bash' },
    { method: 'applyPatchApproval', allow: 'approved', deny: 'abort', tool: 'Edit' },
  ]

  for (const c of approvalCases) {
    it(`${c.method}: allow → "${c.allow}"`, async () => {
      const h = start(() => ({ behavior: 'allow' }))
      await handshake(h)
      h.server.say({ id: 99, method: c.method, params: { command: 'rm -rf build', threadId: 'thr-1' } })
      await settle()
      const reply = h.server.sent.find((m) => m.id === 99 && m.result !== undefined)!
      expect((reply.result as { decision: string }).decision).toBe(c.allow)
      expect(h.approvals[0]!.toolName).toBe(c.tool)
    })

    it(`${c.method}: deny → "${c.deny}"`, async () => {
      const h = start(() => ({ behavior: 'deny', message: 'no' }))
      await handshake(h)
      h.server.say({ id: 100, method: c.method, params: { command: 'rm -rf /', threadId: 'thr-1' } })
      await settle()
      const reply = h.server.sent.find((m) => m.id === 100 && m.result !== undefined)!
      expect((reply.result as { decision: string }).decision).toBe(c.deny)
    })
  }

  it('returns the granted permission subset in the schema permissions requests require', async () => {
    const h = start(() => ({ behavior: 'allow' }))
    await handshake(h)
    const requested = { network: { enabled: true } }
    h.server.say({
      id: 101,
      method: 'item/permissions/requestApproval',
      params: { permissions: requested, threadId: 'thr-1' },
    })
    await settle()
    const reply = h.server.sent.find((m) => m.id === 101 && m.result !== undefined)!
    expect(reply.result).toEqual({ permissions: requested })
    expect(h.approvals[0]!.toolName).toBe('Permissions')
  })

  it('grants no permissions when the person denies a permissions request', async () => {
    const h = start(() => ({ behavior: 'deny', message: 'no network' }))
    await handshake(h)
    h.server.say({
      id: 102,
      method: 'item/permissions/requestApproval',
      params: { permissions: { network: { enabled: true } }, threadId: 'thr-1' },
    })
    await settle()
    const reply = h.server.sent.find((m) => m.id === 102 && m.result !== undefined)!
    expect(reply.result).toEqual({ permissions: {} })
  })

  it('denies rather than hanging when nobody can be reached', async () => {
    const h = start(() => {
      throw new Error('no phone, no laptop, nobody')
    })
    await handshake(h)
    h.server.say({ id: 7, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } })
    await settle()
    const reply = h.server.sent.find((m) => m.id === 7)!
    // Leaving Codex waiting forever would be worse than refusing.
    expect((reply.result as { decision: string }).decision).toBe('decline')
  })

  it('answers a request it does not broker instead of leaving Codex waiting', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ id: 42, method: 'mcpServer/elicitation/request', params: {} })
    await settle()
    const reply = h.server.sent.find((m) => m.id === 42)!
    expect(reply.error).toBeDefined()
    expect(h.approvals).toHaveLength(0) // and it never bothered the human about it
  })
})

describe('the Codex adapter — what reaches the phone', () => {
  it('streams the assistant’s words', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ method: 'item/agentMessage/delta', params: { delta: 'Hello ' } })
    h.server.say({ method: 'item/agentMessage/delta', params: { delta: 'there' } })
    await settle()
    expect(h.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual([
      'Hello ',
      'there',
    ])
  })

  it('uses authoritative item/completed text when a build sends no deltas', async () => {
    const h = start()
    await handshake(h)
    h.server.say({
      method: 'item/completed',
      params: { item: { id: 'msg-1', type: 'agentMessage', text: 'The final answer.' } },
    })
    await settle()
    expect(h.events.some((e) => e.type === 'text' && (e as { text: string }).text === 'The final answer.')).toBe(true)
  })

  it('does not duplicate completed text after streaming deltas', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ method: 'item/agentMessage/delta', params: { itemId: 'msg-2', delta: 'Hello ' } })
    h.server.say({ method: 'item/agentMessage/delta', params: { itemId: 'msg-2', delta: 'there' } })
    h.server.say({
      method: 'item/completed',
      params: { item: { id: 'msg-2', type: 'agentMessage', text: 'Hello there' } },
    })
    await settle()
    const text = h.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('Hello there')
  })

  it('marks reasoning as thinking, not speech', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ method: 'item/reasoning/textDelta', params: { delta: 'weighing options' } })
    await settle()
    expect(h.events.some((e) => e.type === 'thinking')).toBe(true)
  })

  it('reports tools it ran, so the activity feed is not silent', async () => {
    const h = start()
    await handshake(h)
    h.server.say({
      method: 'item/started',
      params: { item: { id: 'exec-1', type: 'commandExecution', command: 'pnpm test' } },
    })
    h.server.say({
      method: 'item/completed',
      params: { item: { id: 'exec-1', type: 'commandExecution', command: 'pnpm test' } },
    })
    await settle()
    const tool = h.events.find((e) => e.type === 'tool') as { text: string } | undefined
    expect(tool?.text).toBe('Bash: pnpm test')
    expect(h.autoApproved).toContain('Bash')
  })

  it('never calls an action auto-approved when Codex actually asked the phone about it', async () => {
    const h = start()
    await handshake(h)
    h.server.say({
      method: 'item/started',
      params: { item: { id: 'exec-asked', type: 'commandExecution', command: 'pnpm test' } },
    })
    h.server.say({
      id: 88,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'exec-asked', command: 'pnpm test' },
    })
    await settle()
    h.server.say({
      method: 'item/completed',
      params: { item: { id: 'exec-asked', type: 'commandExecution', command: 'pnpm test' } },
    })
    await settle()
    expect(h.autoApproved).not.toContain('Bash')
  })

  it('ends the turn without ending the session — a session is a dialogue', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ method: 'turn/completed', params: {} })
    await settle()
    expect(h.events.some((e) => e.type === 'turn-end')).toBe(true)

    // …and a reply starts the next turn on the same thread.
    h.handle.sendMessage('now do the other thing')
    await settle()
    const turns = h.server.sent.filter((m) => m.method === 'turn/start')
    expect(turns).toHaveLength(2)
    expect((turns[1]!.params as { input: unknown[] }).input).toEqual([
      { type: 'text', text: 'now do the other thing' },
    ])
  })

  it('surfaces a Codex error rather than going quiet', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ method: 'error', params: { message: 'rate limited' } })
    await settle()
    expect(h.events.some((e) => e.type === 'text' && (e as { text: string }).text.includes('rate limited'))).toBe(true)
  })

  it('accepts current nested turn and error notification shapes', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ method: 'turn/started', params: { turn: { id: 'turn-current' } } })
    h.server.say({ method: 'error', params: { error: { message: 'nested failure' } } })
    await settle()
    expect(h.events.some((e) => e.type === 'text' && (e as { text: string }).text === 'nested failure')).toBe(true)
    void h.handle.interrupt()
    await new Promise((r) => setTimeout(r, 300))
    expect((h.server.sentMethod('turn/interrupt')?.params as { turnId?: string })?.turnId).toBe('turn-current')
  })
})

describe('the Codex adapter — it must never take the daemon down', () => {
  it('ignores a malformed line', async () => {
    const h = start()
    await handshake(h)
    h.server.stdout.emit('data', 'this is not json\n')
    h.server.say({ method: 'item/agentMessage/delta', params: { delta: 'still here' } })
    await settle()
    expect(h.events.some((e) => e.type === 'text' && (e as { text: string }).text === 'still here')).toBe(true)
  })

  it('handles a message split across chunk boundaries', async () => {
    const h = start()
    await handshake(h)
    const line = JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'split' } })
    h.server.stdout.emit('data', line.slice(0, 20))
    h.server.stdout.emit('data', `${line.slice(20)}\n`)
    await settle()
    expect(h.events.some((e) => e.type === 'text' && (e as { text: string }).text === 'split')).toBe(true)
  })

  it('reports a thread that never opened instead of hanging forever', async () => {
    const h = start()
    await settle()
    h.server.replyTo('initialize', {})
    await settle()
    const call = h.server.sentMethod('thread/start')!
    h.server.say({ id: call.id, error: { code: -32000, message: 'no capacity' } })
    await settle()
    expect(h.events.some((e) => e.type === 'text' && (e as { text: string }).text.includes('no capacity'))).toBe(true)
  })

  it('survives Codex exiting underneath it', async () => {
    const h = start()
    await handshake(h)
    h.server.emit('exit', 1)
    await settle()
    // The stream must END, not hang: a session that never closes is a session stuck on the phone.
    expect(() => h.handle.sendMessage('anyone there?')).not.toThrow()
  })

  it('interrupt tells Codex first, then stops the process', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ method: 'turn/started', params: { turnId: 'turn-9' } })
    await settle()
    // Deliberately never reply to turn/interrupt: this is Codex wedged, which is exactly
    // when someone reaches for Stop. Stop must still stop.
    void h.handle.interrupt()
    await new Promise((r) => setTimeout(r, 400))
    const interrupt = h.server.sentMethod('turn/interrupt')
    expect(interrupt).toBeDefined()
    expect((interrupt!.params as Record<string, unknown>).turnId).toBe('turn-9')
    expect(h.server.killedWith).toBe('SIGTERM')
  })
})

describe('the Codex adapter — the activity feed shows actions, not conversation', () => {
  it('never reports the assistant’s own message as a tool it ran', async () => {
    // Caught by a live run: "auto-ran agentMessage" in the feed is the same wrongness as
    // showing machine plumbing as human speech.
    const h = start()
    await handshake(h)
    for (const type of ['userMessage', 'agentMessage', 'reasoning', 'todoList']) {
      h.server.say({ method: 'item/started', params: { item: { type } } })
    }
    await settle()
    expect(h.autoApproved).toHaveLength(0)
    expect(h.events.filter((e) => e.type === 'tool')).toHaveLength(0)
  })

  it('still reports the things it actually did', async () => {
    const h = start()
    await handshake(h)
    h.server.say({ method: 'item/started', params: { item: { type: 'commandExecution', command: 'ls' } } })
    h.server.say({ method: 'item/started', params: { item: { type: 'fileChange', path: 'src/a.ts' } } })
    await settle()
    expect(h.events.filter((e) => e.type === 'tool').map((e) => (e as { text: string }).text)).toEqual([
      'Bash: ls',
      'Edit: src/a.ts',
    ])
  })
})
