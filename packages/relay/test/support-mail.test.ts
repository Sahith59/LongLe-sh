import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drainSupportMail, type SupportMailConfig } from '../worker/support-mail.js'

describe('durable owner email outbox', () => {
  let sqlite: DatabaseSync
  let env: SupportMailConfig
  const now = 1_800_000_000_000
  const id = 'cc661b0a-923e-4c7d-bb09-86ee10ae6c77'
  const provider = '7f6d9b26-ff67-4e20-a856-1387c60bfe12'
  const accept = () => Response.json({ id: provider })
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    for (const file of ['0001_feedback.sql', '0002_email_outbox.sql']) {
      sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
    }
    // This intentionally adapts only the D1 methods used by the unit under test. Runtime-D1
    // validation is a separate release gate, not established by this SQLite fixture.
    const db = { prepare(sql: string) {
      const build = (values: (string | number | null)[] = []) => ({
        bind: (...args: (string | number | null)[]) => build(args),
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
      })
      return build()
    } } as unknown as D1Database
    env = { FEEDBACK_DB: db, FEEDBACK_ENABLED: 'true', SUPPORT_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test-not-live', OWNER_NOTIFICATION_EMAIL: 'owner@example.com' }
    sqlite.prepare(`INSERT INTO feedback(id, access_hash, category, subject, message, created_at, updated_at, expires_at)
      VALUES (?, 'hash', 'help', 'private subject', 'private content', ?, ?, ?)`).run(id, now, now, now + 90 * 86400_000)
  })
  afterEach(() => sqlite.close())
  const row = () => sqlite.prepare('SELECT * FROM support_email_outbox').get()!
  it('creates the notification transactionally without copying support content', () => {
    expect(row().id).toBe(id)
    expect(row().state).toBe('pending')
    expect(JSON.stringify(row())).not.toContain('private content')
    expect(row().payload).toBeNull()
  })
  it('does nothing without enabled email and configured recipient', async () => {
    delete env.OWNER_NOTIFICATION_EMAIL
    const network = vi.fn<typeof fetch>()
    expect(await drainSupportMail(env, network, () => now)).toEqual({ processed: 0, disabled: true })
    expect(row().attempts).toBe(0)
    expect(network).not.toHaveBeenCalled()
  })
  it('accepts once, persists the provider ID, and never re-sends an accepted job', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => accept())
    await drainSupportMail(env, network, () => now)
    await drainSupportMail(env, network, () => now + 10_000)
    expect(network).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({ state: 'accepted', provider_id: provider, attempts: 1 })
    expect(JSON.stringify(row())).not.toContain('private content')
  })
  it('preserves the exact payload and key on retry, even if destination configuration changes', async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('timeout')).mockImplementation(async () => accept())
    await drainSupportMail(env, network, () => now)
    expect(row().state).toBe('pending')
    await drainSupportMail(env, network, () => now + 10_000)
    expect(network).toHaveBeenCalledTimes(1)
    env.OWNER_NOTIFICATION_EMAIL = 'changed@example.com'
    await drainSupportMail(env, network, () => now + 60_001)
    expect(network).toHaveBeenCalledTimes(2)
    expect(network.mock.calls[0]?.[1]?.body).toEqual(network.mock.calls[1]?.[1]?.body)
    expect(network.mock.calls[0]?.[1]?.headers).toEqual(network.mock.calls[1]?.[1]?.headers)
  })
  it('concurrent drains cannot claim the same active lease', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => accept())
    await Promise.all([drainSupportMail(env, network, () => now), drainSupportMail(env, network, () => now)])
    expect(network).toHaveBeenCalledTimes(1)
  })
  it('recovers expired leases without changing notification identity', async () => {
    sqlite.prepare("UPDATE support_email_outbox SET state = 'sending', lease_id = 'old', lease_until = ?, attempts = 1").run(now + 60_000)
    const network = vi.fn<typeof fetch>().mockImplementation(async () => accept())
    await drainSupportMail(env, network, () => now)
    expect(network).not.toHaveBeenCalled()
    await drainSupportMail(env, network, () => now + 60_001)
    expect(network).toHaveBeenCalledTimes(1)
    expect(row().attempts).toBe(2)
  })
  it.each(['age', 'attempts'])('requires review after retry budget exhaustion: %s', async reason => {
    if (reason === 'attempts') sqlite.exec('UPDATE support_email_outbox SET attempts = 8')
    const network = vi.fn<typeof fetch>()
    await drainSupportMail(env, network, () => reason === 'age' ? now + 23 * 3600_000 : now)
    expect(row().state).toBe('review')
    expect(network).not.toHaveBeenCalled()
  })
  it('report deletion cascades into its pending email job', async () => {
    sqlite.prepare('DELETE FROM feedback WHERE id = ?').run(id)
    const network = vi.fn<typeof fetch>()
    await drainSupportMail(env, network, () => now)
    expect(network).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM support_email_outbox').get()?.n).toBe(0)
  })
})
