import type { SessionEvent } from '@longleash/protocol'

export type SessionStatus = 'running' | 'ended' | 'errored'

export interface ActivityItem {
  toolName: string
  inputSummary: string
  autoApproved: boolean
}

export interface SessionView {
  sessionId: string
  agent: string
  cwd: string
  title: string
  /** Where it came from. "unknown" rather than a guess when the daemon did not say. */
  origin: string
  status: SessionStatus
  output: string
  activity: ActivityItem[]
  error?: string
}

export interface PendingApproval {
  approvalId: string
  sessionId: string
  toolName: string
  inputSummary: string
  targetPath?: string
  outsideRoot: boolean
}

export interface StoreState {
  sessions: Record<string, SessionView>
  approvals: PendingApproval[]
}

export interface StoreOptions {
  /** Bound retained output: a phone cannot hold an unbounded transcript. */
  maxOutputChars?: number
}

const DEFAULT_MAX_OUTPUT = 200_000

export function createStore(options: StoreOptions = {}) {
  const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT
  const sessions: Record<string, SessionView> = {}
  const approvals = new Map<string, PendingApproval>()
  /** Approvals hidden optimistically while their decision is in flight. */
  const deciding = new Map<string, PendingApproval>()
  /** Every approval the daemon has confirmed decided — replays must not resurrect them. */
  const settled = new Set<string>()
  const cursors: Record<string, number> = {}
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const ensure = (sessionId: string): SessionView => {
    const existing = sessions[sessionId]
    if (existing) return existing
    const created: SessionView = {
      sessionId,
      agent: 'claude',
      cwd: '',
      title: '',
      origin: 'unknown',
      status: 'running',
      output: '',
      activity: [],
    }
    sessions[sessionId] = created
    return created
  }

  function apply(event: SessionEvent): void {
    const seen = cursors[event.sessionId] ?? 0
    // Replays and duplicate deliveries must never double-append.
    if (event.seq <= seen) return
    cursors[event.sessionId] = event.seq

    const session = ensure(event.sessionId)
    switch (event.type) {
      case 'session.started': {
        const payload = event.payload as { agent: string; cwd: string; title?: string; origin?: string }
        session.agent = payload.agent
        session.cwd = payload.cwd
        session.title = payload.title ?? ''
        session.origin = payload.origin ?? 'unknown'
        break
      }
      case 'stream.delta': {
        const payload = event.payload as { text: string }
        session.output = (session.output + payload.text).slice(-maxOutput)
        break
      }
      case 'activity.tool': {
        const payload = event.payload as ActivityItem
        session.activity = [...session.activity, payload].slice(-200)
        break
      }
      case 'approval.requested': {
        const payload = event.payload as {
          approvalId: string
          toolName: string
          inputSummary: string
          targetPath?: string
          outsideRoot?: boolean
        }
        if (settled.has(payload.approvalId)) break
        approvals.set(payload.approvalId, {
          approvalId: payload.approvalId,
          sessionId: event.sessionId,
          toolName: payload.toolName,
          inputSummary: payload.inputSummary,
          ...(payload.targetPath === undefined ? {} : { targetPath: payload.targetPath }),
          outsideRoot: payload.outsideRoot === true,
        })
        break
      }
      case 'approval.decided': {
        const payload = event.payload as { approvalId: string }
        settled.add(payload.approvalId)
        approvals.delete(payload.approvalId)
        deciding.delete(payload.approvalId)
        break
      }
      case 'session.ended': {
        session.status = 'ended'
        break
      }
      case 'session.errored': {
        session.status = 'errored'
        session.error = (event.payload as { message: string }).message
        break
      }
      default:
        break
    }
    notify()
  }

  /** The daemon could not honour our cursor: drop what we have and replay from the start. */
  function applyGap(sessionId: string): void {
    cursors[sessionId] = 0
    const session = sessions[sessionId]
    if (session) {
      session.output = ''
      session.activity = []
    }
    for (const [id, approval] of approvals) {
      if (approval.sessionId === sessionId) approvals.delete(id)
    }
    notify()
  }

  /** Hide an approval the moment it is answered; the network can catch up afterwards. */
  function markDeciding(approvalId: string): void {
    const approval = approvals.get(approvalId)
    if (!approval) return
    deciding.set(approvalId, approval)
    approvals.delete(approvalId)
    notify()
  }

  /** The decision did not land — put it back, unless the daemon has since settled it. */
  function rollbackDecision(approvalId: string): void {
    const approval = deciding.get(approvalId)
    deciding.delete(approvalId)
    if (!approval || settled.has(approvalId)) return
    approvals.set(approvalId, approval)
    notify()
  }

  return {
    apply,
    applyGap,
    markDeciding,
    rollbackDecision,
    cursors: () => ({ ...cursors }),
    getState: (): StoreState => ({ sessions, approvals: [...approvals.values()] }),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type Store = ReturnType<typeof createStore>
