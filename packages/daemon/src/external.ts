import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AskedQuestion, type AgentKind, type SessionEvent, type SessionGate } from '@longleash/protocol'
import type { EventLog, AppendInput } from './eventlog.js'
import type { ApprovalStore } from './approvals.js'
import type { DecisionOutcome, SessionStatus } from './sessions.js'
import type { SessionRegistry } from './session-registry.js'

/**
 * Sessions the human started themselves — `claude` in a terminal, or the VS Code
 * extension's CLI core. LongLeash never scrapes their TUI; everything here arrives
 * through Claude Code's own structured surfaces:
 *
 *   - hooks (SessionStart / PreToolUse / SessionEnd) report lifecycle and ask
 *     permission through a local, secret-authenticated endpoint, and
 *   - the transcript JSONL that Claude Code itself writes is tailed for the
 *     conversation — a file format, not a screen.
 *
 * The contract with the terminal is graceful degradation, never obstruction:
 * a PreToolUse question waits for the phone only while someone could plausibly
 * answer, and otherwise resolves to "ask" — which hands the decision straight
 * back to the terminal prompt exactly as if LongLeash were not installed.
 */

export interface HookDecision {
  decision: 'allow' | 'deny' | 'ask'
  reason: string
}

/**
 * The agent CLIs that report through the hook endpoint. Both speak the same three-way
 * contract — allow, deny, or stay out — which is why one manager serves both.
 */
export type TerminalAgent = Extract<AgentKind, 'claude' | 'codex'>

/** Where the person is driving a session from. Reported by the hook, never inferred here. */
export type Surface = 'terminal' | 'vscode'

/** Unknown or absent means a plain terminal — the assumption that is right most often. */
export function surfaceOf(raw: unknown): Surface {
  return raw === 'vscode' ? 'vscode' : 'terminal'
}

/** Anything unrecognised is treated as Claude Code, the original and still the default. */
export function terminalAgentOf(raw: unknown): TerminalAgent {
  return raw === 'codex' ? 'codex' : 'claude'
}

const AGENT_LABEL: Record<TerminalAgent, string> = { claude: 'terminal', codex: 'codex' }

export interface ExternalSessionsOptions {
  eventLog: EventLog
  /**
   * A store of its OWN, never shared with SessionManager: decision routing relies
   * on each manager recognising exactly its own approval ids.
   */
  approvals: ApprovalStore
  onEvent?: (event: SessionEvent) => void
  /**
   * Who could answer right now, which decides how long the terminal may be held.
   *
   *   'connected' — the app is OPEN on a phone; an answer can arrive in seconds
   *   'push'      — reachable, but the app is closed; they must see an alert and open it
   *   'none'      — nobody. Never hold the terminal at all.
   *
   * The first version asked only "is there an audience?" and counted a push REGISTRATION as
   * one. A registration is permanent, so it always said yes — and every question froze the
   * keyboard for two minutes even with the phone face-down in a drawer.
   */
  audience: () => 'connected' | 'push' | 'none'
  /**
   * Survives a daemon restart. Without it, a session that is still RUNNING becomes invisible
   * the moment the daemon restarts — and therefore unstoppable — until it happens to fire
   * another hook. Optional so tests and demos need not carry one.
   */
  registry?: SessionRegistry
  now?: () => number
  /** How long a question may hold the terminal when the app is open on a phone. */
  waitMs?: number
  /** How long to hold when only a push can reach them — time to feel it and open the app. */
  pushWaitMs?: number
  /** Transcript poll cadence. */
  pollMs?: number
  /** Test seams for the stop path: process verification and the kill itself. */
  isClaudeProcess?: (pid: number) => boolean
  kill?: (pid: number) => void
  /**
   * A terminal session finished (or was stopped). Its conversation survives in
   * Claude Code's storage under this resume id — the hand that receives the baton.
   */
  onEnded?: (info: {
    sessionId: string
    claudeSessionId: string
    cwd: string
    title: string
    startedAt: number
  }) => void
}

interface ExternalSession {
  sessionId: string
  /** Which CLI this session belongs to — a person running several must be able to tell. */
  agent: TerminalAgent
  /** Terminal or editor. The other half of telling four identical-looking sessions apart. */
  surface: Surface
  cwd: string
  transcriptPath: string
  status: SessionStatus
  startedAt: number
  title: string
  /** The claude process itself, reported by the hook — what Stop actually stops. */
  pid: number | null
  /** False until the first human message renames it from its folder. */
  named: boolean
  /** The permission mode Claude Code last reported for this session. */
  permissionMode: string | null
  /** LongLeash's own gate: whether this session may page the phone at all. */
  gate: SessionGate
  /** Byte offset already ingested from the transcript. */
  offset: number
  /** Carry-over of a partial trailing line between polls. */
  remainder: string
  timer: ReturnType<typeof setInterval> | null
}

