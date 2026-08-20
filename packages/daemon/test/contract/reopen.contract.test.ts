import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../../src/eventlog.js'
import { ApprovalStore } from '../../src/approvals.js'
import { SessionManager } from '../../src/sessions.js'
import { createClaudeAgentFactory } from '../../src/adapters/claude.js'

/**
 * Against the REAL Claude Agent SDK, on the user's subscription. This is the sequence that
 * failed in the field — reopen, reopen, error — and unit tests with a fake agent cannot
 * prove it fixed, because the failure came from the SDK's own resume behaviour.
 *
 *   pnpm --filter @longleash/daemon test:contract
 */

let dir: string
let root: string
let eventLog: EventLog
let approvals: ApprovalStore
let manager: SessionManager

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'longleash-reopen-'))
  root = realpathSync(dir)
  eventLog = new EventLog(':memory:')
  approvals = new ApprovalStore(':memory:')
  manager = new SessionManager({
    eventLog,
    approvals,
    allowedRoots: [root],
    agentFactories: {
      claude: createClaudeAgentFactory({ allowedTools: [], isolateFromUserSettings: true, maxTurns: 4 }),
    },
  })
})

afterEach(() => {
  eventLog.close()
  approvals.close()
  rmSync(dir, { recursive: true, force: true })
})

const transcript = (sessionId: string): string => {
  const replay = eventLog.replay(sessionId, 0)
  if (replay.gap) throw new Error('unexpected gap')
  return replay.events
    .filter((e) => e.type === 'stream.delta' && (e.payload as { kind?: string }).kind === 'text')
    .map((e) => (e.payload as { text: string }).text)
    .join('')
}

const settle = async (sessionId: string, until: () => boolean, ms = 90_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!until()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the agent')
    await new Promise((r) => setTimeout(r, 250))
  }
  void sessionId
}

const statusOf = (sessionId: string) =>
  manager.listSessions().find((s) => s.sessionId === sessionId)?.status

describe('reopening against real Claude', () => {
  it('reopen twice then continue — the sequence that errored in the field', async () => {
    const { sessionId } = await manager.startSession({
      agent: 'claude',
      cwd: root,
      prompt: 'Say BETA and nothing else.',
      origin: 'phone',
    })
    await settle(sessionId, () => statusOf(sessionId) === 'waiting')
    expect(transcript(sessionId)).toContain('BETA')

    // A turn ending leaves the session OPEN and waiting on you, so there is nothing to
    // reopen yet — that refusal is correct.
    expect(await manager.resumeSession(sessionId, 'dev_phone')).toBe(false)

    // The field sequence: the conversation closes, then Reopen is tapped twice. This used
    // to re-run the prompt each time and end in an SDK error.
    await manager.stopSession(sessionId, 'dev_phone')
    expect(await manager.resumeSession(sessionId, 'dev_phone')).toBe(true)
    expect(await manager.resumeSession(sessionId, 'dev_phone')).toBe(true) // idempotent, harmless
    expect(statusOf(sessionId)).toBe('waiting')

    // Nothing new was said by merely reopening.
    const beforeTyping = transcript(sessionId)
    expect(beforeTyping.match(/BETA/g)?.length).toBe(1)

    // Now carry it on with actual words; the agent must remember its own past.
    expect(manager.sendMessage(sessionId, 'What did you just say? Repeat it exactly.', 'dev_phone')).toBe(true)
    await settle(
      sessionId,
      () => statusOf(sessionId) === 'waiting' && (transcript(sessionId).match(/BETA/g)?.length ?? 0) >= 2,
    )

    const full = transcript(sessionId)
    expect(full.match(/BETA/g)!.length).toBeGreaterThanOrEqual(2)
    expect(statusOf(sessionId)).not.toBe('errored')
  }, 180_000)

  it('a stopped conversation reopens and continues rather than failing', async () => {
    const { sessionId } = await manager.startSession({
      agent: 'claude',
      cwd: root,
      prompt: 'Say GAMMA and nothing else.',
      origin: 'phone',
    })
    await settle(sessionId, () => statusOf(sessionId) === 'waiting')
    await manager.stopSession(sessionId, 'dev_phone')
    expect(statusOf(sessionId)).toBe('ended')

    expect(await manager.resumeSession(sessionId, 'dev_phone')).toBe(true)
    expect(manager.sendMessage(sessionId, 'Now say DELTA and nothing else.', 'dev_phone')).toBe(true)
    await settle(sessionId, () => transcript(sessionId).includes('DELTA'))
    expect(statusOf(sessionId)).not.toBe('errored')
  }, 180_000)
})
