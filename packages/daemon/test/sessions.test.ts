import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { SessionManager, SessionError } from '../src/sessions.js'
import type { AgentFactory, AgentRunRequest, PermissionDecision } from '../src/agent.js'

/** Deterministic stand-in for a real agent: the test drives it step by step. */
class FakeAgent {
  readonly toolResults: { name: string; decision: PermissionDecision }[] = []
  private request!: AgentRunRequest
  private queue: unknown[] = []
  private waiter: (() => void) | null = null
  private finished = false
  private failure: Error | null = null

  /** Follow-up messages the session delivered to this agent. */
  readonly received: string[] = []

  /** Runs this fake has been asked to start, with the resume id each was given. */
  readonly runs: (string | undefined)[] = []

  readonly factory: AgentFactory = (request) => {
    this.request = request
    this.runs.push(request.resume)
    this.queue = []
    this.finished = false
    this.failure = null
    // Real agents announce their resumable id shortly after starting.
    queueMicrotask(() => request.onAgentSession(`claude_${this.runs.length}`))
    return {
      events: this.iterate(),
      sendMessage: (text: string) => {
        this.received.push(text)
      },
      interrupt: async () => {
        this.finish()
      },
    }
  }

  endTurn(): void {
    this.push({ type: 'turn-end' })
  }

  get cwd(): string {
    return this.request.cwd
  }
  get prompt(): string {
    return this.request.prompt
  }

  /** Ask for permission the way the SDK's canUseTool does, and record what came back. */
  async requestTool(name: string, input: unknown = { path: 'x.ts' }): Promise<PermissionDecision> {
    const decision = await this.request.canUseTool(name, input)
    this.toolResults.push({ name, decision })
    return decision
  }

  reportAutoApproved(name: string, input: unknown = {}): void {
    this.request.onAutoApprovedTool(name, input)
  }

  say(text: string): void {
    this.push({ type: 'text', text })
  }

  finish(): void {
    this.finished = true
    this.wake()
  }

  fail(message: string): void {
    this.failure = new Error(message)
    this.wake()
  }

  private push(msg: unknown): void {
    this.queue.push(msg)
    this.wake()
  }

  private wake(): void {
    this.waiter?.()
    this.waiter = null
  }

  private async *iterate(): AsyncGenerator<never> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift() as never
      }
      if (this.failure) throw this.failure
      if (this.finished) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

interface Harness {
  manager: SessionManager
  log: EventLog
  approvals: ApprovalStore
  agent: FakeAgent
  root: string
  dir: string
  now: () => number
  setNow: (ms: number) => void
}

let clock = 1_000_000

function makeHarness(
  opts: { approvalTtlMs?: number; denyOutsideRoot?: boolean; maxConcurrentSessions?: number } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'longleash-sessions-'))
  const root = realpathSync(dir)
  const log = new EventLog(':memory:')
  const approvals = new ApprovalStore(':memory:', { now: () => clock })
  const agent = new FakeAgent()
  const manager = new SessionManager({
    eventLog: log,
    approvals,
    allowedRoots: [root],
    agentFactories: { claude: agent.factory },
    now: () => clock,
    approvalTtlMs: opts.approvalTtlMs ?? 24 * 60 * 60_000,
    ...(opts.denyOutsideRoot === undefined ? {} : { denyOutsideRoot: opts.denyOutsideRoot }),
    ...(opts.maxConcurrentSessions === undefined
      ? {}
      : { maxConcurrentSessions: opts.maxConcurrentSessions }),
  })
  return {
    manager,
    log,
    approvals,
    agent,
    root,
    dir,
    now: () => clock,
    setNow: (ms) => {
      clock = ms
    },
  }
}

const eventsOf = (log: EventLog, sessionId: string) => {
  const replay = log.replay(sessionId, 0)
  if (replay.gap) throw new Error('unexpected gap')
  return replay.events
}

const typesOf = (log: EventLog, sessionId: string) => eventsOf(log, sessionId).map((e) => e.type)

