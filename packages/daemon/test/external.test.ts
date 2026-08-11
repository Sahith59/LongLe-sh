import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@longleash/protocol'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import {
  ExternalSessions,
  humanSaid,
  readQuestions,
  titleFrom,
  terminalAgentOf,
  transcriptDeltas,
} from '../src/external.js'

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
    audience?: 'connected' | 'push' | 'none'
    waitMs?: number
    pushWaitMs?: number
    isClaude?: (pid: number) => boolean
    kill?: (pid: number) => void
  } = {},
): ExternalSessions {
  return new ExternalSessions({
    eventLog,
    approvals,
    onEvent: (event) => seen.push(event),
    audience: () => opts.audience ?? 'connected',
    waitMs: opts.waitMs ?? 100,
    pushWaitMs: opts.pushWaitMs ?? 50,
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
    const external = manager({ audience: 'none' })
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

  it('NEVER kills a recycled pid — but clears the session instead of refusing forever', () => {
    // The safety property is unchanged and non-negotiable: the pid is no longer our agent, so
    // nothing may be killed. What changed is the aftermath. Refusing left the session listed as
    // running for the rest of time and made Stop look broken; the process is plainly gone, so
    // the honest thing is to end the session and say so.
    const killed: number[] = []
    const external = manager({ isClaude: () => false, kill: (pid) => killed.push(pid) })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'), 4242)

    expect(external.stop('ext_abc', 'dev_phone')).toBe(true)
    expect(killed).toEqual([]) // ← the thing that must never regress
    expect(external.listSessions()).toHaveLength(0)
    expect(seen.some((e) => e.type === 'session.ended')).toBe(true)
    external.shutdown()
  })

  it('still refuses a session it never knew — there is nothing to end', () => {
    const external = manager()
    expect(external.stop('ext_nope', 'dev_phone')).toBe(false)
    external.shutdown()
  })

  it('clears a session whose pid the hook never found, rather than stranding it', () => {
    // Codex sessions had exactly this shape: no pid reported, so Stop refused every time and
    // the session stayed in the list forever. Seen in the field 2026-08-09.
    const killed: number[] = []
    const external = manager({ kill: (pid) => killed.push(pid) })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl')) // hook could not find the pid
    expect(external.stop('ext_abc', 'dev_phone')).toBe(true)
    expect(killed).toEqual([])
    expect(external.listSessions()).toHaveLength(0)
    external.shutdown()
  })

  it('a live session is still killed for real', () => {
    const killed: number[] = []
    const external = manager({ isClaude: () => true, kill: (pid) => killed.push(pid) })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'), 4242)
    expect(external.stop('ext_abc', 'dev_phone')).toBe(true)
    expect(killed).toEqual([4242])
    external.shutdown()
  })

  it('ending — by exit or by stop — hands the baton onward with the resume id', () => {
    const batons: string[] = []
    const external = new ExternalSessions({
      eventLog,
      approvals,
      onEvent: (event) => seen.push(event),
      audience: () => 'connected' as const,
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
      audience: () => 'connected' as const,
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

  it('reads Codex rollout messages without duplicating event_msg copies', () => {
    expect(transcriptDeltas({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done from Codex.' }],
      },
    })).toEqual([{ type: 'stream.delta', payload: { kind: 'text', text: 'Done from Codex.' } }])
    expect(transcriptDeltas({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Done from Codex.' },
    })).toEqual([])
  })

  it('keeps Codex user speech but removes injected environment/plugin blocks', () => {
    const deltas = transcriptDeltas({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '<recommended_plugins>hidden</recommended_plugins>\nFix the stop button.\n<environment_context>hidden</environment_context>',
        }],
      },
    })
    expect(deltas).toEqual([{ type: 'stream.delta', payload: { kind: 'user', text: 'Fix the stop button.' } }])
  })

  it('keeps only the human request from Codex VS Code\'s IDE context envelope', () => {
    const deltas = transcriptDeltas({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '# Context from my IDE setup:\n\n## Open tabs:\n- PLAN.md: PLAN.md\n\n## My request:\nFix the gibberish transcript.',
        }],
      },
    })
    expect(deltas).toEqual([{
      type: 'stream.delta',
      payload: { kind: 'user', text: 'Fix the gibberish transcript.' },
    }])
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

    external.decide(approvalId, 'allow', 'dev_phone', 'but start simple', {
      'Which trigger method?': 'Manual',
    })
    const verdict = await pending
    expect(verdict.decision).toBe('allow')
    expect(verdict.answers).toEqual({ 'Which trigger method?': 'Manual' })
    expect(verdict.reason).toContain('Answered from your phone')
    expect(verdict.additionalContext).toBe('The user added: but start simple')
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

})


