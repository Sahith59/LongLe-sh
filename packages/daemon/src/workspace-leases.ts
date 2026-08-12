import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'

export type WorkspaceOwnerKind = 'session' | 'external' | 'reservation'

export interface WorkspaceLease {
  workspaceKey: string
  cwd: string
  ownerId: string
  ownerKind: WorkspaceOwnerKind
  ownerOrigin: string
  acquiredAt: number
  updatedAt: number
}

interface WorkspaceLeaseRow {
  workspace_key: string
  cwd: string
  owner_id: string
  owner_kind: WorkspaceOwnerKind
  owner_origin: string
  acquired_at: number
  updated_at: number
}

export class WorkspaceLeaseError extends Error {
  constructor(
    readonly reason: 'workspace-conflict' | 'unknown-reservation' | 'reservation-mismatch',
    message: string,
    readonly conflict?: WorkspaceLease,
  ) {
    super(message)
    this.name = 'WorkspaceLeaseError'
  }
}

/**
 * Durable, exclusive ownership of a real checkout.
 *
 * V1 deliberately treats every agent as a potential writer. Codex can be sandboxed read-only,
 * but Claude and externally started sessions cannot be proven read-only through one stable
 * cross-provider contract. A sequential lease is less parallel, but it is an invariant rather
 * than a prompt. Reservations bridge the asynchronous stop/start gap during a handoff so a third
 * session cannot steal the checkout between the parent stopping and the child starting.
 */
export class WorkspaceLeaseManager {
  private readonly db: Database.Database
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()

