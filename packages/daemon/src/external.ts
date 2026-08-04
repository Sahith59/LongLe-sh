import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SessionEvent } from '@longleash/protocol'
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
  /** Byte offset already ingested from the transcript. */
  offset: number
  /** Carry-over of a partial trailing line between polls. */
  remainder: string
  timer: ReturnType<typeof setInterval> | null
}

interface Waiting {
  resolve: (decision: HookDecision) => void
  timer: ReturnType<typeof setTimeout>
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`

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
  ): Promise<HookDecision> {
    const session = this.ensure(claudeSessionId, cwd, transcriptPath)

    if (!this.hasAudience()) {
      return Promise.resolve({
        decision: 'ask',
        reason: 'No phone is reachable; deciding in the terminal.',
      })
    }

    const approvalId = newId('apr')
    const inputSummary = summarize(toolName, toolInput)
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
      payload: { approvalId, toolName, inputSummary, expiresAt, outsideRoot: false },
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
      this.waiting.set(approvalId, { resolve, timer })
    })
  }

  /** The phone answered. Mirrors SessionManager.decide, for this manager's approvals only. */
  decide(approvalId: string, verdict: 'allow' | 'deny', decidedBy: string, reply?: string): DecisionOutcome {
    const approval = this.approvals.get(approvalId)
    if (!approval) return 'unknown'
    const committed = this.approvals.decide(
      approvalId,
      verdict === 'allow' ? 'allowed' : 'denied',
      decidedBy,
      reply,
    )
    if (!committed) return 'already-decided'
    this.emit(approval.sessionId, {
      type: 'approval.decided',
      payload: { approvalId, verdict, decidedBy, ...(reply === undefined ? {} : { reply }) },
    })
    const waiter = this.waiting.get(approvalId)
    if (waiter) {
      this.waiting.delete(approvalId)
      clearTimeout(waiter.timer)
      waiter.resolve(
        verdict === 'allow'
          ? { decision: 'allow', reason: `Approved from your phone by ${decidedBy}` }
          : {
              decision: 'deny',
              reason: reply ? `Denied from your phone: ${reply}` : 'Denied from your phone',
            },
      )
    }
    return 'decided'
  }

  sessionEnd(claudeSessionId: string): void {
    const session = this.sessions.get(claudeSessionId)
    if (!session) return
    this.drain(session)
    if (session.timer !== null) clearInterval(session.timer)
    session.status = 'ended'
    this.emit(session.sessionId, { type: 'session.status', payload: { status: 'ended' } })
    this.emit(session.sessionId, { type: 'session.ended', payload: { reason: 'terminal session ended' } })
    this.sessions.delete(claudeSessionId)
    // Pass the baton: an ended terminal conversation becomes reopenable from the phone.
    this.onEnded?.({
      sessionId: session.sessionId,
      claudeSessionId,
      cwd: session.cwd,
      title: session.title,
      startedAt: session.startedAt,
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
  }[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      agent: 'claude',
      cwd: session.cwd,
      status: session.status,
      startedAt: session.startedAt,
      origin: 'terminal',
      title: session.title,
      resumable: false,
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
      offset: hasHistory && existsSync(transcriptPath) ? statSync(transcriptPath).size : 0,
      remainder: '',
      timer: null,
    }
    this.sessions.set(claudeSessionId, session)

    if (!hasHistory) {
      this.emit(sessionId, {
        type: 'session.started',
        payload: { agent: 'claude', cwd, title: session.title, origin: 'terminal' },
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
  }

  private emit(sessionId: string, input: AppendInput): void {
    const event = this.eventLog.append(sessionId, input)
    this.onEvent?.(event)
  }
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
    if (typeof content === 'string') push('user', content)
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>
        // tool_result blocks are plumbing between the agent and its tools, not speech.
        if (b.type === 'text' && typeof b.text === 'string') push('user', b.text)
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