describe('a terminal session earns a name', () => {
  it('renames itself to the first thing the person asked for', async () => {
    const transcript = join(dir, 'name.jsonl')
    writeFileSync(transcript, '')
    const external = manager()
    external.sessionStart('abc', '/Users/x/proj', transcript)
    // Born knowing only its folder — which is why two sessions in one directory used to
    // be indistinguishable in the list.
    expect(external.listSessions()[0]?.title).toBe('proj — terminal')

    appendFileSync(
      transcript,
      line({ type: 'user', message: { content: 'Fix the flaky pagination test\nsecond line ignored' } }),
    )
    await until(() => external.listSessions()[0]?.title === 'Fix the flaky pagination test')

    const renamed = seen.find(
      (e) => e.type === 'session.status' && (e.payload as { title?: string }).title !== undefined,
    )
    expect((renamed?.payload as { title: string }).title).toBe('Fix the flaky pagination test')

    // A later message must not rename it again — the name is what it set out to do.
    appendFileSync(transcript, line({ type: 'user', message: { content: 'now do something else' } }))
    await new Promise((r) => setTimeout(r, 90))
    expect(external.listSessions()[0]?.title).toBe('Fix the flaky pagination test')
    external.shutdown()
  })

  it('reports the permission mode, and only when it changes', async () => {
    const external = manager({ audience: 'none' })
    await external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'Bash', {}, 'bypassPermissions')
    await external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'Bash', {}, 'bypassPermissions')
    const modeEvents = seen.filter(
      (e) => e.type === 'session.status' && (e.payload as { permissionMode?: string }).permissionMode,
    )
    expect(modeEvents).toHaveLength(1)
    expect((modeEvents[0]?.payload as { permissionMode: string }).permissionMode).toBe('bypassPermissions')
    external.shutdown()
  })
})

describe('slash commands are machinery, not speech', () => {
  it('renders a command by name instead of its markup', () => {
    expect(humanSaid('<command-name>/exit</command-name> <command-message>exit</command-message> <command-args></command-args>')).toBe('/exit')
    expect(humanSaid('<command-name>/model</command-name> <command-args>opus</command-args>')).toBe('/model opus')
    expect(humanSaid('just a normal message')).toBe('just a normal message')
  })

  it('never titles a session after a slash command with no name', () => {
    expect(titleFrom('<command-name></command-name>')).toBeNull()
    expect(titleFrom('   ')).toBeNull()
    expect(titleFrom('a'.repeat(100))?.length).toBe(72)
  })

  it('titles a Codex VS Code session from the request, not the IDE wrapper', () => {
    expect(titleFrom(
      '# Context from my IDE setup:\n\n## Open tabs:\n- PLAN.md\n\n## My request:\nFix mobile overflow',
    )).toBe('Fix mobile overflow')
  })
})


