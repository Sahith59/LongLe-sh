import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../../src/eventlog.js'
import { ApprovalStore } from '../../src/approvals.js'
import { SessionManager } from '../../src/sessions.js'
import { createCodexAgentFactory } from '../../src/adapters/codex.js'

// `pnpm test:contract` is the product-level live-agent gate. Keeping Codex behind a second,
// undocumented environment flag made that command look green while silently skipping one
// of the two agents LongLeash claims to support.
const suite = process.env.LONGLEASH_CONTRACT === '1' || process.env.LONGLEASH_CODEX_CONTRACT === '1'
  ? describe
  : describe.skip
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

suite('real Codex app-server contract', () => {
  it('starts from the phone path, emits final assistant text, reaches waiting, and stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'longleash-codex-contract-'))
    dirs.push(dir)
    const root = realpathSync(dir)
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const manager = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [root],
      agentFactories: {
        codex: createCodexAgentFactory({
          approvalPolicy: 'never',
          sandbox: 'read-only',
          managedHome: join(root, '.codex-managed'),
        }),
      },
    })
    try {
      const { sessionId } = await manager.startSession({
        agent: 'codex',
        cwd: root,
        prompt: 'Reply with exactly LONGLEASH_CODEX_OK and do not use tools.',
      })
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const session = manager.listSessions().find((item) => item.sessionId === sessionId)
        if (session?.status === 'waiting') break
        if (session?.status === 'errored' || session?.status === 'ended') {
          throw new Error(`Codex ended as ${session.status}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(manager.listSessions().find((item) => item.sessionId === sessionId)?.status).toBe('waiting')
      const replay = log.replay(sessionId, 0)
      if (replay.gap) throw new Error('unexpected event-log gap')
      const text = replay.events
        .filter((event) => event.type === 'stream.delta' && event.payload.kind === 'text')
        .map((event) => String(event.payload.text))
        .join('')
      expect(text).toContain('LONGLEASH_CODEX_OK')
      expect(await manager.stopSession(sessionId, 'contract')).toBe(true)
    } finally {
      await manager.shutdown()
      approvals.close()
      log.close()
    }
  }, 150_000)

  it('really blocks a shell action, accepts the phone approval shape, and performs it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'longleash-codex-approval-'))
    dirs.push(dir)
    const root = realpathSync(dir)
    const target = join(root, 'codex-approved.txt')
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const manager = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [root],
      agentFactories: {
        codex: createCodexAgentFactory({
          approvalPolicy: 'untrusted',
          sandbox: 'workspace-write',
          managedHome: join(root, '.codex-managed'),
          ...(process.env.LONGLEASH_DEBUG === '1' ? { log: console.log } : {}),
        }),
      },
      ...(process.env.LONGLEASH_DEBUG === '1'
        ? { onEvent: (event) => console.log(`[codex] ${event.type} ${JSON.stringify(event.payload)}`) }
        : {}),
    })
    let approveTimer: ReturnType<typeof setInterval> | undefined
    try {
      const { sessionId } = await manager.startSession({
        agent: 'codex',
        cwd: root,
        prompt: `Run a shell command that writes exactly CODEX_APPROVED to ${target}, then reply DONE.`,
      })

      const approvalDeadline = Date.now() + 120_000
      while (manager.listPendingApprovals().length === 0 && Date.now() < approvalDeadline) {
        const status = manager.listSessions().find((item) => item.sessionId === sessionId)?.status
        if (status === 'errored' || status === 'ended') throw new Error(`Codex ended as ${status}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const pending = manager.listPendingApprovals()
      expect(pending.length).toBeGreaterThan(0)
      expect(existsSync(target)).toBe(false)

      // Keep answering in case Codex legitimately splits the action into more than one request.
      approveTimer = setInterval(() => {
        for (const approval of manager.listPendingApprovals()) {
          manager.decide(approval.approvalId, 'allow', 'contract-phone')
        }
      }, 100)

      const completionDeadline = Date.now() + 120_000
      while (Date.now() < completionDeadline) {
        const status = manager.listSessions().find((item) => item.sessionId === sessionId)?.status
        if (status === 'waiting') break
        if (status === 'errored' || status === 'ended') throw new Error(`Codex ended as ${status}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(manager.listSessions().find((item) => item.sessionId === sessionId)?.status).toBe('waiting')
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(target, 'utf8').trim()).toBe('CODEX_APPROVED')
    } finally {
      if (approveTimer !== undefined) clearInterval(approveTimer)
      await manager.shutdown()
      approvals.close()
      log.close()
    }
  }, 150_000)

  it('stops, reopens, and continues the same real Codex thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'longleash-codex-resume-'))
    dirs.push(dir)
    const root = realpathSync(dir)
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    const manager = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [root],
      agentFactories: {
        codex: createCodexAgentFactory({
          approvalPolicy: 'never',
          sandbox: 'read-only',
          managedHome: join(root, '.codex-managed'),
        }),
      },
    })
    try {
      const { sessionId } = await manager.startSession({
        agent: 'codex',
        cwd: root,
        prompt: 'Remember the codeword COBALT_LEASH. Reply only STORED. Do not use tools.',
      })
      const firstDeadline = Date.now() + 120_000
      while (
        manager.listSessions().find((item) => item.sessionId === sessionId)?.status !== 'waiting' &&
        Date.now() < firstDeadline
      ) await new Promise((resolve) => setTimeout(resolve, 100))
      expect(manager.listSessions().find((item) => item.sessionId === sessionId)?.status).toBe('waiting')

      expect(await manager.stopSession(sessionId, 'contract-phone')).toBe(true)
      expect(await manager.resumeSession(sessionId, 'contract-phone')).toBe(true)
      expect(
        manager.sendMessage(
          sessionId,
          'What codeword did I ask you to remember? Reply only with it.',
          'contract-phone',
        ),
      ).toBe(true)

      const secondDeadline = Date.now() + 120_000
      while (Date.now() < secondDeadline) {
        const session = manager.listSessions().find((item) => item.sessionId === sessionId)
        const replay = log.replay(sessionId, 0)
        const text = replay.gap
          ? ''
          : replay.events
              .filter((event) => event.type === 'stream.delta' && event.payload.kind === 'text')
              .map((event) => String(event.payload.text))
              .join('')
        if (session?.status === 'waiting' && text.includes('COBALT_LEASH')) break
        if (session?.status === 'errored') throw new Error('resumed Codex session errored')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const replay = log.replay(sessionId, 0)
      if (replay.gap) throw new Error('unexpected event-log gap')
      expect(
        replay.events
          .filter((event) => event.type === 'stream.delta' && event.payload.kind === 'text')
          .map((event) => String(event.payload.text))
          .join(''),
      ).toContain('COBALT_LEASH')
      expect(manager.listSessions().find((item) => item.sessionId === sessionId)?.status).toBe('waiting')
    } finally {
      await manager.shutdown()
      approvals.close()
      log.close()
    }
  }, 150_000)
})