describe('startSession: allowlisted roots (security boundary)', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('starts a session in an allowlisted root and pins the cwd', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'do the thing' })
    expect(sessionId).toMatch(/^ses_/)
    expect(h.agent.cwd).toBe(h.root)
    expect(h.agent.prompt).toBe('do the thing')
    const started = eventsOf(h.log, sessionId)[0]
    expect(started?.type).toBe('session.started')
    if (started?.type === 'session.started') expect(started.payload.cwd).toBe(h.root)
  })

  it('starts in a subdirectory of an allowlisted root', async () => {
    const sub = join(h.root, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: sub, prompt: 'x' })
    expect(h.agent.cwd).toBe(sub)
    expect(typesOf(h.log, sessionId)).toContain('session.started')
  })

  it('refuses a cwd outside every allowlisted root', async () => {
    await expect(h.manager.startSession({ agent: 'claude', cwd: '/etc', prompt: 'x' })).rejects.toThrow(SessionError)
  })

  it('refuses ../ traversal that escapes the root', async () => {
    await expect(
      h.manager.startSession({ agent: 'claude', cwd: join(h.root, '..', '..'), prompt: 'x' }),
    ).rejects.toThrow(/not allowed/i)
  })

  it('refuses a sibling directory whose path merely shares the root prefix', async () => {
    const sibling = `${h.root}-evil`
    mkdirSync(sibling, { recursive: true })
    try {
      await expect(h.manager.startSession({ agent: 'claude', cwd: sibling, prompt: 'x' })).rejects.toThrow(
        /not allowed/i,
      )
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('refuses a symlink inside the root that points outside it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'longleash-outside-'))
    const link = join(h.root, 'escape')
    symlinkSync(outside, link)
    try {
      await expect(h.manager.startSession({ agent: 'claude', cwd: link, prompt: 'x' })).rejects.toThrow(/not allowed/i)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a cwd that does not exist', async () => {
    await expect(
      h.manager.startSession({ agent: 'claude', cwd: join(h.root, 'nope'), prompt: 'x' }),
    ).rejects.toThrow(SessionError)
  })

  it('refuses an unknown agent kind', async () => {
    await expect(
      h.manager.startSession({ agent: 'gemini', cwd: h.root, prompt: 'x' }),
    ).rejects.toThrow(/no adapter/i)
  })

  it('refuses an empty prompt', async () => {
    await expect(h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: '  ' })).rejects.toThrow(SessionError)
  })
})

describe('streaming', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('turns agent output into stream.delta events and ends cleanly', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    h.agent.say('hello ')
    h.agent.say('world')
    h.agent.finish()
    await h.manager.waitForIdle(sessionId)

    const events = eventsOf(h.log, sessionId)
    const texts = events.filter((e) => e.type === 'stream.delta').map((e) => (e.payload as { text: string }).text)
    expect(texts).toEqual(['hello ', 'world'])
    expect(events[events.length - 1]?.type).toBe('session.ended')
  })

  it('records session.errored when the agent dies mid-stream', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    h.agent.say('partial output')
    h.agent.fail('agent process exploded')
    await h.manager.waitForIdle(sessionId)

    const events = eventsOf(h.log, sessionId)
    const last = events[events.length - 1]
    expect(last?.type).toBe('session.errored')
    if (last?.type === 'session.errored') expect(last.payload.message).toContain('exploded')
    // The partial output before the crash is not lost.
    expect(events.some((e) => e.type === 'stream.delta')).toBe(true)
  })

  it('marks the session ended in the session list once finished', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    expect(h.manager.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('running')
    h.agent.finish()
    await h.manager.waitForIdle(sessionId)
    expect(h.manager.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('ended')
  })
})