describe('the gate — asking for less, never more', () => {
  it('a muted session approves without ever paging the phone', async () => {
    const external = manager({ waitMs: 5000 })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'))
    expect(external.setGate('ext_abc', 'auto')).toBe(true)

    const verdict = await external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'Bash', {
      command: 'pnpm build',
    })
    expect(verdict.decision).toBe('allow')
    // The point of muting: no approval is created, so nothing rings.
    expect(seen.some((e) => e.type === 'approval.requested')).toBe(false)
    external.shutdown()
  })

  it('unmuting restores asking, and the phone is told either way', async () => {
    const external = manager({ waitMs: 5000 })
    external.sessionStart('abc', '/x', join(dir, 'n.jsonl'))
    external.setGate('ext_abc', 'auto')
    external.setGate('ext_abc', 'ask')

    const gates = seen
      .filter((e) => e.type === 'session.status')
      .map((e) => (e.payload as { gate?: string }).gate)
      .filter((g) => g !== undefined)
    expect(gates).toEqual(['auto', 'ask'])

    void external.preToolUse('abc', '/x', join(dir, 'n.jsonl'), 'Bash', {})
    await until(() => seen.some((e) => e.type === 'approval.requested'))
    external.shutdown()
  })

  it('refuses to gate a session it has never seen', () => {
    const external = manager()
    expect(external.setGate('ext_nope', 'auto')).toBe(false)
    external.shutdown()
  })

  it('a muted session still shows everything in its transcript', async () => {
    const transcript = join(dir, 'muted.jsonl')
    writeFileSync(transcript, '')
    const external = manager()
    external.sessionStart('abc', '/x', transcript)
    external.setGate('ext_abc', 'auto')
    await external.preToolUse('abc', '/x', transcript, 'Bash', { command: 'ls' })

    appendFileSync(
      transcript,
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      }),
    )
    await until(() => seen.some((e) => e.type === 'stream.delta'))
    external.shutdown()
  })
})

describe('Codex fires every hook twice — the phone must still see one decision', () => {
  it('joins two identical tool calls onto a single approval, and answers both', async () => {
    const m = manager({ waitMs: 5_000 })
    // Both arrive before either resolves, exactly as the two Codex hook processes do.
    const first = m.preToolUse('cdx-1', dir, '', 'Bash', { command: 'rm -rf build' }, 'default', { dedupeKey: 'exec-abc' })
    const second = m.preToolUse('cdx-1', dir, '', 'Bash', { command: 'rm -rf build' }, 'default', { dedupeKey: 'exec-abc' })

    await until(() => seen.some((e) => e.type === 'approval.requested'))
    const raised = seen.filter((e) => e.type === 'approval.requested')
    expect(raised).toHaveLength(1) // one card, not two

    const approvalId = (raised[0] as { payload: { approvalId: string } }).payload.approvalId
    m.decide(approvalId, 'allow', 'phone', 'go ahead')

    // The person answered once; both waiting hook processes get that same answer.
    expect(await first).toEqual(await second)
    expect((await first).decision).toBe('allow')
    m.shutdown()
  })

  it('does not collapse genuinely different tool calls', async () => {
    const m = manager({ waitMs: 5_000 })
    void m.preToolUse('cdx-2', dir, '', 'Bash', { command: 'ls' }, 'default', { dedupeKey: 'exec-one' })
    void m.preToolUse('cdx-2', dir, '', 'Bash', { command: 'rm -rf /' }, 'default', { dedupeKey: 'exec-two' })
    await until(() => seen.filter((e) => e.type === 'approval.requested').length === 2)
    expect(seen.filter((e) => e.type === 'approval.requested')).toHaveLength(2)
    m.shutdown()
  })

  it('releases the key once settled, so the same tool asked again still asks', async () => {
    const m = manager({ waitMs: 5_000 })
    const first = m.preToolUse('cdx-3', dir, '', 'Bash', { command: 'ls' }, 'default', { dedupeKey: 'exec-same' })
    await until(() => seen.some((e) => e.type === 'approval.requested'))
    const id = (seen.find((e) => e.type === 'approval.requested') as { payload: { approvalId: string } })
      .payload.approvalId
    m.decide(id, 'allow', 'phone')
    await first

    seen.length = 0
    void m.preToolUse('cdx-3', dir, '', 'Bash', { command: 'ls' }, 'default', { dedupeKey: 'exec-same' })
    await until(() => seen.some((e) => e.type === 'approval.requested'))
    // A stale verdict must never be replayed for a later, real decision.
    expect(seen.filter((e) => e.type === 'approval.requested')).toHaveLength(1)
    m.shutdown()
  })

  it('a muted session still auto-approves both copies without raising a card', async () => {
    const m = manager({ waitMs: 5_000 })
    m.sessionStart('cdx-4', dir, '')
    const list = m.listSessions()
    m.setGate(list[0]!.sessionId, 'auto')
    seen.length = 0
    const a = await m.preToolUse('cdx-4', dir, '', 'Bash', { command: 'ls' }, 'default', { dedupeKey: 'exec-x' })
    const b = await m.preToolUse('cdx-4', dir, '', 'Bash', { command: 'ls' }, 'default', { dedupeKey: 'exec-x' })
    expect(a.decision).toBe('allow')
    expect(b.decision).toBe('allow')
    expect(seen.filter((e) => e.type === 'approval.requested')).toHaveLength(0)
    m.shutdown()
  })
})

