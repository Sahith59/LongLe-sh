import type { DelegationSummary } from '@longleash/protocol'

export interface PendingDelegationLaunch {
  requestId: string
  idempotencyKey: string
  sourceSessionId: string
  sourceSeq?: number
}

/** Direct replies correlate by request id; reconnect/hello recovery correlates by durable key. */
export function matchesPendingDelegation(
  pending: PendingDelegationLaunch | null,
  delegation: DelegationSummary,
  requestId?: string,
): pending is PendingDelegationLaunch {
  return (
    pending !== null &&
    (requestId === pending.requestId || delegation.idempotencyKey === pending.idempotencyKey)
  )
}
