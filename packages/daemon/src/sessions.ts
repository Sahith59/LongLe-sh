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
    this.approvals.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        origin TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        agent_session_id TEXT
      )
    `)
    // A session whose daemon died has no agent behind it; showing it as "working" would be a
    // lie the user cannot act on, so anything left live is closed out on startup.
    this.approvals.rawDb
      .prepare("UPDATE sessions SET status = 'ended' WHERE status IN ('running','waiting')")
      .run()
    this.approvals.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      )
    `)
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
  listSessions(): SessionSummary[] {
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
      }
    })
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
   * Reopen a finished conversation. The agent replays its own transcript, so it resumes
   * knowing everything it knew before, and the events continue in the same stream rather
   * than starting a second session that looks like a duplicate.
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

    const agent = AgentKind.safeParse(row.agent)
    if (!agent.success) return false
    const factory = this.agentFactories[agent.data]
    if (!factory) return false

    // The directory must still be permitted: an allowlist change must not be bypassable
    // by reopening something started under the old configuration.
    let cwd: string
    try {
      cwd = this.assertAllowedCwd(row.cwd)
    } catch {
      return false
    }

    this.audit(actor, 'session.resume', sessionId)
    const waiting = new Map<string, (decision: PermissionDecision) => void>()
    const handle = this.spawn(
      factory,
      sessionId,
      cwd,
      row.title,
      waiting,
      row.agent_session_id ?? undefined,
    )
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
    // Resuming makes the agent replay its closing message, so mark the seam rather than
    // letting repeated text look like a glitch.
    this.emit(sessionId, { type: 'stream.delta', payload: { kind: 'user', text: '\n\n— reopened —\n' } })
    this.emit(sessionId, { type: 'session.status', payload: { status: 'running', detail: 'reopened' } })
    session.done = this.consume(session)
    this.sessions.set(sessionId, session)
    this.claimed.add(sessionId)
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
    if (!session || (session.status !== 'running' && session.status !== 'waiting')) return false
    this.audit(actor, 'message.send', `${sessionId}: ${trimmed.slice(0, 80)}`)
    session.status = 'running'
    this.markStatus(sessionId, 'running')
    this.emit(sessionId, { type: 'stream.delta', payload: { kind: 'user', text: `\n\n› ${trimmed}\n` } })
    this.emit(sessionId, { type: 'session.status', payload: { status: 'running' } })
    session.handle.sendMessage(trimmed)
    return true
  }

  /**
   * Stop a running agent. Without this a remote control has no brake: denying the next
   * approval does nothing to an agent that never asks for one again.
   */
  async stopSession(sessionId: string, actor: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'running' && session.status !== 'waiting')) return false
    this.audit(actor, 'session.stop', sessionId)
    try {
      await session.handle.interrupt()
    } catch {
      // An agent that cannot be interrupted cleanly is still torn down below.
    }
    session.status = 'ended'
    this.markStatus(sessionId, 'ended')
    this.releasePending(session, 'Session stopped from your device')
    this.emit(sessionId, { type: 'session.ended', payload: { reason: `stopped by ${actor}` } })
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
      this.markStatus(session.sessionId, 'ended')
      this.emit(session.sessionId, { type: 'session.ended', payload: {} })
    } catch (err) {
      session.status = 'errored'
      this.markStatus(session.sessionId, 'errored')
      this.emit(session.sessionId, {
        type: 'session.errored',
        payload: { message: err instanceof Error ? err.message : 'Agent failed' },
      })
    } finally {
      this.claimed.delete(session.sessionId)
      // A dead agent can never answer: close out anything it left pending.
      this.releasePending(session, 'Session ended before a decision')
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