describe('approvals', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('a tool request becomes a pending approval plus an event, and the agent waits', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    const pending = h.agent.requestTool('Write', { file_path: '/tmp/a.ts', content: 'x' })
    await h.manager.waitForApproval(sessionId)

    const inbox = h.manager.listPendingApprovals()
    expect(inbox).toHaveLength(1)
    expect(inbox[0]?.toolName).toBe('Write')
    expect(inbox[0]?.sessionId).toBe(sessionId)
    expect(typesOf(h.log, sessionId)).toContain('approval.requested')

    // The agent is genuinely blocked until a decision arrives.
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)

    h.manager.decide(inbox[0]!.approvalId, 'allow', 'dev_phone')
    expect(await pending).toMatchObject({ behavior: 'allow' })
  })

  it('denying carries the steering reply back to the agent', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    const pending = h.agent.requestTool('Bash', { command: 'rm -rf /' })
    await h.manager.waitForApproval(sessionId)
    const approvalId = h.manager.listPendingApprovals()[0]!.approvalId

    h.manager.decide(approvalId, 'deny', 'dev_phone', 'absolutely not, use the staging script')
    const decision = await pending
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') expect(decision.message).toContain('staging')

    const decided = eventsOf(h.log, sessionId).find((e) => e.type === 'approval.decided')
    expect(decided?.payload).toMatchObject({ verdict: 'deny', decidedBy: 'dev_phone' })
  })

  it('a second decision on the same approval is a no-op, not a double-resolve', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    const pending = h.agent.requestTool('Write')
    await h.manager.waitForApproval(sessionId)
    const approvalId = h.manager.listPendingApprovals()[0]!.approvalId

    expect(h.manager.decide(approvalId, 'allow', 'dev_a')).toBe('decided')
    expect(h.manager.decide(approvalId, 'deny', 'dev_b')).toBe('already-decided')
    expect(await pending).toMatchObject({ behavior: 'allow' })

    const decidedEvents = eventsOf(h.log, sessionId).filter((e) => e.type === 'approval.decided')
    expect(decidedEvents).toHaveLength(1)
  })

  it('an unknown approval id is reported, never silently swallowed', () => {
    expect(h.manager.decide('apr_ghost', 'allow', 'dev_phone')).toBe('unknown')
  })

  it('an expired approval auto-denies the agent so it cannot hang forever', async () => {
    const short = makeHarness({ approvalTtlMs: 60_000 })
    try {
      const { sessionId } = await short.manager.startSession({ agent: 'claude', cwd: short.root, prompt: 'x' })
      const pending = short.agent.requestTool('Write')
      await short.manager.waitForApproval(sessionId)
      const approvalId = short.manager.listPendingApprovals()[0]!.approvalId

      clock += 60_001
      short.manager.sweepExpiredApprovals()

      const decision = await pending
      expect(decision.behavior).toBe('deny')
      expect(short.manager.listPendingApprovals()).toHaveLength(0)
      expect(short.manager.decide(approvalId, 'allow', 'dev_phone')).toBe('already-decided')
      const decided = eventsOf(short.log, sessionId).find((e) => e.type === 'approval.decided')
      expect(decided?.payload).toMatchObject({ verdict: 'deny', decidedBy: 'system:expired' })
    } finally {
      rmSync(short.dir, { recursive: true, force: true })
      short.log.close()
      short.approvals.close()
    }
  })

  it('approvals survive in storage so a reconnecting phone still sees the inbox', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    void h.agent.requestTool('Write')
    await h.manager.waitForApproval(sessionId)
    const stored = h.approvals.listPending()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.inputSummary).toContain('Write')
  })
})

