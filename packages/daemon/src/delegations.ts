import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  DelegationContextScope,
  DelegationRole,
  DelegationStatus,
  MAX_DELEGATION_BRIEFING_CHARACTERS,
  MAX_DELEGATION_DEPTH,
  type DelegationSummary,
  type SessionRelationship,
} from '@longleash/protocol'
import { ensureColumns } from './migrate.js'

export type DelegationTargetAgent = 'claude' | 'codex'

export interface DelegationRecord {
  delegationId: string
  idempotencyKey: string
  sourceSessionId: string
  sourceSeq?: number
  targetSessionId?: string
  targetAgent: DelegationTargetAgent
  role: DelegationRole
  contextScope: DelegationContextScope
  depth: number
  briefing: string
  returnText?: string
  returnIdempotencyKey?: string
  returnedBy?: string
  returnedAt?: number
  status: DelegationStatus
  failure?: string
  createdBy: string
  createdAt: number
  updatedAt: number
}

export interface CreateDelegationInput {
  idempotencyKey: string
  sourceSessionId: string
  sourceSeq?: number
  targetAgent: DelegationTargetAgent
  role: DelegationRole
  contextScope: DelegationContextScope
  depth: number
  briefing: string
  createdBy: string
}

export class DelegationError extends Error {
  constructor(
    readonly reason: 'invalid-input' | 'idempotency-conflict' | 'unknown-delegation' | 'invalid-transition',
    message: string,
  ) {
    super(message)
    this.name = 'DelegationError'
  }
}

interface DelegationRow {
  delegation_id: string
  idempotency_key: string
  source_session_id: string
  source_seq: number | null
  target_session_id: string | null
  target_agent: string
  role: string
  context_scope: string
  depth: number
  briefing: string
  return_text: string | null
  return_idempotency_key: string | null
  returned_by: string | null
  returned_at: number | null
  status: string
  failure: string | null
  created_by: string
  created_at: number
  updated_at: number
}

const TARGET_AGENTS = new Set<DelegationTargetAgent>(['claude', 'codex'])
const TERMINAL = new Set<DelegationStatus>(['returned', 'cancelled', 'failed'])
const newId = () => `del_${randomBytes(9).toString('base64url')}`

/**
 * Durable delegation identity and lifecycle.
 *
 * This store intentionally does not start agents. The later DelegationManager composes it with
 * SessionManager, workspace leases, and transcript selection. Keeping persistence independent
 * makes retries and daemon restarts testable without launching a vendor process.
 */
export class DelegationStore {
  private readonly db: Database.Database
  private readonly now: () => number

