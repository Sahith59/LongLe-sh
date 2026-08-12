import {
  MAX_DELEGATION_DEPTH,
  type DelegationContextScope,
  type DelegationRole,
  type DelegationSummary,
  type DelegationTargetAgent,
  type SessionEvent,
} from '@longleash/protocol'
import type { BriefingBuilder } from './briefing.js'
import type { ReturnBuilder, ReturnDraft } from './return-builder.js'
import { WorkspaceLeaseError, type WorkspaceLeaseManager } from './workspace-leases.js'
import {
  DelegationError,
  DelegationStore,
  summarizeDelegation,
  type DelegationRecord,
} from './delegations.js'
import type { SessionListing, SessionManager } from './sessions.js'

export const DEFAULT_MAX_ACTIVE_DELEGATIONS_PER_SOURCE = 3

export interface StartDelegationInput {
  idempotencyKey: string
  sourceSessionId: string
  sourceSeq?: number
  targetAgent: DelegationTargetAgent
  role: DelegationRole
  contextScope: DelegationContextScope
  briefing: string
  createdBy: string
}

export type DelegationManagerReason =
  | 'unknown-source'
  | 'target-unavailable'
  | 'max-depth'
  | 'too-many-delegations'
  | 'launch-failed'
  | 'invalid-input'
  | 'idempotency-conflict'
  | 'unknown-delegation'
  | 'return-not-ready'
  | 'takeover-required'
  | 'delivery-failed'
  | 'workspace-conflict'

export class DelegationManagerError extends Error {
  constructor(readonly reason: DelegationManagerReason, message: string) {
    super(message)
    this.name = 'DelegationManagerError'
  }
}

export interface DelegationManagerOptions {
  store: DelegationStore
  sessions: SessionManager
  briefings: BriefingBuilder
  /** Includes phone-managed and currently observed terminal/editor sessions. */
  sourceSessions: () => SessionListing[]
  onUpdate?: (delegation: DelegationSummary) => void
  maxActivePerSource?: number
  returns?: ReturnBuilder
  workspace?: WorkspaceLeaseManager
  /** Stops a managed or external source without inventing a follow-up prompt. */
  pauseSession?: (session: SessionListing, actor: string, reason: string) => Promise<boolean>
}

/**
 * The single authority allowed to turn a confirmed briefing into a child agent.
 *
 * State moves to `starting` synchronously before the first await. That makes two taps, two
 * relay deliveries, and a reconnect retry converge on one durable record and one child.
 */
export class DelegationManager {
  private readonly store: DelegationStore
  private readonly sessions: SessionManager
  private readonly briefings: BriefingBuilder
  private readonly sourceSessions: () => SessionListing[]
  private readonly onUpdate: ((delegation: DelegationSummary) => void) | undefined
  private readonly maxActivePerSource: number
  private readonly returns: ReturnBuilder | undefined
  private readonly workspace: WorkspaceLeaseManager | undefined
  private readonly pauseSession: DelegationManagerOptions['pauseSession']
  /** One return may cross the asynchronous pause/resume boundary per delegation at a time. */
  private readonly returning = new Map<
    string,
    Promise<{ delegation: DelegationSummary; created: boolean }>
  >()

  constructor(opts: DelegationManagerOptions) {
    this.store = opts.store
    this.sessions = opts.sessions
    this.briefings = opts.briefings
    this.sourceSessions = opts.sourceSessions
    this.onUpdate = opts.onUpdate
    this.maxActivePerSource = opts.maxActivePerSource ?? DEFAULT_MAX_ACTIVE_DELEGATIONS_PER_SOURCE
    this.returns = opts.returns
    this.workspace = opts.workspace
    this.pauseSession = opts.pauseSession
    if (!Number.isInteger(this.maxActivePerSource) || this.maxActivePerSource < 1) {
      throw new Error('maxActivePerSource must be a positive integer')
    }
    this.reconcile()
  }