describe('path guard: tools targeting outside the allowlisted roots', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('marks a tool whose path is inside the root as safe, with the resolved path', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    void h.agent.requestTool('Write', { file_path: join(h.root, 'ok.ts') })
    await h.manager.waitForApproval(sessionId)
    const approval = h.manager.listPendingApprovals()[0]!
    expect(approval.targetPath).toBe(join(h.root, 'ok.ts'))
    expect(approval.outsideRoot).toBe(false)
  })

  it('FLAGS a tool whose path escapes every allowlisted root', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    void h.agent.requestTool('Write', { file_path: '/tmp/escape.txt' })
    await h.manager.waitForApproval(sessionId)
    const approval = h.manager.listPendingApprovals()[0]!
    expect(approval.outsideRoot).toBe(true)
    const event = eventsOf(h.log, sessionId).find((e) => e.type === 'approval.requested')
    expect(event?.payload).toMatchObject({ outsideRoot: true })
  })

  it('flags ../ traversal dressed up as a relative path', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    void h.agent.requestTool('Write', { file_path: '../../etc/passwd' })
    await h.manager.waitForApproval(sessionId)
    expect(h.manager.listPendingApprovals()[0]!.outsideRoot).toBe(true)
  })

  it('resolves a bare relative path against the session cwd, not the daemon process cwd', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    void h.agent.requestTool('Write', { file_path: 'notes.md' })
    await h.manager.waitForApproval(sessionId)
    const approval = h.manager.listPendingApprovals()[0]!
    expect(approval.targetPath).toBe(join(h.root, 'notes.md'))
    expect(approval.outsideRoot).toBe(false)
  })

  it('with denyOutsideRoot the agent is refused immediately, with no approval shown to a human', async () => {
    const strict = makeHarness({ denyOutsideRoot: true })
    try {
      const { sessionId } = await strict.manager.startSession({
        agent: 'claude',
        cwd: strict.root,
        prompt: 'x',
      })
      const decision = await strict.agent.requestTool('Write', { file_path: '/tmp/nope.txt' })
      expect(decision.behavior).toBe('deny')
      if (decision.behavior === 'deny') expect(decision.message).toMatch(/outside/i)
      expect(strict.manager.listPendingApprovals()).toHaveLength(0)
      const blocked = eventsOf(strict.log, sessionId).find((e) => e.type === 'approval.decided')
      expect(blocked?.payload).toMatchObject({ verdict: 'deny', decidedBy: 'system:outside-root' })
    } finally {
      rmSync(strict.dir, { recursive: true, force: true })
      strict.log.close()
      strict.approvals.close()
    }
  })

  it('does not pretend to understand shell commands: a Bash tool has no target path', async () => {
    const strict = makeHarness({ denyOutsideRoot: true })
    try {
      const { sessionId } = await strict.manager.startSession({
        agent: 'claude',
        cwd: strict.root,
        prompt: 'x',
      })
      void strict.agent.requestTool('Bash', { command: 'echo hi > /tmp/sneaky.txt' })
      await strict.manager.waitForApproval(sessionId)
      const approval = strict.manager.listPendingApprovals()[0]!
      // Honest: we do not parse shell syntax, so this still reaches the human to decide.
      expect(approval.targetPath).toBeNull()
      expect(approval.outsideRoot).toBe(false)
    } finally {
      rmSync(strict.dir, { recursive: true, force: true })
      strict.log.close()
      strict.approvals.close()
    }
  })
})

describe('activity feed for auto-approved tools', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('records tools that never asked permission (spike S0 finding)', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    h.agent.reportAutoApproved('Read', { file_path: 'a.ts' })
    await new Promise((r) => setTimeout(r, 10))

    const activity = eventsOf(h.log, sessionId).find((e) => e.type === 'activity.tool')
    expect(activity).toBeDefined()
    expect(activity?.payload).toMatchObject({ toolName: 'Read', autoApproved: true })
    // It must NOT masquerade as something awaiting a decision.
    expect(h.manager.listPendingApprovals()).toHaveLength(0)
  })
})

