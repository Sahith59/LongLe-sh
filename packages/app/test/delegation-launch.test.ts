import { describe, expect, it } from 'vitest'
import type { DelegationSummary } from '@longleash/protocol'
import { matchesPendingDelegation } from '../src/lib/delegation-launch.js'

const pending = {
  requestId: 'launch-request-1',
  idempotencyKey: 'stable-operation-1',
  sourceSessionId: 'ses_parent',
}

const delegation: DelegationSummary = {
  delegationId: 'del_1',
  idempotencyKey: 'stable-operation-1',
  sourceSessionId: 'ses_parent',
  targetSessionId: 'ses_child',
  targetAgent: 'codex',
  role: 'review',
  contextScope: 'recent',
  depth: 1,
  status: 'running',
  createdAt: 1,
  updatedAt: 2,
}

describe('delegation launch reconciliation', () => {
  it('accepts the initiating direct response by request id', () => {
    expect(matchesPendingDelegation(pending, { ...delegation, idempotencyKey: 'different' }, 'launch-request-1'))
      .toBe(true)
  })

  it('recovers from a lost acknowledgement using hello/broadcast durable state', () => {
    expect(matchesPendingDelegation(pending, delegation)).toBe(true)
  })

  it('does not navigate for another device or another launch', () => {
    expect(
      matchesPendingDelegation(
        pending,
        { ...delegation, idempotencyKey: 'other-operation' },
        'other-request',
      ),
    ).toBe(false)
  })
})
