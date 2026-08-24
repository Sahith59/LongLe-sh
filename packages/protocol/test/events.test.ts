import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_VERSION,
  DelegationPreviewSchema,
  DelegationUpdateSchema,
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

  it('round-trips an attributed delegated child without flattening partial metadata', () => {
    const ev = parseEvent({
      ...baseEvent,
      type: 'session.started',
      payload: {
        agent: 'codex',
        cwd: '/Users/x/proj',
        title: 'review the parser',
        relationship: {
          delegationId: 'del_1',
          parentSessionId: 'ses_parent',
          role: 'review',
          depth: 1,
        },
      },
    })
    if (ev.type !== 'session.started') expect.unreachable('wrong type')
    expect(ev.payload.relationship).toEqual({
      delegationId: 'del_1',
      parentSessionId: 'ses_parent',
      role: 'review',
      depth: 1,
    })
  })

  it('rejects incomplete delegated-session attribution', () => {
    expect(() =>
      parseEvent({
        ...baseEvent,
        type: 'session.started',
        payload: {
          agent: 'codex',
          cwd: '/Users/x/proj',
          relationship: { delegationId: 'del_1', role: 'review' },
        },
      }),
    ).toThrowError()
  })

  it('round-trips a stream.delta event', () => {
    const ev = parseEvent({
      ...baseEvent,
      type: 'stream.delta',
      payload: { kind: 'text', text: 'hello' },
    })
    expect(ev.type).toBe('stream.delta')
  })

  it('validates transcript reset, phone reclaim, and bounded session renaming', () => {
    expect(parseEvent({
      ...baseEvent,
      type: 'session.transcript.reset',
      payload: { reason: 'provider-snapshot' },
    }).type).toBe('session.transcript.reset')
    expect(parseClientMessage({ v: 1, type: 'reclaimSession', sessionId: 'ses_1' }).type)
      .toBe('reclaimSession')
    expect(parseClientMessage({ v: 1, type: 'renameSession', sessionId: 'ses_1', title: 'Release audit' }).type)
      .toBe('renameSession')
    expect(() => parseClientMessage({
      v: 1, type: 'renameSession', sessionId: 'ses_1', title: 'x'.repeat(81),
    })).toThrowError()
  })

  it('carries a live resume id the moment the native agent announces it', () => {
    const ev = parseEvent({
      ...baseEvent,
      type: 'session.status',
      payload: {
        status: 'running',
        live: true,
        resumable: true,
        resumeId: 'native-thread-1',
      },
    })
    expect(ev.payload).toMatchObject({ resumable: true, resumeId: 'native-thread-1' })
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
      syncId: 'sync-1',
    })
    expect(msg.type).toBe('subscribe')
    expect(msg.syncId).toBe('sync-1')
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

  it('validates safe parallel and provider reasoning settings', () => {
    const message = parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'startSession',
      agent: 'claude',
      root: '/Users/x/proj',
      prompt: 'review it',
      workspaceMode: 'isolated',
      settings: {
        mode: 'plan',
        model: 'opus',
        effort: 'high',
        thinking: { mode: 'fixed', budgetTokens: 16_384 },
      },
    })
    if (message.type !== 'startSession') expect.unreachable('wrong type')
    expect(message.workspaceMode).toBe('isolated')
    expect(message.settings?.mode).toBe('plan')
    expect(message.settings?.thinking).toEqual({ mode: 'fixed', budgetTokens: 16_384 })
  })

  it('rejects an invented working mode instead of silently weakening safety', () => {
    expect(() => parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'startSession',
      agent: 'codex',
      root: '/Users/x/proj',
      prompt: 'work on it',
      settings: { mode: 'unrestricted' },
    })).toThrowError()
  })

  it('rejects fixed thinking without a bounded token budget', () => {
    expect(() => parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'startSession',
      agent: 'claude',
      root: '/Users/x/proj',
      prompt: 'review it',
      settings: { thinking: { mode: 'fixed' } },
    })).toThrow()
  })

  it('validates mid-session controls and requires an explicit external handoff signal', () => {
    const message = parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'updateSessionSettings',
      requestId: 'settings-1',
      sessionId: 'ext_existing',
      settings: { model: 'opus', effort: 'high', thinking: { mode: 'adaptive' } },
      externalTransferConfirmed: true,
    })
    expect(message).toMatchObject({
      type: 'updateSessionSettings',
      sessionId: 'ext_existing',
      externalTransferConfirmed: true,
    })
    expect(() => parseClientMessage({
      ...message,
      settings: { thinking: { mode: 'fixed', budgetTokens: 10 } },
    })).toThrowError()
  })

  it('parses an attributed delegation preview request', () => {
    const msg = parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'previewDelegation',
      requestId: 'preview-1',
      sourceSessionId: 'ses_parent',
      sourceSeq: 18,
      targetAgent: 'codex',
      role: 'review',
      contextScope: 'selected',
    })
    expect(msg).toMatchObject({ type: 'previewDelegation', sourceSeq: 18, targetAgent: 'codex' })
  })

  it('rejects unsupported delegation roles and target agents', () => {
    expect(() =>
      parseClientMessage({
        v: PROTOCOL_VERSION,
        type: 'previewDelegation',
        requestId: 'preview-1',
        sourceSessionId: 'ses_parent',
        targetAgent: 'gemini',
        role: 'browse-everything',
        contextScope: 'task',
      }),
    ).toThrowError()
  })

  it('requires an explicit confirmation and bounds the exact launch briefing', () => {
    const valid = {
      v: PROTOCOL_VERSION,
      type: 'startDelegation',
      requestId: 'launch-1',
      idempotencyKey: 'stable-phone-operation',
      sourceSessionId: 'ses_parent',
      targetAgent: 'codex',
      role: 'review',
      contextScope: 'recent',
      briefing: 'Review the pairing lifecycle.',
      settings: { model: 'gpt-5.6', effort: 'high' },
      confirmed: true,
      workspaceTransferConfirmed: true,
    }
    expect(parseClientMessage(valid)).toMatchObject({
      type: 'startDelegation',
      confirmed: true,
      settings: { model: 'gpt-5.6', effort: 'high' },
    })
    expect(() => parseClientMessage({ ...valid, confirmed: false })).toThrowError()
    expect(() => parseClientMessage({ ...valid, workspaceTransferConfirmed: false })).toThrowError()
    expect(() => parseClientMessage({ ...valid, briefing: 'x'.repeat(24_001) })).toThrowError()
  })

  it('parses reviewed return preview and requires explicit delivery confirmation', () => {
    expect(parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'prepareReturn',
      requestId: 'return-preview-1',
      delegationId: 'del_1',
    })).toMatchObject({ type: 'prepareReturn', delegationId: 'del_1' })

    const delivery = {
      v: PROTOCOL_VERSION,
      type: 'returnDelegation',
      requestId: 'return-1',
      idempotencyKey: 'return-op-1',
      delegationId: 'del_1',
      returnText: 'Reviewed result.',
      confirmed: true,
      takeoverConfirmed: false,
    }
    expect(parseClientMessage(delivery)).toMatchObject({ type: 'returnDelegation', confirmed: true })
    expect(() => parseClientMessage({ ...delivery, confirmed: false })).toThrowError()
    expect(() => parseClientMessage({ ...delivery, returnText: 'x'.repeat(24_001) })).toThrowError()
  })

  it('validates the public delegation lifecycle without exposing its private briefing', () => {
    const update = DelegationUpdateSchema.parse({
      v: PROTOCOL_VERSION,
      type: 'delegation',
      requestId: 'launch-1',
      created: true,
      delegation: {
        delegationId: 'del_1',
        idempotencyKey: 'phone-op-1',
        sourceSessionId: 'ses_parent',
        targetSessionId: 'ses_child',
        targetAgent: 'codex',
        role: 'review',
        contextScope: 'recent',
        depth: 1,
        status: 'running',
        createdAt: 1,
        updatedAt: 2,
      },
    })
    expect(update.delegation).not.toHaveProperty('briefing')
  })

  it('validates the exact preview shape sent back to the phone', () => {
    expect(
      DelegationPreviewSchema.parse({
        v: PROTOCOL_VERSION,
        type: 'delegationPreview',
        requestId: 'preview-1',
        source: {
          sessionId: 'ses_parent',
          agent: 'claude',
          cwd: '/work/project',
          title: 'Fix pairing',
          origin: 'terminal',
        },
        sourceSeq: 18,
        targetAgent: 'codex',
        role: 'review',
        contextScope: 'selected',
        briefing: 'Review this.',
        context: {
          includedFirstSeq: 18,
          includedLastSeq: 18,
          includedBlocks: 1,
          omittedEvents: 0,
          omittedCharacters: 0,
          truncated: false,
          characterCount: 12,
          maxCharacters: 24_000,
        },
      }),
    ).toMatchObject({ type: 'delegationPreview', requestId: 'preview-1' })
  })

  it('parses a push subscription exactly as the browser serialises one', () => {
    const msg = parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'pushSubscribe',
      subscription: {
        endpoint: 'https://web.push.apple.com/QOfNHV7c',
        expirationTime: null,
        keys: { p256dh: 'BPk…truncated', auth: 'sVx…truncated' },
      },
    })
    expect(msg.type).toBe('pushSubscribe')
  })

  it('rejects a push subscription missing its encryption keys — it could never be used', () => {
    expect(() =>
      parseClientMessage({
        v: PROTOCOL_VERSION,
        type: 'pushSubscribe',
        subscription: { endpoint: 'https://web.push.apple.com/x' },
      }),
    ).toThrowError()
  })

  it('parses the test-alert request — it carries nothing but its type', () => {
    const msg = parseClientMessage({ v: PROTOCOL_VERSION, type: 'pushTest' })
    expect(msg.type).toBe('pushTest')
  })

  it('parses pushUnsubscribe by endpoint', () => {
    const msg = parseClientMessage({
      v: PROTOCOL_VERSION,
      type: 'pushUnsubscribe',
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    })
    expect(msg.type).toBe('pushUnsubscribe')
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
