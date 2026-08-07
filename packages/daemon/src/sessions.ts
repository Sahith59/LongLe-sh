import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { AgentFactory, AgentRunHandle, PermissionDecision } from './agent.js'
import type { ApprovalStore } from './approvals.js'
import type { EventLog, AppendInput } from './eventlog.js'
import { AgentKind, SessionOrigin, type SessionEvent } from '@longleash/protocol'
import { isSensitivePath } from './sensitive.js'

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60_000

export type SessionStatus = 'running' | 'waiting' | 'ended' | 'errored'
export type DecisionOutcome = 'decided' | 'already-decided' | 'unknown'

export class SessionError extends Error {
  constructor(
    readonly reason: 'cwd-not-allowed' | 'no-adapter' | 'invalid-input' | 'session-busy' | 'too-many-sessions',
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
  /** Where this session came from, so the phone can distinguish it from others. */
  origin: SessionOrigin
  /** Human-readable label — the opening request, so a list is scannable. */
  title: string
}

/**
 * A summary as the phone receives it. `resumable` is derived from storage rather than
 * carried as session state — it answers "can typing carry this on?", which is true of
 * history a live session knows nothing about.
 */
export interface SessionListing extends SessionSummary {
  resumable: boolean
  /** The agent's conversation id, so the phone can offer `claude --resume <id>`. */
  resumeId?: string
}

export interface StartSessionInput {
  agent: AgentKind
  cwd: string
  prompt: string
  origin?: SessionOrigin
  /** Device that requested this, recorded in the audit log. */
  actor?: string
}

export interface AuditEntry {
  at: number
  actor: string
  action: string
  detail: string
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
  /** Cap concurrent agents so a buggy or hostile client cannot exhaust the machine. */
  maxConcurrentSessions?: number
  /**
   * Refuse credential and system folders even when they sit inside an allowed root. Needed
   * whenever a broad root (like a home directory) is allowed.
   */
  excludeSensitive?: boolean
  /**
   * Refuse tools whose declared path escapes the allowlisted roots, without troubling the
   * human. Off by default so the person stays in charge; on for sandboxed use where "it can
   * only touch this directory" must be literally true.
   */
  denyOutsideRoot?: boolean
}

interface LiveSession extends SessionSummary {
  /** Present only while the agent process exists. */
  handle: AgentRunHandle
  done: Promise<void>
  /** Resolvers for approvals this session is currently blocked on. */
  waiting: Map<string, (decision: PermissionDecision) => void>
  /**
   * A newer run (a reopen, or a wake) has taken this conversation over. The old run may still
   * be draining; when it finishes it must NOT write its terminal status, or a conversation
   * the person just reopened silently flips back to finished.
   */
  superseded?: boolean
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`

/**
 * Tools that declare a path get it checked; shell commands do not, because parsing shell
 * syntax to find writes would be security theatre. Those still go to a human, who sees the
 * whole command.
 */
function declaredPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

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
  private readonly denyOutsideRoot: boolean
  private readonly maxConcurrentSessions: number
  private readonly excludeSensitive: boolean
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
    this.denyOutsideRoot = opts.denyOutsideRoot ?? false
    this.maxConcurrentSessions = opts.maxConcurrentSessions ?? 10
    this.excludeSensitive = opts.excludeSensitive ?? false
    // A restart takes every agent process with it — but not the conversations. Anything with
    // a resume id becomes 'waiting': the transcript survives on disk and a reply wakes it (see
    // sendMessage). Only a session that never announced a resume id is truly over. Either way
    // the transition is APPENDED TO THE EVENT LOG: silently rewriting the table once made
    // hello say "ended" while the replayed stream still ended "waiting" — the phone believed
    // the stream, showed a live session, and the send bounced.
    const stranded = this.approvals.rawDb
      .prepare(
        "SELECT session_id, status, agent_session_id FROM sessions WHERE status IN ('running','waiting')",
      )
      .all() as { session_id: string; status: string; agent_session_id: string | null }[]
    for (const row of stranded) {
      if (row.agent_session_id !== null) {
        if (row.status !== 'waiting') {
          this.markStatus(row.session_id, 'waiting')
          this.emit(row.session_id, {
            type: 'session.status',
            payload: { status: 'waiting', detail: 'interrupted by a daemon restart' },
          })
        }
      } else {
        this.markStatus(row.session_id, 'ended')
        this.emit(row.session_id, {
          type: 'session.ended',
          payload: {
            reason: 'daemon restarted before the agent announced a resume id',
            resumable: false,
          },
        })
      }
    }
    // A crashed daemon takes its agents with it; anything still pending can never be answered.
    this.orphansClosed = this.approvals.closeOrphans('Daemon restarted before this was answered').length
  }

  /** How many stale approvals were reconciled at startup; surfaced so restarts are visible. */
  readonly orphansClosed: number = 0

  async startSession(input: StartSessionInput): Promise<{ sessionId: string }> {
    const running = [...this.sessions.values()].filter(
      (s) => s.status === 'running' || s.status === 'waiting',
    ).length
    if (running >= this.maxConcurrentSessions) {
      throw new SessionError(
        'too-many-sessions',
        `Too many sessions running (${running}/${this.maxConcurrentSessions}). Stop one first.`,
      )
    }
    const prompt = input.prompt.trim()
    if (prompt.length === 0) throw new SessionError('invalid-input', 'Prompt must not be empty')

    // Validate at runtime too: this is a public entry point, not only reached via the WS schema.
    const agent = AgentKind.safeParse(input.agent)
    if (!agent.success) throw new SessionError('no-adapter', `No adapter for agent "${String(input.agent)}"`)

    const factory = this.agentFactories[agent.data]
    if (!factory) throw new SessionError('no-adapter', `No adapter for agent "${agent.data}"`)

    const cwd = this.assertAllowedCwd(input.cwd)
    const origin = SessionOrigin.catch('daemon').parse(input.origin ?? 'daemon')
    const sessionId = newId('ses')
    this.claimed.add(sessionId)

    const title = prompt.slice(0, 80)
    this.persistSession({
      sessionId,
      agent: agent.data,
      cwd,
      origin,
      title,
      status: 'running',
      startedAt: this.now(),
    })
    this.emit(sessionId, {
      type: 'session.started',
      payload: { agent: agent.data, cwd, title, origin },
    })
    this.audit(input.actor ?? 'daemon', 'session.start', `${agent.data} in ${cwd}`)

    const waiting = new Map<string, (decision: PermissionDecision) => void>()
    const handle = this.spawn(factory, sessionId, cwd, prompt, waiting)

    const session: LiveSession = {
      sessionId,
      agent: agent.data,
      cwd,
      status: 'running',
      startedAt: this.now(),
      origin,
      title,
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
    this.audit(decidedBy, 'approval.decide', `${verdict} ${approval.inputSummary}`)

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

  /**
   * Every session this daemon knows about, live or historical. A phone that reloads — or a
   * daemon that restarted — must be able to rebuild the list rather than showing nothing.
   */
  listSessions(): SessionListing[] {
    const rows = this.approvals.rawDb
      .prepare('SELECT * FROM sessions ORDER BY started_at ASC')
      .all() as {
      session_id: string
      agent: string
      cwd: string
      origin: string
      title: string
      status: string
      started_at: number
      agent_session_id: string | null
    }[]
    return rows.map((row) => {
      const live = this.sessions.get(row.session_id)
      return {
        sessionId: row.session_id,
        agent: row.agent as AgentKind,
        cwd: row.cwd,
        origin: row.origin as SessionOrigin,
        title: row.title,
        // Trust the live process over the stored row while it is running.
        status: live ? live.status : (row.status as SessionStatus),
        startedAt: row.started_at,
        resumable: row.agent_session_id !== null,
        ...(row.agent_session_id === null ? {} : { resumeId: row.agent_session_id }),
      }
    })
  }

  /**
   * Adopt a finished TERMINAL session so a phone reply can wake it: the
   * conversation lives in Claude Code's own storage, keyed by its resume id,
   * and wake() continues it through the SDK exactly like any dormant phone
   * session. This is the baton pass — terminal to phone — and it only ever
   * happens for a session that is no longer running anywhere else, because
   * one conversation gets one driver at a time.
   */
  adoptEndedSession(input: {
    sessionId: string
    cwd: string
    title: string
    origin: SessionOrigin
    startedAt: number
    agentSessionId: string
  }): void {
    this.approvals.rawDb
      .prepare(
        `INSERT INTO sessions (session_id, agent, cwd, origin, title, status, started_at, agent_session_id)
         VALUES (?, 'claude', ?, ?, ?, 'ended', ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           status = 'ended',
           cwd = excluded.cwd,
           title = excluded.title,
           agent_session_id = excluded.agent_session_id`,
      )
      .run(input.sessionId, input.cwd, input.origin, input.title, input.startedAt, input.agentSessionId)
  }

  private persistSession(summary: SessionSummary): void {
    this.approvals.rawDb
      .prepare(
        `INSERT INTO sessions (session_id, agent, cwd, origin, title, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET status = excluded.status`,
      )
      .run(
        summary.sessionId,
        summary.agent,
        summary.cwd,
        summary.origin,
        summary.title,
        summary.status,
        summary.startedAt,
      )
  }

  private markStatus(sessionId: string, status: SessionStatus): void {
    this.approvals.rawDb
      .prepare('UPDATE sessions SET status = ? WHERE session_id = ?')
      .run(status, sessionId)
  }

  /**
   * Can typing carry this conversation on? True once the agent has announced a resume id,
   * which is the moment its transcript becomes reachable again. Read at the instant a
   * session ends so the live event can carry the truth — `hello` alone is not enough,
   * because this is precisely the fact that flips AS a session ends.
   */
  private resumableOf(sessionId: string): boolean {
    return this.resumeIdOf(sessionId) !== undefined
  }

  /** The agent's conversation id, once it has announced one. */
  private resumeIdOf(sessionId: string): string | undefined {
    const row = this.approvals.rawDb
      .prepare('SELECT agent_session_id FROM sessions WHERE session_id = ?')
      .get(sessionId) as { agent_session_id: string | null } | undefined
    return row?.agent_session_id ?? undefined
  }

  private spawn(
    factory: AgentFactory,
    sessionId: string,
    cwd: string,
    prompt: string,
    waiting: Map<string, (decision: PermissionDecision) => void>,
    resume?: string,
  ) {
    return factory({
      sessionId,
      cwd,
      prompt,
      ...(resume === undefined ? {} : { resume }),
      canUseTool: (toolName, toolInput) =>
        this.requestApproval(sessionId, cwd, waiting, toolName, toolInput),
      onAutoApprovedTool: (toolName, toolInput) => {
        this.emit(sessionId, {
          type: 'activity.tool',
          payload: { toolName, inputSummary: summarize(toolName, toolInput), autoApproved: true },
        })
      },
      // Remember how to reopen this conversation later.
      onAgentSession: (agentSessionId) => {
        this.approvals.rawDb
          .prepare('UPDATE sessions SET agent_session_id = ? WHERE session_id = ?')
          .run(agentSessionId, sessionId)
      },
    })
  }

  /**
   * Reopen a finished conversation — which means making it READY, not re-running it.
   *
   * This used to re-spawn the agent with the original prompt (truncated to the 80-char
   * title, no less), so tapping Reopen silently re-executed the first instruction. On
   * "say BETA" that only looked odd; on "delete the old migrations" it would have been a
   * destructive action nobody asked for twice. Nothing is started here: the conversation is
   * simply marked live again, and the agent wakes on the human's next message carrying
   * their actual words (see sendMessage → wake).
   */
  async resumeSession(sessionId: string, actor: string): Promise<boolean> {
    const live = this.sessions.get(sessionId)
    if (live && (live.status === 'running' || live.status === 'waiting')) return false

    const row = this.approvals.rawDb
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as
      | { agent: string; cwd: string; origin: string; title: string; started_at: number; agent_session_id: string | null }
      | undefined
    if (!row) return false
    // Without a resume point there is nothing to carry on from; saying otherwise would
    // leave the person typing into a conversation that can never answer.
    if (row.agent_session_id === null) return false

    const agent = AgentKind.safeParse(row.agent)
    if (!agent.success) return false
    if (!this.agentFactories[agent.data]) return false

    // The directory must still be permitted: an allowlist change must not be bypassable
    // by reopening something started under the old configuration.
    try {
      this.assertAllowedCwd(row.cwd)
    } catch {
      return false
    }

    this.audit(actor, 'session.resume', sessionId)
    this.supersede(sessionId)
    this.markStatus(sessionId, 'waiting')
    this.emit(sessionId, { type: 'session.status', payload: { status: 'waiting', detail: 'reopened' } })
    return true
  }

  /**
   * Continue an existing conversation. Without this every message would start a new session,
   * which is not a conversation at all.
   */
  sendMessage(sessionId: string, text: string, actor: string): boolean {
    const trimmed = text.trim()
    if (trimmed.length === 0) return false
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'running' && session.status !== 'waiting')) {
      return this.wake(sessionId, trimmed, actor)
    }
    this.audit(actor, 'message.send', `${sessionId}: ${trimmed.slice(0, 80)}`)
    session.status = 'running'
    this.markStatus(sessionId, 'running')
    this.emit(sessionId, { type: 'stream.delta', payload: { kind: 'user', text: `\n\n› ${trimmed}\n` } })
    this.emit(sessionId, { type: 'session.status', payload: { status: 'running' } })
    session.handle.sendMessage(trimmed)
    return true
  }

  /**
   * A conversation without a live process is dormant, not dead: the agent's transcript is on
   * disk and the SDK can resume it. So a reply revives the agent with that reply as its next
   * prompt — the alternative was telling the human to start over and lose everything, which is
   * exactly what happened when a daemon restart stranded a "waiting" session.
   */
  private wake(sessionId: string, text: string, actor: string): boolean {
    const row = this.approvals.rawDb
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as
      | { agent: string; cwd: string; origin: string; title: string; started_at: number; agent_session_id: string | null }
      | undefined
    if (!row || row.agent_session_id === null) return false

    const agent = AgentKind.safeParse(row.agent)
    if (!agent.success) return false
    const factory = this.agentFactories[agent.data]
    if (!factory) return false

    // Waking starts a real agent process; it obeys the same cap as starting one.
    const running = [...this.sessions.values()].filter(
      (s) => s.status === 'running' || s.status === 'waiting',
    ).length
    if (running >= this.maxConcurrentSessions) return false

    // The allowlist of today governs, not the one this session was started under.
    let cwd: string
    try {
      cwd = this.assertAllowedCwd(row.cwd)
    } catch {
      return false
    }

    this.audit(actor, 'session.wake', `${sessionId}: ${text.slice(0, 80)}`)
    this.supersede(sessionId)
    const waiting = new Map<string, (decision: PermissionDecision) => void>()
    const handle = this.spawn(factory, sessionId, cwd, text, waiting, row.agent_session_id)
    const session: LiveSession = {
      sessionId,
      agent: agent.data,
      cwd,
      status: 'running',
      startedAt: row.started_at,
      origin: SessionOrigin.catch('daemon').parse(row.origin),
      title: row.title,
      handle,
      waiting,
      done: Promise.resolve(),
    }
    this.markStatus(sessionId, 'running')
    this.emit(sessionId, { type: 'stream.delta', payload: { kind: 'user', text: `\n\n› ${text}\n` } })
    this.emit(sessionId, { type: 'session.status', payload: { status: 'running' } })
    session.done = this.consume(session)
    this.sessions.set(sessionId, session)
    this.claimed.add(sessionId)
    return true
  }

  /**
   * Stop a running agent. Without this a remote control has no brake: denying the next
   * approval does nothing to an agent that never asks for one again.
   */
  async stopSession(sessionId: string, actor: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'running' && session.status !== 'waiting')) {
      return this.closeDormant(sessionId, actor)
    }
    this.audit(actor, 'session.stop', sessionId)
    try {
      await session.handle.interrupt()
    } catch {
      // An agent that cannot be interrupted cleanly is still torn down below.
    }
    session.status = 'ended'
    this.markStatus(sessionId, 'ended')
    this.releasePending(session, 'Session stopped from your device')
    this.emit(sessionId, {
      type: 'session.ended',
      payload: {
        reason: `stopped by ${actor}`,
        resumable: this.resumableOf(sessionId),
        ...(this.resumeIdOf(sessionId) === undefined ? {} : { resumeId: this.resumeIdOf(sessionId) }),
      },
    })
    return true
  }

  /** Hand this conversation to a newer run; whatever was draining must stop speaking for it. */
  private supersede(sessionId: string): void {
    const stale = this.sessions.get(sessionId)
    if (!stale) return
    stale.superseded = true
    this.sessions.delete(sessionId)
  }

  /**
   * Stop every agent and wait for it to finish draining. Without this, a shutting-down daemon
   * closes its databases while a consume loop is still writing — an unhandled rejection at
   * best, a corrupted final status at worst.
   */
  async shutdown(): Promise<void> {
    const live = [...this.sessions.values()]
    await Promise.all(
      live.map(async (session) => {
        try {
          await session.handle.interrupt()
        } catch {
          // An agent that will not interrupt cleanly still gets awaited below.
        }
      }),
    )
    await Promise.all(live.map((session) => session.done.catch(() => {})))
  }

  /** Stopping a dormant conversation: nothing to interrupt, but "this is over" must stick. */
  private closeDormant(sessionId: string, actor: string): boolean {
    const row = this.approvals.rawDb
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get(sessionId) as { status: string } | undefined
    if (!row || (row.status !== 'running' && row.status !== 'waiting')) return false
    this.audit(actor, 'session.stop', sessionId)
    this.markStatus(sessionId, 'ended')
    this.emit(sessionId, {
      type: 'session.ended',
      payload: {
        reason: `stopped by ${actor}`,
        resumable: this.resumableOf(sessionId),
        ...(this.resumeIdOf(sessionId) === undefined ? {} : { resumeId: this.resumeIdOf(sessionId) }),
      },
    })
    return true
  }

  /**
   * Expiry only means something if something enforces it. Returns a stop function so tests and
   * shutdown can dispose the timer instead of leaking it.
   */
  startMaintenance(intervalMs = 60_000): () => void {
    const timer = setInterval(() => this.sweepExpiredApprovals(), intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }

  /** The directories agents may work in — the app offers these instead of asking for a path. */
  listAllowedRoots(): string[] {
    return [...this.allowedRoots]
  }

  listAuditEntries(limit = 200): AuditEntry[] {
    return this.approvals.rawDb
      .prepare('SELECT at, actor, action, detail FROM audit ORDER BY at ASC, rowid ASC LIMIT ?')
      .all(limit) as AuditEntry[]
  }

  private audit(actor: string, action: string, detail: string): void {
    this.approvals.rawDb
      .prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .run(this.now(), actor, action, detail.slice(0, 500))
  }

  private releasePending(session: LiveSession, message: string): void {
    for (const [approvalId, resolve] of session.waiting) {
      this.approvals.decide(approvalId, 'denied', 'system:session-ended', message)
      resolve({ behavior: 'deny', message })
    }
    session.waiting.clear()
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
    cwd: string,
    waiting: Map<string, (decision: PermissionDecision) => void>,
    toolName: string,
    input: unknown,
  ): Promise<PermissionDecision> {
    const approvalId = newId('apr')
    const expiresAt = this.now() + this.approvalTtlMs
    const inputSummary = summarize(toolName, input)

    // An agent can hand a tool any absolute path; pinning cwd governs the process, not the
    // arguments. Resolve what the tool actually targets and judge it against the allowlist.
    const declared = declaredPath(input)
    const targetPath = declared === null ? null : resolve(cwd, declared)
    const outsideRoot = targetPath !== null && !this.isInsideAllowedRoot(targetPath)

    if (outsideRoot && this.denyOutsideRoot) {
      this.approvals.create({
        approvalId,
        sessionId,
        toolName,
        inputSummary,
        expiresAt,
        targetPath,
        outsideRoot,
      })
      const message = `Refused: ${targetPath} is outside the allowed project directories`
      this.approvals.decide(approvalId, 'denied', 'system:outside-root', message)
      this.emit(sessionId, {
        type: 'approval.decided',
        payload: { approvalId, verdict: 'deny', decidedBy: 'system:outside-root', reply: message },
      })
      return { behavior: 'deny', message }
    }

    this.approvals.create({
      approvalId,
      sessionId,
      toolName,
      inputSummary,
      expiresAt,
      targetPath,
      outsideRoot,
    })
    this.emit(sessionId, {
      type: 'approval.requested',
      payload: {
        approvalId,
        toolName,
        inputSummary,
        expiresAt,
        ...(targetPath === null ? {} : { targetPath }),
        outsideRoot,
      },
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
        if (message.type === 'turn-end') {
          // The agent replied and is now waiting on the human; the conversation continues.
          session.status = 'waiting'
          this.markStatus(session.sessionId, 'waiting')
          this.emit(session.sessionId, { type: 'session.status', payload: { status: 'waiting' } })
          continue
        }
        this.emit(session.sessionId, {
          type: 'stream.delta',
          payload: { kind: message.type, text: message.text },
        })
      }
      session.status = 'ended'
      if (!session.superseded) {
        this.markStatus(session.sessionId, 'ended')
        this.emit(session.sessionId, {
          type: 'session.ended',
          payload: {
            resumable: this.resumableOf(session.sessionId),
            ...(this.resumeIdOf(session.sessionId) === undefined
              ? {}
              : { resumeId: this.resumeIdOf(session.sessionId) }),
          },
        })
      }
    } catch (err) {
      session.status = 'errored'
      if (!session.superseded) {
        this.markStatus(session.sessionId, 'errored')
        this.emit(session.sessionId, {
          type: 'session.errored',
          payload: { message: err instanceof Error ? err.message : 'Agent failed' },
        })
      }
    } finally {
      this.claimed.delete(session.sessionId)
      // A dead agent can never answer: close out anything it left pending.
      this.releasePending(session, 'Session ended before a decision')
      // Leave the live map: a finished run kept lingering here and shadowed the stored row,
      // so a reopened conversation still reported the dead agent's status.
      if (this.sessions.get(session.sessionId) === session) {
        this.sessions.delete(session.sessionId)
      }
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

  /** A path counts as inside only if it equals a root or sits beneath it. */
  private isInsideAllowedRoot(target: string): boolean {
    const resolved = this.canonical(target)
    return this.allowedRoots.some((root) => resolved === root || resolved.startsWith(root + sep))
  }

  private assertAllowedCwd(cwd: string): string {
    let real: string
    try {
      real = realpathSync(resolve(cwd))
    } catch {
      throw new SessionError('cwd-not-allowed', `Directory is not allowed or does not exist: ${cwd}`)
    }
    // Hiding a folder from search is cosmetic; refusing to run there is the real protection.
    if (this.excludeSensitive && isSensitivePath(real)) {
      throw new SessionError('cwd-not-allowed', `Directory is not allowed: ${cwd}`)
    }
    const permitted = this.allowedRoots.some((root) => real === root || real.startsWith(root + sep))
    if (!permitted) {
      throw new SessionError('cwd-not-allowed', `Directory is not allowed: ${cwd}`)
    }
    return real
  }
}
