import { describe, expect, it } from 'vitest'
import {
  delegationDraftKey,
  readDelegationDraft,
  removeDelegationDraft,
  writeDelegationDraft,
} from '../src/lib/delegation-draft.js'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  }
}

describe('delegation drafts', () => {
  it('keeps per-message drafts separate from a session-level draft', () => {
    expect(delegationDraftKey('ses/a', 18)).not.toBe(delegationDraftKey('ses/a'))
    expect(delegationDraftKey('ses/a', 18)).not.toBe(delegationDraftKey('ses/a', 19))
  })

  it('round-trips the exact editable briefing and controls', () => {
    const storage = memoryStorage()
    const draft = {
      idempotencyKey: 'stable-launch-key',
      sourceSessionId: 'ses_parent',
      sourceSeq: 18,
      targetAgent: 'codex' as const,
      role: 'review' as const,
      contextScope: 'selected' as const,
      briefing: 'The user edited this exact briefing.',
      updatedAt: 123,
    }
    expect(writeDelegationDraft(draft, storage)).toBe(true)
    expect(readDelegationDraft('ses_parent', 18, storage)).toEqual(draft)
  })

  it('upgrades a Phase 1A draft with a stable launch key without losing edits', () => {
    const storage = memoryStorage()
    storage.setItem(
      delegationDraftKey('ses_parent'),
      JSON.stringify({
        sourceSessionId: 'ses_parent',
        targetAgent: 'codex',
        role: 'review',
        contextScope: 'recent',
        briefing: 'Keep this edit.',
        updatedAt: 123,
      }),
    )
    const upgraded = readDelegationDraft('ses_parent', undefined, storage)
    expect(upgraded).toMatchObject({ briefing: 'Keep this edit.' })
    expect(upgraded?.idempotencyKey).toEqual(expect.any(String))
  })

  it('does not restore malformed or cross-session browser data', () => {
    const storage = memoryStorage()
    storage.setItem(
      delegationDraftKey('ses_parent'),
      JSON.stringify({
        sourceSessionId: 'ses_other',
        targetAgent: 'gemini',
        role: 'review',
        contextScope: 'task',
        briefing: 'wrong',
        updatedAt: 123,
      }),
    )
    expect(readDelegationDraft('ses_parent', undefined, storage)).toBeNull()
  })

  it('removes a discarded draft', () => {
    const storage = memoryStorage()
    const draft = {
      sourceSessionId: 'ses_parent',
      targetAgent: 'claude' as const,
      role: 'test' as const,
      contextScope: 'recent' as const,
      briefing: 'test it',
      updatedAt: 123,
    }
    writeDelegationDraft(draft, storage)
    removeDelegationDraft('ses_parent', undefined, storage)
    expect(readDelegationDraft('ses_parent', undefined, storage)).toBeNull()
  })

  it('degrades safely when storage is unavailable', () => {
    const rejecting = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(readDelegationDraft('ses_parent', undefined, rejecting)).toBeNull()
    expect(
      writeDelegationDraft(
        {
          sourceSessionId: 'ses_parent',
          targetAgent: 'codex',
          role: 'review',
          contextScope: 'recent',
          briefing: '',
          updatedAt: 123,
        },
        rejecting,
      ),
    ).toBe(false)
    expect(() => removeDelegationDraft('ses_parent', undefined, rejecting)).not.toThrow()
  })
})