  capabilities() {
    const targets = {
      claude: this.sessions.supportsAgent('claude'),
      codex: this.sessions.supportsAgent('codex'),
    }
    return {
      preview: true,
      start: targets.claude || targets.codex,
      targets,
      maxDepth: MAX_DELEGATION_DEPTH,
      maxActivePerSource: this.maxActivePerSource,
      return: this.returns !== undefined,
      workspace: this.workspace !== undefined && this.pauseSession !== undefined ? 'sequential' : 'legacy',
    }
  }

  list(): DelegationSummary[] {
    return this.store.list().map(summarizeDelegation)
  }

  async start(input: StartDelegationInput): Promise<{ delegation: DelegationSummary; created: boolean }> {
    const accepted = this.store.findByIdempotencyKey(input.idempotencyKey.trim())
    if (accepted !== null && accepted.status !== 'draft') {
      // Reconnect retries must remain answerable even if the source transcript was pruned or
      // the target adapter was disabled after the original launch. The store still compares
      // every creation field, so a changed request cannot hide behind the old key.
      try {
        const replay = this.store.createDraft({ ...input, depth: accepted.depth })
        return { delegation: summarizeDelegation(replay.record), created: false }
      } catch (error) {
        if (error instanceof DelegationError) {
          throw new DelegationManagerError(
            error.reason === 'idempotency-conflict' ? 'idempotency-conflict' : 'invalid-input',
            error.message,
          )
        }
        throw error
      }
    }

    // An external conversation can share its stable id with the dormant managed row created
    // when it was previously handed to the phone. Prefer the currently live driver; picking
    // the historical row would skip takeover and then fail against its own checkout lease.
    const sourceMatches = this.sourceSessions().filter(
      (session) => session.sessionId === input.sourceSessionId,
    )
    const source = sourceMatches.find((session) => session.live) ?? sourceMatches[0]
    if (source === undefined) {
      throw new DelegationManagerError('unknown-source', 'That source session is no longer available.')
    }
    if (!this.sessions.supportsAgent(input.targetAgent)) {
      throw new DelegationManagerError(
        'target-unavailable',
        `${agentName(input.targetAgent)} is not installed or configured on this laptop.`,
      )
    }
    if (this.workspace !== undefined && source.live && this.pauseSession === undefined) {
      throw new DelegationManagerError(
        'launch-failed',
        'Protected handoff is misconfigured: the live source cannot be paused safely.',
      )
    }

    const depth = (source.relationship?.depth ?? 0) + 1
    if (depth > MAX_DELEGATION_DEPTH) {
      throw new DelegationManagerError(
        'max-depth',
        `V1 supports ${MAX_DELEGATION_DEPTH} delegation levels. Return to an earlier session to delegate again.`,
      )
    }

    // The edited briefing is intentionally accepted verbatim, but its claimed source message
    // must be real. Rebuilding the deterministic preview validates both source and sequence.
    try {
      this.briefings.build({
        sourceSessionId: input.sourceSessionId,
        ...(input.sourceSeq === undefined ? {} : { sourceSeq: input.sourceSeq }),
        targetAgent: input.targetAgent,
        role: input.role,
        contextScope: input.contextScope,
      })
    } catch (error) {
      throw new DelegationManagerError(
        'invalid-input',
        error instanceof Error ? error.message : 'The selected source context is no longer available.',
      )
    }

    if (accepted === null) {
      const active = this.store
        .listForSession(input.sourceSessionId)
        .filter(
          (record) =>
            record.sourceSessionId === input.sourceSessionId &&
            (record.status === 'starting' || record.status === 'running'),
        ).length
      if (active >= this.maxActivePerSource) {
        throw new DelegationManagerError(
          'too-many-delegations',
          `This session already has ${active} delegated agents running. Wait for one to finish or stop it first.`,
        )
      }
    }

    let created: boolean
    let record: DelegationRecord
    try {
      const result = this.store.createDraft({ ...input, depth })
      created = result.created
      record = result.record
      if (created) {
        this.sessions.recordAudit(
          input.createdBy,
          'delegation.create',
          `${record.delegationId} from ${record.sourceSessionId} to ${record.targetAgent}`,
        )
      }
    } catch (error) {
      if (error instanceof DelegationError) {
        throw new DelegationManagerError(
          error.reason === 'idempotency-conflict' ? 'idempotency-conflict' : 'invalid-input',
          error.message,
        )
      }
      throw error
    }

    // A replay after the first request crossed the launch boundary observes its durable state.
    if (record.status !== 'draft') {
      return { delegation: summarizeDelegation(record), created: false }
    }

    record = this.store.markStarting(record.delegationId)
    this.sessions.recordAudit(input.createdBy, 'delegation.start', record.delegationId)
    this.notify(record)
    let reserved = false
    try {
      if (this.workspace !== undefined) {
        this.workspace.reserveTransfer({
          reservationId: record.delegationId,
          cwd: source.cwd,
          ...(source.live ? { fromSessionId: source.sessionId } : {}),
          actor: input.createdBy,
        })
        reserved = true
        if (source.live && this.pauseSession !== undefined) {
          const paused = await this.pauseSession(
            source,
            input.createdBy,
            `Workspace handed to delegated ${agentName(record.targetAgent)} child`,
          )
          if (!paused) {
            const sourceIsLive = () => this.sourceSessions().some(
              (session) => session.sessionId === source.sessionId && session.live,
            )
            if (sourceIsLive()) {
              this.workspace.restoreReservation({
                reservationId: record.delegationId,
                sessionId: source.sessionId,
                cwd: source.cwd,
                ownerKind: source.origin === 'terminal' || source.origin === 'vscode' ? 'external' : 'session',
                ownerOrigin: source.origin,
                actor: input.createdBy,
              })
              // The process may have ended between the failed pause and the transactional
              // restore. Re-check after restoration so that race cannot leave dead authority
              // blocking the checkout until the next daemon restart.
              if (!sourceIsLive()) {
                this.workspace.release(source.sessionId, 'system:delegation', 'source ended during failed handoff')
              }
            } else {
              this.workspace.releaseReservation(
                record.delegationId,
                'system:delegation',
                'source ended during failed handoff',
              )
            }
            throw new DelegationManagerError(
              'workspace-conflict',
              'The source could not be paused safely because it has no recoverable conversation point.',
            )
          }
        }
      }
      const { sessionId } = await this.sessions.startSession({
        agent: record.targetAgent,
        cwd: source.cwd,
        prompt: record.briefing,
        preservePromptWhitespace: true,
        title: `${roleName(record.role)} · ${source.title || 'delegated task'}`,
        origin: 'phone',
        relationship: {
          delegationId: record.delegationId,
          parentSessionId: record.sourceSessionId,
          role: record.role,
          depth: record.depth,
        },
        actor: input.createdBy,
        ...(this.workspace === undefined ? {} : { workspaceReservationId: record.delegationId }),
      })
      // The session.started event normally attaches this synchronously. Keep this idempotent
      // fallback for managers embedded without an event mirror.
      const current = this.store.get(record.delegationId)
      if (current?.status === 'starting') {
        record = this.store.attachTarget(record.delegationId, sessionId)
        this.sessions.recordAudit(
          input.createdBy,
          'delegation.attach',
          `${record.delegationId} -> ${sessionId}`,
        )
        this.notify(record)
      } else if (current !== null) {
        record = current
      }
      return { delegation: summarizeDelegation(record), created }
    } catch (error) {
      if (reserved) {
        this.workspace?.releaseReservation(record.delegationId, 'system:delegation', 'child launch failed')
      }
      const current = this.store.get(record.delegationId)
      if (current !== null && current.status !== 'failed') {
        try {
          record = this.store.fail(
            record.delegationId,
            error instanceof Error ? error.message : 'The target agent failed to start.',
          )
          this.sessions.recordAudit('system:delegation', 'delegation.fail', record.delegationId)
          this.notify(record)
        } catch {
          // A simultaneous terminal event won the state transition; its update is authoritative.
        }
      }
      throw new DelegationManagerError(
        error instanceof DelegationManagerError
          ? error.reason
          : error instanceof WorkspaceLeaseError
            ? 'workspace-conflict'
            : 'launch-failed',
        error instanceof Error ? error.message : 'The target agent failed to start.',
      )
    }
  }

