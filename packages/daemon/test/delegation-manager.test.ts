import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentFactory, AgentRunRequest, AgentStreamMessage } from '../src/agent.js'
import { ApprovalStore } from '../src/approvals.js'
import { BriefingBuilder } from '../src/briefing.js'
import {
  DelegationManager,
  DelegationManagerError,
  type StartDelegationInput,
} from '../src/delegation-manager.js'
import { DelegationStore } from '../src/delegations.js'
import { EventLog } from '../src/eventlog.js'
import { SessionManager, type SessionListing } from '../src/sessions.js'
import { ReturnBuilder } from '../src/return-builder.js'
import { WorkspaceLeaseManager } from '../src/workspace-leases.js'

class ControlledRun {
  private ended = false
  private wake: (() => void) | null = null
  private readonly queue: AgentStreamMessage[] = []

  complete(text: string): void {
    this.queue.push({ type: 'text', text }, { type: 'turn-end' })
    this.wake?.()
    this.wake = null
  }

  finish(): void {
    this.ended = true
    this.wake?.()
    this.wake = null
  }

  async *events(): AsyncGenerator<AgentStreamMessage> {
    while (!this.ended || this.queue.length > 0) {
      while (this.queue.length > 0) yield this.queue.shift()!
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}

class ControlledAgent {
  readonly requests: AgentRunRequest[] = []
  readonly runs: ControlledRun[] = []
  readonly messages: string[] = []

  readonly factory: AgentFactory = (request) => {
    this.requests.push(request)
    const run = new ControlledRun()
    this.runs.push(run)
    queueMicrotask(() => request.onAgentSession(`native_${this.requests.length}`))
    return {
      events: run.events(),
      sendMessage: (text) => this.messages.push(text),
      interrupt: async () => run.finish(),
    }
  }
}

interface Harness {
  root: string
  log: EventLog
  approvals: ApprovalStore
  store: DelegationStore
  sessions: SessionManager
  manager: DelegationManager
  source: SessionListing
  claude: ControlledAgent
  codex: ControlledAgent
  close: () => Promise<void>
}

const open: Harness[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()))
})

