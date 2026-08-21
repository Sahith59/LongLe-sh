import { describe, it, expect } from 'vitest'
import type { SessionEvent } from '@longleash/protocol'
import { createStore, sortSessionsNewestFirst, type StoreState } from '../src/lib/store.js'

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

  it('retains delegated parent attribution from both events and hello seeds', () => {
    const store = createStore()
    const relationship = {
      delegationId: 'del_1',
      parentSessionId: 'ses_parent',
      role: 'review' as const,
      depth: 1,
    }
    store.apply(
      ev({
        v: 1,
        seq: 1,
        sessionId: 'ses_child',
        ts: 1,
        type: 'session.started',
        payload: { agent: 'codex', cwd: '/proj/api', relationship },
      }),
    )
    expect(stateOf(store).sessions.ses_child?.relationship).toEqual(relationship)

    const reloaded = createStore()
    reloaded.seedSessions([
      {
        sessionId: 'ses_child',
        agent: 'codex',
        cwd: '/proj/api',
        title: 'review',
        origin: 'phone',
        status: 'running',
        relationship,
      },
    ])
    expect(stateOf(reloaded).sessions.ses_child?.relationship).toEqual(relationship)
  })

  it('learns from the ending event whether this can be carried on', () => {
    // The regression: `resumable` used to arrive ONLY in hello, so a phone already
    // watching a session kept "no resume point" forever after a stop — even though
    // the daemon had just adopted the conversation and made it continuable.
    const store = createStore()
    store.apply(started('ses_1'))
    store.seedSessions([
      {
        sessionId: 'ses_1',
        agent: 'claude',
        cwd: '/x',
        title: 't',
        origin: 'terminal',
        status: 'running',
        resumable: false,
      },
    ])
    expect(stateOf(store).sessions.ses_1?.resumable).toBe(false)

    store.apply(
      ev({
        v: 1,
        seq: 5,
        sessionId: 'ses_1',
        ts: 1,
        type: 'session.ended',
        payload: { reason: 'stopped by dev_phone', resumable: true },
      }),
    )
    expect(stateOf(store).sessions.ses_1?.resumable).toBe(true)
    expect(stateOf(store).sessions.ses_1?.status).toBe('ended')
  })

  it('leaves resumable alone when the ending event does not mention it', () => {
    // An older daemon omits the field; the phone must not silently downgrade to false.
    const store = createStore()
    store.apply(started('ses_1'))
    store.seedSessions([
      {
        sessionId: 'ses_1',
        agent: 'claude',
        cwd: '/x',
        title: 't',
        origin: 'phone',
        status: 'running',
        resumable: true,
      },
    ])
    store.apply(
      ev({ v: 1, seq: 5, sessionId: 'ses_1', ts: 1, type: 'session.ended', payload: {} }),
    )
    expect(stateOf(store).sessions.ses_1?.resumable).toBe(true)
  })

  it('an ending or error event clears every approval owned by that session', () => {
    const store = createStore()
    store.apply(started('ses_ended'))
    store.apply(approval('ses_ended', 2, 'apr_ended'))
    store.apply(ev({ v: 1, seq: 3, sessionId: 'ses_ended', ts: 1, type: 'session.ended', payload: {} }))
    expect(stateOf(store).approvals.some((a) => a.approvalId === 'apr_ended')).toBe(false)
    expect(stateOf(store).sessions.ses_ended?.live).toBe(false)

    store.apply(started('ses_error'))
    store.apply(approval('ses_error', 2, 'apr_error'))
    store.apply(ev({
      v: 1,
      seq: 3,
      sessionId: 'ses_error',
      ts: 1,
      type: 'session.errored',
      payload: { message: 'gone' },
    }))
    expect(stateOf(store).approvals.some((a) => a.approvalId === 'apr_error')).toBe(false)
    expect(stateOf(store).sessions.ses_error?.live).toBe(false)
  })

  it('a Stop acknowledgement reconciles a process the daemon already lost', () => {
    const store = createStore()
    store.apply(started('ext_dead'))
    store.apply(approval('ext_dead', 2, 'apr_dead'))
    store.settleSession('ext_dead')
    expect(stateOf(store).sessions.ext_dead).toMatchObject({ status: 'ended', live: false })
    expect(stateOf(store).approvals.some((a) => a.sessionId === 'ext_dead')).toBe(false)
  })

  it('remembers the conversation id so it can be picked up at a keyboard', () => {
    const store = createStore()
    store.apply(
      ev({
        v: 1,
        seq: 1,
        sessionId: 'ses_1',
        ts: 1,
        type: 'session.started',
        payload: { agent: 'claude', cwd: '/x', origin: 'terminal', resumeId: 'abc-123' },
      }),
    )
    expect(stateOf(store).sessions.ses_1?.resumeId).toBe('abc-123')

    store.apply(
      ev({
        v: 1,
        seq: 2,
        sessionId: 'ses_1',
        ts: 2,
        type: 'session.status',
        payload: { status: 'running', live: true, resumable: true, resumeId: 'live-456' },
      }),
    )
    expect(stateOf(store).sessions.ses_1).toMatchObject({
      live: true,
      resumable: true,
      resumeId: 'live-456',
    })

    // It also arrives on the ending event and in a reconnect seed.
    const other = createStore()
    other.apply(started('ses_2'))
    other.apply(
      ev({
        v: 1,
        seq: 2,
        sessionId: 'ses_2',
        ts: 1,
        type: 'session.ended',
        payload: { resumable: true, resumeId: 'def-456' },
      }),
    )
    expect(stateOf(other).sessions.ses_2?.resumeId).toBe('def-456')

    const seeded = createStore()
    seeded.seedSessions([
      {
        sessionId: 'ses_3',
        agent: 'claude',
        cwd: '/x',
        title: 't',
        origin: 'terminal',
        status: 'ended',
        resumable: true,
        resumeId: 'ghi-789',
      },
    ])
    expect(stateOf(seeded).sessions.ses_3?.resumeId).toBe('ghi-789')
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
  it('publishes one coherent snapshot after a replay transaction', () => {
    const store = createStore()
    let paints = 0
    store.subscribe(() => { paints += 1 })

    store.beginHydration()
    store.seedSessions([
      { sessionId: 'ses_1', startedAt: 10, agent: 'claude', cwd: '/x', title: 'one', origin: 'phone', status: 'running' },
    ])
    store.apply(started('ses_1', 1))
    store.apply(delta('ses_1', 2, 'ready'))
    expect(paints).toBe(0)

    store.endHydration()
    expect(paints).toBe(1)
    expect(stateOf(store).sessions.ses_1?.output).toBe('ready')
  })

  it('sorts mixed provider seeds deterministically by creation time', () => {
    const store = createStore()
    store.seedSessions([
      { sessionId: 'ext_old', startedAt: 10, agent: 'claude', cwd: '/x', title: 'old', origin: 'terminal', status: 'running' },
      { sessionId: 'ses_new', startedAt: 30, agent: 'codex', cwd: '/x', title: 'new', origin: 'phone', status: 'waiting' },
      { sessionId: 'ses_middle', startedAt: 20, agent: 'claude', cwd: '/x', title: 'middle', origin: 'vscode', status: 'running' },
    ])
    expect(sortSessionsNewestFirst(Object.values(stateOf(store).sessions)).map((session) => session.sessionId))
      .toEqual(['ses_new', 'ses_middle', 'ext_old'])
  })

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

describe('readable transcript', () => {
  const toolDelta = (sessionId: string, seq: number, text: string) =>
    ev({ v: 1, seq, sessionId, ts: 1, type: 'stream.delta', payload: { kind: 'tool', text } })
  const userDelta = (sessionId: string, seq: number, text: string) =>
    ev({ v: 1, seq, sessionId, ts: 1, type: 'stream.delta', payload: { kind: 'user', text } })

  it('keeps what each piece was, instead of flattening everything into one blob', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(delta('ses_1', 2, "I'll search for it."))
    store.apply(toolDelta('ses_1', 3, 'Bash: pwd'))
    store.apply(delta('ses_1', 4, 'Found it.'))

    const blocks = stateOf(store).sessions.ses_1?.blocks ?? []
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text'])
    expect(blocks[1]?.text).toBe('Bash: pwd')
  })

  it('merges consecutive prose so streaming does not shatter a sentence', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(delta('ses_1', 2, 'Hello '))
    store.apply(delta('ses_1', 3, 'there'))
    const blocks = stateOf(store).sessions.ses_1?.blocks ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toBe('Hello there')
    expect(blocks[0]).toMatchObject({ firstSeq: 2, lastSeq: 3 })
  })

  it('keeps discrete message sequence ids stable for future delegation selection', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(userDelta('ses_1', 7, '\n\n› review this\n'))
    store.apply(toolDelta('ses_1', 8, 'Read: parser.ts'))
    const blocks = stateOf(store).sessions.ses_1?.blocks ?? []
    expect(blocks).toMatchObject([
      { kind: 'user', firstSeq: 7, lastSeq: 7 },
      { kind: 'tool', firstSeq: 8, lastSeq: 8 },
    ])
  })

  it('never merges a tool call into prose', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(toolDelta('ses_1', 2, 'Bash: ls'))
    store.apply(toolDelta('ses_1', 3, 'Bash: pwd'))
    const blocks = stateOf(store).sessions.ses_1?.blocks ?? []
    expect(blocks).toHaveLength(2)
  })

  it('keeps your own messages distinct from the agent speaking', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(delta('ses_1', 2, 'agent says'))
    store.apply(userDelta('ses_1', 3, '\n\n› do this next\n'))
    const blocks = stateOf(store).sessions.ses_1?.blocks ?? []
    expect(blocks[1]?.kind).toBe('user')
    expect(blocks[1]?.text).toContain('do this next')
  })

  it('the list preview shows prose only, not tool noise', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(toolDelta('ses_1', 2, 'Bash: find ~ -maxdepth 4 -iname "*stick*"'))
    store.apply(delta('ses_1', 3, 'Found the app.'))
    expect(stateOf(store).sessions.ses_1?.output).toBe('Found the app.')
  })

  it('caps retained blocks so a long session cannot exhaust phone memory', () => {
    const store = createStore({ maxOutputChars: 200 })
    store.apply(started('ses_1'))
    for (let i = 0; i < 100; i++) store.apply(toolDelta('ses_1', i + 2, `Bash: command number ${i}`))
    const blocks = stateOf(store).sessions.ses_1?.blocks ?? []
    const total = blocks.reduce((sum, b) => sum + b.text.length, 0)
    expect(total).toBeLessThanOrEqual(400)
    expect(blocks[blocks.length - 1]?.text).toContain('99')
  })

  it('a gap clears blocks along with everything else', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(delta('ses_1', 2, 'stale'))
    store.applyGap('ses_1')
    expect(stateOf(store).sessions.ses_1?.blocks).toHaveLength(0)
  })
})

