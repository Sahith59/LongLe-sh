import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@longleash/protocol'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { ExternalSessions } from '../src/external.js'
import { SessionRegistry } from '../src/session-registry.js'

/**
 * Reproduces the field failure of 2026-08-09 exactly.
 *
 * A Claude session was genuinely RUNNING. The daemon restarted. From that moment the daemon
 * had no record of it, so every Stop from the phone answered `refused` — for a live session,
 * for hours, with nothing to explain it. The session only reappeared if it happened to run
 * another tool.
 */

let dir: string
let eventLog: EventLog
let approvals: ApprovalStore
let registry: SessionRegistry
let seen: SessionEvent[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'll-restart-'))
  eventLog = new EventLog(':memory:')
  approvals = new ApprovalStore(':memory:')
  registry = new SessionRegistry(join(dir, 'live.db'))
  seen = []
})
afterEach(() => {
  registry.close()
  eventLog.close()
  approvals.close()
  rmSync(dir, { recursive: true, force: true })
})

const build = (opts: { alive: boolean; kill?: (pid: number) => void }) =>
  new ExternalSessions({
    eventLog,
    approvals,
    registry,
    onEvent: (e) => seen.push(e),
    audience: () => 'connected' as const,
    pollMs: 25,
    isClaudeProcess: () => opts.alive,
    kill: opts.kill ?? (() => {}),
  })

describe('a daemon restart must not lose a session that is still running', () => {
  it('re-adopts a live session, and Stop works on it again', () => {
    const transcript = join(dir, 't.jsonl')
    writeFileSync(transcript, '')

    const first = build({ alive: true })
    first.sessionStart('agent-1', dir, transcript, 4242)
    expect(first.listSessions()).toHaveLength(1)
    first.shutdown() // the daemon goes away; the agent keeps running

    // A brand-new daemon, exactly as a restart produces.
    seen.length = 0
    const killed: number[] = []
    const second = build({ alive: true, kill: (pid) => killed.push(pid) })

    const listed = second.listSessions()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.sessionId).toBe('ext_agent-1')

    // The exact thing that was refused in the field.
    expect(second.stop('ext_agent-1', 'dev_phone')).toBe(true)
    expect(killed).toEqual([4242])
    second.shutdown()
  })

  it('does NOT re-adopt a session whose process died while the daemon was down', () => {
    const transcript = join(dir, 't2.jsonl')
    writeFileSync(transcript, '')
    const first = build({ alive: true })
    first.sessionStart('agent-2', dir, transcript, 5150)
    first.shutdown()

    seen.length = 0
    const second = build({ alive: false }) // the process is gone now
    expect(second.listSessions()).toHaveLength(0)
    // And the phone is TOLD, because it only ever clears a session on an event.
    expect(seen.some((e) => e.type === 'session.ended')).toBe(true)
    second.shutdown()
  })

  it('forgets a session that ended normally, so it never comes back', () => {
    const transcript = join(dir, 't3.jsonl')
    writeFileSync(transcript, '')
    const first = build({ alive: true })
    first.sessionStart('agent-3', dir, transcript, 6000)
    first.sessionEnd('agent-3')
    first.shutdown()

    const second = build({ alive: true })
    expect(second.listSessions()).toHaveLength(0)
    second.shutdown()
  })

  it('a session with no pid is not resurrected as unstoppable', () => {
    // Codex sessions had exactly this shape before the pid fix; re-adopting one would
    // recreate the very "listed but unstoppable" state this whole change exists to remove.
    const transcript = join(dir, 't4.jsonl')
    writeFileSync(transcript, '')
    const first = build({ alive: true })
    first.sessionStart('agent-4', dir, transcript) // no pid
    first.shutdown()

    const second = build({ alive: true })
    expect(second.listSessions()).toHaveLength(0)
    second.shutdown()
  })

  it('keeps the vendor and surface across a restart', () => {
    const transcript = join(dir, 't5.jsonl')
    writeFileSync(transcript, '')
    const first = build({ alive: true })
    first.sessionStart('agent-5', dir, transcript, 7000, 'codex', 'vscode')
    first.shutdown()

    const second = build({ alive: true })
    const s = second.listSessions()[0]
    expect(s?.agent).toBe('codex')
    expect(s?.origin).toBe('vscode')
    second.shutdown()
  })
})
