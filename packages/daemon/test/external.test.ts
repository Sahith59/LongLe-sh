import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@longleash/protocol'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { ExternalSessions, formatAnswers, readQuestions, transcriptDeltas } from '../src/external.js'

let dir: string
let eventLog: EventLog
let approvals: ApprovalStore
let seen: SessionEvent[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'll-external-'))
  eventLog = new EventLog(':memory:')
  approvals = new ApprovalStore(':memory:')
  seen = []
})
afterEach(() => {
  eventLog.close()
  approvals.close()
  rmSync(dir, { recursive: true, force: true })
})

function manager(
  opts: {
    audience?: boolean
    waitMs?: number
    isClaude?: (pid: number) => boolean
    kill?: (pid: number) => void
  } = {},
): ExternalSessions {
  return new ExternalSessions({
    eventLog,
    approvals,
    onEvent: (event) => seen.push(event),
    hasAudience: () => opts.audience ?? true,
    waitMs: opts.waitMs ?? 100,
    pollMs: 25,
    isClaudeProcess: opts.isClaude ?? (() => true),
    kill: opts.kill ?? (() => {}),
  })
}

const until = async (check: () => boolean, ms = 2500): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise((r) => setTimeout(r, 15))
  }
}

const line = (value: unknown) => JSON.stringify(value) + '\n'

