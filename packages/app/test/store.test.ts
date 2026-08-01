import { describe, it, expect } from 'vitest'
import type { SessionEvent } from '@longleash/protocol'
import { createStore, type StoreState } from '../src/lib/store.js'

/** Events are hand-built here; the daemon validates for real, so cast at the boundary. */
const ev = (raw: Record<string, unknown>): SessionEvent => raw as unknown as SessionEvent

const started = (sessionId: string, seq = 1, origin: string | null = 'phone') =>
  ev({
    v: 1,
    seq,
    sessionId,
    ts: 1,
    type: 'session.started',
    payload: { agent: 'claude', cwd: '/proj/api', title: 'add tests', ...(origin ? { origin } : {}) },
  })

const delta = (sessionId: string, seq: number, text: string) =>
  ev({ v: 1, seq, sessionId, ts: 1, type: 'stream.delta', payload: { kind: 'text', text } })

const approval = (sessionId: string, seq: number, approvalId: string, extra: object = {}) =>
  ev({
    v: 1,
    seq,
    sessionId,
    ts: 1,
    type: 'approval.requested',
    payload: { approvalId, toolName: 'Write', inputSummary: 'Write a.ts', expiresAt: 9e12, ...extra },
  })

const decided = (sessionId: string, seq: number, approvalId: string) =>
  ev({
    v: 1,
    seq,
    sessionId,
    ts: 1,
    type: 'approval.decided',
    payload: { approvalId, verdict: 'allow', decidedBy: 'dev_1' },
  })

const stateOf = (store: ReturnType<typeof createStore>): StoreState => store.getState()

describe('session list', () => {
  it('creates a session entry with its origin and project so the user knows where it runs', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    const session = stateOf(store).sessions.ses_1
    expect(session?.origin).toBe('phone')
    expect(session?.cwd).toBe('/proj/api')
    expect(session?.title).toBe('add tests')
    expect(session?.status).toBe('running')
  })

  it('falls back to a neutral origin rather than claiming a session came from the phone', () => {
    const store = createStore()
    store.apply(started('ses_1', 1, null))
    expect(stateOf(store).sessions.ses_1?.origin).toBe('unknown')
  })

  it('tracks status through ended and errored', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(ev({ v: 1, seq: 2, sessionId: 'ses_1', ts: 1, type: 'session.ended', payload: {} }))
    expect(stateOf(store).sessions.ses_1?.status).toBe('ended')

    store.apply(started('ses_2'))
    store.apply(
      ev({
        v: 1,
        seq: 2,
        sessionId: 'ses_2',
        ts: 1,
        type: 'session.errored',
        payload: { message: 'boom' },
      }),
    )
    expect(stateOf(store).sessions.ses_2?.status).toBe('errored')
    expect(stateOf(store).sessions.ses_2?.error).toBe('boom')
  })

  it('keeps sessions separate — output never bleeds between agents', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(started('ses_2'))
    store.apply(delta('ses_1', 2, 'mine'))
    store.apply(delta('ses_2', 2, 'theirs'))
    expect(stateOf(store).sessions.ses_1?.output).toBe('mine')
    expect(stateOf(store).sessions.ses_2?.output).toBe('theirs')
  })
})

describe('cursors and reconnect', () => {
  it('advances the cursor per session so a reconnect resumes exactly where it stopped', () => {
    const store = createStore()
    store.apply(started('ses_1', 1))
    store.apply(delta('ses_1', 2, 'a'))
    store.apply(delta('ses_1', 3, 'b'))
    expect(store.cursors()).toEqual({ ses_1: 3 })
  })

  it('ignores a replayed event it has already seen, so catch-up cannot duplicate output', () => {
    const store = createStore()
    store.apply(started('ses_1', 1))
    store.apply(delta('ses_1', 2, 'a'))
    store.apply(delta('ses_1', 2, 'a'))
    expect(stateOf(store).sessions.ses_1?.output).toBe('a')
    expect(store.cursors()).toEqual({ ses_1: 2 })
  })

  it('resets a session and asks for a full replay when the daemon reports a gap', () => {
    const store = createStore()
    store.apply(started('ses_1', 1))
    store.apply(delta('ses_1', 2, 'stale'))
    store.applyGap('ses_1')
    expect(store.cursors()).toEqual({ ses_1: 0 })
    expect(stateOf(store).sessions.ses_1?.output).toBe('')
  })
})