describe('hardening: stop, limits, origin, audit (audit A1-A6)', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('a running agent can be stopped from the phone', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    h.agent.say('working…')
    expect(await h.manager.stopSession(sessionId, 'dev_phone')).toBe(true)
    await h.manager.waitForIdle(sessionId)
    expect(h.manager.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('ended')
  })

  it('stopping releases an agent blocked on an approval instead of leaving it hanging', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    const pending = h.agent.requestTool('Write')
    await h.manager.waitForApproval(sessionId)

    await h.manager.stopSession(sessionId, 'dev_phone')
    expect(await pending).toMatchObject({ behavior: 'deny' })
    expect(h.manager.listPendingApprovals()).toHaveLength(0)
  })

  it('stopping an unknown or already-finished session is a no-op, not a crash', async () => {
    expect(await h.manager.stopSession('ses_ghost', 'dev_phone')).toBe(false)
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    h.agent.finish()
    await h.manager.waitForIdle(sessionId)
    expect(await h.manager.stopSession(sessionId, 'dev_phone')).toBe(false)
  })

  it('refuses to exceed the concurrent session cap', async () => {
    const capped = makeHarness({ maxConcurrentSessions: 2 })
    try {
      await capped.manager.startSession({ agent: 'claude', cwd: capped.root, prompt: 'one' })
      await capped.manager.startSession({ agent: 'claude', cwd: capped.root, prompt: 'two' })
      await expect(
        capped.manager.startSession({ agent: 'claude', cwd: capped.root, prompt: 'three' }),
      ).rejects.toThrow(/too many/i)
    } finally {
      rmSync(capped.dir, { recursive: true, force: true })
      capped.log.close()
      capped.approvals.close()
    }
  })

  it('a finished session frees a slot', async () => {
    const capped = makeHarness({ maxConcurrentSessions: 1 })
    try {
      const first = await capped.manager.startSession({ agent: 'claude', cwd: capped.root, prompt: 'one' })
      capped.agent.finish()
      await capped.manager.waitForIdle(first.sessionId)
      await expect(
        capped.manager.startSession({ agent: 'claude', cwd: capped.root, prompt: 'two' }),
      ).resolves.toBeDefined()
    } finally {
      rmSync(capped.dir, { recursive: true, force: true })
      capped.log.close()
      capped.approvals.close()
    }
  })

  it('records where a session came from so the phone can say "started from your phone"', async () => {
    const { sessionId } = await h.manager.startSession({
      agent: 'claude',
      cwd: h.root,
      prompt: 'x',
      origin: 'phone',
    })
    expect(h.manager.listSessions().find((s) => s.sessionId === sessionId)?.origin).toBe('phone')
    const started = eventsOf(h.log, sessionId)[0]
    expect(started?.payload).toMatchObject({ origin: 'phone' })
  })

  it('defaults an unspecified origin to the daemon rather than guessing', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    expect(h.manager.listSessions().find((s) => s.sessionId === sessionId)?.origin).toBe('daemon')
  })

  it('writes an audit entry for every mutating operation, attributed to a device', async () => {
    const { sessionId } = await h.manager.startSession({
      agent: 'claude',
      cwd: h.root,
      prompt: 'x',
      origin: 'phone',
      actor: 'dev_phone1',
    })
    void h.agent.requestTool('Write')
    await h.manager.waitForApproval(sessionId)
    h.manager.decide(h.manager.listPendingApprovals()[0]!.approvalId, 'allow', 'dev_phone1')
    await h.manager.stopSession(sessionId, 'dev_phone1')

    const entries = h.manager.listAuditEntries()
    expect(entries.map((e) => e.action)).toEqual(['session.start', 'approval.decide', 'session.stop'])
    expect(entries.every((e) => e.actor === 'dev_phone1')).toBe(true)
    expect(entries[0]?.detail).toContain(h.root)
  })

  it('audit entries survive so a stolen-device review is possible after the fact', async () => {
    await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x', actor: 'dev_a' })
    await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'y', actor: 'dev_b' })
    const rows = h.approvals.rawDb.prepare('SELECT actor FROM audit ORDER BY at ASC').all() as {
      actor: string
    }[]
    expect(rows.map((r) => r.actor)).toEqual(['dev_a', 'dev_b'])
  })
})

