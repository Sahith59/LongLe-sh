import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { AgentFactory, AgentRunHandle, PermissionDecision } from './agent.js'
import type { ApprovalStore } from './approvals.js'
import type { EventLog, AppendInput } from './eventlog.js'
import { AgentKind, type SessionEvent } from '@longleash/protocol'

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60_000

export type SessionStatus = 'running' | 'ended' | 'errored'
export type DecisionOutcome = 'decided' | 'already-decided' | 'unknown'

export class SessionError extends Error {
  constructor(
    readonly reason: 'cwd-not-allowed' | 'no-adapter' | 'invalid-input' | 'session-busy',
    message: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

export interface SessionSummary {
  sessionId: string
  agent: AgentKind
  cwd: string
  status: SessionStatus
  startedAt: number
}

export interface StartSessionInput {
  agent: AgentKind
  cwd: string
  prompt: string
}

export interface SessionManagerOptions {
  eventLog: EventLog
  approvals: ApprovalStore
  /** Remote session start is bounded by API shape: nothing outside these roots can be targeted. */
  allowedRoots: string[]
  agentFactories: Partial<Record<AgentKind, AgentFactory>>
  now?: () => number
  approvalTtlMs?: number
  onEvent?: (event: SessionEvent) => void
}

interface LiveSession extends SessionSummary {
  handle: AgentRunHandle
  done: Promise<void>
  /** Resolvers for approvals this session is currently blocked on. */
  waiting: Map<string, (decision: PermissionDecision) => void>
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`

function summarize(toolName: string, input: unknown): string {
  let detail = ''
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    const interesting = record.file_path ?? record.path ?? record.command ?? record.pattern
    if (typeof interesting === 'string') detail = ` ${interesting}`
  }
  return `${toolName}${detail}`.slice(0, 300)
}

export class SessionManager {
  private readonly eventLog: EventLog
  private readonly approvals: ApprovalStore
  private readonly allowedRoots: string[]
  private readonly agentFactories: Partial<Record<AgentKind, AgentFactory>>
  private readonly now: () => number
  private readonly approvalTtlMs: number
  private readonly onEvent: ((event: SessionEvent) => void) | undefined
  private readonly sessions = new Map<string, LiveSession>()
  private readonly claimed = new Set<string>()
  /** Resolves when a session's next approval has been registered — lets tests avoid sleeps. */
  private readonly approvalWaiters = new Map<string, (() => void)[]>()

  constructor(opts: SessionManagerOptions) {
    this.eventLog = opts.eventLog
    this.approvals = opts.approvals
    this.allowedRoots = opts.allowedRoots.map((root) => this.canonical(root))
    this.agentFactories = opts.agentFactories
    this.now = opts.now ?? Date.now
    this.approvalTtlMs = opts.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.onEvent = opts.onEvent
  }

  async startSession(input: StartSessionInput): Promise<{ sessionId: string }> {
    const prompt = input.prompt.trim()
    if (prompt.length === 0) throw new SessionError('invalid-input', 'Prompt must not be empty')

    // Validate at runtime too: this is a public entry point, not only reached via the WS schema.
    const agent = AgentKind.safeParse(input.agent)
    if (!agent.success) throw new SessionError('no-adapter', `No adapter for agent "${String(input.agent)}"`)

    const factory = this.agentFactories[agent.data]
    if (!factory) throw new SessionError('no-adapter', `No adapter for agent "${agent.data}"`)

    const cwd = this.assertAllowedCwd(input.cwd)
    const sessionId = newId('ses')
    this.claimed.add(sessionId)

    this.emit(sessionId, {
      type: 'session.started',
      payload: { agent: agent.data, cwd, title: prompt.slice(0, 80) },
    })

    const waiting = new Map<string, (decision: PermissionDecision) => void>()
    const handle = factory({
      sessionId,
      cwd,
      prompt,
      canUseTool: (toolName, toolInput) => this.requestApproval(sessionId, waiting, toolName, toolInput),
      onAutoApprovedTool: (toolName, toolInput) => {
        this.emit(sessionId, {
          type: 'activity.tool',
          payload: { toolName, inputSummary: summarize(toolName, toolInput), autoApproved: true },
        })
      },
    })

    const session: LiveSession = {
      sessionId,
      agent: agent.data,
      cwd,
      status: 'running',
      startedAt: this.now(),
      handle,
      waiting,
      done: Promise.resolve(),
    }
    session.done = this.consume(session)
    this.sessions.set(sessionId, session)
    return { sessionId }
  }

  decide(approvalId: string, verdict: 'allow' | 'deny', decidedBy: string, reply?: string): DecisionOutcome {
    const approval = this.approvals.get(approvalId)
    if (!approval) return 'unknown'

    const committed = this.approvals.decide(
      approvalId,
      verdict === 'allow' ? 'allowed' : 'denied',
      decidedBy,
      reply,
    )
    if (!committed) return 'already-decided'

    this.emit(approval.sessionId, {
      type: 'approval.decided',
      payload: { approvalId, verdict, decidedBy, ...(reply === undefined ? {} : { reply }) },
    })

    const session = this.sessions.get(approval.sessionId)
    const resolver = session?.waiting.get(approvalId)
    if (resolver) {
      session?.waiting.delete(approvalId)
      resolver(
        verdict === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: reply ?? 'Denied from your phone' },
      )
    }
    return 'decided'
  }

  /** Deny anything past its deadline so a forgotten prompt cannot pin an agent forever. */
  sweepExpiredApprovals(): number {
    const expired = this.approvals.findExpired()
    for (const approval of expired) {
      this.decide(approval.approvalId, 'deny', 'system:expired', 'Approval expired before it was answered')
    }
    return expired.length
  }

  listPendingApprovals() {
    return this.approvals.listPending()
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(({ sessionId, agent, cwd, status, startedAt }) => ({
      sessionId,
      agent,
      cwd,
      status,
      startedAt,
    }))
  }

  /** One writer per session: a second driver must never race the first over the same transcript. */
  claimSession(sessionId: string): void {
    if (this.claimed.has(sessionId)) {
      throw new SessionError('session-busy', `Session ${sessionId} is already claimed by another driver`)
    }
    this.claimed.add(sessionId)
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.done
  }

  /**
   * Resolves once this session has an approval waiting. Returns immediately when one is
   * already pending — a caller must never hang because it asked a moment too late.
   */
  waitForApproval(sessionId: string): Promise<void> {
    const alreadyPending = this.approvals.listPending().some((a) => a.sessionId === sessionId)
    if (alreadyPending) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.approvalWaiters.get(sessionId) ?? []
      waiters.push(resolve)
      this.approvalWaiters.set(sessionId, waiters)
    })
  }

  private async requestApproval(
    sessionId: string,
    waiting: Map<string, (decision: PermissionDecision) => void>,
    toolName: string,
    input: unknown,
  ): Promise<PermissionDecision> {
    const approvalId = newId('apr')
    const expiresAt = this.now() + this.approvalTtlMs
    const inputSummary = summarize(toolName, input)

    this.approvals.create({ approvalId, sessionId, toolName, inputSummary, expiresAt })
    this.emit(sessionId, {
      type: 'approval.requested',
      payload: { approvalId, toolName, inputSummary, expiresAt },
    })

    const decision = new Promise<PermissionDecision>((resolve) => {
      waiting.set(approvalId, resolve)
    })

    for (const waiter of this.approvalWaiters.get(sessionId) ?? []) waiter()
    this.approvalWaiters.delete(sessionId)

    return decision
  }

  private async consume(session: LiveSession): Promise<void> {
    try {
      for await (const message of session.handle.events) {
        this.emit(session.sessionId, {
          type: 'stream.delta',
          payload: { kind: message.type === 'text' ? 'text' : message.type, text: message.text },
        })
      }
      session.status = 'ended'
      this.emit(session.sessionId, { type: 'session.ended', payload: {} })
    } catch (err) {
      session.status = 'errored'
      this.emit(session.sessionId, {
        type: 'session.errored',
        payload: { message: err instanceof Error ? err.message : 'Agent failed' },
      })
    } finally {
      this.claimed.delete(session.sessionId)
      // A dead agent can never answer: close out anything it left pending.
      for (const [approvalId, resolve] of session.waiting) {
        this.approvals.decide(approvalId, 'denied', 'system:session-ended', 'Session ended before a decision')
        resolve({ behavior: 'deny', message: 'Session ended before a decision' })
      }
      session.waiting.clear()
    }
  }

  private emit(sessionId: string, input: AppendInput): void {
    const event = this.eventLog.append(sessionId, input)
    this.onEvent?.(event)
  }

  /**
   * Resolve symlinks before comparing: on macOS /tmp is itself a symlink, and a link planted
   * inside an allowed root must not become an escape hatch.
   */
  private canonical(path: string): string {
    const resolved = resolve(path)
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  }

  private assertAllowedCwd(cwd: string): string {
    let real: string
    try {
      real = realpathSync(resolve(cwd))
    } catch {
      throw new SessionError('cwd-not-allowed', `Directory is not allowed or does not exist: ${cwd}`)
    }
    const permitted = this.allowedRoots.some((root) => real === root || real.startsWith(root + sep))
    if (!permitted) {
      throw new SessionError('cwd-not-allowed', `Directory is not allowed: ${cwd}`)
    }
    return real
  }
}
