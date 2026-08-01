import Database from 'better-sqlite3'
import { ensureColumns } from './migrate.js'

export type ApprovalStatus = 'pending' | 'allowed' | 'denied'

export interface ApprovalRecord {
  approvalId: string
  sessionId: string
  toolName: string
  inputSummary: string
  createdAt: number
  expiresAt: number
  status: ApprovalStatus
  decidedBy: string | null
  decidedAt: number | null
  reply: string | null
  /** Resolved path the tool targets, when it declares one. Null for opaque tools like Bash. */
  targetPath: string | null
  /** True when that path escapes every allowlisted root — surfaced prominently to the human. */
  outsideRoot: boolean
}

interface ApprovalRow {
  approval_id: string
  session_id: string
  tool_name: string
  input_summary: string
  created_at: number
  expires_at: number
  status: ApprovalStatus
  decided_by: string | null
  decided_at: number | null
  reply: string | null
  target_path: string | null
  outside_root: number
}

export interface CreateApprovalInput {
  approvalId: string
  sessionId: string
  toolName: string
  inputSummary: string
  expiresAt: number
  targetPath?: string | null
  outsideRoot?: boolean
}

/**
 * Approvals outlive any single connection: a phone that reconnects hours later must still
 * find what is waiting, so they live in SQLite rather than only in memory.
 */
export class ApprovalStore {
  readonly rawDb: Database.Database
  private readonly now: () => number

  constructor(path: string, opts: { now?: () => number } = {}) {
    this.rawDb = new Database(path)
    this.rawDb.pragma('journal_mode = WAL')
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        decided_by TEXT,
        decided_at INTEGER,
        reply TEXT,
        target_path TEXT,
        outside_root INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        origin TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        agent_session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS audit (
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `)
    // A database written by an earlier release lacks columns added since; add them rather
    // than failing at runtime with "no such column".
    // One owner per database file: this store defines every table it holds, so opening it is
    // always enough to bring an older file fully up to date.
    ensureColumns(this.rawDb, 'approvals', [
      { name: 'target_path', definition: 'TEXT' },
      { name: 'outside_root', definition: 'INTEGER NOT NULL DEFAULT 0' },
    ])
    ensureColumns(this.rawDb, 'sessions', [{ name: 'agent_session_id', definition: 'TEXT' }])
    this.now = opts.now ?? Date.now
  }

  create(input: CreateApprovalInput): ApprovalRecord {
    const createdAt = this.now()
    this.rawDb
      .prepare(
        `INSERT INTO approvals (approval_id, session_id, tool_name, input_summary, created_at, expires_at, status, decided_by, decided_at, reply, target_path, outside_root)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.approvalId,
        input.sessionId,
        input.toolName,
        input.inputSummary,
        createdAt,
        input.expiresAt,
        input.targetPath ?? null,
        input.outsideRoot === true ? 1 : 0,
      )
    return {
      approvalId: input.approvalId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      inputSummary: input.inputSummary,
      expiresAt: input.expiresAt,
      createdAt,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      reply: null,
      targetPath: input.targetPath ?? null,
      outsideRoot: input.outsideRoot === true,
    }
  }

  get(approvalId: string): ApprovalRecord | null {
    const row = this.rawDb.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(approvalId) as
      | ApprovalRow
      | undefined
    return row ? this.toRecord(row) : null
  }

  listPending(): ApprovalRecord[] {
    const rows = this.rawDb
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as ApprovalRow[]
    return rows.map((row) => this.toRecord(row))
  }

  /** Returns false when the approval was already decided, so callers stay idempotent. */
  decide(approvalId: string, status: 'allowed' | 'denied', decidedBy: string, reply?: string): boolean {
    const result = this.rawDb
      .prepare(
        `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, reply = ?
         WHERE approval_id = ? AND status = 'pending'`,
      )
      .run(status, decidedBy, this.now(), reply ?? null, approvalId)
    return result.changes === 1
  }

  /** Pending approvals whose deadline has passed; the caller denies them so agents never hang. */
  findExpired(): ApprovalRecord[] {
    const rows = this.rawDb
      .prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?")
      .all(this.now()) as ApprovalRow[]
    return rows.map((row) => this.toRecord(row))
  }

  /**
   * A crashed daemon takes its agent processes with it, so anything still pending on startup
   * can never be answered. Close them out rather than showing a phantom inbox forever.
   */
  closeOrphans(reason: string): string[] {
    const orphans = this.listPending()
    for (const approval of orphans) {
      this.decide(approval.approvalId, 'denied', 'system:orphaned', reason)
    }
    return orphans.map((approval) => approval.approvalId)
  }

  close(): void {
    this.rawDb.close()
  }

  private toRecord(row: ApprovalRow): ApprovalRecord {
    return {
      approvalId: row.approval_id,
      sessionId: row.session_id,
      toolName: row.tool_name,
      inputSummary: row.input_summary,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      reply: row.reply,
      targetPath: row.target_path,
      outsideRoot: row.outside_root === 1,
    }
  }
}
