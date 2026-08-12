import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentFactory, AgentRunRequest, AgentStreamMessage } from '../src/agent.js'
import { ApprovalStore } from '../src/approvals.js'
import { BriefingBuilder } from '../src/briefing.js'
import { DelegationManager } from '../src/delegation-manager.js'
import { DelegationStore } from '../src/delegations.js'
import { EventLog } from '../src/eventlog.js'
import { ReturnBuilder } from '../src/return-builder.js'
import { SessionManager, type SessionListing } from '../src/sessions.js'
import { WorkspaceLeaseManager } from '../src/workspace-leases.js'

class Run {
  private readonly queue: AgentStreamMessage[] = []
  private ended = false
  private wake: (() => void) | null = null

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
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

class Agent {
  readonly requests: AgentRunRequest[] = []
  readonly runs: Run[] = []
  constructor(private readonly stopsOnInterrupt = true) {}
  readonly factory: AgentFactory = (request) => {
    this.requests.push(request)
    const run = new Run()
    this.runs.push(run)
    queueMicrotask(() => request.onAgentSession(`native_${this.requests.length}`))
    return {
      events: run.events(),
      sendMessage: () => {},
      interrupt: async () => { if (this.stopsOnInterrupt) run.finish() },
    }
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { assertion(); return } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 0)) }
  }
  throw last
}

