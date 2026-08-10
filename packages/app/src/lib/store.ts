import type { AskedQuestion, SessionEvent } from '@longleash/protocol'

export type SessionStatus = 'running' | 'waiting' | 'ended' | 'errored'

export interface ActivityItem {
  toolName: string
  inputSummary: string
  autoApproved: boolean
}

export type BlockKind = 'text' | 'tool' | 'thinking' | 'user'

export interface Block {
  kind: BlockKind
  text: string
}

export interface SessionView {
  sessionId: string
  agent: string
  cwd: string
  title: string
  /** Where it came from. "unknown" rather than a guess when the daemon did not say. */
  origin: string
  status: SessionStatus
  /** Structured transcript: what each piece was, so the UI can render it as a conversation. */
  blocks: Block[]
  /** Prose only, for one-line previews — tool noise would make a list unreadable. */
  output: string
  activity: ActivityItem[]
  /** Whether typing can carry this conversation on — false for pre-resume-id history. */
  resumable: boolean
  /**
   * The agent's own conversation id. Offered so a person can pick the SAME conversation
   * back up at their keyboard with `claude --resume <id>` — the freedom to move a
   * conversation between surfaces rather than being locked to whichever one began it.
   */
  resumeId?: string
  /** The permission mode the laptop reports for this session, when it says. */
  permissionMode?: string
  /** LongLeash's own gate: 'ask' pages the phone, 'auto' stays silent. */
  gate?: 'ask' | 'auto'
  error?: string
}

export interface PendingApproval {
  approvalId: string
  sessionId: string
  toolName: string
  inputSummary: string
  targetPath?: string
  outsideRoot: boolean
  /**
   * Present when Claude is ASKING rather than requesting permission. A question is
   * answered by choosing, not by allowing — the phone renders a different surface,
   * because mistaking "which one?" for "may I?" is how someone answers wrongly in a hurry.
   */
  questions?: AskedQuestion[]
}

export interface StoreState {
  sessions: Record<string, SessionView>
  approvals: PendingApproval[]
}

/** Approvals belonging to one session, so a focused view shows only what is relevant. */
export function approvalsFor(state: StoreState, sessionId: string): PendingApproval[] {
  return state.approvals.filter((approval) => approval.sessionId === sessionId)
}

export interface SessionSeed {
  sessionId: string
  agent: string
  cwd: string
  title: string
  origin: string
  status: SessionStatus
  resumable?: boolean
  resumeId?: string
  gate?: 'ask' | 'auto'
}

export interface StoreOptions {
  /** Bound retained output: a phone cannot hold an unbounded transcript. */
  maxOutputChars?: number
}

const DEFAULT_MAX_OUTPUT = 200_000