  prepareReturn(delegationId: string): ReturnDraft & {
    delegationId: string
    parent: SessionListing
    child: SessionListing
    role: DelegationRole
    requiresTakeover: boolean
  } {
    if (this.returns === undefined) {
      throw new DelegationManagerError('return-not-ready', 'Reviewed returns are unavailable on this daemon.')
    }
    const record = this.store.get(delegationId)
    if (record === null) throw new DelegationManagerError('unknown-delegation', 'That delegation no longer exists.')
    if (record.status !== 'ready' && record.status !== 'returned') {
      throw new DelegationManagerError(
        'return-not-ready',
        'The child has not completed a response that can be reviewed yet.',
      )
    }
    if (record.targetSessionId === undefined) {
      throw new DelegationManagerError('return-not-ready', 'The delegated child session is missing.')
    }
    const all = this.sourceSessions()
    const parents = all.filter((session) => session.sessionId === record.sourceSessionId)
    const parent = parents.find((session) => session.live) ?? parents[0]
    const child = all.find((session) => session.sessionId === record.targetSessionId)
    if (parent === undefined || child === undefined) {
      throw new DelegationManagerError('return-not-ready', 'The parent or child session is unavailable.')
    }
    const draft = this.returns.build({
      childSessionId: child.sessionId,
      childAgent: child.agent,
      childTitle: child.title,
      role: record.role,
    })
    return {
      ...draft,
      delegationId,
      parent,
      child,
      role: record.role,
      requiresTakeover: parents.some(
        (session) => session.live && (session.origin === 'terminal' || session.origin === 'vscode'),
      ),
    }
  }