describe('a person running several agents must be able to tell them apart', () => {
  it('a Codex session reports as codex, and says so in its title', () => {
    const m = manager()
    m.sessionStart('c-1', '/tmp/proj', '', undefined, 'codex')
    const [s] = m.listSessions()
    expect(s!.agent).toBe('codex')
    expect(s!.title).toContain('codex')
    const started = seen.find((e) => e.type === 'session.started') as { payload: { agent: string } }
    expect(started.payload.agent).toBe('codex')
    m.shutdown()
  })

  it('a Claude session is unchanged — the default stays the default', () => {
    const m = manager()
    m.sessionStart('c-2', '/tmp/proj', '')
    const [s] = m.listSessions()
    expect(s!.agent).toBe('claude')
    expect(s!.title).toContain('terminal')
    m.shutdown()
  })

  it('an unknown vendor degrades to claude rather than breaking the session', () => {
    expect(terminalAgentOf('something-new')).toBe('claude')
    expect(terminalAgentOf(undefined)).toBe('claude')
    expect(terminalAgentOf('codex')).toBe('codex')
  })

  it('the vendor survives a session first seen at a permission question', async () => {
    const m = manager({ waitMs: 50 })
    // No SessionStart: the hook endpoint can meet a session for the first time here.
    await m.preToolUse('c-3', '/tmp/proj', '', 'Bash', { command: 'ls' }, 'default', { agent: 'codex' })
    expect(m.listSessions()[0]!.agent).toBe('codex')
    m.shutdown()
  })
})