  constructor(db: Database.Database, opts: { now?: () => number } = {}) {
    this.db = db
    this.now = opts.now ?? Date.now
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegations (
        delegation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        source_session_id TEXT NOT NULL,
        source_seq INTEGER,
        target_session_id TEXT UNIQUE,
        target_agent TEXT NOT NULL,
        role TEXT NOT NULL,
        context_scope TEXT NOT NULL,
        depth INTEGER NOT NULL,
        briefing TEXT NOT NULL,
        return_text TEXT,
        status TEXT NOT NULL,
        failure TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (source_seq IS NULL OR source_seq > 0),
        CHECK (depth BETWEEN 1 AND 2),
        CHECK (target_agent IN ('claude', 'codex')),
        CHECK (role IN ('investigate', 'review', 'implement', 'test')),
        CHECK (context_scope IN ('selected', 'recent', 'task')),
        CHECK (status IN ('draft', 'starting', 'running', 'ready', 'returned', 'cancelled', 'failed'))
      );
      CREATE INDEX IF NOT EXISTS delegations_source ON delegations (source_session_id, created_at);
      CREATE INDEX IF NOT EXISTS delegations_target ON delegations (target_session_id);
    `)
    ensureColumns(this.db, 'delegations', [
      { name: 'return_idempotency_key', definition: 'TEXT' },
      { name: 'returned_by', definition: 'TEXT' },
      { name: 'returned_at', definition: 'INTEGER' },
    ])
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS delegations_return_key
      ON delegations (return_idempotency_key)
      WHERE return_idempotency_key IS NOT NULL;
    `)
  }

  /**
   * Create once. A transport retry carrying the same key and same content returns the original
   * record; reusing a key for different work is rejected instead of launching the wrong child.
   */
  createDraft(input: CreateDelegationInput): { record: DelegationRecord; created: boolean } {
    const clean = this.validateCreate(input)
    const existing = this.findByIdempotencyKey(clean.idempotencyKey)
    if (existing !== null) {
      if (!sameCreation(existing, clean)) {
        throw new DelegationError(
          'idempotency-conflict',
          'That delegation request key was already used for different work.',
        )
      }
      return { record: existing, created: false }
    }

    const at = this.now()
    const delegationId = newId()
    this.db
      .prepare(
        `INSERT INTO delegations (
          delegation_id, idempotency_key, source_session_id, source_seq, target_session_id,
          target_agent, role, context_scope, depth, briefing, return_text, status, failure,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, 'draft', NULL, ?, ?, ?)`,
      )
      .run(
        delegationId,
        clean.idempotencyKey,
        clean.sourceSessionId,
        clean.sourceSeq ?? null,
        clean.targetAgent,
        clean.role,
        clean.contextScope,
        clean.depth,
        clean.briefing,
        clean.createdBy,
        at,
        at,
      )
    return { record: this.require(delegationId), created: true }
  }

  get(delegationId: string): DelegationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE delegation_id = ?')
      .get(delegationId) as DelegationRow | undefined
    return row === undefined ? null : fromRow(row)
  }

  listForSession(sessionId: string): DelegationRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM delegations
           WHERE source_session_id = ? OR target_session_id = ?
           ORDER BY created_at ASC, delegation_id ASC`,
        )
        .all(sessionId, sessionId) as DelegationRow[]
    ).map(fromRow)
  }

  list(): DelegationRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM delegations ORDER BY created_at ASC, delegation_id ASC')
        .all() as DelegationRow[]
    ).map(fromRow)
  }

  findByIdempotencyKey(key: string): DelegationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE idempotency_key = ?')
      .get(key) as DelegationRow | undefined
    return row === undefined ? null : fromRow(row)
  }

  findByTargetSession(targetSessionId: string): DelegationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE target_session_id = ?')
      .get(targetSessionId) as DelegationRow | undefined
    return row === undefined ? null : fromRow(row)
  }

  markStarting(delegationId: string): DelegationRecord {
    return this.transition(delegationId, ['draft'], 'starting')
  }

  /** Safe only after recovery proved no attributed child session was persisted. */
  resetStarting(delegationId: string): DelegationRecord {
    return this.transition(delegationId, ['starting'], 'draft')
  }

  attachTarget(delegationId: string, targetSessionId: string): DelegationRecord {
    const target = targetSessionId.trim()
    if (target === '') throw new DelegationError('invalid-input', 'Target session id must not be empty.')
    const current = this.require(delegationId)
    if (current.status === 'running' && current.targetSessionId === target) return current
    if (current.status !== 'starting') {
      throw new DelegationError(
        'invalid-transition',
        `Cannot attach a child while delegation ${delegationId} is ${current.status}.`,
      )
    }
    if (current.targetSessionId !== undefined && current.targetSessionId !== target) {
      throw new DelegationError('invalid-transition', 'This delegation already names a different child session.')
    }
    try {
      this.db
        .prepare(
          `UPDATE delegations
           SET target_session_id = ?, status = 'running', updated_at = ?
           WHERE delegation_id = ? AND status = 'starting'`,
        )
        .run(target, this.now(), delegationId)
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new DelegationError('invalid-input', 'That child session already belongs to a delegation.')
      }
      throw error
    }
    return this.require(delegationId)
  }

  markReady(delegationId: string): DelegationRecord {
    return this.transition(delegationId, ['running'], 'ready')
  }

  markReturned(
    delegationId: string,
    input: { returnText: string; idempotencyKey: string; returnedBy: string },
  ): { record: DelegationRecord; created: boolean } {
    const text = input.returnText
    const key = input.idempotencyKey.trim()
    const returnedBy = input.returnedBy.trim()
    if (text.trim() === '') throw new DelegationError('invalid-input', 'Return text must not be empty.')
    if (key === '') throw new DelegationError('invalid-input', 'Return idempotency key must not be empty.')
    if (returnedBy === '') throw new DelegationError('invalid-input', 'Returning device must not be empty.')
    const current = this.require(delegationId)
    if (current.status === 'returned') {
      if (current.returnIdempotencyKey === key && current.returnText === text) {
        return { record: current, created: false }
      }
      throw new DelegationError(
        'idempotency-conflict',
        'This delegation was already returned with different reviewed text.',
      )
    }
    if (current.status !== 'ready') {
      throw new DelegationError(
        'invalid-transition',
        `Cannot return delegation ${delegationId} while it is ${current.status}.`,
      )
    }
    const at = this.now()
    try {
      const result = this.db
        .prepare(
          `UPDATE delegations
           SET status = 'returned', return_text = ?, return_idempotency_key = ?,
               returned_by = ?, returned_at = ?, failure = NULL, updated_at = ?
           WHERE delegation_id = ? AND status = 'ready'`,
        )
        .run(text, key, returnedBy, at, at, delegationId)
      if (result.changes !== 1) {
        const latest = this.require(delegationId)
        if (
          latest.status === 'returned' &&
          latest.returnIdempotencyKey === key &&
          latest.returnText === text
        ) {
          return { record: latest, created: false }
        }
        throw new DelegationError(
          'idempotency-conflict',
          'This delegation changed while its reviewed return was being recorded.',
        )
      }
    } catch (error) {
      if (error instanceof DelegationError) throw error
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new DelegationError('idempotency-conflict', 'That return request key was already used.')
      }
      throw error
    }
    return { record: this.require(delegationId), created: true }
  }

  cancel(delegationId: string): DelegationRecord {
    const current = this.require(delegationId)
    if (current.status === 'cancelled') return current
    if (TERMINAL.has(current.status)) {
      throw new DelegationError(
        'invalid-transition',
        `Cannot cancel delegation ${delegationId} after it became ${current.status}.`,
      )
    }
    return this.transition(delegationId, [current.status], 'cancelled')
  }

  fail(delegationId: string, failure: string): DelegationRecord {
    const detail = failure.trim().slice(0, 500)
    if (detail === '') throw new DelegationError('invalid-input', 'Failure detail must not be empty.')
    const current = this.require(delegationId)
    if (current.status === 'failed' && current.failure === detail) return current
    if (TERMINAL.has(current.status)) {
      throw new DelegationError(
        'invalid-transition',
        `Cannot fail delegation ${delegationId} after it became ${current.status}.`,
      )
    }
    this.db
      .prepare(
        `UPDATE delegations
         SET status = 'failed', failure = ?, updated_at = ?
         WHERE delegation_id = ?`,
      )
      .run(detail, this.now(), delegationId)
    return this.require(delegationId)
  }

  relationshipForTarget(targetSessionId: string): SessionRelationship | undefined {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE target_session_id = ?')
      .get(targetSessionId) as DelegationRow | undefined
    if (row === undefined) return undefined
    const record = fromRow(row)
    return {
      delegationId: record.delegationId,
      parentSessionId: record.sourceSessionId,
      role: record.role,
      depth: record.depth,
    }
  }

  private transition(
    delegationId: string,
    allowed: DelegationStatus[],
    next: DelegationStatus,
  ): DelegationRecord {
    const current = this.require(delegationId)
    if (current.status === next) return current
    if (!allowed.includes(current.status)) {
      throw new DelegationError(
        'invalid-transition',
        `Cannot move delegation ${delegationId} from ${current.status} to ${next}.`,
      )
    }
    const result = this.db
      .prepare(
        `UPDATE delegations SET status = ?, failure = NULL, updated_at = ?
         WHERE delegation_id = ? AND status = ?`,
      )
      .run(next, this.now(), delegationId, current.status)
    if (result.changes !== 1) {
      throw new DelegationError('invalid-transition', 'The delegation changed while it was being updated.')
    }
    return this.require(delegationId)
  }

  private require(delegationId: string): DelegationRecord {
    const record = this.get(delegationId)
    if (record === null) {
      throw new DelegationError('unknown-delegation', `Unknown delegation: ${delegationId}`)
    }
    return record
  }

  private validateCreate(input: CreateDelegationInput): CreateDelegationInput {
    const idempotencyKey = input.idempotencyKey.trim()
    const sourceSessionId = input.sourceSessionId.trim()
    // Preserve the exact reviewed editor contents. Whitespace is only used to reject an empty
    // briefing; it is not silently removed before the child receives it.
    const briefing = input.briefing
    const createdBy = input.createdBy.trim()
    if (idempotencyKey === '' || idempotencyKey.length > 200) {
      throw new DelegationError('invalid-input', 'Idempotency key must be between 1 and 200 characters.')
    }
    if (sourceSessionId === '') throw new DelegationError('invalid-input', 'Source session is required.')
    if (briefing.trim() === '') throw new DelegationError('invalid-input', 'Briefing must not be empty.')
    if (briefing.length > MAX_DELEGATION_BRIEFING_CHARACTERS) {
      throw new DelegationError('invalid-input', 'Briefing is too large to delegate safely.')
    }
    if (createdBy === '') throw new DelegationError('invalid-input', 'Creating device is required.')
    if (!TARGET_AGENTS.has(input.targetAgent)) {
      throw new DelegationError('invalid-input', 'V1 delegation targets must be Claude or Codex.')
    }
    const role = DelegationRole.safeParse(input.role)
    const contextScope = DelegationContextScope.safeParse(input.contextScope)
    if (!role.success || !contextScope.success) {
      throw new DelegationError('invalid-input', 'Delegation role or context scope is invalid.')
    }
    if (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > MAX_DELEGATION_DEPTH) {
      throw new DelegationError('invalid-input', 'V1 delegation depth must be 1 or 2.')
    }
    if (input.sourceSeq !== undefined && (!Number.isInteger(input.sourceSeq) || input.sourceSeq < 1)) {
      throw new DelegationError('invalid-input', 'Selected transcript sequence must be positive.')
    }
    return {
      idempotencyKey,
      sourceSessionId,
      ...(input.sourceSeq === undefined ? {} : { sourceSeq: input.sourceSeq }),
      targetAgent: input.targetAgent,
      role: role.data,
      contextScope: contextScope.data,
      depth: input.depth,
      briefing,
      createdBy,
    }
  }
}

/** Strip the editable prompt and device identity before lifecycle state crosses to a phone. */
export function summarizeDelegation(record: DelegationRecord): DelegationSummary {
  return {
    delegationId: record.delegationId,
    idempotencyKey: record.idempotencyKey,
    sourceSessionId: record.sourceSessionId,
    ...(record.sourceSeq === undefined ? {} : { sourceSeq: record.sourceSeq }),
    ...(record.targetSessionId === undefined ? {} : { targetSessionId: record.targetSessionId }),
    targetAgent: record.targetAgent,
    role: record.role,
    contextScope: record.contextScope,
    depth: record.depth,
    status: record.status,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ...(record.returnIdempotencyKey === undefined
      ? {}
      : { returnIdempotencyKey: record.returnIdempotencyKey }),
    ...(record.returnedAt === undefined ? {} : { returnedAt: record.returnedAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function fromRow(row: DelegationRow): DelegationRecord {
  const role = DelegationRole.parse(row.role)
  const contextScope = DelegationContextScope.parse(row.context_scope)
  const status = DelegationStatus.parse(row.status)
  if (!TARGET_AGENTS.has(row.target_agent as DelegationTargetAgent)) {
    throw new DelegationError('invalid-input', `Stored target agent is invalid: ${row.target_agent}`)
  }
  return {
    delegationId: row.delegation_id,
    idempotencyKey: row.idempotency_key,
    sourceSessionId: row.source_session_id,
    ...(row.source_seq === null ? {} : { sourceSeq: row.source_seq }),
    ...(row.target_session_id === null ? {} : { targetSessionId: row.target_session_id }),
    targetAgent: row.target_agent as DelegationTargetAgent,
    role,
    contextScope,
    depth: row.depth,
    briefing: row.briefing,
    ...(row.return_text === null ? {} : { returnText: row.return_text }),
    ...(row.return_idempotency_key === null ? {} : { returnIdempotencyKey: row.return_idempotency_key }),
    ...(row.returned_by === null ? {} : { returnedBy: row.returned_by }),
    ...(row.returned_at === null ? {} : { returnedAt: row.returned_at }),
    status,
    ...(row.failure === null ? {} : { failure: row.failure }),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sameCreation(record: DelegationRecord, input: CreateDelegationInput): boolean {
  return (
    record.sourceSessionId === input.sourceSessionId &&
    record.sourceSeq === input.sourceSeq &&
    record.targetAgent === input.targetAgent &&
    record.role === input.role &&
    record.contextScope === input.contextScope &&
    record.depth === input.depth &&
    record.briefing === input.briefing &&
    record.createdBy === input.createdBy
  )
}
