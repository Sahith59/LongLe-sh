import type {
  DelegationContextScope,
  DelegationRole,
  DelegationTargetAgent,
} from '@longleash/protocol'

const PREFIX = 'longleash.delegation-draft.v1.'
const TARGETS = new Set<DelegationTargetAgent>(['claude', 'codex'])
const ROLES = new Set<DelegationRole>(['investigate', 'review', 'implement', 'test'])
const SCOPES = new Set<DelegationContextScope>(['selected', 'recent', 'task'])

export interface DelegationDraft {
  /** Stable across refresh/reconnect so one confirmed tap can create at most one child. */
  idempotencyKey?: string
  sourceSessionId: string
  sourceSeq?: number
  targetAgent: DelegationTargetAgent
  role: DelegationRole
  contextScope: DelegationContextScope
  briefing: string
  updatedAt: number
}

export function newDelegationIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): DraftStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function delegationDraftKey(sourceSessionId: string, sourceSeq?: number): string {
  return `${PREFIX}${encodeURIComponent(sourceSessionId)}.${sourceSeq ?? 'session'}`
}

/** Invalid or stale browser data is ignored; a bad draft must never wedge the sheet. */
export function readDelegationDraft(
  sourceSessionId: string,
  sourceSeq?: number,
  storage?: DraftStorage | null,
): DelegationDraft | null {
  try {
    const target = storage === undefined ? browserStorage() : storage
    if (target === null) return null
    const raw = target.getItem(delegationDraftKey(sourceSessionId, sourceSeq))
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<DelegationDraft>
    if (
      value.sourceSessionId !== sourceSessionId ||
      value.sourceSeq !== sourceSeq ||
      !TARGETS.has(value.targetAgent as DelegationTargetAgent) ||
      !ROLES.has(value.role as DelegationRole) ||
      !SCOPES.has(value.contextScope as DelegationContextScope) ||
      typeof value.briefing !== 'string' ||
      typeof value.updatedAt !== 'number'
    ) {
      return null
    }
    return {
      ...(value as Omit<DelegationDraft, 'idempotencyKey'>),
      // Transparently upgrade Phase 1A drafts rather than discarding a person's edits.
      idempotencyKey:
        typeof value.idempotencyKey === 'string' && value.idempotencyKey.trim() !== ''
          ? value.idempotencyKey
          : newDelegationIdempotencyKey(),
    }
  } catch {
    return null
  }
}

export function writeDelegationDraft(
  draft: DelegationDraft,
  storage?: DraftStorage | null,
): boolean {
  try {
    const target = storage === undefined ? browserStorage() : storage
    if (target === null) return false
    target.setItem(delegationDraftKey(draft.sourceSessionId, draft.sourceSeq), JSON.stringify(draft))
    return true
  } catch {
    // Private browsing or storage pressure may reject writes. The in-memory editor still works.
    return false
  }
}

export function removeDelegationDraft(
  sourceSessionId: string,
  sourceSeq?: number,
  storage?: DraftStorage | null,
): void {
  try {
    const target = storage === undefined ? browserStorage() : storage
    if (target === null) return
    target.removeItem(delegationDraftKey(sourceSessionId, sourceSeq))
  } catch {
    // A non-writable storage area is already equivalent to no persisted draft.
  }
}