  constructor(db: Database.Database, opts: { now?: () => number } = {}) {
    this.db = db
    this.now = opts.now ?? Date.now
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_leases (
        workspace_key TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        owner_id TEXT NOT NULL UNIQUE,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('session', 'external', 'reservation')),
        owner_origin TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_leases_owner ON workspace_leases (owner_id);
    `)
  }

  acquire(input: {
    sessionId: string
    cwd: string
    ownerKind: Exclude<WorkspaceOwnerKind, 'reservation'>
    ownerOrigin: string
    actor: string
  }): WorkspaceLease {
    const ownerId = required(input.sessionId, 'Session id')
    const canonical = this.canonical(input.cwd)
    const transaction = this.db.transaction(() => {
      const current = this.getByWorkspaceKey(canonical)
      if (current !== null) {
        if (current.ownerId === ownerId) return current
        throw conflictError(canonical, current)
      }
      const at = this.now()
      this.db.prepare(
        `INSERT INTO workspace_leases
          (workspace_key, cwd, owner_id, owner_kind, owner_origin, acquired_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(canonical, canonical, ownerId, input.ownerKind, required(input.ownerOrigin, 'Owner origin'), at, at)
      this.audit(input.actor, 'workspace.acquire', `${canonical} -> ${ownerId}`)
      return this.requireByOwner(ownerId)
    })
    return transaction()
  }

  /** Hold a checkout while its current process is being stopped and its successor is starting. */
  reserveTransfer(input: {
    reservationId: string
    cwd: string
    fromSessionId?: string
    actor: string
  }): WorkspaceLease {
    const ownerId = reservationOwner(input.reservationId)
    const canonical = this.canonical(input.cwd)
    const transaction = this.db.transaction(() => {
      const current = this.getByWorkspaceKey(canonical)
      if (current?.ownerId === ownerId) return current
      if (
        current !== null &&
        (input.fromSessionId === undefined || current.ownerId !== input.fromSessionId)
      ) {
        throw conflictError(canonical, current)
      }
      const at = this.now()
      if (current === null) {
        this.db.prepare(
          `INSERT INTO workspace_leases
            (workspace_key, cwd, owner_id, owner_kind, owner_origin, acquired_at, updated_at)
           VALUES (?, ?, ?, 'reservation', 'longleash-handoff', ?, ?)`,
        ).run(canonical, canonical, ownerId, at, at)
      } else {
        this.db.prepare(
          `UPDATE workspace_leases
           SET owner_id = ?, owner_kind = 'reservation', owner_origin = 'longleash-handoff', updated_at = ?
           WHERE workspace_key = ? AND owner_id = ?`,
        ).run(ownerId, at, canonical, current.ownerId)
      }
      this.audit(input.actor, 'workspace.reserve', `${canonical} -> ${ownerId}`)
      return this.requireByOwner(ownerId)
    })
    return transaction()
  }

  /** Replace a handoff reservation with the real successor session in one SQLite transaction. */
  claimReservation(input: {
    reservationId: string
    sessionId: string
    cwd: string
    ownerKind: Exclude<WorkspaceOwnerKind, 'reservation'>
    ownerOrigin: string
    actor: string
  }): WorkspaceLease {
    const reservedBy = reservationOwner(input.reservationId)
    const ownerId = required(input.sessionId, 'Session id')
    const canonical = this.canonical(input.cwd)
    const transaction = this.db.transaction(() => {
      const current = this.getByWorkspaceKey(canonical)
      if (current?.ownerId === ownerId) return current
      if (current === null || current.ownerId !== reservedBy || current.ownerKind !== 'reservation') {
        throw new WorkspaceLeaseError(
          'unknown-reservation',
          'The workspace handoff expired before the receiving session could claim it.',
          current ?? undefined,
        )
      }
      const at = this.now()
      this.db.prepare(
        `UPDATE workspace_leases
         SET owner_id = ?, owner_kind = ?, owner_origin = ?, updated_at = ?
         WHERE workspace_key = ? AND owner_id = ?`,
      ).run(ownerId, input.ownerKind, required(input.ownerOrigin, 'Owner origin'), at, canonical, reservedBy)
      this.audit(input.actor, 'workspace.claim', `${canonical}: ${reservedBy} -> ${ownerId}`)
      return this.requireByOwner(ownerId)
    })
    return transaction()
  }

  /** Put a failed handoff back where it began when that process is still authoritative. */
  restoreReservation(input: {
    reservationId: string
    sessionId: string
    cwd: string
    ownerKind: Exclude<WorkspaceOwnerKind, 'reservation'>
    ownerOrigin: string
    actor: string
  }): WorkspaceLease | null {
    try {
      return this.claimReservation(input)
    } catch (error) {
      if (error instanceof WorkspaceLeaseError && error.reason === 'unknown-reservation') return null
      throw error
    }
  }

  release(ownerId: string, actor: string, reason: string): WorkspaceLease | null {
    const transaction = this.db.transaction(() => {
      const current = this.getByOwner(ownerId)
      if (current === null) return null
      this.db.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(ownerId)
      this.audit(actor, 'workspace.release', `${current.workspaceKey} <- ${ownerId}: ${reason.slice(0, 160)}`)
      return current
    })
    const lease = transaction()
    if (lease !== null) this.notify()
    return lease
  }

  releaseReservation(reservationId: string, actor: string, reason: string): WorkspaceLease | null {
    return this.release(reservationOwner(reservationId), actor, reason)
  }

  getByOwner(ownerId: string): WorkspaceLease | null {
    const row = this.db.prepare('SELECT * FROM workspace_leases WHERE owner_id = ?').get(ownerId) as
      | WorkspaceLeaseRow
      | undefined
    return row === undefined ? null : fromRow(row)
  }

  getByCwd(cwd: string): WorkspaceLease | null {
    return this.getByWorkspaceKey(this.canonical(cwd))
  }

  list(): WorkspaceLease[] {
    return (this.db.prepare('SELECT * FROM workspace_leases ORDER BY acquired_at, workspace_key').all() as WorkspaceLeaseRow[])
      .map(fromRow)
  }

  /**
   * A process never survives a daemon restart when LongLeash owns it. External processes are
   * re-adopted before their ids are supplied here. Anything else is stale authority and must be
   * released; keeping it would brick a checkout forever after an ordinary crash.
   */
  reconcile(input: {
    activeSessionIds: Iterable<string>
    validReservationIds?: Iterable<string>
    actor?: string
  }): WorkspaceLease[] {
    const active = new Set(input.activeSessionIds)
    const reservations = new Set(
      [...(input.validReservationIds ?? [])].map((id) => reservationOwner(id)),
    )
    const released: WorkspaceLease[] = []
    for (const lease of this.list()) {
      const valid = lease.ownerKind === 'reservation'
        ? reservations.has(lease.ownerId)
        : active.has(lease.ownerId)
      if (valid) continue
      const removed = this.release(lease.ownerId, input.actor ?? 'system:recovery', 'stale after daemon restart')
      if (removed !== null) released.push(removed)
    }
    return released
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private getByWorkspaceKey(workspaceKey: string): WorkspaceLease | null {
    const row = this.db.prepare('SELECT * FROM workspace_leases WHERE workspace_key = ?').get(workspaceKey) as
      | WorkspaceLeaseRow
      | undefined
    return row === undefined ? null : fromRow(row)
  }

  private requireByOwner(ownerId: string): WorkspaceLease {
    const lease = this.getByOwner(ownerId)
    if (lease === null) throw new Error(`Workspace lease for ${ownerId} disappeared during its transaction.`)
    return lease
  }

  private canonical(cwd: string): string {
    const absolute = resolve(required(cwd, 'Workspace'))
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }

  private audit(actor: string, action: string, detail: string): void {
    this.db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .run(this.now(), required(actor, 'Actor'), action, detail)
  }

  private notify(): void {
    for (const listener of this.listeners) queueMicrotask(listener)
  }
}

function required(value: string, label: string): string {
  const clean = value.trim()
  if (clean === '') throw new Error(`${label} must not be empty.`)
  return clean
}

function reservationOwner(id: string): string {
  return `reservation:${required(id, 'Reservation id')}`
}

function conflictError(cwd: string, conflict: WorkspaceLease): WorkspaceLeaseError {
  return new WorkspaceLeaseError(
    'workspace-conflict',
    `This workspace is already controlled by session ${conflict.ownerId}. Stop or release it before starting another writer in ${cwd}.`,
    conflict,
  )
}

function fromRow(row: WorkspaceLeaseRow): WorkspaceLease {
  return {
    workspaceKey: row.workspace_key,
    cwd: row.cwd,
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    ownerOrigin: row.owner_origin,
    acquiredAt: row.acquired_at,
    updatedAt: row.updated_at,
  }
}
