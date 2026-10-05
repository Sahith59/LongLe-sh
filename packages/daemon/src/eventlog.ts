import Database from 'better-sqlite3'
import { AskedQuestion, parseEvent, PROTOCOL_VERSION, type SessionEvent, type AskedQuestion as AskedQuestionValue } from '@longleash/protocol'

export type AppendInput = {
  [K in SessionEvent['type']]: {
    type: K
    payload: Extract<SessionEvent, { type: K }>['payload']
  }
}[SessionEvent['type']]

export type ReplayResult =
  | { gap: false; events: SessionEvent[] }
  | { gap: true; reason: 'cursor-ahead'; latestSeq: number }
  | { gap: true; reason: 'pruned'; earliestSeq: number }

interface EventRow {
  session_id: string
  seq: number
  ts: number
  v: number
  type: string
  payload: string
}

export class EventLog {
  readonly rawDb: Database.Database
  private readonly now: () => number
  private readonly insertStmt: Database.Statement
  private readonly maxSeqStmt: Database.Statement
  private readonly minSeqStmt: Database.Statement
  private readonly latestTsStmt: Database.Statement
  private readonly selectFromStmt: Database.Statement
  private readonly pruneStmt: Database.Statement

  constructor(path: string, opts: { now?: () => number } = {}) {
    this.rawDb = new Database(path)
    this.rawDb.pragma('journal_mode = WAL')
    this.rawDb.pragma('synchronous = NORMAL')
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        v INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS session_aliases (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    this.now = opts.now ?? Date.now
    this.insertStmt = this.rawDb.prepare(
      'INSERT INTO events (session_id, seq, ts, v, type, payload) VALUES (?, ?, ?, ?, ?, ?)',
    )
    this.maxSeqStmt = this.rawDb.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?',
    )
    this.minSeqStmt = this.rawDb.prepare(
      'SELECT COALESCE(MIN(seq), 0) AS seq FROM events WHERE session_id = ?',
    )
    this.latestTsStmt = this.rawDb.prepare(
      'SELECT COALESCE(MAX(ts), 0) AS ts FROM events WHERE session_id = ?',
    )
    this.selectFromStmt = this.rawDb.prepare(
      'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
    )
    this.pruneStmt = this.rawDb.prepare('DELETE FROM events WHERE session_id = ? AND seq < ?')
  }

  append(sessionId: string, input: AppendInput): SessionEvent {
    return this.appendBatch(sessionId, [input])[0] as SessionEvent
  }

  appendBatch(sessionId: string, inputs: AppendInput[]): SessionEvent[] {
    const run = this.rawDb.transaction((items: AppendInput[]): SessionEvent[] => {
      let seq = this.latestSeq(sessionId)
      const events: SessionEvent[] = []
      for (const item of items) {
        seq += 1
        const event = parseEvent({
          v: PROTOCOL_VERSION,
          seq,
          sessionId,
          ts: this.now(),
          type: item.type,
          payload: item.payload,
        })
        this.insertStmt.run(sessionId, event.seq, event.ts, event.v, event.type, JSON.stringify(event.payload))
        events.push(event)
      }
      return events
    })
    return run(inputs)
  }

  replay(sessionId: string, fromCursor: number): ReplayResult {
    const latestSeq = this.latestSeq(sessionId)
    if (fromCursor > latestSeq) {
      return { gap: true, reason: 'cursor-ahead', latestSeq }
    }
    const earliestSeq = (this.minSeqStmt.get(sessionId) as { seq: number }).seq
    if (earliestSeq > 0 && fromCursor < earliestSeq - 1) {
      return { gap: true, reason: 'pruned', earliestSeq }
    }
    const rows = this.selectFromStmt.all(sessionId, fromCursor) as EventRow[]
    const events = rows.map((row) =>
      parseEvent({
        v: row.v,
        seq: row.seq,
        sessionId: row.session_id,
        ts: row.ts,
        type: row.type,
        payload: JSON.parse(row.payload),
      }),
    )
    return { gap: false, events }
  }

  latestSeq(sessionId: string): number {
    return (this.maxSeqStmt.get(sessionId) as { seq: number }).seq
  }

