import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isNewYorkMondayMorning, scheduleWeeklyDigest, type ReportingEnv } from '../worker/reporting.js'
import type { AccountDirectory } from '../worker/owner-accounts.js'

describe('aggregate owner reporting', () => {
  let sqlite: DatabaseSync
  let env: ReportingEnv
  const source: AccountDirectory = {
    async list() { return { data: [], totalCount: 0 } },
    async count(input) { if (!input) return 3; if (input.userId?.includes('user_owner')) return 1; return 1 },
  }
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    for (const file of ['0001_feedback.sql', '0002_email_outbox.sql', '0003_measurement.sql']) {
      sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
    }
    const prepare = (sql: string) => { const build = (values: (string | number | null)[] = []) => ({
      bind: (...args: (string | number | null)[]) => build(args),
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    }); return build() }
    env = { PUBLIC_APP_HOST: 'app.longleash.dev', FEEDBACK_DB: { prepare } as unknown as D1Database,
      FEEDBACK_ENABLED: 'true', REPORTING_ENABLED: 'true', SUPPORT_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test',
      OWNER_NOTIFICATION_EMAIL: 'owner@example.com', OWNER_USER_IDS: 'user_owner' }
  })
  afterEach(() => sqlite.close())

  it('uses the owner timezone gate and deduplicates a completed UTC week', async () => {
    const monday = Date.parse('2026-09-14T13:05:00Z')
    expect(isNewYorkMondayMorning(monday)).toBe(true)
    expect(isNewYorkMondayMorning(Date.parse('2026-09-14T12:05:00Z'))).toBe(false)
    expect(await scheduleWeeklyDigest(env, monday, source)).toEqual({ queued: true, skipped: false })
    expect(await scheduleWeeklyDigest(env, monday + 60_000, source)).toEqual({ queued: false, skipped: false })
    const row = sqlite.prepare('SELECT kind, payload FROM support_email_outbox').get() as { kind: string; payload: string }
    expect(row.kind).toBe('weekly_digest')
    expect(row.payload).toContain('aggregate counts only')
    expect(row.payload).not.toContain('dev@example.com')
  })

  it('does not queue outside the schedule or without a configured sender', async () => {
    expect(await scheduleWeeklyDigest(env, Date.parse('2026-09-15T13:05:00Z'), source)).toEqual({ queued: false, skipped: true })
    delete env.RESEND_API_KEY
    expect(await scheduleWeeklyDigest(env, Date.parse('2026-09-14T13:05:00Z'), source)).toEqual({ queued: false, skipped: true })
  })
})
