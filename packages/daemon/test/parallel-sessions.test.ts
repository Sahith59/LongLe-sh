import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalStore } from '../src/approvals.js'
import type { AgentFactory, AgentRunRequest, AgentStreamMessage } from '../src/agent.js'
import { EventLog } from '../src/eventlog.js'
import { SessionManager } from '../src/sessions.js'
import { WorkspaceLeaseManager } from '../src/workspace-leases.js'
import { WorktreeManager } from '../src/worktrees.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'longleash-parallel-'))
  roots.push(root)
  execFileSync('git', ['-C', root, 'init'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'tests@longleash.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'LongLeash tests'])
  writeFileSync(join(root, 'README.md'), 'parallel\n')
  execFileSync('git', ['-C', root, 'add', 'README.md'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'initial'])
  return realpathSync(root)
}

describe('parallel sessions in one project', () => {
  it('keeps the first writer in place and starts the second in an isolated worktree', async () => {
    const root = repo()
    const managed = mkdtempSync(join(tmpdir(), 'longleash-worktrees-'))
    roots.push(managed)
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const requests: AgentRunRequest[] = []
    const finishers: (() => void)[] = []
    const factory: AgentFactory = (request) => {
      requests.push(request)
      let finish = () => {}
      const ended = new Promise<void>((resolve) => { finish = resolve })
      finishers.push(finish)
      async function* events(): AsyncGenerator<AgentStreamMessage> { await ended }
      return { events: events(), interrupt: async () => finish(), sendMessage: () => {} }
    }
    const workspace = new WorkspaceLeaseManager(approvals.rawDb)
    const sessions = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [root],
      agentFactories: { claude: factory, codex: factory },
      workspace,
      worktrees: new WorktreeManager(managed),
    })

    try {
      await sessions.startSession({ agent: 'claude', cwd: root, prompt: 'first', workspaceMode: 'auto' })
      await sessions.startSession({ agent: 'codex', cwd: root, prompt: 'second', workspaceMode: 'auto' })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.cwd).toBe(root)
      expect(requests[1]?.cwd).not.toBe(root)
      expect(sessions.listSessions().map((session) => session.workspace?.mode)).toEqual(['shared', 'isolated'])
      expect(workspace.list()).toHaveLength(2)
    } finally {
      await sessions.shutdown()
      log.close()
      approvals.close()
    }
  })
})