  /** Recent observed native Codex IDs, read from durable metadata without replaying transcripts. */
  knownObservedCodexNativeIds(limit = 256): string[] {
    const rows = this.rawDb.prepare(`
      SELECT native_id FROM (
        SELECT json_extract(start.payload, '$.resumeId') AS native_id, start.ts AS started_at
        FROM events AS start
        WHERE start.type = 'session.started'
          AND json_extract(start.payload, '$.agent') = 'codex'
          AND json_extract(start.payload, '$.controller') = 'external'
          AND json_extract(start.payload, '$.control') = 'observe'
          AND json_type(start.payload, '$.resumeId') = 'text'
          AND NOT EXISTS (
            SELECT 1 FROM events AS ended
            WHERE ended.session_id = start.session_id AND ended.type = 'session.ended'
              AND ended.seq > start.seq
              AND json_extract(ended.payload, '$.reason') IS NOT 'LongLeash stopped watching'
          )
      ) AS known
      GROUP BY native_id ORDER BY MAX(started_at) DESC, native_id DESC LIMIT ?
    `).all(limit) as { native_id: string }[]
    return rows.map((row) => row.native_id)
  }

  /** Bounded IDE replay: pagination never loads an entire historical conversation. */
  readPage(sessionId: string, fromCursor: number): { events: SessionEvent[]; latestCursor: number; hasMore: boolean } {
    const rows = this.rawDb.prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT 250')
      .all(sessionId, fromCursor) as EventRow[]
    const events = rows.map((row) => parseEvent({ v: row.v, seq: row.seq, sessionId: row.session_id,
      ts: row.ts, type: row.type, payload: JSON.parse(row.payload) }))
    const latestCursor = events.at(-1)?.seq ?? Math.min(fromCursor, this.latestSeq(sessionId))
    return { events, latestCursor, hasMore: latestCursor < this.latestSeq(sessionId) }
  }

  /** Recover question choices for a still-pending approval outside the current replay page. */
  pendingQuestions(sessionId: string, approvalId: string): AskedQuestionValue[] | undefined {
    const row = this.rawDb.prepare(
      `SELECT payload FROM events WHERE session_id = ? AND type = 'approval.requested'
       AND json_extract(payload, '$.approvalId') = ? ORDER BY seq DESC LIMIT 1`,
    ).get(sessionId, approvalId) as { payload: string } | undefined
    if (!row) return undefined
    try {
      const payload = JSON.parse(row.payload) as { questions?: unknown }
      const result = AskedQuestion.array().safeParse(payload.questions)
      return result.success ? result.data : undefined
    } catch { return undefined }
  }

  latestTimestamp(sessionId: string): number {
    return (this.latestTsStmt.get(sessionId) as { ts: number }).ts
  }

  /** Historical lifecycle-only IDs are not conversations: no text, tool, or approval arrived. */
  hasConversationActivity(sessionId: string): boolean {
    const row = this.rawDb.prepare(
      `SELECT 1 FROM events WHERE session_id = ?
       AND type NOT IN ('session.started', 'session.status', 'session.ended') LIMIT 1`,
    ).get(sessionId)
    return row !== undefined
  }

  aliasFor(sessionId: string): string | undefined {
    const row = this.rawDb
      .prepare('SELECT title FROM session_aliases WHERE session_id = ?')
      .get(sessionId) as { title: string } | undefined
    return row?.title
  }

  setAlias(sessionId: string, title: string): void {
    this.rawDb
      .prepare(
        `INSERT INTO session_aliases (session_id, title, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      )
      .run(sessionId, title, this.now())
  }

  pruneBefore(sessionId: string, uptoExclusive: number): void {
    this.pruneStmt.run(sessionId, uptoExclusive)
  }

  close(): void {
    this.rawDb.close()
  }
}

export function coalesceTextDeltas(inputs: AppendInput[]): AppendInput[] {
  const out: AppendInput[] = []
  for (const input of inputs) {
    const prev = out[out.length - 1]
    if (
      input.type === 'stream.delta' &&
      input.payload.kind === 'text' &&
      prev !== undefined &&
      prev.type === 'stream.delta' &&
      prev.payload.kind === 'text'
    ) {
      out[out.length - 1] = {
        type: 'stream.delta',
        payload: { ...prev.payload, text: prev.payload.text + input.payload.text },
      }
    } else {
      out.push(input)
    }
  }
  return out
}
