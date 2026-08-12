import { describe, expect, it } from 'vitest'
import {
  readReturnDraft,
  removeReturnDraft,
  returnDraftKey,
  writeReturnDraft,
} from '../src/lib/delegation-return-draft.js'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  }
}

describe('reviewed return drafts', () => {
  it('round-trips the edited bytes and stable delivery key without trimming them', () => {
    const target = memoryStorage()
    const draft = {
      delegationId: 'del/one',
      idempotencyKey: 'return-operation-1',
      returnText: '\n  Keep indentation.  \nAnd the final newline.\n',
      updatedAt: 123,
    }
    expect(writeReturnDraft(draft, target)).toBe(true)
    expect(readReturnDraft('del/one', target)).toEqual(draft)
  })

  it('isolates drafts per delegation and rejects cross-delegation browser data', () => {
    const target = memoryStorage()
    expect(returnDraftKey('del/a')).not.toBe(returnDraftKey('del/b'))
    target.setItem(returnDraftKey('del/a'), JSON.stringify({
      delegationId: 'del/b', idempotencyKey: 'key', returnText: 'wrong route', updatedAt: 1,
    }))
    expect(readReturnDraft('del/a', target)).toBeNull()
  })

  it('removes a settled draft and degrades safely when browser storage is unavailable', () => {
    const target = memoryStorage()
    const draft = {
      delegationId: 'del_done', idempotencyKey: 'return-done', returnText: 'done', updatedAt: 4,
    }
    writeReturnDraft(draft, target)
    removeReturnDraft('del_done', target)
    expect(readReturnDraft('del_done', target)).toBeNull()

    const rejecting = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(readReturnDraft('del_done', rejecting)).toBeNull()
    expect(writeReturnDraft(draft, rejecting)).toBe(false)
    expect(() => removeReturnDraft('del_done', rejecting)).not.toThrow()
  })
})
