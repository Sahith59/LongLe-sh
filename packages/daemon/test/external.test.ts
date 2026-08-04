import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@longleash/protocol'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { ExternalSessions, transcriptDeltas } from '../src/external.js'

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