describe('stale errors', () => {
  const errored = (sessionId: string, seq: number, message: string) =>
    ev({ v: 1, seq, sessionId, ts: 1, type: 'session.errored', payload: { message } })
  const statusRunning = (sessionId: string, seq: number) =>
    ev({ v: 1, seq, sessionId, ts: 1, type: 'session.status', payload: { status: 'running' } })

  it('clears an old failure once the session is running again', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(errored('ses_1', 2, 'no such column: agent_session_id'))
    expect(stateOf(store).sessions.ses_1?.error).toBeTruthy()

    // Reopening emits a running status; the previous failure is history, not current state.
    store.apply(statusRunning('ses_1', 3))
    expect(stateOf(store).sessions.ses_1?.error).toBeUndefined()
    expect(stateOf(store).sessions.ses_1?.status).toBe('running')
  })

  it('keeps the failure visible while the session is still failed', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(errored('ses_1', 2, 'boom'))
    expect(stateOf(store).sessions.ses_1?.error).toBe('boom')
  })

  it('does not carry a failure across a replay of a now-healthy session', () => {
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(errored('ses_1', 2, 'old failure'))
    store.applyGap('ses_1')
    store.apply(started('ses_1', 1))
    expect(stateOf(store).sessions.ses_1?.error).toBeUndefined()
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

  it('never merges user messages — two reopened markers must not become one bubble', () => {
    const say = (seq: number, text: string) =>
      ev({ v: 1, seq, sessionId: 'ses_1', ts: 1, type: 'stream.delta', payload: { kind: 'user', text } })
    const store = createStore()
    store.apply(started('ses_1'))
    store.apply(say(2, '\n\n— reopened —\n'))
    store.apply(say(3, '\n\n— reopened —\n'))
    store.apply(say(4, '\n\n› carry on\n'))
    const blocks = stateOf(store).sessions.ses_1?.blocks ?? []
    const users = blocks.filter((b) => b.kind === 'user')
    expect(users).toHaveLength(3)
    expect(users[0]?.text.trim()).toBe('— reopened —')
    expect(users[1]?.text.trim()).toBe('— reopened —')
  })

describe('a session the daemon no longer knows about must stop looking alive', () => {
  it('clears ghosts left by a previous daemon run, and their approvals', () => {
    const store = createStore()
    // How it happens in the field: the daemon died holding these, so no session.ended was
    // ever written and the phone kept showing them as working for days.
    store.seedSessions([
      { sessionId: 'ext_ghost', agent: 'claude', cwd: '/x', title: 'old', origin: 'terminal', status: 'running' },
      { sessionId: 'ext_live', agent: 'claude', cwd: '/x', title: 'now', origin: 'terminal', status: 'running' },
    ] as never)
    store.apply({
      sessionId: 'ext_ghost',
      seq: 1,
      type: 'approval.requested',
      payload: { approvalId: 'apr_old', toolName: 'Bash', inputSummary: 'rm -rf', expiresAt: Date.now() + 1e6 },
    } as never)
    expect(stateOf(store).sessions['ext_ghost']?.status).toBe('running')

    // The daemon reconnects and lists only what it actually has.
    store.seedSessions([
      { sessionId: 'ext_live', agent: 'claude', cwd: '/x', title: 'now', origin: 'terminal', status: 'running' },
    ] as never)

    const after = stateOf(store)
    expect(after.sessions['ext_ghost']?.status).toBe('ended')
    expect(after.sessions['ext_ghost']?.live).toBe(false)
    expect(after.sessions['ext_live']?.status).toBe('running')
    // Its approval died with it — nothing could ever answer it.
    expect([...after.approvals.values()].some((a) => a.sessionId === 'ext_ghost')).toBe(false)

    // Historical replay can restore the last conversation status, but cannot manufacture a
    // process the authoritative hello says does not exist.
    store.apply(ev({
      v: 1, seq: 2, sessionId: 'ext_ghost', ts: 1, type: 'session.status',
      payload: { status: 'waiting' },
    }))
    expect(stateOf(store).sessions['ext_ghost']).toMatchObject({ status: 'waiting', live: false })
  })

  it('does not resurrect or discard a session that legitimately finished', () => {
    const store = createStore()
    store.seedSessions([
      { sessionId: 'ext_done', agent: 'claude', cwd: '/x', title: 'done', origin: 'terminal', status: 'ended' },
    ] as never)
    store.seedSessions([] as never)
    // Still present to read, still ended — the conversation is worth keeping.
    expect(stateOf(store).sessions['ext_done']?.status).toBe('ended')
  })
})

describe('a dormant conversation is history, not something happening now', () => {
  it('marks a session with no process behind it as not live', () => {
    const store = createStore()
    store.seedSessions([
      // What a restart produces: parked as waiting so it can be reopened, but nothing running.
      { sessionId: 'ses_old', agent: 'claude', cwd: '/x', title: 'SLURM account',
        origin: 'terminal', status: 'waiting', live: false, resumable: true },
      { sessionId: 'ses_now', agent: 'claude', cwd: '/x', title: 'today',
        origin: 'terminal', status: 'waiting', live: true, resumable: true },
    ] as never)
    const s = stateOf(store).sessions
    expect(s['ses_old']?.live).toBe(false)
    expect(s['ses_now']?.live).toBe(true)
  })

  it('never keeps an approval on a dormant hello seed', () => {
    const store = createStore()
    store.apply(started('ses_old'))
    store.apply(approval('ses_old', 2, 'apr_stale'))
    store.seedSessions([
      { sessionId: 'ses_old', agent: 'claude', cwd: '/x', title: 'old', origin: 'terminal',
        status: 'waiting', live: false, resumable: true },
    ] as never)
    expect(stateOf(store).approvals).toEqual([])
  })

  it('does not let replayed waiting status turn a dormant hello seed live again', () => {
    const store = createStore()
    store.seedSessions([
      { sessionId: 'ses_old', agent: 'claude', cwd: '/x', title: 'old', origin: 'phone',
        status: 'waiting', live: false, resumable: true },
    ] as never)
    // Older logs have no `live` field. Hello remains the authority for that fact.
    store.apply(ev({
      v: 1, seq: 10, sessionId: 'ses_old', ts: 1, type: 'session.status',
      payload: { status: 'waiting', detail: 'interrupted by a daemon restart' },
    }))
    expect(stateOf(store).sessions.ses_old?.live).toBe(false)
  })

  it('assumes live when an older daemon does not say — never hide something that IS running', () => {
    const store = createStore()
    store.seedSessions([
      { sessionId: 'ses_x', agent: 'claude', cwd: '/x', title: 't', origin: 'terminal', status: 'waiting' },
    ] as never)
    expect(stateOf(store).sessions['ses_x']?.live).toBe(true)
  })
})
