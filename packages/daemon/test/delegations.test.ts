import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalStore } from '../src/approvals.js'
import { DelegationError, DelegationStore, type CreateDelegationInput } from '../src/delegations.js'

let approvals: ApprovalStore
let clock: number
let store: DelegationStore

const draft = (extra: Partial<CreateDelegationInput> = {}): CreateDelegationInput => ({
  idempotencyKey: 'phone-op-1',
  sourceSessionId: 'ses_parent',
  sourceSeq: 18,
  targetAgent: 'codex',
  role: 'review',
  contextScope: 'selected',
  depth: 1,
  briefing: 'Review the parser and report correctness issues.',
  createdBy: 'dev_phone',
  ...extra,
})

beforeEach(() => {
  approvals = new ApprovalStore(':memory:')
  clock = 1_000
  store = new DelegationStore(approvals.rawDb, { now: () => clock })
})

afterEach(() => approvals.close())

describe('durable delegation identity', () => {
  it('creates a draft with an attributed source, target, role, and stable selected event', () => {
    const result = store.createDraft(draft())
    expect(result.created).toBe(true)
    expect(result.record).toMatchObject({
      delegationId: expect.stringMatching(/^del_/),
      sourceSessionId: 'ses_parent',
      sourceSeq: 18,
      targetAgent: 'codex',
      role: 'review',
      contextScope: 'selected',
      depth: 1,
      status: 'draft',
      createdBy: 'dev_phone',
      createdAt: 1_000,
      updatedAt: 1_000,
    })
  })

  it('returns the same draft for a retried idempotent request', () => {
    const first = store.createDraft(draft())
    clock = 2_000
    const retry = store.createDraft(draft())
    expect(retry.created).toBe(false)
    expect(retry.record.delegationId).toBe(first.record.delegationId)
    expect(retry.record.createdAt).toBe(1_000)
  })

  it('preserves the exact human-reviewed briefing bytes', () => {
    const briefing = '\n  Keep this formatting exactly.  \n'
    expect(store.createDraft(draft({ briefing })).record.briefing).toBe(briefing)
  })

  it('refuses reuse of an idempotency key for different work', () => {
    store.createDraft(draft())
    expect(() => store.createDraft(draft({ briefing: 'Implement it instead.' }))).toThrowError(
      DelegationError,
    )
  })

  it('survives recreating the store over the same database', () => {
    const created = store.createDraft(draft()).record
    const reopened = new DelegationStore(approvals.rawDb)
    expect(reopened.get(created.delegationId)).toEqual(created)
  })

  it('finds a delegation from either the parent or child session', () => {
    const created = store.createDraft(draft()).record
    store.markStarting(created.delegationId)
    store.attachTarget(created.delegationId, 'ses_child')
    expect(store.listForSession('ses_parent').map((d) => d.delegationId)).toEqual([
      created.delegationId,
    ])
    expect(store.listForSession('ses_child').map((d) => d.delegationId)).toEqual([
      created.delegationId,
    ])
  })
})