/** Everything about a permission question beyond the tool itself. */
export interface PermissionContext {
  /**
   * The agent's own id for this exact tool call, when it provides one. Codex can fire the
   * same hook more than once with byte-identical payloads, so without this the phone would
   * show two cards for one decision — and a person who learns their inbox double-counts
   * stops trusting it, which is the same harm as asking about things that cannot matter.
   * Both callers join one approval and receive the same answer.
   */
  dedupeKey?: string
  /** Which CLI is asking. Defaults to Claude Code, the original caller. */
  agent?: TerminalAgent
  /** Terminal or editor, as reported by the hook. */
  surface?: Surface
  /**
   * Fires when the asking process goes away — which is how we learn the person answered
   * at their keyboard instead of on their phone.
   */
  abandoned?: AbortSignal
}

interface Waiting {
  resolve: (decision: HookDecision) => void
  timer: ReturnType<typeof setTimeout>
  /** So a session ending can clear whatever it left outstanding. */
  sessionId: string
  /** Set when this is a question: answering it is not the same act as allowing it. */
  questions?: AskedQuestion[]
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`

/**
 * Claude Code's AskUserQuestion tool, read out of the hook payload. Anything that does
 * not parse is treated as "not a question", which degrades to the ordinary permission
 * path rather than dropping the interaction — a malformed question must never become a
 * silent no-op at someone's terminal.
 */
export function readQuestions(toolName: string, input: unknown): AskedQuestion[] | null {
  if (toolName !== 'AskUserQuestion') return null
  if (!input || typeof input !== 'object') return null
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const parsed: AskedQuestion[] = []
  for (const q of raw.slice(0, 4)) {
    const result = AskedQuestion.safeParse(q)
    if (result.success) parsed.push(result.data)
  }
  return parsed.length > 0 ? parsed : null
}

/**
 * What Claude receives once a question has been answered on the phone. A PreToolUse hook
 * cannot supply a tool's result — it can only allow, deny, or modify input — so the
 * answer travels back as the denial reason. Phrased to be unmistakable: the tool did not
 * run, but the question HAS been answered and must not be asked again.
 */
export function formatAnswers(
  questions: AskedQuestion[],
  answers: Record<string, string>,
  response?: string,
): string {
  const lines: string[] = []
  for (const q of questions) {
    const picked = answers[q.question]
    if (picked) lines.push(`\u2022 ${q.question} \u2192 ${picked}`)
  }
  if (response !== undefined && response.trim() !== '') {
    lines.push(`\u2022 They also said: ${response.trim()}`)
  }
  return [
    // Opens with "Not an error" on purpose: Claude Code paints every intercepted tool
    // red under an "Error:" prefix, so the first words a person reads in their terminal
    // should contradict that. The model reads the same sentence and treats it as a reply.
    'Not an error — answered from your phone via LongLeash.',
    '',
    ...lines,
    '',
    'Continue with this answer; do not ask the question again.',
  ].join('\n')
}

function summarize(toolName: string, input: unknown): string {
  let detail = ''
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    const interesting = record.file_path ?? record.path ?? record.command ?? record.pattern
    if (typeof interesting === 'string') detail = ` ${interesting}`
  }
  return `${toolName}${detail}`.slice(0, 300)
}

export class ExternalSessions {
  private readonly eventLog: EventLog
  private readonly approvals: ApprovalStore
  private readonly onEvent: ((event: SessionEvent) => void) | undefined
  private readonly audience: () => 'connected' | 'push' | 'none'
  private readonly pushWaitMs: number
  private readonly now: () => number
  private readonly waitMs: number
  private readonly pollMs: number
  private readonly sessions = new Map<string, ExternalSession>()
  private readonly waiting = new Map<string, Waiting>()
  /** Tool calls currently awaiting a phone, keyed by session + the agent's tool-call id. */
  private readonly inFlight = new Map<string, Promise<HookDecision>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly registry: SessionRegistry | undefined
  private readonly isClaudeProcess: (pid: number) => boolean
  private readonly kill: (pid: number) => void
  private readonly onEnded: ExternalSessionsOptions['onEnded']

  constructor(opts: ExternalSessionsOptions) {
    this.eventLog = opts.eventLog
    this.approvals = opts.approvals
    this.onEvent = opts.onEvent
    this.registry = opts.registry
    this.audience = opts.audience
    this.now = opts.now ?? Date.now
    // 45s with the app open, 20s on a push alone. Long enough to answer from a pocket,
    // short enough that a person AT the keyboard is never meaningfully locked out.
    this.waitMs = opts.waitMs ?? 45_000
    this.pushWaitMs = opts.pushWaitMs ?? 20_000
    this.pollMs = opts.pollMs ?? 800
    this.isClaudeProcess = opts.isClaudeProcess ?? agentProcessCheck
    this.kill = opts.kill ?? ((pid) => process.kill(pid, 'SIGTERM'))
    this.onEnded = opts.onEnded
    // A crashed daemon takes its hook waiters with it; those questions were
    // answered at the terminal long ago. Never resurrect them as a phantom inbox.
    /**
     * A previous run died holding these. Closing the SQLite row is not enough: a phone that is
     * still showing the card only ever removes it on an `approval.decided` EVENT, so the row
     * and the screen have to be closed together or the card is immortal.
     */
    for (const orphan of this.approvals.closeOrphans(
      'The daemon restarted; this was answered in the terminal.',
    )) {
      this.emit(orphan.sessionId, {
        type: 'approval.decided',
        payload: {
          approvalId: orphan.approvalId,
          verdict: 'deny',
          decidedBy: 'system:orphaned',
          reply: 'The daemon restarted; this was answered in the terminal.',
        },
      })
      // The session that owned it is gone with the process that was running it.
      this.emit(orphan.sessionId, {
        type: 'session.ended',
        payload: { reason: 'the daemon restarted', resumable: false },
      })
    }

    // Take back whatever is still genuinely running. Must come AFTER the orphan sweep so a
    // re-adopted session does not inherit a question nobody can answer any more.
    this.readopt()
  }

  /**
   * Take back the sessions a previous run was watching.
   *
   * Anything whose process is still alive is re-adopted and stays stoppable. Anything whose
   * process is gone is announced as ended, which is the only way the phone can ever stop
   * showing it — the app clears a session on the event, never on silence.
   */
  private readopt(): void {
    if (this.registry === undefined) return
    for (const row of this.registry.all()) {
      const alive = row.pid !== null && this.isClaudeProcess(row.pid)
      if (!alive) {
        this.registry.forget(row.agentSessionId)
        this.emit(row.sessionId, { type: 'session.status', payload: { status: 'ended' } })
        this.emit(row.sessionId, {
          type: 'session.ended',
          payload: { reason: 'this session is no longer running', resumable: false },
        })
        continue
      }
      const session: ExternalSession = {
        sessionId: row.sessionId,
        agent: terminalAgentOf(row.agent),
        surface: surfaceOf(row.surface),
        cwd: row.cwd,
        transcriptPath: row.transcriptPath,
        status: 'running',
        startedAt: row.startedAt,
        title: row.title,
        pid: row.pid,
        named: true,
        permissionMode: null,
        gate: 'ask',
        // Everything already ingested stays ingested; only what grew since is new.
        offset: existsSync(row.transcriptPath) ? statSync(row.transcriptPath).size : 0,
        remainder: '',
        timer: null,
      }
      this.sessions.set(row.agentSessionId, session)
      session.timer = setInterval(() => this.drain(session), this.pollMs)
      session.timer.unref?.()
      this.emit(session.sessionId, { type: 'session.status', payload: { status: 'running' } })
    }
  }

  /** Register (or re-adopt after a daemon restart) a terminal session. */
  sessionStart(
    claudeSessionId: string,
    cwd: string,
    transcriptPath: string,
    pid?: number,
    agent: TerminalAgent = 'claude',
    surface: Surface = 'terminal',
  ): void {
    const session = this.ensure(claudeSessionId, cwd, transcriptPath, agent, surface)
    if (pid !== undefined && Number.isInteger(pid) && pid > 1) {
      session.pid = pid
      this.persist(claudeSessionId, session)
    }
  }

  /**
   * Stop a terminal session from the phone — for real. The recorded pid is only
   * trusted after re-verifying it still belongs to a claude process, because PIDs
   * get recycled and killing a stranger's process is unforgivable.
   */
  stop(externalSessionId: string, decidedBy: string): boolean {
    const entry = [...this.sessions.entries()].find(([, s]) => s.sessionId === externalSessionId)
    if (!entry) return false
    const [claudeSessionId, session] = entry

    /**
     * The process is gone, or we never learned what it was.
     *
     * Refusing was wrong in both directions: the session stayed listed as running forever, and
     * pressing Stop did nothing with no explanation — which is exactly what a person reads as
     * "this product does not work". A session whose process is not there IS over, so say so and
     * clear it. This is also what kept ghost sessions from previous runs in the list.
     */
    if (session.pid === null || !this.isClaudeProcess(session.pid)) {
      this.emit(session.sessionId, {
        type: 'stream.delta',
        payload: { kind: 'text', text: '— this session is no longer running —' },
      })
      this.sessionEnd(claudeSessionId)
      return true
    }
    try {
      this.kill(session.pid)
    } catch {
      return false
    }
    this.emit(session.sessionId, {
      type: 'stream.delta',
      payload: { kind: 'text', text: `— stopped from your phone by ${decidedBy} —` },
    })
    // SessionEnd normally arrives from the dying process's own hook; ending it
    // here as well is idempotent and keeps the phone honest if that hook never runs.
    this.sessionEnd(claudeSessionId)
    return true
  }

  /**
   * A tool wants to run in the terminal. Returns what the hook should tell
   * Claude Code — and "ask" always means "behave as if we were never here".
   */
  preToolUse(
    claudeSessionId: string,
    cwd: string,
    transcriptPath: string,
    toolName: string,
    toolInput: unknown,
    permissionMode?: string,
    opts: PermissionContext = {},
  ): Promise<HookDecision> {
    const { dedupeKey, agent = 'claude', surface = 'terminal', abandoned } = opts
    const session = this.ensure(claudeSessionId, cwd, transcriptPath, agent, surface)

    const joinKey = dedupeKey === undefined ? null : `${session.sessionId}:${dedupeKey}`
    if (joinKey !== null) {
      const already = this.inFlight.get(joinKey)
      if (already !== undefined) return already
    }

    // Muted by the person: approve without asking. This exists because a session whose
    // permission mode auto-approves ignores a refusal from anyone — so paging a phone
    // about it is a question whose answer cannot matter, which is worse than silence.
    if (session.gate === 'auto') {
      return Promise.resolve({ decision: 'allow', reason: 'Auto-approved: you muted this session.' })
    }

    // Surface the mode the moment it changes: a phone that is being asked about a session
    // running in auto mode deserves to see that contradiction rather than puzzle over it.
    if (permissionMode !== undefined && permissionMode !== session.permissionMode) {
      session.permissionMode = permissionMode
      this.emit(session.sessionId, {
        type: 'session.status',
        payload: { status: session.status, permissionMode },
      })
    }

    const who = this.audience()
    if (who === 'none') {
      return Promise.resolve({
        decision: 'ask',
        reason: 'No phone is reachable; deciding in the terminal.',
      })
    }
    // Holding the keyboard is a cost paid by whoever is sitting at it. Pay less of it when the
    // app is not even open, because then the answer cannot arrive quickly anyway.
    const holdMs = who === 'connected' ? this.waitMs : this.pushWaitMs

    const questions = readQuestions(toolName, toolInput)
    const approvalId = newId('apr')
    // A question's summary is the question itself; a tool's is what it would touch.
    const inputSummary = questions
      ? questions.map((q) => q.question).join(' · ').slice(0, 300)
      : summarize(toolName, toolInput)
    const expiresAt = this.now() + holdMs
    this.approvals.create({
      approvalId,
      sessionId: session.sessionId,
      toolName,
      inputSummary,
      expiresAt,
      targetPath: null,
      outsideRoot: false,
    })
    this.emit(session.sessionId, {
      type: 'approval.requested',
      payload: {
        approvalId,
        toolName,
        inputSummary,
        expiresAt,
        outsideRoot: false,
        ...(questions === null ? {} : { questions }),
      },
    })

    const pending = new Promise<HookDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(approvalId)
        this.approvals.decide(
          approvalId,
          'denied',
          'system:timeout',
          'No answer from the phone in time; the terminal asked instead.',
        )
        this.emit(session.sessionId, {
          type: 'approval.decided',
          payload: {
            approvalId,
            verdict: 'deny',
            decidedBy: 'system:timeout',
            reply: 'Answered in the terminal instead.',
          },
        })
        resolve({ decision: 'ask', reason: 'No answer from the phone; deciding in the terminal.' })
      }, holdMs)
      timer.unref?.()
      this.waiting.set(approvalId, {
        resolve,
        timer,
        sessionId: session.sessionId,
        ...(questions === null ? {} : { questions }),
      })

      /**
       * The person answered at the keyboard instead.
       *
       * When they do, the agent moves straight on and the hook process exits — so its
       * request dies. Nothing else tells us: the phone would otherwise keep showing a
       * card for a decision that was made minutes ago, and an inbox that shows things
       * which are no longer true is worse than no inbox at all.
       */
      if (abandoned !== undefined) {
        const onAbandon = () => this.abandon(approvalId, 'answered-at-keyboard')
        if (abandoned.aborted) onAbandon()
        else abandoned.addEventListener('abort', onAbandon, { once: true })
      }
    })

    if (joinKey !== null) {
      this.inFlight.set(joinKey, pending)
      // Release the key however this settles, so a later identical call asks again
      // rather than replaying a stale verdict.
      void pending.finally(() => {
        this.inFlight.delete(joinKey)
      })
    }
    return pending
  }

  /**
   * Stop waiting on an approval nobody will ever answer, and tell the phone so.
   *
   * Three things can strand a question, and all three used to leave a card on the phone
   * that stayed there forever:
   *   - the person answered at their keyboard, so the asking process exited;
   *   - the session ended while a question was outstanding;
   *   - the deadline passed with no in-memory waiter to notice (after a restart).
   *
   * All of them resolve to `ask`, which is the same thing LongLeash says whenever it has
   * no opinion: the terminal decides, exactly as if we were not installed.
   */
  private abandon(approvalId: string, why: 'answered-at-keyboard' | 'session-ended' | 'expired'): boolean {
    const record = this.approvals.get(approvalId)
    if (record === null || record.status !== 'pending') return false

    const waiter = this.waiting.get(approvalId)
    const sessionId = waiter?.sessionId ?? record.sessionId
    if (waiter !== undefined) {
      clearTimeout(waiter.timer)
      this.waiting.delete(approvalId)
    }

    const reply = {
      'answered-at-keyboard': 'Answered at the keyboard.',
      'session-ended': 'The session ended before this was answered.',
      expired: 'No answer in time; the terminal decided.',
    }[why]

    this.approvals.decide(approvalId, 'denied', `system:${why}`, reply)
    this.emit(sessionId, {
      type: 'approval.decided',
      payload: { approvalId, verdict: 'deny', decidedBy: `system:${why}`, reply },
    })
    // Resolving to "ask" is what hands the decision back; the hook is usually gone by now,
    // and a resolved promise it never reads is harmless.
    waiter?.resolve({ decision: 'ask', reason: reply })
    return true
  }

  /**
   * Clear anything whose deadline has passed. `ApprovalStore.findExpired()` existed with a
   * comment saying the caller denies them — and had no caller, so an approval that outlived
   * its deadline stayed pending forever. This is that caller.
   */
  sweepExpired(): number {
    let cleared = 0
    for (const approval of this.approvals.findExpired()) {
      if (this.abandon(approval.approvalId, 'expired')) cleared += 1
    }
    return cleared
  }

  /** The phone answered. Mirrors SessionManager.decide, for this manager's approvals only. */
  decide(
    approvalId: string,
    verdict: 'allow' | 'deny',
    decidedBy: string,
    reply?: string,
    answers?: Record<string, string>,
  ): DecisionOutcome {
    const approval = this.approvals.get(approvalId)
    if (!approval) return 'unknown'
    const waiter = this.waiting.get(approvalId)
    const questions = waiter?.questions

    const committed = this.approvals.decide(
      approvalId,
      verdict === 'allow' ? 'allowed' : 'denied',
      decidedBy,
      reply,
    )
    if (!committed) return 'already-decided'

    this.emit(approval.sessionId, {
      type: 'approval.decided',
      payload: {
        approvalId,
        verdict,
        decidedBy,
        ...(reply === undefined ? {} : { reply }),
        ...(answers === undefined ? {} : { answers }),
      },
    })

    if (waiter) {
      this.waiting.delete(approvalId)
      clearTimeout(waiter.timer)
      // A question is answered, never "approved": the tool is refused on purpose and the
      // chosen options travel back as the reason, which is the only channel a PreToolUse
      // hook has for saying something to the model.
      if (questions !== undefined && answers !== undefined) {
        waiter.resolve({ decision: 'deny', reason: formatAnswers(questions, answers, reply) })
      } else if (questions !== undefined) {
        // The person dismissed the question instead of answering it.
        waiter.resolve({
          decision: 'ask',
          reason: 'The user left this question for the terminal.',
        })
      } else {
        waiter.resolve(
          verdict === 'allow'
            ? { decision: 'allow', reason: `Approved from your phone by ${decidedBy}` }
            : {
                decision: 'deny',
                reason: reply ? `Denied from your phone: ${reply}` : 'Denied from your phone',
              },
        )
      }
    }
    return 'decided'
  }

  /** Mute or unmute a session from the phone. Returns false for a session it does not know. */
  setGate(externalSessionId: string, gate: SessionGate): boolean {
    const session = [...this.sessions.values()].find((s) => s.sessionId === externalSessionId)
    if (!session) return false
    session.gate = gate
    this.emit(session.sessionId, {
      type: 'session.status',
      payload: { status: session.status, gate },
    })
    return true
  }

  sessionEnd(claudeSessionId: string): void {
    const session = this.sessions.get(claudeSessionId)
    if (!session) return
    this.drain(session)
    if (session.timer !== null) clearInterval(session.timer)
    session.status = 'ended'
    this.sessions.delete(claudeSessionId)
    this.registry?.forget(claudeSessionId)

    // Anything it was still asking about can never be answered now: the process that would
    // have received the verdict is gone. Clearing them here is what stops a finished session
    // leaving permanent cards behind on the phone.
    for (const [approvalId, waiting] of [...this.waiting.entries()]) {
      if (waiting.sessionId === session.sessionId) this.abandon(approvalId, 'session-ended')
    }

    // Pass the baton BEFORE announcing the end: the adoption is what makes this
    // conversation reopenable, and the event that reports the ending must be able
    // to tell the phone so in the same breath. Announcing first would leave every
    // already-connected phone believing "no resume point" until it reconnected —
    // which is exactly the bug this ordering exists to prevent.
    const adopted = this.onEnded !== undefined
    this.onEnded?.({
      sessionId: session.sessionId,
      claudeSessionId,
      cwd: session.cwd,
      title: session.title,
      startedAt: session.startedAt,
    })

    this.emit(session.sessionId, { type: 'session.status', payload: { status: 'ended' } })
    this.emit(session.sessionId, {
      type: 'session.ended',
      payload: { reason: 'terminal session ended', resumable: adopted, resumeId: claudeSessionId },
    })
  }

  listSessions(): {
    sessionId: string
    agent: TerminalAgent
    cwd: string
    status: SessionStatus
    startedAt: number
    origin: Surface
    title: string
    resumable: boolean
    resumeId: string
    gate: SessionGate
  }[] {
    return [...this.sessions.entries()].map(([claudeSessionId, session]) => ({
      sessionId: session.sessionId,
      agent: session.agent,
      cwd: session.cwd,
      status: session.status,
      startedAt: session.startedAt,
      origin: session.surface,
      title: session.title,
      // Live: it cannot be reopened while it is still running at the keyboard…
      resumable: false,
      // …but its conversation id is known from the first hook event, so the phone can
      // always offer `claude --resume <id>` for picking it up later.
      resumeId: claudeSessionId,
      gate: session.gate,
    }))
  }

  /** Write this session down so a restart can take it back. */
  private persist(agentSessionId: string, session: ExternalSession): void {
    this.registry?.remember({
      agentSessionId,
      sessionId: session.sessionId,
      agent: session.agent,
      surface: session.surface,
      cwd: session.cwd,
      transcriptPath: session.transcriptPath,
      pid: session.pid,
      title: session.title,
      startedAt: session.startedAt,
    })
  }

  /** Start the periodic expiry sweep. Returns a stop function. */
  startSweeping(everyMs = 15_000): () => void {
    const timer = setInterval(() => this.sweepExpired(), everyMs)
    timer.unref?.()
    this.sweepTimer = timer
    return () => clearInterval(timer)
  }

  shutdown(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer)
    this.sweepTimer = null

    /**
     * Say that these sessions are over BEFORE going away.
     *
     * Clearing the map silently left the last persisted event saying `running`, so every phone
     * kept them listed as live forever and Stop on them was refused — the daemon no longer had
     * them to stop. Even a clean Ctrl-C did this, not just a crash.
     *
     * This says "we can no longer see it", which is true and is the honest thing a phone needs;
     * it does not touch the terminal process, which may legitimately outlive us and be adopted
     * again on the next start.
     */
    for (const [, session] of this.sessions) {
      this.emit(session.sessionId, { type: 'session.status', payload: { status: 'ended' } })
      this.emit(session.sessionId, {
        type: 'session.ended',
        payload: { reason: 'LongLeash stopped watching', resumable: false },
      })
    }
    for (const [approvalId, waiter] of this.waiting) {
      clearTimeout(waiter.timer)
      waiter.resolve({ decision: 'ask', reason: 'The daemon is shutting down.' })
      this.waiting.delete(approvalId)
    }
    for (const session of this.sessions.values()) {
      if (session.timer !== null) clearInterval(session.timer)
    }
    this.sessions.clear()
  }

  /* ------------------------------------------------------------------ internals */

  private ensure(
    claudeSessionId: string,
    cwd: string,
    transcriptPath: string,
    agent: TerminalAgent = 'claude',
    surface: Surface = 'terminal',
  ): ExternalSession {
    const existing = this.sessions.get(claudeSessionId)
    if (existing) return existing

    const sessionId = `ext_${claudeSessionId}`
    // A daemon restart mid-conversation must adopt, not duplicate: history in the
    // log means the phone already has the story up to where the tail resumes.
    const replay = this.eventLog.replay(sessionId, 0)
    const hasHistory = replay.gap === false ? replay.events.length > 0 : true
    const session: ExternalSession = {
      sessionId,
      agent,
      surface,
      cwd,
      transcriptPath,
      status: 'running',
      startedAt: this.now(),
      title: `${basename(cwd)} — ${surface === 'vscode' ? 'VS Code' : AGENT_LABEL[agent]}`,
      pid: null,
      named: false,
      permissionMode: null,
      gate: 'ask',
      offset: hasHistory && existsSync(transcriptPath) ? statSync(transcriptPath).size : 0,
      remainder: '',
      timer: null,
    }
    this.sessions.set(claudeSessionId, session)
    this.persist(claudeSessionId, session)

    if (!hasHistory) {
      this.emit(sessionId, {
        type: 'session.started',
        payload: {
          agent,
          cwd,
          title: session.title,
          origin: surface,
          resumeId: claudeSessionId,
        },
      })
    }
    this.emit(sessionId, { type: 'session.status', payload: { status: 'running' } })

    session.timer = setInterval(() => this.drain(session), this.pollMs)
    session.timer.unref?.()
    this.drain(session)
    return session
  }

  /** Ingest whatever the transcript has grown since the last look. */
  private drain(session: ExternalSession): void {
    let size: number
    try {
      size = statSync(session.transcriptPath).size
    } catch {
      return // not written yet — Claude Code creates it lazily
    }
    if (size <= session.offset) return

    let chunk: string
    try {
      const fd = openSync(session.transcriptPath, 'r')
      try {
        const buffer = Buffer.alloc(size - session.offset)
        const read = readSync(fd, buffer, 0, buffer.length, session.offset)
        chunk = buffer.subarray(0, read).toString('utf8')
        session.offset += read
      } finally {
        closeSync(fd)
      }
    } catch {
      return
    }

    const text = session.remainder + chunk
    const lines = text.split('\n')
    session.remainder = lines.pop() ?? ''
    const deltas: AppendInput[] = []
    for (const line of lines) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      for (const delta of transcriptDeltas(parsed)) deltas.push(delta)
    }
    for (const delta of deltas) this.emit(session.sessionId, delta)

    // The first thing the person asked for becomes the session's name. Every terminal
    // session in one folder was otherwise called the same thing, which is useless
    // precisely when several are open at once.
    if (!session.named) {
      for (const delta of deltas) {
        if (delta.type !== 'stream.delta' || delta.payload.kind !== 'user') continue
        const title = titleFrom(delta.payload.text)
        if (title === null) continue
        session.named = true
        session.title = title
        this.emit(session.sessionId, {
          type: 'session.status',
          payload: { status: session.status, title },
        })
        break
      }
    }
  }

  private emit(sessionId: string, input: AppendInput): void {
    const event = this.eventLog.append(sessionId, input)
    this.onEvent?.(event)
  }
}

/**
 * What the person actually said. Claude Code records slash commands as markup
 * (`<command-name>/exit</command-name>…`) in the same place as real messages; rendering
 * that verbatim on a phone shows plumbing where speech should be.
 */
/**
 * Tags the harness and the IDE inject into the conversation as if the person had typed
 * them. Named explicitly so the common ones are unambiguous — but the general rule below
 * is what actually carries the weight, because this list will keep growing and the next
 * tag must not need a release to stop leaking onto someone's phone.
 */
const MACHINE_TAGS = [
  'ide_opened_file',
  'ide_selection',
  'task-notification',
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'command-message',
  'command-args',
  'command-name',
]

/** A whole block of `<tag>…</tag>`, with nothing else around it. */
const ONLY_TAGS = /^(?:\s*<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>\s*)+$/

/**
 * What a person actually said, out of a transcript entry recorded as coming from them.
 *
 * Agents receive a lot of machinery on the user's turn — files opened in the IDE, background
 * task notifications, system reminders — and none of it is speech. Showing it as speech makes
 * the phone look like it is quoting you saying things you never said, which is both confusing
 * and the kind of small wrongness that makes people stop trusting the whole view.
 *
 * Returns '' for anything that is purely machinery.
 */
export function humanSaid(text: string): string {
  // Slash commands are the one case where markup wraps something the person genuinely did.
  if (/<command-(name|message|args)>/.test(text)) {
    const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim()
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim()
    if (name === undefined || name === '') return ''
    return args ? `${name} ${args}` : name
  }

  // Strip known machine blocks wherever they sit, so a real message that merely arrived
  // alongside one still reaches the phone intact.
  let remaining = text
  for (const tag of MACHINE_TAGS) {
    remaining = remaining.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '')
    // Unclosed variants appear when a block is truncated mid-write.
    remaining = remaining.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), '')
  }

  // Anything still made entirely of tags is machinery we have not met before.
  if (ONLY_TAGS.test(remaining.trim())) return ''

  return remaining.trim()
}

/**
 * A name a person would recognise, taken from the first thing they asked for. Without
 * this every terminal session in one folder is called the same thing, which makes a list
 * of them useless exactly when there are several to choose between.
 */
export function titleFrom(text: string): string | null {
  const line = humanSaid(text).trim().split('\n').find((l) => l.trim() !== '')
  if (line === undefined) return null
  const clean = line.trim()
  if (clean === '') return null
  return clean.length > 72 ? `${clean.slice(0, 71)}\u2026` : clean
}

/**
 * Is this pid still the agent we think it is? PIDs recycle; never kill on faith.
 *
 * Checks BOTH vendors because a Codex session's process is `codex`, not `claude`. The first
 * version only matched claude, so Stop on a Codex session could never succeed even once its
 * pid was reported — it simply refused, forever, with nothing on the phone to explain why.
 */
function agentProcessCheck(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1500,
    }).trim()
    return /\b(claude|codex)\b/.test(command)
  } catch {
    return false
  }
}

/**
 * One transcript line → zero or more stream deltas. The JSONL is Claude Code's
 * own on-disk format: `user` and `assistant` records carrying content blocks,
 * interleaved with meta records this deliberately ignores.
 */
export function transcriptDeltas(line: unknown): AppendInput[] {
  if (!line || typeof line !== 'object') return []
  const record = line as Record<string, unknown>
  if (record.isMeta === true) return []
  const message = record.message as Record<string, unknown> | undefined
  if (!message) return []

  const out: AppendInput[] = []
  const push = (kind: 'text' | 'tool' | 'thinking' | 'user', text: string) => {
    if (text.trim() !== '') out.push({ type: 'stream.delta', payload: { kind, text } })
  }

  if (record.type === 'user') {
    const content = message.content
    if (typeof content === 'string') push('user', humanSaid(content))
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>
        // tool_result blocks are plumbing between the agent and its tools, not speech.
        if (b.type === 'text' && typeof b.text === 'string') push('user', humanSaid(b.text))
      }
    }
    return out
  }

  if (record.type === 'assistant') {
    const content = message.content
    if (!Array.isArray(content)) return out
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') push('text', b.text)
      else if (b.type === 'thinking' && typeof b.thinking === 'string') push('thinking', b.thinking)
      else if (b.type === 'tool_use' && typeof b.name === 'string') {
        push('tool', summarize(b.name, b.input).replace(/^(\S+) /, '$1: '))
      }
    }
  }
  return out
}