describe('terminal sessions, adopted through hooks', () => {
  it('a new session announces itself with origin terminal', () => {
    const external = manager()
    external.sessionStart('abc-123', '/Users/x/proj', join(dir, 'none.jsonl'))
    const started = seen.find((e) => e.type === 'session.started')
    expect(started?.sessionId).toBe('ext_abc-123')
    expect((started?.payload as { origin?: string }).origin).toBe('terminal')
    expect(external.listSessions()[0]).toMatchObject({
      origin: 'terminal',
      resumable: false,
      cwd: '/Users/x/proj',
    })
    external.shutdown()
  })

  it('tails the transcript Claude Code writes — text, thinking, tools, and the human', async () => {
    const transcript = join(dir, 't.jsonl')
    writeFileSync(
      transcript,
      line({ type: 'user', message: { role: 'user', content: 'fix the flaky test' } }),
    )
    const external = manager()
    external.sessionStart('abc', '/Users/x/proj', transcript)
    await until(() => seen.some((e) => e.type === 'stream.delta'))

    appendFileSync(
      transcript,
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'The retry loop looks suspicious…' },
            { type: 'text', text: 'Found it — the cursor reset races the poll.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/Users/x/proj/poll.ts' } },
          ],
        },
      }),
    )
    await until(() => seen.filter((e) => e.type === 'stream.delta').length >= 4)

    const kinds = seen
      .filter((e) => e.type === 'stream.delta')
      .map((e) => (e.payload as { kind: string; text: string }))
    expect(kinds.map((k) => k.kind)).toEqual(['user', 'thinking', 'text', 'tool'])
    expect(kinds[3]?.text).toBe('Edit: /Users/x/proj/poll.ts')
    external.shutdown()
  })

  it('survives a transcript line split across two polls', async () => {
    const transcript = join(dir, 'split.jsonl')
    const full = line({ type: 'user', message: { content: 'hello from a split write' } })
    writeFileSync(transcript, full.slice(0, 25))
    const external = manager()
    external.sessionStart('abc', '/x', transcript)
    await new Promise((r) => setTimeout(r, 80))
    expect(seen.filter((e) => e.type === 'stream.delta')).toHaveLength(0)
    appendFileSync(transcript, full.slice(25))
    await until(() => seen.some((e) => e.type === 'stream.delta'))
    external.shutdown()
  })

  it('an approval waits for the phone and resolves with its verdict', async () => {
    const external = manager({ waitMs: 5000 })
    const pending = external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'Bash', {
      command: 'rm -rf dist',
    })
    await until(() => seen.some((e) => e.type === 'approval.requested'))
    const requested = seen.find((e) => e.type === 'approval.requested')
    const approvalId = (requested?.payload as { approvalId: string }).approvalId

    expect(external.decide(approvalId, 'allow', 'dev_phone')).toBe('decided')
    const verdict = await pending
    expect(verdict.decision).toBe('allow')
    expect(verdict.reason).toContain('dev_phone')
    external.shutdown()
  })

  it('a denial carries the steering reply into the terminal', async () => {
    const external = manager({ waitMs: 5000 })
    const pending = external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'Write', {})
    await until(() => seen.some((e) => e.type === 'approval.requested'))
    const approvalId = (seen.find((e) => e.type === 'approval.requested')?.payload as {
      approvalId: string
    }).approvalId
    external.decide(approvalId, 'deny', 'dev_phone', 'use the staging config')
    const verdict = await pending
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('staging')
    external.shutdown()
  })

  it('an unanswered question falls back to the terminal — ask, never block', async () => {
    const external = manager({ waitMs: 60 })
    const verdict = await external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'Bash', {})
    expect(verdict.decision).toBe('ask')
    // …and the phone inbox clears rather than showing a phantom question.
    expect(seen.some((e) => e.type === 'approval.decided')).toBe(true)
    external.shutdown()
  })

  it('with nobody to answer, it steps aside immediately', async () => {
    const external = manager({ audience: false })
    const verdict = await external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'Bash', {})
    expect(verdict.decision).toBe('ask')
    expect(seen.some((e) => e.type === 'approval.requested')).toBe(false)
    external.shutdown()
  })

  it('a daemon restart adopts a known session instead of duplicating it', () => {
    const transcript = join(dir, 'r.jsonl')
    writeFileSync(transcript, line({ type: 'user', message: { content: 'earlier words' } }))
    const first = manager()
    first.sessionStart('abc', '/x', transcript)
    first.shutdown()

    const startsBefore = seen.filter((e) => e.type === 'session.started').length
    const second = manager()
    second.sessionStart('abc', '/x', transcript)
    expect(seen.filter((e) => e.type === 'session.started')).toHaveLength(startsBefore)
    second.shutdown()
  })

  it('stop kills the verified process and closes the story', () => {
    const killed: number[] = []
    const external = manager({ kill: (pid) => killed.push(pid) })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'), 4242)
    expect(external.stop('ext_abc', 'dev_phone')).toBe(true)
    expect(killed).toEqual([4242])
    expect(seen.some((e) => e.type === 'session.ended')).toBe(true)
    const note = seen.find(
      (e) => e.type === 'stream.delta' && String((e.payload as { text: string }).text).includes('stopped from your phone'),
    )
    expect(note).toBeTruthy()
    external.shutdown()
  })

  it('refuses to kill a recycled pid — the process is no longer claude', () => {
    const killed: number[] = []
    const external = manager({ isClaude: () => false, kill: (pid) => killed.push(pid) })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'), 4242)
    expect(external.stop('ext_abc', 'dev_phone')).toBe(false)
    expect(killed).toEqual([])
    external.shutdown()
  })

  it('refuses to stop a session it never knew, or one without a pid', () => {
    const external = manager()
    expect(external.stop('ext_nope', 'dev_phone')).toBe(false)
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl')) // hook could not find the pid
    expect(external.stop('ext_abc', 'dev_phone')).toBe(false)
    external.shutdown()
  })

  it('ending — by exit or by stop — hands the baton onward with the resume id', () => {
    const batons: string[] = []
    const external = new ExternalSessions({
      eventLog,
      approvals,
      onEvent: (event) => seen.push(event),
      hasAudience: () => true,
      isClaudeProcess: () => true,
      kill: () => {},
      onEnded: (info) => batons.push(`${info.sessionId}:${info.claudeSessionId}`),
    })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'), 777)
    external.stop('ext_abc', 'dev_phone')
    external.sessionStart('def', '/y', join(dir, 'n2.jsonl'))
    external.sessionEnd('def')
    expect(batons).toEqual(['ext_abc:abc', 'ext_def:def'])
    external.shutdown()
  })

  it('the ending event itself says the conversation can be carried on', () => {
    // The regression: a phone already watching learned "ended" but never learned that
    // the stop had just made it resumable, so Reopen stayed hidden until a reconnect.
    const external = new ExternalSessions({
      eventLog,
      approvals,
      onEvent: (event) => seen.push(event),
      hasAudience: () => true,
      isClaudeProcess: () => true,
      kill: () => {},
      onEnded: () => {},
    })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'), 999)
    external.stop('ext_abc', 'dev_phone')
    const ended = seen.find((e) => e.type === 'session.ended')
    expect((ended?.payload as { resumable?: boolean }).resumable).toBe(true)
    external.shutdown()
  })

  it('with nobody to adopt it, the ending event says so honestly', () => {
    const external = manager() // no onEnded wired
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'), 999)
    external.stop('ext_abc', 'dev_phone')
    const ended = seen.find((e) => e.type === 'session.ended')
    expect((ended?.payload as { resumable?: boolean }).resumable).toBe(false)
    external.shutdown()
  })

  it('offers the conversation id from the first moment, so it can be resumed at a keyboard', () => {
    const external = manager()
    external.sessionStart('abc-123', '/Users/x/proj', join(dir, 'n.jsonl'))

    // In the listing a phone receives on connect…
    expect(external.listSessions()[0]?.resumeId).toBe('abc-123')
    // …in the event announcing it…
    const started = seen.find((e) => e.type === 'session.started')
    expect((started?.payload as { resumeId?: string }).resumeId).toBe('abc-123')
    // …and in the event closing it.
    external.sessionEnd('abc-123')
    const ended = seen.find((e) => e.type === 'session.ended')
    expect((ended?.payload as { resumeId?: string }).resumeId).toBe('abc-123')
    external.shutdown()
  })

  it('session end closes the story', () => {
    const external = manager()
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'))
    external.sessionEnd('abc')
    expect(seen.some((e) => e.type === 'session.ended')).toBe(true)
    expect(external.listSessions()).toHaveLength(0)
    external.shutdown()
  })
})