  async returnDelegation(input: {
    delegationId: string
    idempotencyKey: string
    returnText: string
    takeoverConfirmed: boolean
    actor: string
  }): Promise<{ delegation: DelegationSummary; created: boolean }> {
    const pending = this.returning.get(input.delegationId)
    if (pending !== undefined) {
      // Replay only after the winner is durable. The same operation converges; changed text or
      // a changed key is rejected before another parent delivery can cross the boundary.
      try { await pending } catch { /* a failed winner leaves the ready operation retryable */ }
      return this.returnDelegation(input)
    }
    const operation = this.deliverReturn(input)
    this.returning.set(input.delegationId, operation)
    try {
      return await operation
    } finally {
      if (this.returning.get(input.delegationId) === operation) {
        this.returning.delete(input.delegationId)
      }
    }
  }

  private async deliverReturn(input: {
    delegationId: string
    idempotencyKey: string
    returnText: string
    takeoverConfirmed: boolean
    actor: string
  }): Promise<{ delegation: DelegationSummary; created: boolean }> {
    let record = this.store.get(input.delegationId)
    if (record === null) throw new DelegationManagerError('unknown-delegation', 'That delegation no longer exists.')
    if (record.status === 'returned') {
      try {
        const replay = this.store.markReturned(input.delegationId, {
          returnText: input.returnText,
          idempotencyKey: input.idempotencyKey,
          returnedBy: input.actor,
        })
        return { delegation: summarizeDelegation(replay.record), created: false }
      } catch (error) {
        throw delegationStoreError(error)
      }
    }
    const preview = this.prepareReturn(input.delegationId)
    if (preview.requiresTakeover && !input.takeoverConfirmed) {
      throw new DelegationManagerError(
        'takeover-required',
        'The parent is still running in Terminal or VS Code. Confirm takeover before returning into it.',
      )
    }
    const childId = record.targetSessionId!
    const sourceId = record.sourceSessionId
    if (this.workspace !== undefined && preview.child.live && this.pauseSession === undefined) {
      throw new DelegationManagerError(
        'delivery-failed',
        'Protected return is misconfigured: the live child cannot be paused safely.',
      )
    }
    let reserved = false
    try {
      if (this.workspace !== undefined) {
        this.workspace.reserveTransfer({
          reservationId: `return:${record.delegationId}`,
          cwd: preview.parent.cwd,
          fromSessionId: childId,
          actor: input.actor,
        })
        reserved = true
      }

      if (preview.child.live && this.pauseSession !== undefined) {
        const paused = await this.pauseSession(
          preview.child,
          input.actor,
          'Workspace handed back to the source session',
        )
        if (!paused) throw new DelegationManagerError('delivery-failed', 'The child could not be paused safely.')
      }

      if (preview.requiresTakeover && this.pauseSession !== undefined) {
        const liveParent = this.sourceSessions().find(
          (session) =>
            session.sessionId === record!.sourceSessionId &&
            session.live &&
            (session.origin === 'terminal' || session.origin === 'vscode'),
        )
        if (liveParent !== undefined) {
          const stopped = await this.pauseSession(liveParent, input.actor, 'Taken over for reviewed return')
          if (!stopped) throw new DelegationManagerError('delivery-failed', 'The external parent could not be stopped.')
        }
      }

      const attribution = `${preview.attribution}\nDelegation: ${record.delegationId}`
      const delivery = this.sessions.sendMessageOnce({
        sessionId: record.sourceSessionId,
        text: `${attribution}\n\n${input.returnText}`,
        actor: input.actor,
        deliveryId: `delegation-return:${input.idempotencyKey}`,
        ...(this.workspace === undefined
          ? {}
          : { workspaceReservationId: `return:${record.delegationId}` }),
      })
      if (delivery === 'not-running') {
        throw new DelegationManagerError(
          'delivery-failed',
          'The parent could not be resumed. Its folder may no longer be allowed or its native resume point is missing.',
        )
      }
      if (delivery === 'uncertain') {
        throw new DelegationManagerError(
          'delivery-failed',
          'Delivery was interrupted at the vendor boundary. Inspect the parent transcript first; LongLeash will not automatically resend and risk duplicate work.',
        )
      }
      const returned = this.store.markReturned(record.delegationId, {
        returnText: input.returnText,
        idempotencyKey: input.idempotencyKey,
        returnedBy: input.actor,
      })
      record = returned.record
      this.sessions.recordAudit(input.actor, 'delegation.return', record.delegationId)
      this.notify(record)
      return { delegation: summarizeDelegation(record), created: returned.created }
    } catch (error) {
      if (reserved) {
        const reservationId = `return:${record.delegationId}`
        const activeWriter = this.sourceSessions().find(
          (session) =>
            session.live &&
            (session.sessionId === childId || session.sessionId === sourceId),
        )
        if (activeWriter !== undefined) {
          const restored = this.workspace?.restoreReservation({
            reservationId,
            sessionId: activeWriter.sessionId,
            cwd: activeWriter.cwd,
            ownerKind:
              activeWriter.origin === 'terminal' || activeWriter.origin === 'vscode'
                ? 'external'
                : 'session',
            ownerOrigin: activeWriter.origin,
            actor: 'system:delegation',
          })
          // The process can finish while the failed operation is unwinding. Never turn that
          // race into a dead lease merely because it was live one lookup ago.
          const stillLive = this.sourceSessions().some(
            (session) => session.sessionId === activeWriter.sessionId && session.live,
          )
          if (restored !== null && !stillLive) {
            this.workspace?.release(
              activeWriter.sessionId,
              'system:delegation',
              'writer ended during failed return',
            )
          }
        } else {
          this.workspace?.releaseReservation(
            reservationId,
            'system:delegation',
            'return delivery failed',
          )
        }
      }
      if (error instanceof DelegationManagerError) throw error
      throw delegationStoreError(error)
    }
  }

