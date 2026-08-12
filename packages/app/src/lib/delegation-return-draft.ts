const PREFIX = 'longleash.delegation-return.v1.'

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface DelegationReturnDraft {
  delegationId: string
  idempotencyKey: string
  returnText: string
  updatedAt: number
}

function storage(): DraftStorage | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

export function newReturnIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `return-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function returnDraftKey(delegationId: string): string {
  return `${PREFIX}${encodeURIComponent(delegationId)}`
}

export function readReturnDraft(
  delegationId: string,
  target: DraftStorage | null = storage(),
): DelegationReturnDraft | null {
  try {
    if (target === null) return null
    const raw = target.getItem(returnDraftKey(delegationId))
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<DelegationReturnDraft>
    if (
      value.delegationId !== delegationId ||
      typeof value.idempotencyKey !== 'string' || value.idempotencyKey.trim() === '' ||
      typeof value.returnText !== 'string' ||
      typeof value.updatedAt !== 'number'
    ) return null
    return value as DelegationReturnDraft
  } catch {
    return null
  }
}

export function writeReturnDraft(
  draft: DelegationReturnDraft,
  target: DraftStorage | null = storage(),
): boolean {
  try {
    if (target === null) return false
    target.setItem(returnDraftKey(draft.delegationId), JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

export function removeReturnDraft(
  delegationId: string,
  target: DraftStorage | null = storage(),
): void {
  try { target?.removeItem(returnDraftKey(delegationId)) } catch { /* best effort */ }
}
