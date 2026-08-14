import { IDE_PROTOCOL_VERSION, type IdeSessionInventory } from '@longleash/protocol'
import { describe, expect, it } from 'vitest'
import { buildInventorySections, sessionStateLabel } from '../src/inventory.js'

const inventory: IdeSessionInventory = {
  v: IDE_PROTOCOL_VERSION,
  type: 'ide.sessionInventory',
  streamId: 'daemon_boot_1',
  cursor: 7,
  generatedAt: 10_000,
  sessions: [
    {
      sessionId: 'old-waiting',
      provider: 'claude',
      title: 'Dormant conversation',
      origin: 'terminal',
      status: 'waiting',
      live: false,
      resumable: true,
      workspace: { label: 'LongLeash', mode: 'shared' },
      updatedAt: 3,
    },
    {
      sessionId: 'active',
      provider: 'codex',
      title: 'Implement transport',
      origin: 'vscode',
      status: 'running',
      live: true,
      resumable: true,
      workspace: { label: 'LongLeash', branch: 'phase-2a', mode: 'isolated' },
      updatedAt: 4,
    },
    {
      sessionId: 'approval-new',
      provider: 'claude',
      title: 'Approve release command',
      origin: 'phone',
      status: 'waiting',
      live: true,
      resumable: true,
      attention: 'approval',
      workspace: { label: 'LongLeash', mode: 'shared' },
      updatedAt: 6,
    },
    {
      sessionId: 'approval-old',
      provider: 'codex',
      title: 'Answer architecture question',
      origin: 'phone',
      status: 'waiting',
      live: true,
      resumable: true,
      attention: 'question',
      workspace: { label: 'LongLeash', mode: 'shared' },
      updatedAt: 5,
    },
  ],
}

describe('VS Code session inventory projection', () => {
  it('groups attention first, live processes second, and dormant history last', () => {
    const sections = buildInventorySections(inventory)
    expect(sections.map((section) => section.id)).toEqual(['needs-you', 'active', 'earlier'])
    expect(sections[0]?.sessions.map((session) => session.sessionId)).toEqual([
      'approval-new',
      'approval-old',
    ])
    expect(sections[1]?.sessions.map((session) => session.sessionId)).toEqual(['active'])
    expect(sections[2]?.sessions.map((session) => session.sessionId)).toEqual(['old-waiting'])
  })

  it('never labels a dormant waiting conversation as active', () => {
    expect(sessionStateLabel(inventory.sessions[0]!)).toBe('ready to reopen')
    expect(sessionStateLabel(inventory.sessions[1]!)).toBe('working')
  })

  it('does not mutate the daemon snapshot while sorting', () => {
    const before = JSON.stringify(inventory)
    buildInventorySections(inventory)
    expect(JSON.stringify(inventory)).toBe(before)
  })
})
