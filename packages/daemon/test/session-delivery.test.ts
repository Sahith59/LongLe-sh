import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentFactory, AgentStreamMessage } from '../src/agent.js'
import { ApprovalStore } from '../src/approvals.js'
import { EventLog } from '../src/eventlog.js'
import { SessionManager } from '../src/sessions.js'

class HoldingAgent {
  readonly messages: string[] = []
  private ended = false
  private wake: (() => void) | null = null

  readonly factory: AgentFactory = () => ({
    events: this.events(),
    sendMessage: (text) => this.messages.push(text),
    interrupt: async () => {
      this.ended = true
      this.wake?.()
      this.wake = null
    },
  })

  private async *events(): AsyncGenerator<AgentStreamMessage> {
    while (!this.ended) await new Promise<void>((resolve) => { this.wake = resolve })
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('durable reviewed-return delivery boundary', () => {
  it('upgrades old markers as sent, marks accepted sends, and never auto-resends an uncertain one', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-delivery-')))
    const log = new EventLog(':memory:')
    const approvals = new ApprovalStore(':memory:')
    approvals.rawDb.exec(`
      CREATE TABLE session_deliveries (
        delivery_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO session_deliveries (delivery_id, session_id, created_at)
      VALUES ('legacy-delivery', 'ses_legacy', 1);
    `)
    const agent = new HoldingAgent()
    const sessions = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [root],
      agentFactories: { claude: agent.factory },
    })
    cleanups.push(async () => {
      await sessions.shutdown()
      log.close()
      approvals.close()
      rmSync(root, { recursive: true, force: true })
    })

    expect(approvals.rawDb.prepare(
      "SELECT state FROM session_deliveries WHERE delivery_id = 'legacy-delivery'",
    ).get()).toEqual({ state: 'sent' })

    const { sessionId } = await sessions.startSession({ agent: 'claude', cwd: root, prompt: 'Parent task.' })
    expect(sessions.sendMessageOnce({
      sessionId,
      text: 'Reviewed result.',
      actor: 'dev_phone',
      deliveryId: 'return-accepted',
    })).toBe('sent')
    expect(agent.messages).toEqual(['Reviewed result.'])
    expect(sessions.sendMessageOnce({
      sessionId,
      text: 'Reviewed result.',
      actor: 'dev_phone',
      deliveryId: 'return-accepted',
    })).toBe('already-sent')
    expect(agent.messages).toEqual(['Reviewed result.'])

    approvals.rawDb.prepare(
      "INSERT INTO session_deliveries (delivery_id, session_id, state, created_at) VALUES (?, ?, 'sending', ?)",
    ).run('return-interrupted', sessionId, 2)
    expect(sessions.sendMessageOnce({
      sessionId,
      text: 'Do not silently resend this.',
      actor: 'dev_phone',
      deliveryId: 'return-interrupted',
    })).toBe('uncertain')
    expect(agent.messages).toEqual(['Reviewed result.'])
  })
})
