import Database from 'better-sqlite3'
import { parseEvent, PROTOCOL_VERSION, type SessionEvent } from '@longleash/protocol'

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
      )
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

  latestTimestamp(sessionId: string): number {
    return (this.latestTsStmt.get(sessionId) as { ts: number }).ts
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