describe('approvals inbox', () => {
  it('adds an approval and removes it once decided', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(approval('ses_1', 2, 'apr_1'))
    expect(stateOf(store).approvals).toHaveLength(1)

    store.apply(decided('ses_1', 3, 'apr_1'))
    expect(stateOf(store).approvals).toHaveLength(0)
  })

  it('marks an approval that reaches outside the project so the warning is impossible to miss', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(approval('ses_1', 2, 'apr_1', { outsideRoot: true, targetPath: '/etc/passwd' }))
    const pending = stateOf(store).approvals[0]
    expect(pending?.outsideRoot).toBe(true)
    expect(pending?.targetPath).toBe('/etc/passwd')
  })

  it('hides an approval optimistically on decision, and restores it if the send fails', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(approval('ses_1', 2, 'apr_1'))
    store.markDeciding('apr_1')
    expect(stateOf(store).approvals).toHaveLength(0)

    store.rollbackDecision('apr_1')
    expect(stateOf(store).approvals).toHaveLength(1)
    expect(stateOf(store).approvals[0]?.approvalId).toBe('apr_1')
  })

  it('does not resurrect an approval that the daemon confirmed as decided', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(approval('ses_1', 2, 'apr_1'))
    store.markDeciding('apr_1')
    store.apply(decided('ses_1', 3, 'apr_1'))
    store.rollbackDecision('apr_1')
    expect(stateOf(store).approvals).toHaveLength(0)
  })

  it('survives a replay that re-delivers an already-decided approval', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(approval('ses_1', 2, 'apr_1'))
    store.apply(decided('ses_1', 3, 'apr_1'))

    store.applyGap('ses_1')
    store.apply(approval('ses_1', 1, 'apr_1'))
    store.apply(decided('ses_1', 2, 'apr_1'))
    expect(stateOf(store).approvals).toHaveLength(0)
  })
})

describe('rebuilding after a reload', () => {
  it('seeds the list from what the daemon reports, so a refresh does not wipe the screen', () => {
    const store = createStore()
    store.seedSessions([
      { sessionId: 'ses_1', agent: 'claude', cwd: '/proj/api', title: 'fix parser', origin: 'phone', status: 'waiting' },
      { sessionId: 'ses_2', agent: 'claude', cwd: '/proj/web', title: 'add tests', origin: 'daemon', status: 'ended' },
    ])
    const state = stateOf(store)
    expect(Object.keys(state.sessions)).toHaveLength(2)
    expect(state.sessions.ses_1?.title).toBe('fix parser')
    expect(state.sessions.ses_1?.status).toBe('waiting')
    expect(state.sessions.ses_2?.origin).toBe('daemon')
  })

  it('replayed events refill a seeded session without duplicating it', () => {
    const store = createStore()
    store.seedSessions([
      { sessionId: 'ses_1', agent: 'claude', cwd: '/proj', title: 't', origin: 'phone', status: 'waiting' },
    ])
    store.apply(started('ses_1'))
    store.apply(delta('ses_1', 2, 'restored output'))
    expect(Object.keys(stateOf(store).sessions)).toHaveLength(1)
    expect(stateOf(store).sessions.ses_1?.output).toBe('restored output')
  })

  it('seeding twice does not lose output already streamed', () => {
    const store = createStore()
    store.seedSessions([
      { sessionId: 'ses_1', agent: 'claude', cwd: '/proj', title: 't', origin: 'phone', status: 'running' },
    ])
    store.apply(started('ses_1'))
    store.apply(delta('ses_1', 2, 'keep me'))
    store.seedSessions([
      { sessionId: 'ses_1', agent: 'claude', cwd: '/proj', title: 't', origin: 'phone', status: 'waiting' },
    ])
    expect(stateOf(store).sessions.ses_1?.output).toBe('keep me')
    expect(stateOf(store).sessions.ses_1?.status).toBe('waiting')
  })
})

describe('activity', () => {
  it('records auto-approved tools distinctly from things that needed a decision', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(
      ev({
        v: 1,
        seq: 2,
        sessionId: 'ses_1',
        ts: 1,
        type: 'activity.tool',
        payload: { toolName: 'Read', inputSummary: 'Read a.ts', autoApproved: true },
      }),
    )
    const activity = stateOf(store).sessions.ses_1?.activity ?? []
    expect(activity).toHaveLength(1)
    expect(activity[0]?.autoApproved).toBe(true)
  })

  it('caps stored output so a long session cannot exhaust phone memory', () => {
    const store = createStore({ maxOutputChars: 100 })
    store.apply(started('ses_1'))
    for (let i = 0; i < 50; i++) store.apply(delta('ses_1', i + 2, '0123456789'))
    const output = stateOf(store).sessions.ses_1?.output ?? ''
    expect(output.length).toBeLessThanOrEqual(100)
    expect(output.endsWith('0123456789')).toBe(true)
  })
})
