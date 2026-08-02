import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { SessionManager } from '../src/sessions.js'
import type { AgentFactory } from '../src/agent.js'

const noopAgent: AgentFactory = (request) => {
  // Real agents announce a resume id moments after starting; without it a conversation has
  // no point to carry on from, so a stub that stays silent would test the wrong thing.
  queueMicrotask(() => request.onAgentSession('claude_migrated'))
  return {
    events: (async function* () {})(),
    sendMessage: () => {},
    interrupt: async () => {},
  }
}

let dir: string
let root: string
let dbPath: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-migrate-')))
  root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  dbPath = join(dir, 'approvals.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Recreates a database written by an older release, before later columns existed. */
function writeOldSchema(): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE approvals (
      approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      input_summary TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL, decided_by TEXT, decided_at INTEGER, reply TEXT
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, agent TEXT NOT NULL, cwd TEXT NOT NULL, origin TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL
    );
  `)
  db.prepare(
    `INSERT INTO sessions (session_id, agent, cwd, origin, title, status, started_at)
     VALUES ('ses_old', 'claude', ?, 'phone', 'work from a previous release', 'ended', 1)`,
  ).run(root)
  db.close()
}

describe('upgrading a database written by an older release', () => {
  it('adds columns that did not exist then, instead of failing at runtime', () => {
    writeOldSchema()
    const approvals = new ApprovalStore(dbPath)
    const columns = (approvals.rawDb.prepare('PRAGMA table_info(approvals)').all() as { name: string }[])
      .map((c) => c.name)
    expect(columns).toContain('target_path')
    expect(columns).toContain('outside_root')
    approvals.close()
  })

  it('lets a session started by an older release still be listed and reopened', async () => {
    writeOldSchema()
    const log = new EventLog(join(dir, 'events.db'))
    const approvals = new ApprovalStore(dbPath)
    const manager = new SessionManager({
      eventLog: log,
      approvals,
      allowedRoots: [root],
      agentFactories: { claude: noopAgent },
    })

    // This is what failed on a real upgrade: "no such column: agent_session_id".
    const listed = manager.listSessions()
    expect(listed.map((s) => s.sessionId)).toContain('ses_old')
    // It predates resume points, so it cannot be continued — and says so plainly instead
    // of crashing or pretending. Sessions started after the upgrade can be.
    await expect(manager.resumeSession('ses_old', 'dev_phone')).resolves.toBe(false)
    const { sessionId } = await manager.startSession({ agent: 'claude', cwd: root, prompt: 'new work' })
    await manager.stopSession(sessionId, 'dev_phone')
    await expect(manager.resumeSession(sessionId, 'dev_phone')).resolves.toBe(true)

    log.close()
    approvals.close()
  })

  it('preserves the rows an older release wrote', () => {
    writeOldSchema()
    const approvals = new ApprovalStore(dbPath)
    const row = approvals.rawDb.prepare("SELECT title FROM sessions WHERE session_id = 'ses_old'").get() as
      | { title: string }
      | undefined
    expect(row?.title).toBe('work from a previous release')
    approvals.close()
  })

  it('is safe to run twice — opening an already-current database changes nothing', () => {
    writeOldSchema()
    new ApprovalStore(dbPath).close()
    const second = new ApprovalStore(dbPath)
    const columns = (second.rawDb.prepare('PRAGMA table_info(sessions)').all() as { name: string }[])
      .map((c) => c.name)
    expect(columns.filter((c) => c === 'agent_session_id')).toHaveLength(1)
    second.close()
  })

  it('creates a fresh database with every column present', () => {
    const approvals = new ApprovalStore(join(dir, 'fresh.db'))
    const columns = (approvals.rawDb.prepare('PRAGMA table_info(sessions)').all() as { name: string }[])
      .map((c) => c.name)
    expect(columns).toContain('agent_session_id')
    approvals.close()
  })
})