describe('delegation workspace handoff', () => {
  it('moves one durable checkout lease parent → child → parent through the reviewed return', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-handoff-')))
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const workspace = new WorkspaceLeaseManager(approvals.rawDb)
    const claude = new Agent()
    const codex = new Agent()
    let manager: DelegationManager | undefined
    const sessions = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [dir],
      agentFactories: { claude: claude.factory, codex: codex.factory },
      workspace,
      onEvent: (event) => manager?.handleSessionEvent(event),
    })
    cleanups.push(async () => {
      await sessions.shutdown()
      log.close()
      approvals.close()
      rmSync(dir, { recursive: true, force: true })
    })

    const parentId = (await sessions.startSession({
      agent: 'claude', cwd: dir, prompt: 'Fix the parser.', origin: 'phone', actor: 'dev_phone',
    })).sessionId
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(workspace.getByCwd(dir)?.ownerId).toBe(parentId)

    manager = new DelegationManager({
      store: new DelegationStore(approvals.rawDb),
      sessions,
      briefings: new BriefingBuilder(log),
      returns: new ReturnBuilder(log),
      workspace,
      sourceSessions: () => sessions.listSessions(),
      pauseSession: (session, actor, reason) => sessions.pauseSession(session.sessionId, actor, reason),
    })
    const launched = await manager.start({
      idempotencyKey: 'launch-op-1',
      sourceSessionId: parentId,
      targetAgent: 'codex',
      role: 'review',
      contextScope: 'recent',
      briefing: 'Review the parser fix.',
      createdBy: 'dev_phone',
    })
    const childId = launched.delegation.targetSessionId!
    expect(workspace.getByCwd(dir)?.ownerId).toBe(childId)
    expect(sessions.listSessions().find((session) => session.sessionId === parentId)).toMatchObject({
      live: false, status: 'waiting', resumable: true,
    })

    codex.runs[0]!.complete('The fix is correct; add one regression test.')
    await eventually(() => expect(manager!.list()[0]?.status).toBe('ready'))
    const returned = await manager.returnDelegation({
      delegationId: launched.delegation.delegationId,
      idempotencyKey: 'return-op-1',
      returnText: 'Reviewed: add the missing regression test.',
      takeoverConfirmed: false,
      actor: 'dev_phone',
    })
    expect(returned.delegation.status).toBe('returned')
    expect(workspace.getByCwd(dir)?.ownerId).toBe(parentId)
    expect(claude.requests).toHaveLength(2)
    expect(claude.requests[1]).toMatchObject({ resume: 'native_1' })
    expect(claude.requests[1]!.prompt).toContain('Reviewed: add the missing regression test.')
    expect(sessions.listAuditEntries().map((entry) => entry.action)).toEqual(expect.arrayContaining([
      'workspace.acquire', 'workspace.reserve', 'workspace.claim',
      'session.pause', 'delegation.return',
    ]))
  })

  it('refuses a second managed writer in the same checkout before spawning it', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-writer-')))
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const workspace = new WorkspaceLeaseManager(approvals.rawDb)
    const agent = new Agent()
    const sessions = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [dir],
      agentFactories: { claude: agent.factory },
      workspace,
    })
    cleanups.push(async () => {
      await sessions.shutdown()
      log.close()
      approvals.close()
      rmSync(dir, { recursive: true, force: true })
    })
    await sessions.startSession({ agent: 'claude', cwd: dir, prompt: 'First writer.' })
    await expect(sessions.startSession({ agent: 'claude', cwd: dir, prompt: 'Second writer.' }))
      .rejects.toMatchObject({ reason: 'workspace-conflict' })
    expect(agent.requests).toHaveLength(1)
  })

  it('releases checkout ownership when an adapter refuses startup', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-start-failure-')))
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const workspace = new WorkspaceLeaseManager(approvals.rawDb)
    const sessions = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [dir],
      agentFactories: { claude: () => { throw new Error('adapter refused startup') } },
      workspace,
    })
    cleanups.push(async () => {
      await sessions.shutdown()
      log.close()
      approvals.close()
      rmSync(dir, { recursive: true, force: true })
    })

    await expect(sessions.startSession({ agent: 'claude', cwd: dir, prompt: 'Try once.' }))
      .rejects.toThrow('adapter refused startup')
    expect(workspace.getByCwd(dir)).toBeNull()
    expect(sessions.listSessions()[0]).toMatchObject({ status: 'errored', live: false })
  })

  it('does not restore a dead source lease when the source ends during a failed pause', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-pause-race-')))
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const workspace = new WorkspaceLeaseManager(approvals.rawDb)
    const target = new Agent()
    const sessions = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [dir],
      agentFactories: { codex: target.factory },
      workspace,
    })
    cleanups.push(async () => {
      await sessions.shutdown()
      log.close()
      approvals.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const source: SessionListing = {
      sessionId: 'ext_parent', agent: 'claude', cwd: dir, status: 'running', startedAt: 1,
      origin: 'terminal', title: 'Terminal parent', live: true, resumable: true, resumeId: 'native_parent',
    }
    log.appendBatch(source.sessionId, [
      { type: 'session.started', payload: { agent: 'claude', cwd: dir, title: source.title, origin: 'terminal' } },
      { type: 'stream.delta', payload: { kind: 'user', text: 'Review the handoff.' } },
    ])
    workspace.acquire({
      sessionId: source.sessionId, cwd: dir, ownerKind: 'external', ownerOrigin: 'terminal', actor: 'system',
    })
    const manager = new DelegationManager({
      store: new DelegationStore(approvals.rawDb),
      sessions,
      briefings: new BriefingBuilder(log),
      workspace,
      sourceSessions: () => [source],
      pauseSession: async () => {
        source.live = false
        source.status = 'ended'
        return false
      },
    })

    await expect(manager.start({
      idempotencyKey: 'pause-race', sourceSessionId: source.sessionId, targetAgent: 'codex',
      role: 'review', contextScope: 'recent', briefing: 'Review the handoff.', createdBy: 'dev_phone',
    })).rejects.toMatchObject({ reason: 'workspace-conflict' })
    expect(workspace.getByCwd(dir)).toBeNull()
    expect(target.requests).toHaveLength(0)
  })

  it('restores child ownership when a reviewed return cannot drain that child', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-return-pause-')))
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const workspace = new WorkspaceLeaseManager(approvals.rawDb)
    const parent = new Agent()
    const child = new Agent(false)
    let manager: DelegationManager | undefined
    const sessions = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [dir],
      agentFactories: { claude: parent.factory, codex: child.factory },
      workspace,
      pauseTimeoutMs: 5,
      onEvent: (event) => manager?.handleSessionEvent(event),
    })
    cleanups.push(async () => {
      await sessions.shutdown()
      log.close()
      approvals.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const parentId = (await sessions.startSession({
      agent: 'claude', cwd: dir, prompt: 'Parent work.', origin: 'phone', actor: 'dev_phone',
    })).sessionId
    await new Promise((resolve) => setTimeout(resolve, 0))
    manager = new DelegationManager({
      store: new DelegationStore(approvals.rawDb),
      sessions,
      briefings: new BriefingBuilder(log),
      returns: new ReturnBuilder(log),
      workspace,
      sourceSessions: () => sessions.listSessions(),
      pauseSession: (session, actor, reason) => sessions.pauseSession(session.sessionId, actor, reason),
    })
    const launched = await manager.start({
      idempotencyKey: 'return-pause', sourceSessionId: parentId, targetAgent: 'codex',
      role: 'review', contextScope: 'recent', briefing: 'Review parent work.', createdBy: 'dev_phone',
    })
    const childId = launched.delegation.targetSessionId!
    child.runs[0]!.complete('Reviewed result.')
    await eventually(() => expect(manager!.list()[0]?.status).toBe('ready'))

    await expect(manager.returnDelegation({
      delegationId: launched.delegation.delegationId,
      idempotencyKey: 'return-pause-op',
      returnText: 'Reviewed result.',
      takeoverConfirmed: false,
      actor: 'dev_phone',
    })).rejects.toMatchObject({ reason: 'delivery-failed' })
    expect(workspace.getByCwd(dir)?.ownerId).toBe(childId)
    expect(sessions.listSessions().find((session) => session.sessionId === childId)?.live).toBe(true)
  })
})