  /** Keep orchestration lifecycle derived from the ordinary child session lifecycle. */
  handleSessionEvent(event: SessionEvent): void {
    if (event.type === 'session.started') {
      const relationship = event.payload.relationship
      if (relationship === undefined) return
      const record = this.store.get(relationship.delegationId)
      if (record?.status !== 'starting') return
      const attached = this.store.attachTarget(record.delegationId, event.sessionId)
      this.sessions.recordAudit(
        record.createdBy,
        'delegation.attach',
        `${record.delegationId} -> ${event.sessionId}`,
      )
      this.notify(attached)
      return
    }

    const record = this.store.findByTargetSession(event.sessionId)
    if (record === null) return
    try {
      if (event.type === 'session.errored' && record.status === 'running') {
        const failed = this.store.fail(record.delegationId, event.payload.message)
        this.sessions.recordAudit('system:delegation', 'delegation.fail', record.delegationId)
        this.notify(failed)
      } else if (
        event.type === 'session.status' &&
        event.payload.status === 'waiting' &&
        event.payload.live !== false &&
        record.status === 'running'
      ) {
        const ready = this.store.markReady(record.delegationId)
        this.sessions.recordAudit('system:delegation', 'delegation.ready', record.delegationId)
        this.notify(ready)
      } else if (event.type === 'session.ended' && record.status === 'running') {
        const stopped = event.payload.reason?.toLowerCase().startsWith('stopped by ') === true
        const finished = stopped
          ? this.store.cancel(record.delegationId)
          : this.store.markReady(record.delegationId)
        this.sessions.recordAudit(
          stopped ? event.payload.reason!.slice('stopped by '.length) : 'system:delegation',
          stopped ? 'delegation.cancel' : 'delegation.ready',
          record.delegationId,
        )
        this.notify(finished)
      }
    } catch {
      // Session events can race (interrupt followed by generator completion). The first durable
      // terminal transition wins; later duplicates must not turn into daemon failures.
    }
  }