describe('delegation lifecycle', () => {
  it('moves through draft, starting, running, ready, and returned without losing attribution', () => {
    const created = store.createDraft(draft()).record
    clock = 1_100
    expect(store.markStarting(created.delegationId).status).toBe('starting')
    clock = 1_200
    expect(store.attachTarget(created.delegationId, 'ses_child')).toMatchObject({
      status: 'running',
      targetSessionId: 'ses_child',
      updatedAt: 1_200,
    })
    clock = 1_300
    expect(store.markReady(created.delegationId).status).toBe('ready')
    clock = 1_400
    expect(store.markReturned(created.delegationId, {
      returnText: 'No correctness issues found.',
      idempotencyKey: 'return-op-1',
      returnedBy: 'dev_phone',
    })).toMatchObject({
      created: true,
      record: {
        status: 'returned',
        returnText: 'No correctness issues found.',
        returnIdempotencyKey: 'return-op-1',
        returnedBy: 'dev_phone',
        returnedAt: 1_400,
        sourceSessionId: 'ses_parent',
        targetSessionId: 'ses_child',
        updatedAt: 1_400,
      },
    })
  })

  it('derives the exact child relationship stored on a session', () => {
    const created = store.createDraft(draft({ role: 'test', depth: 2 })).record
    store.markStarting(created.delegationId)
    store.attachTarget(created.delegationId, 'ses_child')
    expect(store.relationshipForTarget('ses_child')).toEqual({
      delegationId: created.delegationId,
      parentSessionId: 'ses_parent',
      role: 'test',
      depth: 2,
    })
  })

  it('does not let a child session belong to two delegations', () => {
    const first = store.createDraft(draft()).record
    const second = store.createDraft(draft({ idempotencyKey: 'phone-op-2' })).record
    store.markStarting(first.delegationId)
    store.attachTarget(first.delegationId, 'ses_child')
    store.markStarting(second.delegationId)
    expect(() => store.attachTarget(second.delegationId, 'ses_child')).toThrowError(/already belongs/i)
  })

  it('rejects lifecycle jumps instead of rewriting history', () => {
    const created = store.createDraft(draft()).record
    expect(() => store.markReady(created.delegationId)).toThrowError(/draft to ready/i)
    expect(() => store.markReturned(created.delegationId, {
      returnText: 'done',
      idempotencyKey: 'return-op-1',
      returnedBy: 'dev_phone',
    })).toThrowError(/while it is draft/i)
  })

  it('returns once with exact reviewed bytes and rejects conflicting retries', () => {
    const created = store.createDraft(draft()).record
    store.markStarting(created.delegationId)
    store.attachTarget(created.delegationId, 'ses_child')
    store.markReady(created.delegationId)
    const returnText = '\n  Exact reviewed result.  \n'
    const first = store.markReturned(created.delegationId, {
      returnText,
      idempotencyKey: 'return-op-1',
      returnedBy: 'dev_phone',
    })
    const retry = store.markReturned(created.delegationId, {
      returnText,
      idempotencyKey: 'return-op-1',
      returnedBy: 'dev_phone',
    })
    expect(first.record.returnText).toBe(returnText)
    expect(retry).toMatchObject({ created: false, record: { status: 'returned' } })
    expect(() => store.markReturned(created.delegationId, {
      returnText: 'changed',
      idempotencyKey: 'return-op-1',
      returnedBy: 'dev_phone',
    })).toThrowError(/different reviewed text/i)
  })

  it('cancels a nonterminal delegation idempotently and refuses to resurrect it', () => {
    const created = store.createDraft(draft()).record
    expect(store.cancel(created.delegationId).status).toBe('cancelled')
    expect(store.cancel(created.delegationId).status).toBe('cancelled')
    expect(() => store.markStarting(created.delegationId)).toThrowError(/cancelled to starting/i)
  })

  it('records a bounded, user-safe failure without permitting later mutation', () => {
    const created = store.createDraft(draft()).record
    const failed = store.fail(created.delegationId, `${'x'.repeat(600)} secret tail`)
    expect(failed.status).toBe('failed')
    expect(failed.failure).toHaveLength(500)
    expect(() => store.cancel(created.delegationId)).toThrowError(/after it became failed/i)
  })
})

describe('V1 input boundaries', () => {
  it('allows only Claude and Codex targets', () => {
    expect(() =>
      store.createDraft(draft({ targetAgent: 'gemini' as unknown as 'codex' })),
    ).toThrowError(/Claude or Codex/i)
  })

  it('caps delegation depth at two edges', () => {
    expect(() => store.createDraft(draft({ depth: 3 }))).toThrowError(/depth must be 1 or 2/i)
  })

  it('requires a positive selected transcript sequence', () => {
    expect(() => store.createDraft(draft({ sourceSeq: 0 }))).toThrowError(/sequence must be positive/i)
  })
})
