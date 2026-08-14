import {
  IdeSessionInventorySchema,
  type IdeSessionInventory,
  type IdeSessionSummary,
} from '@longleash/protocol'

export type InventorySectionId = 'needs-you' | 'active' | 'earlier'

export interface InventorySection {
  id: InventorySectionId
  label: string
  sessions: IdeSessionSummary[]
}

const sectionOrder: readonly { id: InventorySectionId; label: string }[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'active', label: 'Active' },
  { id: 'earlier', label: 'Earlier' },
]

/**
 * Build a deterministic projection. A session appears once: attention wins, then a real live
 * process, then history. Dormant resumable `waiting` sessions therefore never masquerade as active.
 */
export function buildInventorySections(raw: IdeSessionInventory): InventorySection[] {
  const inventory = IdeSessionInventorySchema.parse(raw)
  const buckets = new Map<InventorySectionId, IdeSessionSummary[]>()
  for (const section of sectionOrder) buckets.set(section.id, [])

  for (const session of inventory.sessions) {
    const section: InventorySectionId =
      session.attention !== undefined ? 'needs-you' : session.live ? 'active' : 'earlier'
    buckets.get(section)?.push(session)
  }

  const compare = (left: IdeSessionSummary, right: IdeSessionSummary): number =>
    right.updatedAt - left.updatedAt ||
    left.title.localeCompare(right.title) ||
    left.sessionId.localeCompare(right.sessionId)

  return sectionOrder
    .map((section) => ({ ...section, sessions: [...(buckets.get(section.id) ?? [])].sort(compare) }))
    .filter((section) => section.sessions.length > 0)
}

export function sessionStateLabel(session: IdeSessionSummary): string {
  if (session.attention === 'approval') return 'approval needed'
  if (session.attention === 'question') return 'question waiting'
  if (session.attention === 'error') return 'failed'
  if (!session.live && session.resumable) return 'ready to reopen'
  if (!session.live) return session.status === 'ended' ? 'finished' : session.status
  if (session.status === 'waiting') return 'waiting for you'
  return session.status === 'running' ? 'working' : session.status
}