describe('an approval nobody will ever answer must leave the phone', () => {
  const requested = () => seen.filter((e) => e.type === 'approval.requested')
  const decided = () =>
    seen.filter((e) => e.type === 'approval.decided') as {
      payload: { approvalId: string; verdict: string; decidedBy: string }
    }[]

  it('clears the moment the person answers at their keyboard', async () => {
    const m = manager({ waitMs: 60_000 })
    const gone = new AbortController()
    const pending = m.preToolUse('k-1', dir, '', 'Bash', { command: 'ls' }, 'default', {
      abandoned: gone.signal,
    })
    await until(() => requested().length === 1)

    // The agent moved on at the keyboard, so the hook process died.
    gone.abort()

    // "ask" hands the decision back to the terminal, exactly as if we were never here.
    expect((await pending).decision).toBe('ask')
    expect(decided()).toHaveLength(1)
    expect(decided()[0]!.payload.decidedBy).toBe('system:answered-at-keyboard')
    m.shutdown()
  })

  it('does NOT abandon an approval that is answered normally', async () => {
    // Regression guard: an earlier version listened on the request instead of the response
    // and abandoned every approval the instant it was created.
    const m = manager({ waitMs: 60_000 })
    const gone = new AbortController()
    const pending = m.preToolUse('k-2', dir, '', 'Bash', { command: 'ls' }, 'default', {
      abandoned: gone.signal,
    })
    await until(() => requested().length === 1)
    const id = (requested()[0] as { payload: { approvalId: string } }).payload.approvalId
    m.decide(id, 'allow', 'phone', 'go on')
    expect((await pending).decision).toBe('allow')
    m.shutdown()
  })

  it('an already-answered approval ignores a late abort', async () => {
    const m = manager({ waitMs: 60_000 })
    const gone = new AbortController()
    const pending = m.preToolUse('k-3', dir, '', 'Bash', { command: 'ls' }, 'default', {
      abandoned: gone.signal,
    })
    await until(() => requested().length === 1)
    const id = (requested()[0] as { payload: { approvalId: string } }).payload.approvalId
    m.decide(id, 'allow', 'phone')
    await pending
    const before = decided().length
    gone.abort() // the response finishing also closes the socket — must be a no-op
    await new Promise((r) => setTimeout(r, 20))
    expect(decided()).toHaveLength(before)
    m.shutdown()
  })

  it('a session ending clears the questions it left behind', async () => {
    const m = manager({ waitMs: 60_000 })
    m.sessionStart('k-4', dir, '')
    const pending = m.preToolUse('k-4', dir, '', 'Bash', { command: 'ls' }, 'default')
    await until(() => requested().length === 1)

    m.sessionEnd('k-4')

    expect((await pending).decision).toBe('ask')
    expect(decided()[0]!.payload.decidedBy).toBe('system:session-ended')
    m.shutdown()
  })

  it('sweeps approvals whose deadline has passed — the case with no live waiter', async () => {
    // Reproduces a restarted daemon: the row is pending, but the in-memory timer that would
    // have cleared it died with the previous process.
    const m = manager({ waitMs: 60_000 })
    approvals.create({
      approvalId: 'apr_stale',
      sessionId: 'ext_k-5',
      toolName: 'Bash',
      inputSummary: 'Bash rm -rf /',
      expiresAt: Date.now() - 1_000,
      targetPath: null,
      outsideRoot: false,
    })
    seen.length = 0

    expect(m.sweepExpired()).toBe(1)
    expect(approvals.get('apr_stale')?.status).toBe('denied')
    expect(decided()[0]!.payload.decidedBy).toBe('system:expired')
    // Sweeping again must not re-announce a decision already made.
    expect(m.sweepExpired()).toBe(0)
    m.shutdown()
  })

  it('leaves a still-valid approval alone', async () => {
    const m = manager({ waitMs: 60_000 })
    void m.preToolUse('k-6', dir, '', 'Bash', { command: 'ls' }, 'default')
    await until(() => requested().length === 1)
    expect(m.sweepExpired()).toBe(0)
    expect(decided()).toHaveLength(0)
    m.shutdown()
  })
})

