import { describe, expect, it } from 'vitest'
import { isCurrentFolderReply } from '../src/lib/folder-search.js'

describe('folder search response ordering', () => {
  it('rejects an older root-list reply after the person has typed', () => {
    expect(isCurrentFolderReply('AgentMem-OS', '')).toBe(false)
  })

  it('accepts the reply for the text that is still in the field', () => {
    expect(isCurrentFolderReply('AgentMem-OS', 'AgentMem-OS')).toBe(true)
  })
})