describe('transcript lines → deltas', () => {
  it('ignores meta lines and tool results, keeps human words', () => {
    expect(transcriptDeltas({ isMeta: true, type: 'user', message: { content: 'x' } })).toEqual([])
    expect(
      transcriptDeltas({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'raw output' }] },
      }),
    ).toEqual([])
    const [delta] = transcriptDeltas({ type: 'user', message: { content: 'please fix it' } })
    expect(delta).toMatchObject({ payload: { kind: 'user', text: 'please fix it' } })
  })

  it('tolerates junk without throwing', () => {
    expect(transcriptDeltas(null)).toEqual([])
    expect(transcriptDeltas('not an object')).toEqual([])
    expect(transcriptDeltas({ type: 'assistant' })).toEqual([])
    expect(transcriptDeltas({ type: 'assistant', message: { content: 'weird-string' } })).toEqual([])
  })
})


describe('questions — Claude asking, not asking permission', () => {
  it('reads a question out of the hook payload, and refuses to invent one', () => {
    const parsed = readQuestions('AskUserQuestion', {
  questions: [
    {
      question: 'Which trigger method?',
      header: 'Trigger',
      multiSelect: false,
      options: [
        { label: 'Manual', description: 'Double-tap the stem.' },
        { label: 'Always-on', description: 'Constantly listening.' },
      ],
    },
  ],
})
    expect(parsed).not.toBeNull()
    expect(parsed?.[0]?.question).toBe('Which trigger method?')
    expect(parsed?.[0]?.options).toHaveLength(2)

    // Anything else is not a question, and malformed input degrades rather than throws.
    expect(readQuestions('Bash', { command: 'ls' })).toBeNull()
    expect(readQuestions('AskUserQuestion', null)).toBeNull()
    expect(readQuestions('AskUserQuestion', { questions: [] })).toBeNull()
    expect(readQuestions('AskUserQuestion', { questions: [{ nope: true }] })).toBeNull()
  })

  it('an approval for a question carries the questions to the phone', async () => {
    const external = manager({ waitMs: 5000 })
    void external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'AskUserQuestion', {
  questions: [
    {
      question: 'Which trigger method?',
      header: 'Trigger',
      multiSelect: false,
      options: [
        { label: 'Manual', description: 'Double-tap the stem.' },
        { label: 'Always-on', description: 'Constantly listening.' },
      ],
    },
  ],
})
    await until(() => seen.some((e) => e.type === 'approval.requested'))
    const payload = seen.find((e) => e.type === 'approval.requested')?.payload as {
      questions?: { question: string }[]
      inputSummary: string
    }
    expect(payload.questions?.[0]?.question).toBe('Which trigger method?')
    // The summary is the question itself, so a notification list reads sensibly.
    expect(payload.inputSummary).toContain('Which trigger method?')
    external.shutdown()
  })

  it('answering sends the choice back to Claude as an unmistakable instruction', async () => {
    const external = manager({ waitMs: 5000 })
    const pending = external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'AskUserQuestion', {
  questions: [
    {
      question: 'Which trigger method?',
      header: 'Trigger',
      multiSelect: false,
      options: [
        { label: 'Manual', description: 'Double-tap the stem.' },
        { label: 'Always-on', description: 'Constantly listening.' },
      ],
    },
  ],
})
    await until(() => seen.some((e) => e.type === 'approval.requested'))
    const approvalId = (seen.find((e) => e.type === 'approval.requested')?.payload as {
      approvalId: string
    }).approvalId

    external.decide(approvalId, 'deny', 'dev_phone', undefined, {
      'Which trigger method?': 'Manual',
    })
    const verdict = await pending
    // A PreToolUse hook cannot supply a tool result, so the answer rides the denial —
    // verified against real Claude Code, which replied "Blue it is." to exactly this shape.
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('Which trigger method? \u2192 Manual')
    expect(verdict.reason).toContain('do not ask it again')
    external.shutdown()
  })

  it('dismissing a question hands it back to the terminal rather than answering it wrongly', async () => {
    const external = manager({ waitMs: 5000 })
    const pending = external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'AskUserQuestion', {
  questions: [
    {
      question: 'Which trigger method?',
      header: 'Trigger',
      multiSelect: false,
      options: [
        { label: 'Manual', description: 'Double-tap the stem.' },
        { label: 'Always-on', description: 'Constantly listening.' },
      ],
    },
  ],
})
    await until(() => seen.some((e) => e.type === 'approval.requested'))
    const approvalId = (seen.find((e) => e.type === 'approval.requested')?.payload as {
      approvalId: string
    }).approvalId

    external.decide(approvalId, 'deny', 'dev_phone')
    const verdict = await pending
    expect(verdict.decision).toBe('ask')
    external.shutdown()
  })

  it('formats multi-select answers and typed words together', () => {
    const questions = readQuestions('AskUserQuestion', {
  questions: [
    {
      question: 'Which trigger method?',
      header: 'Trigger',
      multiSelect: false,
      options: [
        { label: 'Manual', description: 'Double-tap the stem.' },
        { label: 'Always-on', description: 'Constantly listening.' },
      ],
    },
  ],
})!
    const text = formatAnswers(questions, { 'Which trigger method?': 'Manual, Always-on' }, 'but start simple')
    expect(text).toContain('Manual, Always-on')
    expect(text).toContain('They also said: but start simple')
  })
})