describe('conversations: a session is a dialogue, not a one-shot', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('a finished turn leaves the session alive and waiting, not ended', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'hi' })
    h.agent.say('hello there')
    h.agent.endTurn()
    await new Promise((r) => setTimeout(r, 20))

    expect(h.manager.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('waiting')
    const types = typesOf(h.log, sessionId)
    expect(types).not.toContain('session.ended')
    expect(types).toContain('session.status')
  })

  it('a follow-up reaches the same agent and keeps one transcript', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'hi' })
    h.agent.say('first answer')
    h.agent.endTurn()
    await new Promise((r) => setTimeout(r, 20))

    expect(h.manager.sendMessage(sessionId, 'now do the next thing', 'dev_phone')).toBe(true)
    expect(h.agent.received).toEqual(['now do the next thing'])

    h.agent.say('second answer')
    await new Promise((r) => setTimeout(r, 20))
    const text = eventsOf(h.log, sessionId)
      .filter((e) => e.type === 'stream.delta')
      .map((e) => (e.payload as { text: string }).text)
      .join('')
    // One conversation: both answers and the human's message live in the same session.
    expect(text).toContain('first answer')
    expect(text).toContain('now do the next thing')
    expect(text).toContain('second answer')
    expect(h.manager.listSessions()).toHaveLength(1)
  })

  it('shows the human message in the transcript so the phone reads like a conversation', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'hi' })
    h.manager.sendMessage(sessionId, 'follow up', 'dev_phone')
    const userDelta = eventsOf(h.log, sessionId).find(
      (e) => e.type === 'stream.delta' && (e.payload as { kind: string }).kind === 'user',
    )
    expect((userDelta?.payload as { text: string }).text).toContain('follow up')
  })

  it('refuses an empty follow-up', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'hi' })
    expect(h.manager.sendMessage(sessionId, '   ', 'dev_phone')).toBe(false)
    expect(h.agent.received).toHaveLength(0)
  })

  it('refuses a follow-up to an unknown or finished session instead of losing it silently', async () => {
    expect(h.manager.sendMessage('ses_ghost', 'hello?', 'dev_phone')).toBe(false)
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'hi' })
    h.agent.finish()
    await h.manager.waitForIdle(sessionId)
    expect(h.manager.sendMessage(sessionId, 'too late', 'dev_phone')).toBe(false)
  })

  it('a waiting session can still be stopped', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'hi' })
    h.agent.endTurn()
    await new Promise((r) => setTimeout(r, 20))
    expect(await h.manager.stopSession(sessionId, 'dev_phone')).toBe(true)
  })

  it('records follow-ups in the audit trail', async () => {
    const { sessionId } = await h.manager.startSession({
      agent: 'claude',
      cwd: h.root,
      prompt: 'hi',
      actor: 'dev_phone',
    })
    h.manager.sendMessage(sessionId, 'keep going', 'dev_phone')
    expect(h.manager.listAuditEntries().map((e) => e.action)).toContain('message.send')
  })
})

describe('single-writer discipline', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('refuses to attach a second driver to a live session', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    expect(() => h.manager.claimSession(sessionId)).toThrow(/already/i)
  })

  it('releases the claim once the session ends', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    h.agent.finish()
    await h.manager.waitForIdle(sessionId)
    expect(() => h.manager.claimSession(sessionId)).not.toThrow()
  })
})

describe('reopening a closed session', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  const closeIt = async (sessionId: string) => {
    h.agent.finish()
    await h.manager.waitForIdle(sessionId)
  }

  it('reopens a finished session and continues the SAME transcript', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'first' })
    h.agent.say('original answer')
    await closeIt(sessionId)
    expect(h.manager.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('ended')

    expect(await h.manager.resumeSession(sessionId, 'dev_phone')).toBe(true)
    expect(h.manager.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('running')
    // The agent was asked to resume its own prior conversation, not start a blank one.
    expect(h.agent.runs[1]).toBe('claude_1')

    h.agent.say('continued answer')
    await new Promise((r) => setTimeout(r, 20))
    const text = eventsOf(h.log, sessionId)
      .filter((e) => e.type === 'stream.delta')
      .map((e) => (e.payload as { text: string }).text)
      .join('')
    expect(text).toContain('original answer')
    expect(text).toContain('continued answer')
    // One session, not a copy.
    expect(h.manager.listSessions()).toHaveLength(1)
  })

  it('accepts follow-up messages again once reopened', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    await closeIt(sessionId)
    expect(h.manager.sendMessage(sessionId, 'too early', 'dev_phone')).toBe(false)

    await h.manager.resumeSession(sessionId, 'dev_phone')
    expect(h.manager.sendMessage(sessionId, 'now it works', 'dev_phone')).toBe(true)
    expect(h.agent.received).toContain('now it works')
  })

  it('refuses to reopen a session that is already running', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    expect(await h.manager.resumeSession(sessionId, 'dev_phone')).toBe(false)
  })

  it('refuses an unknown session', async () => {
    expect(await h.manager.resumeSession('ses_ghost', 'dev_phone')).toBe(false)
  })

  it('re-checks the directory, so a root removed from the allowlist cannot be reopened', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    await closeIt(sessionId)

    const narrowed = new SessionManager({
      eventLog: h.log,
      approvals: h.approvals,
      allowedRoots: [mkdtempSync(join(tmpdir(), 'longleash-other-'))],
      agentFactories: { claude: new FakeAgent().factory },
      now: () => clock,
    })
    expect(await narrowed.resumeSession(sessionId, 'dev_phone')).toBe(false)
  })

  it('records reopening in the audit trail', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    await closeIt(sessionId)
    await h.manager.resumeSession(sessionId, 'dev_phone')
    expect(h.manager.listAuditEntries().map((e) => e.action)).toContain('session.resume')
  })
})