  /** Repair only states for which the persisted child relationship provides hard evidence. */
  private reconcile(): void {
    const sessions = this.sourceSessions()
    for (const record of this.store.list()) {
      if (record.status === 'starting') {
        const children = sessions.filter(
          (session) => session.relationship?.delegationId === record.delegationId,
        )
        if (children.length === 1) {
          const attached = this.store.attachTarget(record.delegationId, children[0]!.sessionId)
          this.sessions.recordAudit('system:recovery', 'delegation.recover-attach', record.delegationId)
          this.notify(attached)
        } else if (children.length === 0) {
          // SessionManager persists attribution before spawning. No child row means launch never
          // crossed that point, so returning to draft is safe and lets the same key retry.
          const reset = this.store.resetStarting(record.delegationId)
          this.sessions.recordAudit('system:recovery', 'delegation.recover-draft', record.delegationId)
          this.notify(reset)
        } else {
          const failed = this.store.fail(record.delegationId, 'Multiple child sessions claimed this delegation.')
          this.sessions.recordAudit('system:recovery', 'delegation.fail', record.delegationId)
          this.notify(failed)
        }
        continue
      }
      if (record.status !== 'running' || record.targetSessionId === undefined) continue
      const child = sessions.find((session) => session.sessionId === record.targetSessionId)
      if (child === undefined) {
        const failed = this.store.fail(record.delegationId, 'The delegated child session is missing.')
        this.sessions.recordAudit('system:recovery', 'delegation.fail', record.delegationId)
        this.notify(failed)
      } else if (child.status === 'errored') {
        const failed = this.store.fail(record.delegationId, 'The delegated child session failed.')
        this.sessions.recordAudit('system:recovery', 'delegation.fail', record.delegationId)
        this.notify(failed)
      } else if (child.status === 'ended') {
        const ready = this.store.markReady(record.delegationId)
        this.sessions.recordAudit('system:recovery', 'delegation.ready', record.delegationId)
        this.notify(ready)
      }
    }
  }

  private notify(record: DelegationRecord): void {
    this.onUpdate?.(summarizeDelegation(record))
  }
}

function delegationStoreError(error: unknown): DelegationManagerError {
  if (error instanceof WorkspaceLeaseError) {
    return new DelegationManagerError('workspace-conflict', error.message)
  }
  if (error instanceof DelegationError) {
    return new DelegationManagerError(
      error.reason === 'idempotency-conflict'
        ? 'idempotency-conflict'
        : error.reason === 'unknown-delegation'
          ? 'unknown-delegation'
          : 'invalid-input',
      error.message,
    )
  }
  return new DelegationManagerError(
    'delivery-failed',
    error instanceof Error ? error.message : 'Could not deliver the reviewed return.',
  )
}

function agentName(agent: DelegationTargetAgent): string {
  return agent === 'claude' ? 'Claude' : 'Codex'
}

function roleName(role: DelegationRole): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1)
}