describe('the phone must never quote you saying something a machine wrote', () => {
  // The exact blocks from Sahith's phone screenshots, 2026-08-09.
  it('drops the IDE file-open notice', () => {
    expect(
      humanSaid(
        '<ide_opened_file>The user opened the file /Volumes/Sahith_SSD/AgentMem-OS/deep-research-report (1).md in the IDE. This may or may not be related to the current task.</ide_opened_file>',
      ),
    ).toBe('')
  })

  it('drops a background task notification, ids and all', () => {
    expect(
      humanSaid(
        '<task-notification> <task-id>bbtoj1bnv</task-id> <tool-use-id>toolu_01XU5C4RnQuRychL2Az2vBhw</tool-use-id> <output-file>/private/tmp/x.output</output-file> <status>completed</status> <summary>Background command "Wait for rate test" completed (exit code 0)</summary> </task-notification>',
      ),
    ).toBe('')
  })

  it('drops system reminders and IDE selections', () => {
    expect(humanSaid('<system-reminder>Some background note</system-reminder>')).toBe('')
    expect(humanSaid('<ide_selection>lines 4-9 of foo.ts</ide_selection>')).toBe('')
  })

  it('drops an unfamiliar machine block it has never seen before', () => {
    // The list will grow; the general rule is what keeps the next one off the phone.
    expect(humanSaid('<some-future-tag><id>7</id><state>done</state></some-future-tag>')).toBe('')
  })

  it('drops a truncated block that was cut off mid-write', () => {
    expect(humanSaid('<task-notification> <task-id>abc</task-id> <status>run')).toBe('')
  })

  // The other direction matters more: dropping real speech is worse than showing noise.
  it('keeps a real message that arrived alongside machinery', () => {
    const said = humanSaid(
      '<ide_opened_file>The user opened server.ts</ide_opened_file>\nfix the retry logic please',
    )
    expect(said).toBe('fix the retry logic please')
  })

  it('keeps prose that merely mentions one of these tags', () => {
    const said = humanSaid('why does the transcript show <ide_opened_file> to the user?')
    expect(said).toContain('why does the transcript show')
  })

  it('keeps ordinary messages untouched', () => {
    expect(humanSaid('run the tests and tell me what breaks')).toBe(
      'run the tests and tell me what breaks',
    )
  })

  it('keeps code blocks containing angle brackets', () => {
    const code = 'use this:\n```tsx\n<Button onClick={go}>Save</Button>\n```'
    expect(humanSaid(code)).toBe(code)
  })

  it('still resolves slash commands to what the person ran', () => {
    expect(humanSaid('<command-name>/compact</command-name><command-args>keep tests</command-args>')).toBe(
      '/compact keep tests',
    )
  })

  it('produces no transcript delta at all for a machine-only user entry', () => {
    const deltas = transcriptDeltas({
      type: 'user',
      message: { content: [{ type: 'text', text: '<ide_opened_file>x.ts</ide_opened_file>' }] },
    })
    expect(deltas).toHaveLength(0)
  })
})

describe('the keyboard must never be locked out — who can answer decides how long we hold', () => {
  it('with nobody reachable, the terminal is not held at all', async () => {
    const m = manager({ audience: 'none' })
    const decision = await m.preToolUse('a-1', dir, '', 'Bash', { command: 'ls' }, 'default')
    expect(decision.decision).toBe('ask')
    expect(seen.filter((e) => e.type === 'approval.requested')).toHaveLength(0)
    m.shutdown()
  })

  it('holds only briefly when a push is the only way to reach them', async () => {
    // The app is closed. They must feel an alert and open it — but the person AT the keyboard
    // is the one paying for that wait, so it has to be short.
    const m = manager({ audience: 'push', waitMs: 5_000, pushWaitMs: 60 })
    const started = Date.now()
    const decision = await m.preToolUse('a-2', dir, '', 'Bash', { command: 'ls' }, 'default')
    const waited = Date.now() - started
    expect(decision.decision).toBe('ask')
    expect(waited).toBeLessThan(2_000) // the short hold, not the long one
    m.shutdown()
  })

  it('holds longer when the app is actually open', async () => {
    const m = manager({ audience: 'connected', waitMs: 120, pushWaitMs: 10 })
    const started = Date.now()
    await m.preToolUse('a-3', dir, '', 'Bash', { command: 'ls' }, 'default')
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    m.shutdown()
  })

  it('a permanent push registration can never masquerade as someone watching', async () => {
    // The bug that froze the terminal for two minutes with the phone face-down in a drawer:
    // presence was "is there an audience?", and a push registration answered yes forever.
    const m = manager({ audience: 'push', waitMs: 10_000, pushWaitMs: 50 })
    const started = Date.now()
    await m.preToolUse('a-4', dir, '', 'Bash', { command: 'ls' }, 'default')
    expect(Date.now() - started).toBeLessThan(2_000)
    m.shutdown()
  })

  it('the default hold is short enough to sit through', () => {
    // Built WITHOUT the test helper, which injects tiny waits — this asserts the real shipped
    // defaults. Pinned because they are a promise to whoever is sitting at the keyboard, and
    // 120s was what made a person unable to answer their own terminal.
    const m = new ExternalSessions({
      eventLog,
      approvals,
      audience: () => 'connected' as const,
    })
    expect((m as unknown as { waitMs: number }).waitMs).toBe(45_000)
    expect((m as unknown as { pushWaitMs: number }).pushWaitMs).toBe(20_000)
    m.shutdown()
  })
})