describe('sessions survive a reload (and a daemon restart)', () => {
  let h: Harness
  beforeEach(() => {
    clock = 1_000_000
    h = makeHarness()
  })
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true })
    h.log.close()
    h.approvals.close()
  })

  it('lists a session with everything a phone needs to rebuild its view', async () => {
    const { sessionId } = await h.manager.startSession({
      agent: 'claude',
      cwd: h.root,
      prompt: 'fix the parser',
      origin: 'phone',
    })
    const listed = h.manager.listSessions().find((s) => s.sessionId === sessionId)
    expect(listed).toMatchObject({ agent: 'claude', cwd: h.root, origin: 'phone', status: 'running' })
    expect(listed?.title).toBe('fix the parser')
  })

  it('keeps finished sessions in the list so history does not vanish', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    h.agent.finish()
    await h.manager.waitForIdle(sessionId)
    expect(h.manager.listSessions().map((s) => s.sessionId)).toContain(sessionId)
  })

  it('a fresh manager on the same storage still lists earlier sessions', async () => {
    const { sessionId } = await h.manager.startSession({
      agent: 'claude',
      cwd: h.root,
      prompt: 'earlier work',
      origin: 'phone',
    })
    h.agent.finish()
    await h.manager.waitForIdle(sessionId)

    // Simulates the daemon being restarted: same databases, new process state.
    const revived = new SessionManager({
      eventLog: h.log,
      approvals: h.approvals,
      allowedRoots: [h.root],
      agentFactories: { claude: new FakeAgent().factory },
      now: () => clock,
    })
    const listed = revived.listSessions().find((s) => s.sessionId === sessionId)
    expect(listed).toBeDefined()
    expect(listed?.title).toBe('earlier work')
    expect(listed?.origin).toBe('phone')
  })

  it('marks sessions that a crashed daemon left running as ended, never as still working', async () => {
    await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'was running' })

    const revived = new SessionManager({
      eventLog: h.log,
      approvals: h.approvals,
      allowedRoots: [h.root],
      agentFactories: { claude: new FakeAgent().factory },
      now: () => clock,
    })
    const statuses = revived.listSessions().map((s) => s.status)
    expect(statuses).not.toContain('running')
    expect(statuses).toContain('ended')
  })

  it('a revived session cannot be messaged, because its agent is gone', async () => {
    const { sessionId } = await h.manager.startSession({ agent: 'claude', cwd: h.root, prompt: 'x' })
    const revived = new SessionManager({
      eventLog: h.log,
      approvals: h.approvals,
      allowedRoots: [h.root],
      agentFactories: { claude: new FakeAgent().factory },
      now: () => clock,
    })
    expect(revived.sendMessage(sessionId, 'still there?', 'dev_phone')).toBe(false)
    expect(await revived.stopSession(sessionId, 'dev_phone')).toBe(false)
  })
})

describe('restart recovery', () => {
  it('approvals left pending by a crashed daemon are closed out, not left hanging', () => {
    const approvals = new ApprovalStore(':memory:', { now: () => clock })
    approvals.create({
      approvalId: 'apr_orphan',
      sessionId: 'ses_old',
      toolName: 'Write',
      inputSummary: 'Write a.ts',
      expiresAt: clock + 60_000,
    })
    expect(approvals.listPending()).toHaveLength(1)

    const orphans = approvals.closeOrphans('daemon restarted')
    expect(orphans).toEqual(['apr_orphan'])
    expect(approvals.listPending()).toHaveLength(0)
    approvals.close()
  })
})
