import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSensitivePath } from '../src/sensitive.js'
import { FolderIndex } from '../src/folders.js'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { SessionManager } from '../src/sessions.js'
import type { AgentFactory } from '../src/agent.js'

const noopAgent: AgentFactory = () => ({
  events: (async function* () {})(),
  sendMessage: () => {},
  interrupt: async () => {},
})

describe('recognising sensitive paths', () => {
  it('flags credential and system folders wherever they appear', () => {
    expect(isSensitivePath('/Users/x/.ssh')).toBe(true)
    expect(isSensitivePath('/Users/x/.ssh/keys')).toBe(true)
    expect(isSensitivePath('/Users/x/.aws/config')).toBe(true)
    expect(isSensitivePath('/Users/x/Library/Keychains')).toBe(true)
  })

  it('leaves ordinary project folders alone', () => {
    expect(isSensitivePath('/Users/x/Desktop/FD_Engineer')).toBe(false)
    expect(isSensitivePath('/Users/x/projects/api')).toBe(false)
  })

  it('does not flag a folder that merely contains a sensitive word', () => {
    expect(isSensitivePath('/Users/x/my-ssh-notes')).toBe(false)
    expect(isSensitivePath('/Users/x/LibraryApp')).toBe(false)
  })
})

describe('a whole-home setup still refuses sensitive folders', () => {
  let home: string
  let log: EventLog
  let approvals: ApprovalStore
  let manager: SessionManager

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-home-')))
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true })
    mkdirSync(join(home, 'Desktop', 'FD_Engineer'), { recursive: true })
    log = new EventLog(':memory:')
    approvals = new ApprovalStore(':memory:')
    manager = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [home],
      agentFactories: { claude: noopAgent },
      excludeSensitive: true,
    })
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    log.close()
    approvals.close()
  })

  it('REFUSES to start an agent in a credential folder inside the allowed root', async () => {
    await expect(
      manager.startSession({ agent: 'claude', cwd: join(home, '.ssh'), prompt: 'x' }),
    ).rejects.toThrow(/not allowed/i)
  })

  it('refuses a nested sensitive folder too', async () => {
    await expect(
      manager.startSession({ agent: 'claude', cwd: join(home, 'Library', 'Keychains'), prompt: 'x' }),
    ).rejects.toThrow(/not allowed/i)
  })

  it('still allows ordinary project folders', async () => {
    await expect(
      manager.startSession({ agent: 'claude', cwd: join(home, 'Desktop', 'FD_Engineer'), prompt: 'x' }),
    ).resolves.toBeDefined()
  })

  it('never offers sensitive folders in search results', () => {
    const index = new FolderIndex([home])
    expect(index.search('ssh')).toHaveLength(0)
    expect(index.search('Keychains')).toHaveLength(0)
    expect(index.search('FD_Engineer')[0]?.label).toContain('FD_Engineer')
  })
})