function makeHarness(opts: {
  sourceAgent?: 'claude' | 'codex'
  sourceDepth?: number
  agents?: Array<'claude' | 'codex'>
  maxActivePerSource?: number
  throwingAgent?: 'claude' | 'codex'
  workspace?: boolean
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'longleash-delegate-'))
  const root = realpathSync(dir)
  const log = new EventLog(':memory:')
  const approvals = new ApprovalStore(':memory:')
  const store = new DelegationStore(approvals.rawDb)
  const workspace = opts.workspace ? new WorkspaceLeaseManager(approvals.rawDb) : undefined
  const claude = new ControlledAgent()
  const codex = new ControlledAgent()
  const enabled = new Set(opts.agents ?? ['claude', 'codex'])
  const throwingFactory: AgentFactory = () => {
    throw new Error('vendor process refused startup')
  }
  let manager: DelegationManager | undefined
  const sessions = new SessionManager({
    eventLog: log,
    approvals,
    allowedRoots: [root],
    agentFactories: {
      ...(enabled.has('claude')
        ? { claude: opts.throwingAgent === 'claude' ? throwingFactory : claude.factory }
        : {}),
      ...(enabled.has('codex')
        ? { codex: opts.throwingAgent === 'codex' ? throwingFactory : codex.factory }
        : {}),
    },
    ...(workspace === undefined ? {} : { workspace }),
    onEvent: (event) => manager?.handleSessionEvent(event),
  })
  const source: SessionListing = {
    sessionId: 'ses_source',
    agent: opts.sourceAgent ?? 'claude',
    cwd: root,
    status: 'ended',
    startedAt: 1,
    origin: 'vscode',
    title: 'Repair pairing lifecycle',
    live: false,
    resumable: true,
    ...(opts.sourceDepth === undefined
      ? {}
      : {
          relationship: {
            delegationId: 'del_parent',
            parentSessionId: 'ses_grandparent',
            role: 'review' as const,
            depth: opts.sourceDepth,
          },
        }),
  }
  log.appendBatch(source.sessionId, [
    {
      type: 'session.started',
      payload: {
        agent: source.agent,
        cwd: source.cwd,
        title: source.title,
        origin: source.origin,
        ...(source.relationship === undefined ? {} : { relationship: source.relationship }),
      },
    },
    { type: 'stream.delta', payload: { kind: 'user', text: '\n\n› Verify the pairing fix.\n' } },
  ])
  manager = new DelegationManager({
    store,
    sessions,
    briefings: new BriefingBuilder(log),
    sourceSessions: () => [source, ...sessions.listSessions()],
    returns: new ReturnBuilder(log),
    ...(workspace === undefined
      ? {}
      : {
          workspace,
          pauseSession: (session: SessionListing, actor: string, reason: string) =>
            sessions.pauseSession(session.sessionId, actor, reason),
        }),
    ...(opts.maxActivePerSource === undefined ? {} : { maxActivePerSource: opts.maxActivePerSource }),
  })
  const harness: Harness = {
    root,
    log,
    approvals,
    store,
    sessions,
    manager,
    source,
    claude,
    codex,
    close: async () => {
      await sessions.shutdown()
      log.close()
      approvals.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  open.push(harness)
  return harness
}

function request(extra: Partial<StartDelegationInput> = {}): StartDelegationInput {
  return {
    idempotencyKey: 'tap-1',
    sourceSessionId: 'ses_source',
    targetAgent: 'codex',
    role: 'review',
    contextScope: 'recent',
    briefing: '\nUSER-EDITED EXACT BRIEFING\n',
    createdBy: 'dev_phone',
    ...extra,
  }
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  throw last
}

describe.each([
  ['claude', 'claude'],
  ['claude', 'codex'],
  ['codex', 'claude'],
  ['codex', 'codex'],
] as const)('%s → %s delegation', (sourceAgent, targetAgent) => {
  it('launches once through the ordinary runner with exact prompt and durable attribution', async () => {
    const h = makeHarness({ sourceAgent })
    const result = await h.manager.start(request({ targetAgent }))
    const target = targetAgent === 'claude' ? h.claude : h.codex

    expect(result).toMatchObject({ created: true, delegation: { status: 'running', depth: 1 } })
    expect(target.requests).toHaveLength(1)
    expect(target.requests[0]?.prompt).toBe('\nUSER-EDITED EXACT BRIEFING\n')
    expect(target.requests[0]?.cwd).toBe(h.root)
    expect(h.sessions.listSessions().find((session) => session.sessionId === result.delegation.targetSessionId))
      .toMatchObject({
        agent: targetAgent,
        title: 'Review · Repair pairing lifecycle',
        relationship: {
          delegationId: result.delegation.delegationId,
          parentSessionId: 'ses_source',
          role: 'review',
          depth: 1,
        },
      })

    target.runs[0]?.finish()
    await eventually(() => expect(h.manager.list()[0]?.status).toBe('ready'))
  })

  it('passes reviewed child model controls through the ordinary attributed runner', async () => {
    const h = makeHarness({ sourceAgent })
    const result = await h.manager.start(request({
      targetAgent,
      settings: targetAgent === 'claude'
        ? { model: 'opus', effort: 'high', thinking: { mode: 'adaptive' } }
        : { model: 'gpt-5.6', effort: 'high' },
    }))
    const target = targetAgent === 'claude' ? h.claude : h.codex
    expect(target.requests[0]?.settings).toEqual(result.delegation.settings)
  })
})

describe('launch integrity and recovery', () => {
  it('converges concurrent double delivery and later reconnect retry on one child', async () => {
    const h = makeHarness()
    const [first, duplicate] = await Promise.all([
      h.manager.start(request()),
      h.manager.start(request()),
    ])
    const replay = await h.manager.start(request())
    expect(h.codex.requests).toHaveLength(1)
    expect(duplicate.delegation.delegationId).toBe(first.delegation.delegationId)
    expect(replay.delegation.targetSessionId).toBe(first.delegation.targetSessionId)
    expect(replay.created).toBe(false)
  })

  it('rejects an idempotency key reused for changed work', async () => {
    const h = makeHarness()
    await h.manager.start(request())
    await expect(h.manager.start(request({ briefing: 'different briefing' }))).rejects.toMatchObject({
      reason: 'idempotency-conflict',
    })
    expect(h.codex.requests).toHaveLength(1)
  })

  it('derives depth from the source and refuses a third edge', async () => {
    const h = makeHarness({ sourceDepth: 2 })
    await expect(h.manager.start(request())).rejects.toMatchObject({ reason: 'max-depth' })
    expect(h.codex.requests).toHaveLength(0)
  })

  it('prefers the live external driver over a dormant row with the same stable session id', async () => {
    const h = makeHarness({ sourceDepth: 2 })
    const liveSource: SessionListing = {
      sessionId: h.source.sessionId,
      agent: h.source.agent,
      cwd: h.source.cwd,
      startedAt: h.source.startedAt,
      title: h.source.title,
      status: 'running',
      origin: 'terminal',
      live: true,
      resumable: false,
    }
    const manager = new DelegationManager({
      store: h.store,
      sessions: h.sessions,
      briefings: new BriefingBuilder(h.log),
      sourceSessions: () => [h.source, liveSource, ...h.sessions.listSessions()],
    })
    await expect(manager.start(request())).resolves.toMatchObject({
      delegation: { depth: 1, status: 'running' },
    })
    expect(h.codex.requests).toHaveLength(1)
  })

  it('enforces the per-parent active-child cap before creating another record', async () => {
    const h = makeHarness({ maxActivePerSource: 1 })
    await h.manager.start(request())
    await expect(h.manager.start(request({ idempotencyKey: 'tap-2' }))).rejects.toMatchObject({
      reason: 'too-many-delegations',
    })
    expect(h.manager.list()).toHaveLength(1)
  })

  it('refuses an unavailable target before persisting or spawning', async () => {
    const h = makeHarness({ agents: ['claude'] })
    await expect(h.manager.start(request({ targetAgent: 'codex' }))).rejects.toMatchObject({
      reason: 'target-unavailable',
    })
    expect(h.manager.list()).toEqual([])
  })

  it('records a synchronous vendor launch failure and closes the phantom session', async () => {
    const h = makeHarness({ throwingAgent: 'codex' })
    await expect(h.manager.start(request())).rejects.toBeInstanceOf(DelegationManagerError)
    expect(h.manager.list()[0]).toMatchObject({ status: 'failed', failure: 'vendor process refused startup' })
    expect(h.sessions.listSessions()[0]).toMatchObject({ status: 'errored', live: false })
  })

  it('maps an independent child Stop to cancellation without touching its parent', async () => {
    const h = makeHarness()
    const started = await h.manager.start(request())
    await h.sessions.stopSession(started.delegation.targetSessionId!, 'dev_phone')
    expect(h.manager.list()[0]?.status).toBe('cancelled')
    expect(h.source.status).toBe('ended')
    expect(h.sessions.listAuditEntries().map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'delegation.create',
        'delegation.start',
        'delegation.attach',
        'session.start',
        'session.stop',
        'delegation.cancel',
      ]),
    )
  })

  it('prepares the last completed child turn, delivers an edited attributed return once, and reopens the parent', async () => {
    const h = makeHarness()
    h.sessions.adoptEndedSession({
      sessionId: h.source.sessionId,
      agent: h.source.agent as 'claude',
      cwd: h.source.cwd,
      title: h.source.title,
      origin: h.source.origin,
      startedAt: h.source.startedAt,
      agentSessionId: 'native_parent',
    })
    const started = await h.manager.start(request())
    h.codex.runs[0]!.complete('Child result before review.')
    await eventually(() => expect(h.manager.list()[0]?.status).toBe('ready'))

    const preview = h.manager.prepareReturn(started.delegation.delegationId)
    expect(preview).toMatchObject({
      returnText: 'Child result before review.',
      requiresTakeover: false,
      parent: { sessionId: 'ses_source' },
      child: { sessionId: started.delegation.targetSessionId },
    })

    const returned = await h.manager.returnDelegation({
      delegationId: started.delegation.delegationId,
      idempotencyKey: 'return-op-1',
      returnText: '\nUser-edited exact return.\n',
      takeoverConfirmed: false,
      actor: 'dev_phone',
    })
    const retry = await h.manager.returnDelegation({
      delegationId: started.delegation.delegationId,
      idempotencyKey: 'return-op-1',
      returnText: '\nUser-edited exact return.\n',
      takeoverConfirmed: false,
      actor: 'dev_phone',
    })
    expect(returned).toMatchObject({ created: true, delegation: { status: 'returned' } })
    expect(retry).toMatchObject({ created: false, delegation: { status: 'returned' } })
    expect(h.claude.requests).toHaveLength(1)
    expect(h.claude.requests[0]!.resume).toBe('native_parent')
    expect(h.claude.requests[0]!.prompt).toBe(
      `Returned from Codex · Review\nChild session: Review · Repair pairing lifecycle\nDelegation: ${started.delegation.delegationId}\n\n\nUser-edited exact return.\n`,
    )
  })

  it('does not mistake historical VS Code origin for the current managed controller', async () => {
    const h = makeHarness()
    const started = await h.manager.start(request())
    h.codex.runs[0]!.complete('Managed child result.')
    await eventually(() => expect(h.manager.list()[0]?.status).toBe('ready'))

    h.source.live = true
    h.source.status = 'waiting'
    h.source.controller = 'longleash'
    expect(h.manager.prepareReturn(started.delegation.delegationId).requiresTakeover).toBe(false)
  })

  it('stops a reviewed return when structured pause evidence says the child still owns it', async () => {
    const h = makeHarness({ workspace: true })
    h.sessions.adoptEndedSession({
      sessionId: h.source.sessionId,
      agent: 'claude',
      cwd: h.source.cwd,
      title: h.source.title,
      origin: h.source.origin,
      startedAt: h.source.startedAt,
      agentSessionId: 'native_parent',
    })
    const started = await h.manager.start(request())
    h.codex.runs[0]!.complete('Guarded child result.')
    await eventually(() => expect(h.manager.list()[0]?.status).toBe('ready'))

    const workspace = new WorkspaceLeaseManager(h.approvals.rawDb)
    const guarded = new DelegationManager({
      store: h.store,
      sessions: h.sessions,
      briefings: new BriefingBuilder(h.log),
      returns: new ReturnBuilder(h.log),
      workspace,
      sourceSessions: () => [h.source, ...h.sessions.listSessions()],
      pauseSession: async () => ({
        paused: false,
        message: 'The child process is still verified live; no return was delivered.',
      }),
    })
    await expect(guarded.returnDelegation({
      delegationId: started.delegation.delegationId,
      idempotencyKey: 'guarded-return',
      returnText: 'Do not deliver this.',
      takeoverConfirmed: false,
      actor: 'dev_phone',
    })).rejects.toMatchObject({
      reason: 'delivery-failed',
      message: 'The child process is still verified live; no return was delivered.',
    })
    expect(h.claude.requests).toHaveLength(0)
    expect(h.manager.list()[0]?.status).toBe('ready')
    expect(workspace.getByCwd(h.root)?.ownerId).toBe(started.delegation.targetSessionId)
  })

  it('serializes simultaneous returns so one reviewed message crosses the async handoff boundary', async () => {
    const h = makeHarness({ workspace: true })
    h.sessions.adoptEndedSession({
      sessionId: h.source.sessionId,
      agent: 'claude',
      cwd: h.source.cwd,
      title: h.source.title,
      origin: h.source.origin,
      startedAt: h.source.startedAt,
      agentSessionId: 'native_parent',
    })
    const started = await h.manager.start(request())
    h.codex.runs[0]!.complete('Concurrent child result.')
    await eventually(() => expect(h.manager.list()[0]?.status).toBe('ready'))

    const operation = {
      delegationId: started.delegation.delegationId,
      idempotencyKey: 'same-return-operation',
      returnText: 'One reviewed return.',
      takeoverConfirmed: false,
      actor: 'dev_phone',
    }
    const [first, replay] = await Promise.all([
      h.manager.returnDelegation(operation),
      h.manager.returnDelegation(operation),
    ])
    expect([first.created, replay.created].sort()).toEqual([false, true])
    expect(h.claude.requests).toHaveLength(1)
    expect(h.claude.messages).toEqual([])
  })

  it('rejects a simultaneous changed return before it can inject a second parent message', async () => {
    const h = makeHarness({ workspace: true })
    h.sessions.adoptEndedSession({
      sessionId: h.source.sessionId,
      agent: 'claude',
      cwd: h.source.cwd,
      title: h.source.title,
      origin: h.source.origin,
      startedAt: h.source.startedAt,
      agentSessionId: 'native_parent',
    })
    const started = await h.manager.start(request())
    h.codex.runs[0]!.complete('Concurrent child result.')
    await eventually(() => expect(h.manager.list()[0]?.status).toBe('ready'))

    const first = h.manager.returnDelegation({
      delegationId: started.delegation.delegationId,
      idempotencyKey: 'winning-return',
      returnText: 'Winning reviewed return.',
      takeoverConfirmed: false,
      actor: 'dev_phone',
    })
    const changed = h.manager.returnDelegation({
      delegationId: started.delegation.delegationId,
      idempotencyKey: 'changed-return',
      returnText: 'Changed reviewed return.',
      takeoverConfirmed: false,
      actor: 'dev_phone',
    })
    await expect(first).resolves.toMatchObject({ delegation: { status: 'returned' }, created: true })
    await expect(changed).rejects.toMatchObject({ reason: 'idempotency-conflict' })
    expect(h.claude.requests).toHaveLength(1)
    expect(h.claude.messages).toEqual([])
  })

  it('keeps a child approval scoped to that child and resolves it through normal controls', async () => {
    const h = makeHarness()
    const started = await h.manager.start(request())
    const childId = started.delegation.targetSessionId!
    const decision = h.codex.requests[0]!.canUseTool('Write', { file_path: 'child.ts' })
    await h.sessions.waitForApproval(childId)
    const approval = h.sessions.listPendingApprovals()[0]
    expect(approval).toMatchObject({ sessionId: childId, toolName: 'Write' })
    expect(h.sessions.decide(approval!.approvalId, 'allow', 'dev_phone')).toBe('decided')
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' })
  })

  it('recovers a persisted running relationship without launching again', async () => {
    const h = makeHarness()
    const started = await h.manager.start(request())
    const restarted = new DelegationManager({
      store: new DelegationStore(h.approvals.rawDb),
      sessions: h.sessions,
      briefings: new BriefingBuilder(h.log),
      sourceSessions: () => [h.source, ...h.sessions.listSessions()],
    })
    expect(restarted.list()[0]).toMatchObject({
      status: 'running',
      targetSessionId: started.delegation.targetSessionId,
    })
    expect(h.codex.requests).toHaveLength(1)
  })

  it('treats daemon shutdown as resumable interruption, not successful delegated work', async () => {
    const h = makeHarness()
    const started = await h.manager.start(request())
    await new Promise((resolve) => setTimeout(resolve, 0))
    await h.sessions.shutdown()
    expect(h.sessions.listSessions().find((session) => session.sessionId === started.delegation.targetSessionId))
      .toMatchObject({ status: 'waiting', live: false, resumable: true })
    expect(h.manager.list()[0]?.status).toBe('running')

    const restarted = new DelegationManager({
      store: new DelegationStore(h.approvals.rawDb),
      sessions: h.sessions,
      briefings: new BriefingBuilder(h.log),
      sourceSessions: () => [h.source, ...h.sessions.listSessions()],
    })
    expect(restarted.list()[0]?.status).toBe('running')
  })

  it('answers an accepted reconnect retry even if source discovery is temporarily absent', async () => {
    const h = makeHarness()
    const started = await h.manager.start(request())
    const restarted = new DelegationManager({
      store: new DelegationStore(h.approvals.rawDb),
      sessions: h.sessions,
      briefings: new BriefingBuilder(h.log),
      sourceSessions: () => h.sessions.listSessions(),
    })
    await expect(restarted.start(request())).resolves.toMatchObject({
      created: false,
      delegation: { targetSessionId: started.delegation.targetSessionId },
    })
    expect(h.codex.requests).toHaveLength(1)
  })

  it('resets an interrupted pre-persistence launch to draft so the same key can retry', () => {
    const h = makeHarness()
    const draft = h.store.createDraft({ ...request(), depth: 1 }).record
    h.store.markStarting(draft.delegationId)
    const restarted = new DelegationManager({
      store: new DelegationStore(h.approvals.rawDb),
      sessions: h.sessions,
      briefings: new BriefingBuilder(h.log),
      sourceSessions: () => [h.source, ...h.sessions.listSessions()],
    })
    expect(restarted.list()[0]?.status).toBe('draft')
  })
})