/** Drop the oldest blocks once the transcript outgrows what a phone should hold. */
function trimBlocks(blocks: Block[], maxChars: number): Block[] {
  let total = blocks.reduce((sum, block) => sum + block.text.length, 0)
  if (total <= maxChars) return blocks
  const kept = [...blocks]
  while (kept.length > 1 && total > maxChars) {
    total -= (kept.shift() as Block).text.length
  }
  return kept
}

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
      blocks: [],
      output: '',
      activity: [],
      resumable: false,
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
        // A fresh start supersedes any earlier failure.
        delete session.error
        const payload = event.payload as {
          agent: string
          cwd: string
          title?: string
          origin?: string
          resumeId?: string
        }
        session.agent = payload.agent
        session.cwd = payload.cwd
        session.title = payload.title ?? ''
        session.origin = payload.origin ?? 'unknown'
        if (payload.resumeId) session.resumeId = payload.resumeId
        break
      }
      case 'stream.delta': {
        const payload = event.payload as { text: string; kind?: BlockKind }
        const kind: BlockKind = payload.kind ?? 'text'
        const last = session.blocks[session.blocks.length - 1]
        // Streaming splits a sentence across many deltas; merge prose and thinking. Never
        // merge tool calls — and never merge user messages: each one is a discrete thing a
        // person said (or a reopened marker), and gluing two together renders them as one
        // garbled bubble.
        if (last && last.kind === kind && (kind === 'text' || kind === 'thinking')) {
          session.blocks = [
            ...session.blocks.slice(0, -1),
            { kind, text: last.text + payload.text },
          ]
        } else {
          session.blocks = [...session.blocks, { kind, text: payload.text }]
        }
        session.blocks = trimBlocks(session.blocks, maxOutput)
        if (kind === 'text') session.output = (session.output + payload.text).slice(-maxOutput)
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
          questions?: AskedQuestion[]
        }
        if (settled.has(payload.approvalId)) break
        approvals.set(payload.approvalId, {
          approvalId: payload.approvalId,
          sessionId: event.sessionId,
          toolName: payload.toolName,
          inputSummary: payload.inputSummary,
          ...(payload.targetPath === undefined ? {} : { targetPath: payload.targetPath }),
          outsideRoot: payload.outsideRoot === true,
          ...(payload.questions === undefined ? {} : { questions: payload.questions }),
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
      case 'session.status': {
        const payload = event.payload as {
          status: SessionStatus
          title?: string
          permissionMode?: string
          gate?: 'ask' | 'auto'
        }
        if (payload.status === 'waiting' || payload.status === 'running') {
          session.status = payload.status
          // The session is alive again, so a past failure is history rather than current state.
          delete session.error
        }
        // A terminal session renames itself once it knows what it was asked to do.
        if (payload.title !== undefined && payload.title !== '') session.title = payload.title
        if (payload.permissionMode !== undefined) session.permissionMode = payload.permissionMode
        if (payload.gate !== undefined) session.gate = payload.gate
        break
      }
      case 'session.ended': {
        session.status = 'ended'
        // Whether this can be carried on flips exactly as it ends — a terminal session
        // adopted on stop, an agent that only just announced its resume id. Taking it
        // from the live event is what keeps Reopen honest without a reconnect.
        const payload = event.payload as { resumable?: boolean; resumeId?: string }
        if (typeof payload.resumable === 'boolean') session.resumable = payload.resumable
        if (payload.resumeId) session.resumeId = payload.resumeId
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

  /**
   * Rebuild the list from what the daemon knows. A reload wipes memory, so without this the
   * app would show nothing even though every session and event is safely stored.
   */
  function seedSessions(seeds: SessionSeed[]): void {
    for (const seed of seeds) {
      const session = ensure(seed.sessionId)
      session.agent = seed.agent
      session.cwd = seed.cwd
      session.title = seed.title
      session.origin = seed.origin
      session.status = seed.status
      session.resumable = seed.resumable ?? false
      if (seed.resumeId) session.resumeId = seed.resumeId
      if (seed.gate) session.gate = seed.gate
    }

    /**
     * Hello is the TRUTH about what is live, not merely an addition to it.
     *
     * This used to only upsert, so anything the daemon had forgotten — a session from a
     * previous run, one whose process died while the daemon was down — stayed on screen as
     * "working" forever. Pressing Stop on one was refused, because the daemon had no such
     * session to stop, and the app had no way to ever learn that.
     *
     * A session the daemon does not list cannot be acted on, so calling it live is a lie.
     * It is marked ended rather than deleted: the conversation is still worth reading.
     */
    const live = new Set(seeds.map((seed) => seed.sessionId))
    for (const session of Object.values(sessions)) {
      if (live.has(session.sessionId)) continue
      if (session.status === 'running' || session.status === 'waiting') {
        session.status = 'ended'
      }
      // Its questions died with it; nothing can answer them now.
      for (const [id, approval] of approvals) {
        if (approval.sessionId === session.sessionId) approvals.delete(id)
      }
    }
    notify()
  }

  /** The daemon could not honour our cursor: drop what we have and replay from the start. */
  function applyGap(sessionId: string): void {
    cursors[sessionId] = 0
    const session = sessions[sessionId]
    if (session) {
      session.output = ''
      session.blocks = []
      session.activity = []
      delete session.error
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
    seedSessions,
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
