import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { AgentFactory, AgentRunHandle, PermissionDecision } from './agent.js'
import type { ApprovalStore } from './approvals.js'
import type { EventLog, AppendInput } from './eventlog.js'
import {
  AgentKind,
  SessionSettings,
  SessionOrigin,
  SessionRelationship,
  WorkspaceMode,
  type SessionEvent,
  type SessionRelationship as SessionRelationshipValue,
  type SessionSettings as SessionSettingsValue,
  type SessionWorkspace,
  type WorkspaceMode as WorkspaceModeValue,
} from '@longleash/protocol'
import { isSensitivePath } from './sensitive.js'
import { WorkspaceLeaseError, type WorkspaceLeaseManager } from './workspace-leases.js'
import { ensureColumns } from './migrate.js'
import { WorktreeError, type WorktreeManager } from './worktrees.js'

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60_000

export type SessionStatus = 'running' | 'waiting' | 'ended' | 'errored'
export type DecisionOutcome = 'decided' | 'already-decided' | 'unknown'

export class SessionError extends Error {
  constructor(
    readonly reason:
      | 'cwd-not-allowed'
      | 'no-adapter'
      | 'invalid-input'
      | 'session-busy'
      | 'too-many-sessions'
      | 'workspace-conflict'
      | 'workspace-isolation-failed'
      | 'unsupported-setting',
    message: string,
    readonly detail?: { ownerSessionId?: string; cwd?: string },
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

function relationshipFromRow(row: {
  parent_session_id: string | null
  delegation_id: string | null
  delegation_role: string | null
  delegation_depth: number | null
}): { relationship?: SessionRelationshipValue } {
  if (
    row.parent_session_id === null ||
    row.delegation_id === null ||
    row.delegation_role === null ||
    row.delegation_depth === null
  ) {
    return {}
  }
  const parsed = SessionRelationship.safeParse({
    parentSessionId: row.parent_session_id,
    delegationId: row.delegation_id,
    role: row.delegation_role,
    depth: row.delegation_depth,
  })
  return parsed.success ? { relationship: parsed.data } : {}
}

function settingsFromRow(raw: string | null): { settings?: SessionSettingsValue } {
  if (raw === null) return {}
  try {
    const parsed = SessionSettings.safeParse(JSON.parse(raw))
    return parsed.success ? { settings: parsed.data } : {}
  } catch {
    return {}
  }
}

function workspaceFromRow(row: {
  cwd: string
  workspace_mode: string
  source_cwd: string | null
  workspace_branch: string | null
}): SessionWorkspace {
  if (row.workspace_mode === 'isolated') {
    return {
      mode: 'isolated',
      sourceCwd: row.source_cwd ?? row.cwd,
      ...(row.workspace_branch === null ? {} : { branch: row.workspace_branch }),
    }
  }
  return { mode: 'shared', sourceCwd: row.source_cwd ?? row.cwd }
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
  /** Present only when this session was created as a deliberately attributed child. */
  relationship?: SessionRelationshipValue
  settings?: SessionSettingsValue
  workspace?: SessionWorkspace
}

/**
 * A summary as the phone receives it. `resumable` is derived from storage rather than
 * carried as session state — it answers "can typing carry this on?", which is true of
 * history a live session knows nothing about.
 */
export interface SessionListing extends SessionSummary {
  /**
   * Is there a real agent process behind this right now?
   *
   * A restart parks every resumable conversation as `waiting` so it can be reopened — which is
   * correct — but the phone treated `waiting` as "happening now", so every conversation ever
   * had accumulated in the ACTIVE list saying "waiting for you". A two-day-old session was
   * still asking for a decision. `waiting` alone cannot tell the two apart; this can.
   */
  live: boolean
  resumable: boolean
  /** The agent's conversation id, so the phone can offer `claude --resume <id>`. */
  resumeId?: string
  controller?: 'longleash' | 'external'
}

export interface SessionWorkspaceConflict {
  cwd: string
  ownerSessionId: string
  ownerKind: 'session' | 'external' | 'reservation'
  ownerOrigin: string
}

export interface StartSessionInput {
  agent: AgentKind
  cwd: string
  prompt: string
  /** Delegation has already shown this prompt byte-for-byte to the human. */
  preservePromptWhitespace?: boolean
  /** A concise child label; the full briefing is intentionally not used as list chrome. */
  title?: string
  origin?: SessionOrigin
  /** DelegationManager supplies this when it creates a child through the ordinary runner. */
  relationship?: SessionRelationshipValue
  /** Device that requested this, recorded in the audit log. */
  actor?: string
  /** DelegationManager reserved the checkout while pausing the source. */
  workspaceReservationId?: string
  /** `auto` shares an idle checkout and creates a Git worktree only when another writer owns it. */
  workspaceMode?: WorkspaceModeValue
  settings?: SessionSettingsValue
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
  /** Durable one-writer ownership. Omit only in isolated unit tests or legacy embeddings. */
  workspace?: WorkspaceLeaseManager
  /** Creates isolated Git checkouts when safe parallelism is requested. */
  worktrees?: WorktreeManager
  /** Maximum time a workspace handoff waits for the old agent process to drain. */
  pauseTimeoutMs?: number
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

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    void promise.then(() => finish(true), () => finish(true))
  })
}

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
  private readonly workspace: WorkspaceLeaseManager | undefined
  private readonly worktrees: WorktreeManager | undefined
  private readonly pauseTimeoutMs: number
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
    this.workspace = opts.workspace
    this.worktrees = opts.worktrees
    this.pauseTimeoutMs = opts.pauseTimeoutMs ?? 15_000
    if (!Number.isFinite(this.pauseTimeoutMs) || this.pauseTimeoutMs < 1) {
      throw new Error('pauseTimeoutMs must be a positive number')
    }
    this.approvals.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS session_deliveries (
        delivery_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'sending' CHECK (state IN ('sending', 'sent')),
        created_at INTEGER NOT NULL
      );
    `)
    // Rows written by the first reviewed-return build predate the explicit state. They were
    // only committed after the vendor call returned, so treating those rows as sent is the
    // faithful upgrade. New rows begin as `sending` and cross to `sent` after acceptance.
    ensureColumns(this.approvals.rawDb, 'session_deliveries', [
      { name: 'state', definition: "TEXT NOT NULL DEFAULT 'sent'" },
    ])
    ensureColumns(this.approvals.rawDb, 'sessions', [
      { name: 'workspace_mode', definition: "TEXT NOT NULL DEFAULT 'shared'" },
      { name: 'source_cwd', definition: 'TEXT' },
      { name: 'workspace_branch', definition: 'TEXT' },
      { name: 'settings_json', definition: 'TEXT' },
    ])
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
            payload: { status: 'waiting', live: false, detail: 'interrupted by a daemon restart' },
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
    // Closing SQLite alone leaves any connected/reconnecting phone holding an immortal card,
    // because the UI converges from events. Close the record and the screen together.
    const orphans = this.approvals.closeOrphans('Daemon restarted before this was answered')
    this.orphansClosed = orphans.length
    for (const orphan of orphans) {
      this.emit(orphan.sessionId, {
        type: 'approval.decided',
        payload: {
          approvalId: orphan.approvalId,
          verdict: 'deny',
          decidedBy: 'system:orphaned',
          reply: 'Daemon restarted before this was answered.',
        },
      })
    }

  }

  /** How many stale approvals were reconciled at startup; surfaced so restarts are visible. */
  readonly orphansClosed: number = 0

  supportsAgent(agent: 'claude' | 'codex'): boolean {
    return this.agentFactories[agent] !== undefined
  }

  /**
   * Current process ownership, deliberately independent of the session's historical origin.
   *
   * A Terminal or VS Code conversation can be handed to LongLeash and then be backed by a
   * managed SDK process. Routing lifecycle operations by `origin` after that handoff sends the
   * stop to the old owner and is both inaccurate and unsafe.
   */
  hasLiveSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return session !== undefined && (session.status === 'running' || session.status === 'waiting')
  }

  /** True only when the provider has supplied a native conversation id that can be reopened. */
  hasResumePoint(sessionId: string): boolean {
    return this.resumeIdOf(sessionId) !== undefined
  }

  /**
   * Explain why this conversation cannot acquire its checkout before any process is touched.
   * The server uses this to show evidence (owner, surface, path, session id) instead of the old
   * generic "did not fully release" guess.
   */
  workspaceConflictFor(sessionId: string): SessionWorkspaceConflict | null {
    if (this.workspace === undefined) return null
    const live = this.sessions.get(sessionId)
    const row = live === undefined
      ? this.approvals.rawDb
          .prepare('SELECT cwd FROM sessions WHERE session_id = ?')
          .get(sessionId) as { cwd: string } | undefined
      : { cwd: live.cwd }
    if (row === undefined) return null
    const lease = this.workspace.getByCwd(row.cwd)
    if (lease === null || lease.ownerId === sessionId) return null
    return {
      cwd: lease.cwd,
      ownerSessionId: lease.ownerId,
      ownerKind: lease.ownerKind,
      ownerOrigin: lease.ownerOrigin,
    }
  }

  /**
   * Persist provider controls and, when this manager owns a live process, apply them through
   * that provider's structured control channel. The current response is never interrupted;
   * the returned `live` flag lets the phone explain whether the next turn or next reopen uses
   * the settings.
   */
  async updateSessionSettings(
    sessionId: string,
    requested: SessionSettingsValue,
    actor: string,
  ): Promise<{ live: boolean; settings: SessionSettingsValue }> {
    const row = this.approvals.rawDb
      .prepare('SELECT agent, status FROM sessions WHERE session_id = ?')
      .get(sessionId) as { agent: string; status: SessionStatus } | undefined
    if (row === undefined) throw new SessionError('invalid-input', 'This session is no longer known to LongLeash.')
    const agent = AgentKind.safeParse(row.agent)
    if (!agent.success || (agent.data !== 'claude' && agent.data !== 'codex')) {
      throw new SessionError('unsupported-setting', 'This session provider does not expose model controls.')
    }
    const parsed = SessionSettings.safeParse(requested)
    if (!parsed.success) {
      throw new SessionError('invalid-input', parsed.error.issues[0]?.message ?? 'Invalid session settings.')
    }
    if (agent.data === 'codex' && parsed.data.thinking !== undefined) {
      throw new SessionError(
        'unsupported-setting',
        'Codex exposes reasoning through effort. Leave Thinking on Provider default.',
      )
    }

    const liveSession = this.sessions.get(sessionId)
    const live = liveSession !== undefined &&
      (liveSession.status === 'running' || liveSession.status === 'waiting')
    if (live) {
      if (liveSession.handle.updateSettings === undefined) {
        throw new SessionError(
          'unsupported-setting',
          'This running adapter cannot change settings safely. Stop it and reopen with the new settings.',
        )
      }
      // Adapter acceptance comes before persistence. Claude acknowledges its control messages;
      // Codex safely schedules these values for its next turn/start on the same thread.
      await liveSession.handle.updateSettings(parsed.data)
      liveSession.settings = parsed.data
    }

    this.approvals.rawDb
      .prepare('UPDATE sessions SET settings_json = ? WHERE session_id = ?')
      .run(JSON.stringify(parsed.data), sessionId)
    this.audit(actor, 'session.settings', `${sessionId}: ${JSON.stringify(parsed.data)}`)
    const status = liveSession?.status ?? row.status
    this.emit(sessionId, {
      type: 'session.status',
      payload: {
        status,
        live,
        settings: parsed.data,
        detail: live
          ? 'Settings updated for the next response'
          : 'Settings saved for the next continuation',
      },
    })
    return { live, settings: parsed.data }
  }

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
    if (input.prompt.trim().length === 0) throw new SessionError('invalid-input', 'Prompt must not be empty')
    const prompt = input.preservePromptWhitespace ? input.prompt : input.prompt.trim()

    // Validate at runtime too: this is a public entry point, not only reached via the WS schema.
    const agent = AgentKind.safeParse(input.agent)
    if (!agent.success) throw new SessionError('no-adapter', `No adapter for agent "${String(input.agent)}"`)

    const factory = this.agentFactories[agent.data]
    if (!factory) throw new SessionError('no-adapter', `No adapter for agent "${agent.data}"`)

    const sourceCwd = this.assertAllowedCwd(input.cwd)
    const origin = SessionOrigin.catch('daemon').parse(input.origin ?? 'daemon')
    const workspaceMode = WorkspaceMode.catch('auto').parse(input.workspaceMode ?? 'auto')
    const parsedSettings = SessionSettings.safeParse(input.settings ?? {})
    if (!parsedSettings.success) {
      throw new SessionError('invalid-input', parsedSettings.error.issues[0]?.message ?? 'Invalid session settings.')
    }
    const settings = Object.keys(parsedSettings.data).length === 0 ? undefined : parsedSettings.data
    if (agent.data === 'codex' && settings?.thinking !== undefined) {
      throw new SessionError(
        'unsupported-setting',
        'Thinking mode is controlled by Codex through reasoning effort. Choose an effort, or leave it on Default.',
      )
    }
    const parsedRelationship = input.relationship === undefined
      ? undefined
      : SessionRelationship.safeParse(input.relationship)
    if (parsedRelationship !== undefined && !parsedRelationship.success) {
      throw new SessionError('invalid-input', 'Delegated session attribution is incomplete or invalid.')
    }
    const relationship = parsedRelationship?.data
    if (relationship !== undefined && relationship.depth > 2) {
      throw new SessionError('invalid-input', 'V1 delegation depth must be 1 or 2.')
    }
    const sessionId = newId('ses')
    const actor = input.actor ?? 'daemon'
    let cwd = sourceCwd
    let sessionWorkspace: SessionWorkspace = { mode: 'shared', sourceCwd }
    const isolate = () => {
      if (this.worktrees === undefined) {
        throw new SessionError(
          'workspace-isolation-failed',
          'Safe parallel checkout support is unavailable in this daemon build.',
        )
      }
      try {
        const prepared = this.worktrees.prepare(sourceCwd, sessionId)
        cwd = prepared.cwd
        sessionWorkspace = { mode: 'isolated', sourceCwd, branch: prepared.branch }
      } catch (error) {
        if (error instanceof WorktreeError) {
          throw new SessionError('workspace-isolation-failed', error.message)
        }
        throw error
      }
    }
    if (workspaceMode === 'isolated') isolate()
    try {
      this.acquireWorkspace({
        sessionId,
        cwd,
        origin,
        actor,
        ...(input.workspaceReservationId === undefined
          ? {}
          : { reservationId: input.workspaceReservationId }),
      })
    } catch (error) {
      // `auto` preserves the ordinary checkout for the first writer and transparently moves
      // a second writer to its own branch. The retry is against a different canonical path,
      // so the one-writer invariant remains intact.
      if (
        workspaceMode === 'auto' &&
        this.worktrees !== undefined &&
        input.workspaceReservationId === undefined &&
        error instanceof SessionError &&
        error.reason === 'workspace-conflict'
      ) {
        isolate()
        this.acquireWorkspace({ sessionId, cwd, origin, actor })
      } else throw error
    }
    this.claimed.add(sessionId)

    const suppliedTitle = input.title?.trim()
    const title = (suppliedTitle === undefined || suppliedTitle === '' ? prompt : suppliedTitle).slice(0, 80)
    const waiting = new Map<string, (decision: PermissionDecision) => void>()
    let handle: AgentRunHandle
    let persisted = false
    try {
      this.persistSession({
        sessionId,
        agent: agent.data,
        cwd,
        origin,
        title,
        status: 'running',
        startedAt: this.now(),
        ...(relationship === undefined ? {} : { relationship }),
        ...(settings === undefined ? {} : { settings }),
        workspace: sessionWorkspace,
      })
      persisted = true
      this.emit(sessionId, {
        type: 'session.started',
        payload: {
          agent: agent.data,
          cwd,
          title,
          origin,
          controller: 'longleash',
          ...(relationship === undefined ? {} : { relationship }),
          ...(settings === undefined ? {} : { settings }),
          workspace: sessionWorkspace,
        },
      })
      // The initial request is part of the conversation and needs its own durable sequence. Without
      // it Delegate could reference follow-ups but not the task that created the session.
      this.emit(sessionId, {
        type: 'stream.delta',
        payload: { kind: 'user', text: `\n\n› ${prompt}\n` },
      })
      this.audit(actor, 'session.start', `${agent.data} in ${cwd}`)
      handle = this.spawn(factory, sessionId, cwd, prompt, waiting, undefined, settings)
    } catch (error) {
      // Ownership is claimed before any durable lifecycle write. Every later synchronous
      // failure must release it; otherwise one bad adapter or disk write bricks this checkout.
      this.claimed.delete(sessionId)
      try { this.workspace?.release(sessionId, 'system:session', 'agent startup failed') } catch { /* original error wins */ }
      if (persisted) {
        try {
          this.markStatus(sessionId, 'errored')
          this.emit(sessionId, {
            type: 'session.errored',
            payload: { message: error instanceof Error ? error.message : 'Agent failed to start' },
          })
        } catch {
          // The original persistence/adapter failure remains the actionable root cause.
        }
      }
      throw error
    }

    const session: LiveSession = {
      sessionId,
      agent: agent.data,
      cwd,
      status: 'running',
      startedAt: this.now(),
      origin,
      title,
      ...(relationship === undefined ? {} : { relationship }),
      ...(settings === undefined ? {} : { settings }),
      workspace: sessionWorkspace,
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
      parent_session_id: string | null
      delegation_id: string | null
      delegation_role: string | null
      delegation_depth: number | null
      workspace_mode: string
      source_cwd: string | null
      workspace_branch: string | null
      settings_json: string | null
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
        live: live !== undefined,
        startedAt: row.started_at,
        resumable: row.agent_session_id !== null,
        ...(row.agent_session_id === null ? {} : { resumeId: row.agent_session_id }),
        ...relationshipFromRow(row),
        ...settingsFromRow(row.settings_json),
        workspace: workspaceFromRow(row),
        controller: 'longleash',
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
    agent: AgentKind
    cwd: string
    title: string
    origin: SessionOrigin
    startedAt: number
    agentSessionId: string
  }): void {
    this.approvals.rawDb
      .prepare(
        `INSERT INTO sessions (
           session_id, agent, cwd, origin, title, status, started_at, agent_session_id,
           workspace_mode, source_cwd
         )
         VALUES (?, ?, ?, ?, ?, 'ended', ?, ?, 'shared', ?)
         ON CONFLICT(session_id) DO UPDATE SET
           status = 'ended',
           agent = excluded.agent,
           origin = excluded.origin,
           cwd = excluded.cwd,
           title = excluded.title,
           agent_session_id = excluded.agent_session_id`,
      )
      .run(
        input.sessionId,
        input.agent,
        input.cwd,
        input.origin,
        input.title,
        input.startedAt,
        input.agentSessionId,
        input.cwd,
      )
  }

  private persistSession(summary: SessionSummary): void {
    const relationship = summary.relationship
    this.approvals.rawDb
      .prepare(
        `INSERT INTO sessions (
           session_id, agent, cwd, origin, title, status, started_at,
           parent_session_id, delegation_id, delegation_role, delegation_depth,
           workspace_mode, source_cwd, workspace_branch, settings_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        relationship?.parentSessionId ?? null,
        relationship?.delegationId ?? null,
        relationship?.role ?? null,
        relationship?.depth ?? null,
        summary.workspace?.mode ?? 'shared',
        summary.workspace?.sourceCwd ?? summary.cwd,
        summary.workspace?.branch ?? null,
        summary.settings === undefined ? null : JSON.stringify(summary.settings),
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
    settings?: SessionSettingsValue,
  ) {
    return factory({
      sessionId,
      cwd,
      prompt,
      ...(resume === undefined ? {} : { resume }),
      ...(settings === undefined ? {} : { settings }),
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
        // An already-open phone must learn this now. Previously the id only appeared in the
        // next hello/reload, so terminal handoff looked random: absent after launch, present
        // after refreshing the exact same session.
        const status = this.sessions.get(sessionId)?.status ?? 'running'
        this.emit(sessionId, {
          type: 'session.status',
          payload: { status, live: true, resumable: true, resumeId: agentSessionId },
        })
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
      | {
          agent: string
          cwd: string
          origin: string
          title: string
          started_at: number
          agent_session_id: string | null
          workspace_mode: string
        }
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
      this.assertSessionCwd(row.cwd, row.workspace_mode)
    } catch {
      return false
    }

    this.audit(actor, 'session.resume', sessionId)
    this.supersede(sessionId)
    this.markStatus(sessionId, 'waiting')
    this.emit(sessionId, {
      type: 'session.status',
      payload: { status: 'waiting', live: false, detail: 'reopened' },
    })
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
    try {
      this.acquireWorkspace({
        sessionId,
        cwd: session.cwd,
        origin: session.origin,
        actor,
      })
    } catch (error) {
      if (error instanceof SessionError && error.reason === 'workspace-conflict') return false
      throw error
    }
    this.audit(actor, 'message.send', `${sessionId}: ${trimmed.slice(0, 80)}`)
    session.status = 'running'
    this.markStatus(sessionId, 'running')
    this.emit(sessionId, { type: 'stream.delta', payload: { kind: 'user', text: `\n\n› ${trimmed}\n` } })
    this.emit(sessionId, {
      type: 'session.status',
      payload: { status: 'running', live: true, controller: 'longleash' },
    })
    session.handle.sendMessage(trimmed)
    return true
  }

  /** Continue an adopted external conversation while atomically claiming its handoff lease. */
  takeOver(sessionId: string, text: string, actor: string, reservationId: string): boolean {
    try {
      const delivered = this.wake(sessionId, text.trim(), actor, { reservationId })
      if (!delivered) {
        this.workspace?.releaseReservation(reservationId, actor, 'external takeover could not start')
      }
      return delivered
    } catch (error) {
      // A provider spawn can throw after the external process released. Never strand the
      // transfer reservation: no managed writer exists to justify keeping that checkout held.
      this.workspace?.releaseReservation(reservationId, actor, 'external takeover could not start')
      throw error
    }
  }

  /**
   * Deliver a reviewed orchestration boundary at most once from LongLeash's perspective.
   * The durable marker is written before the vendor call and marked sent only after acceptance.
   * A crash in that tiny gap is reported as `uncertain`: LongLeash will neither claim success
   * nor automatically risk injecting the same return twice.
   */
  sendMessageOnce(input: {
    sessionId: string
    text: string
    actor: string
    deliveryId: string
    workspaceReservationId?: string
  }): 'sent' | 'already-sent' | 'uncertain' | 'not-running' {
    const deliveryId = input.deliveryId.trim()
    const text = input.text
    if (deliveryId === '' || text.trim() === '') return 'not-running'
    const existing = this.approvals.rawDb
      .prepare('SELECT session_id, state FROM session_deliveries WHERE delivery_id = ?')
      .get(deliveryId) as { session_id: string; state: 'sending' | 'sent' } | undefined
    if (existing !== undefined) {
      if (existing.session_id !== input.sessionId) return 'not-running'
      return existing.state === 'sent' ? 'already-sent' : 'uncertain'
    }

    const session = this.sessions.get(input.sessionId)
    if (!session || (session.status !== 'running' && session.status !== 'waiting')) {
      return this.wake(input.sessionId, text, input.actor, {
        deliveryId,
        ...(input.workspaceReservationId === undefined
          ? {}
          : { reservationId: input.workspaceReservationId }),
      })
        ? 'sent'
        : 'not-running'
    }

    try {
      this.acquireWorkspace({
        sessionId: input.sessionId,
        cwd: session.cwd,
        origin: session.origin,
        actor: input.actor,
        ...(input.workspaceReservationId === undefined
          ? {}
          : { reservationId: input.workspaceReservationId }),
      })
    } catch (error) {
      if (error instanceof SessionError && error.reason === 'workspace-conflict') return 'not-running'
      throw error
    }
    this.rememberDelivery(deliveryId, input.sessionId)
    let acceptedByAgent = false
    try {
      this.audit(input.actor, 'message.return', `${input.sessionId}: ${deliveryId}`)
      session.status = 'running'
      this.markStatus(input.sessionId, 'running')
      this.emit(input.sessionId, { type: 'stream.delta', payload: { kind: 'user', text: `\n\n› ${text}\n` } })
      this.emit(input.sessionId, {
        type: 'session.status',
        payload: { status: 'running', live: true, controller: 'longleash' },
      })
      session.handle.sendMessage(text)
      acceptedByAgent = true
      this.markDeliverySent(deliveryId)
      return 'sent'
    } catch (error) {
      // Before the call crosses the adapter boundary, a clean retry is safe. Afterwards the
      // `sending` row intentionally remains: a reconnect reports uncertainty instead of
      // duplicating work because a follow-up database write failed.
      if (!acceptedByAgent) this.forgetDelivery(deliveryId)
      throw error
    }
  }

  /**
   * A conversation without a live process is dormant, not dead: the agent's transcript is on
   * disk and the SDK can resume it. So a reply revives the agent with that reply as its next
   * prompt — the alternative was telling the human to start over and lose everything, which is
   * exactly what happened when a daemon restart stranded a "waiting" session.
   */
  private wake(
    sessionId: string,
    text: string,
    actor: string,
    opts: { deliveryId?: string; reservationId?: string } = {},
  ): boolean {
    const row = this.approvals.rawDb
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as
      | {
          agent: string
          cwd: string
          origin: string
          title: string
          started_at: number
          agent_session_id: string | null
          workspace_mode: string
          source_cwd: string | null
          workspace_branch: string | null
          settings_json: string | null
        }
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
      cwd = this.assertSessionCwd(row.cwd, row.workspace_mode)
    } catch {
      return false
    }

    try {
      this.acquireWorkspace({
        sessionId,
        cwd,
        origin: SessionOrigin.catch('daemon').parse(row.origin),
        actor,
        ...(opts.reservationId === undefined ? {} : { reservationId: opts.reservationId }),
      })
    } catch (error) {
      if (error instanceof SessionError && error.reason === 'workspace-conflict') return false
      throw error
    }

    this.audit(actor, 'session.wake', `${sessionId}: ${text.slice(0, 80)}`)
    this.supersede(sessionId)
    const waiting = new Map<string, (decision: PermissionDecision) => void>()
    if (opts.deliveryId !== undefined) this.rememberDelivery(opts.deliveryId, sessionId)
    let handle: AgentRunHandle
    try {
      const savedSettings = settingsFromRow(row.settings_json).settings
      handle = this.spawn(factory, sessionId, cwd, text, waiting, row.agent_session_id, savedSettings)
    } catch (error) {
      if (opts.deliveryId !== undefined) this.forgetDelivery(opts.deliveryId)
      this.workspace?.release(sessionId, 'system:session', 'agent wake failed')
      throw error
    }
    const session: LiveSession = {
      sessionId,
      agent: agent.data,
      cwd,
      status: 'running',
      startedAt: row.started_at,
      origin: SessionOrigin.catch('daemon').parse(row.origin),
      title: row.title,
      ...settingsFromRow(row.settings_json),
      workspace: workspaceFromRow(row),
      handle,
      waiting,
      done: Promise.resolve(),
    }
    this.sessions.set(sessionId, session)
    this.claimed.add(sessionId)
    session.done = this.consume(session)
    // The adapter has accepted the prompt now. If any durable write below fails, keep both the
    // live session and the `sending` marker so recovery says "uncertain" rather than resending.
    if (opts.deliveryId !== undefined) this.markDeliverySent(opts.deliveryId)
    this.markStatus(sessionId, 'running')
    this.emit(sessionId, { type: 'stream.delta', payload: { kind: 'user', text: `\n\n› ${text}\n` } })
    this.emit(sessionId, {
      type: 'session.status',
      payload: { status: 'running', live: true, controller: 'longleash' },
    })
    return true
  }

  /** Pause without replaying a prompt, preserving the native resume point for a safe handoff. */
  async pauseSession(sessionId: string, actor: string, reason: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'running' && session.status !== 'waiting')) {
      const row = this.approvals.rawDb
        .prepare('SELECT agent_session_id FROM sessions WHERE session_id = ?')
        .get(sessionId) as { agent_session_id: string | null } | undefined
      return row?.agent_session_id !== null && row !== undefined
    }
    const resumeId = this.resumeIdOf(sessionId)
    if (resumeId === undefined) return false
    this.audit(actor, 'session.pause', `${sessionId}: ${reason.slice(0, 160)}`)
    session.superseded = true
    // Ask the adapter to stop, but trust only the event stream closing as evidence that the
    // writer is gone. The deadline prevents a broken vendor adapter from freezing the phone's
    // handoff forever; on timeout the existing writer keeps its lease and remains visible.
    void Promise.resolve()
      .then(() => session.handle.interrupt())
      .catch(() => {})
    const drained = await settlesWithin(session.done, this.pauseTimeoutMs)
    if (!drained) {
      session.superseded = false
      this.audit(actor, 'session.pause-failed', `${sessionId}: adapter did not stop within ${this.pauseTimeoutMs}ms`)
      return false
    }
    this.sessions.delete(sessionId)
    this.claimed.delete(sessionId)
    this.releasePending(session, 'Session paused for workspace handoff')
    this.markStatus(sessionId, 'waiting')
    this.emit(sessionId, {
      type: 'session.status',
      payload: {
        status: 'waiting',
        live: false,
        resumable: true,
        resumeId,
        detail: reason,
      },
    })
    // A reservation may already own the row; release is intentionally a no-op in that case.
    this.workspace?.release(sessionId, actor, reason)
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
    // We commit the terminal event below. The draining generator must not append a second,
    // contradictory ending after Stop has already been acknowledged.
    session.superseded = true
    void Promise.resolve()
      .then(() => session.handle.interrupt())
      .catch(() => {})
    if (!(await settlesWithin(session.done, this.pauseTimeoutMs))) {
      session.superseded = false
      this.audit(actor, 'session.stop-failed', `${sessionId}: adapter did not stop within ${this.pauseTimeoutMs}ms`)
      return false
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
    this.workspace?.release(sessionId, actor, 'session stopped')
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
    // A daemon shutdown is an interruption, not successful task completion. Suppress each
    // iterator's ordinary end event, then persist whether the conversation can be resumed.
    for (const session of live) session.superseded = true
    for (const session of live) {
      void Promise.resolve()
        .then(() => session.handle.interrupt())
        .catch(() => {})
    }
    // Shutdown is allowed to outlive an uncooperative adapter, but never indefinitely. The
    // daemon owns those processes and process exit is the final backstop after state is saved.
    await Promise.all(live.map((session) => settlesWithin(session.done, this.pauseTimeoutMs)))
    for (const session of live) {
      const resumeId = this.resumeIdOf(session.sessionId)
      if (resumeId !== undefined) {
        this.markStatus(session.sessionId, 'waiting')
        this.emit(session.sessionId, {
          type: 'session.status',
          payload: {
            status: 'waiting',
            live: false,
            resumable: true,
            resumeId,
            detail: 'interrupted by daemon shutdown',
          },
        })
      } else {
        this.markStatus(session.sessionId, 'errored')
        this.emit(session.sessionId, {
          type: 'session.errored',
          payload: { message: 'Daemon stopped before the agent created a resume point.' },
        })
      }
      this.workspace?.release(session.sessionId, 'system:shutdown', 'daemon shutdown')
    }
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
    this.workspace?.release(sessionId, actor, 'dormant session closed')
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

  /** Typed orchestration layers share the same append-only machine audit. */
  recordAudit(actor: string, action: string, detail: string): void {
    this.audit(actor, action, detail)
  }

  private audit(actor: string, action: string, detail: string): void {
    this.approvals.rawDb
      .prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .run(this.now(), actor, action, detail.slice(0, 500))
  }

  private acquireWorkspace(input: {
    sessionId: string
    cwd: string
    origin: SessionOrigin
    actor: string
    reservationId?: string
  }): void {
    if (this.workspace === undefined) return
    try {
      if (input.reservationId !== undefined) {
        this.workspace.claimReservation({
          reservationId: input.reservationId,
          sessionId: input.sessionId,
          cwd: input.cwd,
          ownerKind: 'session',
          ownerOrigin: input.origin,
          actor: input.actor,
        })
      } else {
        this.workspace.acquire({
          sessionId: input.sessionId,
          cwd: input.cwd,
          ownerKind: 'session',
          ownerOrigin: input.origin,
          actor: input.actor,
        })
      }
    } catch (error) {
      if (error instanceof WorkspaceLeaseError) {
        throw new SessionError('workspace-conflict',
          'Another active session owns this checkout. Choose Safe parallel to create an isolated Git branch, or open and stop the controlling session.', {
          ...(error.conflict?.ownerId === undefined ? {} : { ownerSessionId: error.conflict.ownerId }),
          ...(error.conflict?.cwd === undefined ? {} : { cwd: error.conflict.cwd }),
        })
      }
      throw error
    }
  }

  private rememberDelivery(deliveryId: string, sessionId: string): void {
    this.approvals.rawDb
      .prepare("INSERT INTO session_deliveries (delivery_id, session_id, state, created_at) VALUES (?, ?, 'sending', ?)")
      .run(deliveryId, sessionId, this.now())
  }

  private markDeliverySent(deliveryId: string): void {
    this.approvals.rawDb
      .prepare("UPDATE session_deliveries SET state = 'sent' WHERE delivery_id = ? AND state = 'sending'")
      .run(deliveryId)
  }

  private forgetDelivery(deliveryId: string): void {
    this.approvals.rawDb.prepare('DELETE FROM session_deliveries WHERE delivery_id = ?').run(deliveryId)
  }

  private releasePending(session: LiveSession, message: string): void {
    for (const [approvalId, resolve] of session.waiting) {
      const decided = this.approvals.decide(approvalId, 'denied', 'system:session-ended', message)
      if (decided) {
        this.emit(session.sessionId, {
          type: 'approval.decided',
          payload: {
            approvalId,
            verdict: 'deny',
            decidedBy: 'system:session-ended',
            reply: message,
          },
        })
      }
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
          this.emit(session.sessionId, {
            type: 'session.status',
            payload: { status: 'waiting', live: true },
          })
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
      this.workspace?.release(session.sessionId, 'system:session', 'agent process ended')
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

  private assertSessionCwd(cwd: string, workspaceMode: string): string {
    if (workspaceMode !== 'isolated') return this.assertAllowedCwd(cwd)
    let real: string
    try {
      real = realpathSync(resolve(cwd))
    } catch {
      throw new SessionError('cwd-not-allowed', `The isolated checkout no longer exists: ${cwd}`)
    }
    if (!this.worktrees?.owns(real)) {
      throw new SessionError('cwd-not-allowed', 'The isolated checkout is outside LongLeash-managed storage.')
    }
    return real
  }
}
