import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_VERSION,
  parseEvent,
  parseClientMessage,
  type SessionEvent,
} from '../src/index.js'

const baseEvent = {
  v: PROTOCOL_VERSION,
  seq: 1,
  sessionId: 'ses_abc123',
  ts: 1753800000000,
}

describe('event envelope', () => {
  it('round-trips a session.started event', () => {
    const raw = {
      ...baseEvent,
      type: 'session.started',
      payload: { agent: 'claude', cwd: '/Users/x/proj', title: 'fix the bug' },
    }
    const ev = parseEvent(raw)
    expect(ev.type).toBe('session.started')
    expect(ev.seq).toBe(1)
    if (ev.type === 'session.started') {
      expect(ev.payload.cwd).toBe('/Users/x/proj')
    }
  })

  it('round-trips a stream.delta event', () => {
    const ev = parseEvent({
      ...baseEvent,
      type: 'stream.delta',
      payload: { kind: 'text', text: 'hello' },
    })
    expect(ev.type).toBe('stream.delta')
  })

  it('round-trips an approval.requested event with expiry', () => {
    const ev = parseEvent({
      ...baseEvent,
      type: 'approval.requested',
      payload: {
        approvalId: 'apr_1',
        toolName: 'Write',
        inputSummary: 'Write /Users/x/proj/a.ts (42 lines)',
        expiresAt: 1753800600000,
      },
    })
    if (ev.type === 'approval.requested') {
      expect(ev.payload.expiresAt).toBeGreaterThan(ev.ts)
    } else {
      expect.unreachable('wrong type')
    }
  })

  it('rejects an unknown event type with a useful error', () => {
    expect(() =>
      parseEvent({ ...baseEvent, type: 'session.hacked', payload: {} }),
    ).toThrowError(/session\.hacked|invalid/i)
  })

  it('rejects a negative seq (cursors are monotonic, 1-based)', () => {
    expect(() =>
      parseEvent({
        ...baseEvent,
        seq: -5,
        type: 'stream.delta',
        payload: { kind: 'text', text: 'x' },
      }),
    ).toThrowError()
  })

  it('rejects a missing sessionId', () => {
    const { sessionId: _drop, ...rest } = baseEvent
    expect(() =>
      parseEvent({ ...rest, type: 'stream.delta', payload: { kind: 'text', text: 'x' } }),
    ).toThrowError(/sessionId/)
  })

  it('tolerates unknown extra fields (forward compatibility)', () => {
    const ev = parseEvent({
      ...baseEvent,
      type: 'stream.delta',
      payload: { kind: 'text', text: 'x', futureField: 'ignore me' },
      futureTopLevel: true,
    })
    expect(ev.type).toBe('stream.delta')
  })

  it('rejects a payload that does not match the event type', () => {
    expect(() =>
      parseEvent({
        ...baseEvent,
        type: 'approval.requested',
        payload: { kind: 'text', text: 'not an approval' },
      }),
    ).toThrowError()
  })
})

describe('client messages', () => {
  it('parses subscribe with a fromCursor of 0 (meaning: from the beginning)', () => {
    const msg = parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'subscribe',
      sessionId: 'ses_abc123',
      fromCursor: 0,
    })
    expect(msg.type).toBe('subscribe')
  })

  it('parses an approval decision with an optional steering reply', () => {
    const msg = parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'decision',
      approvalId: 'apr_1',
      verdict: 'deny',
      reply: 'use the staging config instead',
    })
    if (msg.type === 'decision') {
      expect(msg.verdict).toBe('deny')
      expect(msg.reply).toContain('staging')
    } else {
      expect.unreachable('wrong type')
    }
  })

  it('rejects a decision verdict outside allow/deny', () => {
    expect(() =>
      parseClientMessage({
        v: PROTOCOL_VERSION,
        type: 'decision',
        approvalId: 'apr_1',
        verdict: 'maybe',
      }),
    ).toThrowError()
  })

  it('parses startSession only with agent, root and prompt', () => {
    const msg = parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'startSession',
      agent: 'claude',
      root: '/Users/x/proj',
      prompt: 'add tests for the parser',
    })
    expect(msg.type).toBe('startSession')
  })

  it('rejects startSession with an empty prompt', () => {
    expect(() =>
      parseClientMessage({
        v: PROTOCOL_VERSION,
        type: 'startSession',
        agent: 'claude',
        root: '/Users/x/proj',
        prompt: '',
      }),
    ).toThrowError()
  })
})

describe('type narrowing', () => {
  it('SessionEvent union narrows by type', () => {
    const ev: SessionEvent = parseEvent({
      ...baseEvent,
      type: 'approval.decided',
      payload: { approvalId: 'apr_1', verdict: 'allow', decidedBy: 'dev_phone1' },
    })
    if (ev.type === 'approval.decided') {
      expect(ev.payload.verdict).toBe('allow')
    } else {
      expect.unreachable('wrong narrow')
    }
  })
})
