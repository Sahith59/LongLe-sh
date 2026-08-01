import { describe, it, expect } from 'vitest'
import { createStore, type StoreState } from '../src/lib/store.js'

const started = (sessionId: string, seq = 1, origin = 'phone') => ({
  v: 1,
  seq,
  sessionId,
  ts: 1,
  type: 'session.started' as const,
  payload: { agent: 'claude', cwd: '/proj/api', title: 'add tests', origin },
})
const delta = (sessionId: string, seq: number, text: string) => ({
  v: 1,
  seq,
  sessionId,
  ts: 1,
  type: 'stream.delta' as const,
  payload: { kind: 'text', text },
})
const approval = (sessionId: string, seq: number, approvalId: string, extra = {}) => ({
  v: 1,
  seq,
  sessionId,
  ts: 1,
  type: 'approval.requested' as const,
  payload: { approvalId, toolName: 'Write', inputSummary: 'Write a.ts', expiresAt: 9e12, ...extra },
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
    store.apply({ ...started('ses_1'), payload: { agent: 'claude', cwd: '/proj' } } as never)
    expect(stateOf(store).sessions.ses_1?.origin).toBe('unknown')
  })

  it('tracks status through ended and errored', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply({ v: 1, seq: 2, sessionId: 'ses_1', ts: 1, type: 'session.ended', payload: {} })
    expect(stateOf(store).sessions.ses_1?.status).toBe('ended')

    store.apply(started('ses_2'))
    store.apply({
      v: 1,
      seq: 2,
      sessionId: 'ses_2',
      ts: 1,
      type: 'session.errored',
      payload: { message: 'boom' },
    })
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

    store.apply({
      v: 1,
      seq: 3,
      sessionId: 'ses_1',
      ts: 1,
      type: 'approval.decided',
      payload: { approvalId: 'apr_1', verdict: 'allow', decidedBy: 'dev_1' },
    })
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

  it('hides an approval optimistically on decision, and restores it if the daemon rejects', () => {
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
    store.apply({
      v: 1,
      seq: 3,
      sessionId: 'ses_1',
      ts: 1,
      type: 'approval.decided',
      payload: { approvalId: 'apr_1', verdict: 'allow', decidedBy: 'dev_1' },
    })
    store.rollbackDecision('apr_1')
    expect(stateOf(store).approvals).toHaveLength(0)
  })

  it('survives a replay that re-delivers an already-decided approval', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(approval('ses_1', 2, 'apr_1'))
    store.apply({
      v: 1,
      seq: 3,
      sessionId: 'ses_1',
      ts: 1,
      type: 'approval.decided',
      payload: { approvalId: 'apr_1', verdict: 'allow', decidedBy: 'dev_1' },
    })
    store.applyGap('ses_1')
    store.apply(approval('ses_1', 1, 'apr_1'))
    store.apply({
      v: 1,
      seq: 2,
      sessionId: 'ses_1',
      ts: 1,
      type: 'approval.decided',
      payload: { approvalId: 'apr_1', verdict: 'allow', decidedBy: 'dev_1' },
    })
    expect(stateOf(store).approvals).toHaveLength(0)
  })
})

describe('activity', () => {
  it('records auto-approved tools distinctly from things that needed a decision', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply({
      v: 1,
      seq: 2,
      sessionId: 'ses_1',
      ts: 1,
      type: 'activity.tool',
      payload: { toolName: 'Read', inputSummary: 'Read a.ts', autoApproved: true },
    })
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
