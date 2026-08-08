import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AskedQuestion, type SessionEvent, type SessionGate } from '@longleash/protocol'
import type { EventLog, AppendInput } from './eventlog.js'
import type { ApprovalStore } from './approvals.js'
import type { DecisionOutcome, SessionStatus } from './sessions.js'

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

export interface ExternalSessionsOptions {
  eventLog: EventLog
  /**
   * A store of its OWN, never shared with SessionManager: decision routing relies
   * on each manager recognising exactly its own approval ids.
   */
  approvals: ApprovalStore
  onEvent?: (event: SessionEvent) => void
  /** Could anyone plausibly answer a phone approval right now? */
  hasAudience: () => boolean
  now?: () => number
  /** How long a PreToolUse question may hold the terminal before falling back to it. */
  waitMs?: number
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

interface Waiting {
  resolve: (decision: HookDecision) => void
  timer: ReturnType<typeof setTimeout>
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
  private readonly hasAudience: () => boolean
  private readonly now: () => number
  private readonly waitMs: number
  private readonly pollMs: number
  private readonly sessions = new Map<string, ExternalSession>()
  private readonly waiting = new Map<string, Waiting>()
  private readonly isClaudeProcess: (pid: number) => boolean
  private readonly kill: (pid: number) => void
  private readonly onEnded: ExternalSessionsOptions['onEnded']

  constructor(opts: ExternalSessionsOptions) {
    this.eventLog = opts.eventLog
    this.approvals = opts.approvals
    this.onEvent = opts.onEvent
    this.hasAudience = opts.hasAudience
    this.now = opts.now ?? Date.now
    this.waitMs = opts.waitMs ?? 120_000
    this.pollMs = opts.pollMs ?? 800
    this.isClaudeProcess = opts.isClaudeProcess ?? claudeProcessCheck
    this.kill = opts.kill ?? ((pid) => process.kill(pid, 'SIGTERM'))
    this.onEnded = opts.onEnded
    // A crashed daemon takes its hook waiters with it; those questions were
    // answered at the terminal long ago. Never resurrect them as a phantom inbox.
    this.approvals.closeOrphans('The daemon restarted; this was answered in the terminal.')
  }

  /** Register (or re-adopt after a daemon restart) a terminal session. */
  sessionStart(claudeSessionId: string, cwd: string, transcriptPath: string, pid?: number): void {
    const session = this.ensure(claudeSessionId, cwd, transcriptPath)
    if (pid !== undefined && Number.isInteger(pid) && pid > 1) session.pid = pid
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
    if (session.pid === null || !this.isClaudeProcess(session.pid)) return false
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
  ): Promise<HookDecision> {
    const session = this.ensure(claudeSessionId, cwd, transcriptPath)

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

    if (!this.hasAudience()) {
      return Promise.resolve({
        decision: 'ask',
        reason: 'No phone is reachable; deciding in the terminal.',
      })
    }

    const questions = readQuestions(toolName, toolInput)
    const approvalId = newId('apr')
    // A question's summary is the question itself; a tool's is what it would touch.
    const inputSummary = questions
      ? questions.map((q) => q.question).join(' · ').slice(0, 300)
      : summarize(toolName, toolInput)
    const expiresAt = this.now() + this.waitMs
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

    return new Promise<HookDecision>((resolve) => {
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
      }, this.waitMs)
      timer.unref?.()
      this.waiting.set(approvalId, {
        resolve,
        timer,
        ...(questions === null ? {} : { questions }),
      })
    })
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
    agent: 'claude'
    cwd: string
    status: SessionStatus
    startedAt: number
    origin: 'terminal'
    title: string
    resumable: boolean
    resumeId: string
    gate: SessionGate
  }[] {
    return [...this.sessions.entries()].map(([claudeSessionId, session]) => ({
      sessionId: session.sessionId,
      agent: 'claude',
      cwd: session.cwd,
      status: session.status,
      startedAt: session.startedAt,
      origin: 'terminal',
      title: session.title,
      // Live: it cannot be reopened while it is still running at the keyboard…
      resumable: false,
      // …but its conversation id is known from the first hook event, so the phone can
      // always offer `claude --resume <id>` for picking it up later.
      resumeId: claudeSessionId,
      gate: session.gate,
    }))
  }

  shutdown(): void {
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

  private ensure(claudeSessionId: string, cwd: string, transcriptPath: string): ExternalSession {
    const existing = this.sessions.get(claudeSessionId)
    if (existing) return existing

    const sessionId = `ext_${claudeSessionId}`
    // A daemon restart mid-conversation must adopt, not duplicate: history in the
    // log means the phone already has the story up to where the tail resumes.
    const replay = this.eventLog.replay(sessionId, 0)
    const hasHistory = replay.gap === false ? replay.events.length > 0 : true
    const session: ExternalSession = {
      sessionId,
      cwd,
      transcriptPath,
      status: 'running',
      startedAt: this.now(),
      title: `${basename(cwd)} — terminal`,
      pid: null,
      named: false,
      permissionMode: null,
      gate: 'ask',
      offset: hasHistory && existsSync(transcriptPath) ? statSync(transcriptPath).size : 0,
      remainder: '',
      timer: null,
    }
    this.sessions.set(claudeSessionId, session)

    if (!hasHistory) {
      this.emit(sessionId, {
        type: 'session.started',
        payload: {
          agent: 'claude',
          cwd,
          title: session.title,
          origin: 'terminal',
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
export function humanSaid(text: string): string {
  if (/<command-(name|message|args)>/.test(text)) {
    const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim()
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim()
    if (name === undefined || name === '') return ''
    return args ? `${name} ${args}` : name
  }
  return text
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

/** Is this pid still a claude process? PIDs recycle; never kill on faith. */
function claudeProcessCheck(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1500,
    }).trim()
    return /\bclaude\b/.test(command)
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
