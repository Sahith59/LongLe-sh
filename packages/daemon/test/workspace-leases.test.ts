import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalStore } from '../src/approvals.js'
import { WorkspaceLeaseError, WorkspaceLeaseManager } from '../src/workspace-leases.js'

let approvals: ApprovalStore
let leases: WorkspaceLeaseManager
let root: string
let clock: number

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-lease-')))
  approvals = new ApprovalStore(':memory:')
  clock = 1_000
  leases = new WorkspaceLeaseManager(approvals.rawDb, { now: () => clock })
})

afterEach(() => {
  approvals.close()
  rmSync(root, { recursive: true, force: true })
})

describe('exclusive workspace ownership', () => {
  it('canonicalises the checkout and refuses a second owner with actionable conflict detail', () => {
    const first = leases.acquire({
      sessionId: 'ses_parent', cwd: root, ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
    })
    expect(first).toMatchObject({ workspaceKey: root, ownerId: 'ses_parent', ownerKind: 'session' })
    expect(() => leases.acquire({
      sessionId: 'ses_other', cwd: join(root, '.'), ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
    })).toThrowError(WorkspaceLeaseError)
    try {
      leases.acquire({
        sessionId: 'ses_other', cwd: root, ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
      })
    } catch (error) {
      expect(error).toMatchObject({
        reason: 'workspace-conflict',
        conflict: { ownerId: 'ses_parent', cwd: root },
      })
    }
  })

  it('atomically transfers parent → reservation → child without an unowned gap', () => {
    leases.acquire({
      sessionId: 'ses_parent', cwd: root, ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
    })
    clock = 1_100
    expect(leases.reserveTransfer({
      reservationId: 'del_1', cwd: root, fromSessionId: 'ses_parent', actor: 'dev_phone',
    })).toMatchObject({ ownerId: 'reservation:del_1', ownerKind: 'reservation' })
    expect(() => leases.acquire({
      sessionId: 'ses_racer', cwd: root, ownerKind: 'external', ownerOrigin: 'terminal', actor: 'system',
    })).toThrowError(/already controlled/i)
    clock = 1_200
    expect(leases.claimReservation({
      reservationId: 'del_1', sessionId: 'ses_child', cwd: root,
      ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
    })).toMatchObject({ ownerId: 'ses_child', ownerKind: 'session', updatedAt: 1_200 })
  })

  it('cannot claim a reservation with the wrong operation id', () => {
    leases.reserveTransfer({ reservationId: 'del_1', cwd: root, actor: 'dev_phone' })
    expect(() => leases.claimReservation({
      reservationId: 'del_2', sessionId: 'ses_child', cwd: root,
      ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
    })).toThrowError(/handoff expired/i)
  })

  it('releases stale owners after restart while retaining re-adopted external sessions', () => {
    leases.acquire({
      sessionId: 'ses_dead', cwd: root, ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
    })
    const second = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-lease-external-')))
    try {
      leases.acquire({
        sessionId: 'ext_alive', cwd: second, ownerKind: 'external', ownerOrigin: 'vscode', actor: 'system',
      })
      const released = leases.reconcile({ activeSessionIds: ['ext_alive'] })
      expect(released.map((lease) => lease.ownerId)).toEqual(['ses_dead'])
      expect(leases.getByOwner('ext_alive')).not.toBeNull()
      expect(leases.getByOwner('ses_dead')).toBeNull()
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })

  it('records every ownership mutation in the shared audit trail', () => {
    leases.acquire({
      sessionId: 'ses_parent', cwd: root, ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
    })
    leases.reserveTransfer({
      reservationId: 'del_1', cwd: root, fromSessionId: 'ses_parent', actor: 'dev_phone',
    })
    leases.claimReservation({
      reservationId: 'del_1', sessionId: 'ses_child', cwd: root,
      ownerKind: 'session', ownerOrigin: 'phone', actor: 'dev_phone',
    })
    leases.release('ses_child', 'dev_phone', 'returned')
    const actions = approvals.rawDb.prepare('SELECT action FROM audit ORDER BY rowid').all() as { action: string }[]
    expect(actions.map((row) => row.action)).toEqual([
      'workspace.acquire', 'workspace.reserve', 'workspace.claim', 'workspace.release',
    ])
  })
})
