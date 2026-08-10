import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'

/**
 * What terminal sessions existed, so a daemon restart does not lose the ones still running.
 *
 * The daemon used to learn a session existed ONLY when one of its hooks fired. Restart it and
 * every already-running agent became invisible to it — the phone still listed the session
 * (correctly, it was alive), but the daemon had no record, so Stop answered `refused` forever
 * and nothing could explain why. The session only reappeared if it happened to run another
 * tool. Observed in the field 2026-08-09: a live session on AgentMem-OS, unstoppable for
 * hours across a restart.
 *
 * So the registry is written on the way in and read on the way back up. It stores only what is
 * needed to re-adopt a session and nothing about what was said — the conversation lives in the
 * event log and the agent's own transcript, and this is deliberately not a second copy of it.
 */

export interface RegisteredSession {
  agentSessionId: string
  sessionId: string
  agent: string
  surface: string
  cwd: string
  transcriptPath: string
  pid: number | null
  title: string
  startedAt: number
}

export class SessionRegistry {
  private readonly db: Db

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_sessions (
        agent_session_id TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        agent            TEXT NOT NULL,
        surface          TEXT NOT NULL,
        cwd              TEXT NOT NULL,
        transcript_path  TEXT NOT NULL,
        pid              INTEGER,
        title            TEXT NOT NULL,
        started_at       INTEGER NOT NULL
      );
    `)
  }

  remember(session: RegisteredSession): void {
    this.db
      .prepare(
        `INSERT INTO live_sessions
           (agent_session_id, session_id, agent, surface, cwd, transcript_path, pid, title, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_session_id) DO UPDATE SET
           pid = excluded.pid, title = excluded.title, surface = excluded.surface`,
      )
      .run(
        session.agentSessionId,
        session.sessionId,
        session.agent,
        session.surface,
        session.cwd,
        session.transcriptPath,
        session.pid,
        session.title,
        session.startedAt,
      )
  }

  forget(agentSessionId: string): void {
    this.db.prepare('DELETE FROM live_sessions WHERE agent_session_id = ?').run(agentSessionId)
  }

  all(): RegisteredSession[] {
    const rows = this.db.prepare('SELECT * FROM live_sessions ORDER BY started_at ASC').all() as {
      agent_session_id: string
      session_id: string
      agent: string
      surface: string
      cwd: string
      transcript_path: string
      pid: number | null
      title: string
      started_at: number
    }[]
    return rows.map((row) => ({
      agentSessionId: row.agent_session_id,
      sessionId: row.session_id,
      agent: row.agent,
      surface: row.surface,
      cwd: row.cwd,
      transcriptPath: row.transcript_path,
      pid: row.pid,
      title: row.title,
      startedAt: row.started_at,
    }))
  }

  close(): void {
    this.db.close()
  }
}
