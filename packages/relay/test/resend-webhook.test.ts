import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Webhook } from 'svix'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleResendWebhook } from '../worker/resend-webhook.js'

describe('signed Resend delivery evidence', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  const secret = `whsec_${Buffer.from('a'.repeat(32)).toString('base64')}`
  const provider = '7f6d9b26-ff67-4e20-a856-1387c60bfe12'
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.exec(readFileSync(new URL('../migrations/0001_feedback.sql', import.meta.url), 'utf8'))
    sqlite.exec(readFileSync(new URL('../migrations/0002_email_outbox.sql', import.meta.url), 'utf8'))
    sqlite.prepare(`INSERT INTO support_email_outbox(id, kind, dedupe_key, created_at, next_attempt_at, updated_at, state, provider_id)
      VALUES (?, 'email_test', 'test', 1, 1, 1, 'accepted', ?)`).run('cc661b0a-923e-4c7d-bb09-86ee10ae6c77', provider)
    db = { prepare(sql: string) { const build = (values: (string | number | null)[] = []) => ({ bind: (...args: (string | number | null)[]) => build(args),
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }), first: async () => sqlite.prepare(sql).get(...values) ?? null })
      return build() } } as unknown as D1Database
  })
  afterEach(() => sqlite.close())
  const signed = (type = 'email.delivered', messageId = 'msg_test_123456') => {
    const created = new Date()
    const raw = JSON.stringify({ type, created_at: created.toISOString(), data: { email_id: provider, to: ['private@example.com'] } })
    return new Request('https://app.longleash.dev/api/resend/webhook', { method: 'POST', body: raw, headers: {
      'svix-id': messageId, 'svix-timestamp': String(Math.floor(created.getTime() / 1000)),
      'svix-signature': new Webhook(secret).sign(messageId, created, raw),
    } })
  }
  it('accepts a valid signature, stores no payload or recipient, and deduplicates replay', async () => {
    expect((await handleResendWebhook(signed(), { FEEDBACK_DB: db, PUBLIC_APP_HOST: 'app.longleash.dev', RESEND_WEBHOOK_SECRET: secret }, Date.now())).status).toBe(200)
    expect(sqlite.prepare('SELECT delivery_state FROM support_email_outbox').get()?.delivery_state).toBe('delivered')
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM support_email_webhook_events').all())).not.toContain('private@example.com')
    const replay = await handleResendWebhook(signed(), { FEEDBACK_DB: db, PUBLIC_APP_HOST: 'app.longleash.dev', RESEND_WEBHOOK_SECRET: secret }, Date.now())
    expect(await replay.json()).toMatchObject({ duplicate: true })
  })
  it('rejects forged signatures and ignores authenticated events for unknown provider IDs', async () => {
    const forged = signed(); forged.headers.set('svix-signature', 'v1,bad')
    expect((await handleResendWebhook(forged, { FEEDBACK_DB: db, PUBLIC_APP_HOST: 'app.longleash.dev', RESEND_WEBHOOK_SECRET: secret })).status).toBe(400)
  })
})
