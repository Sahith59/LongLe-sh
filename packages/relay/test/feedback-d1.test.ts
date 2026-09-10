import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { handleFeedback, expireFeedback, type FeedbackEnv } from '../worker/feedback.js'
import { drainSupportMail } from '../worker/support-mail.js'

describe('feedback migrations and outbox against local workerd D1', () => {
  let runtime: Miniflare
  let db: D1Database
  let env: FeedbackEnv
  const now = 1_800_000_000_000
  const input = { id: 'cc661b0a-923e-4c7d-bb09-86ee10ae6c77', accessToken: 'a'.repeat(64), category: 'bug', subject: 'Test only', message: 'Synthetic report, no customer data.' }
  const submit = () => handleFeedback(new Request('https://longleash.dev/api/feedback', {
    method: 'POST', headers: { Origin: 'https://longleash.dev', 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }), env, async () => null, now)
  beforeAll(async () => {
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-08-14',
      script: 'export default { fetch() { return new Response("test only"); } };', d1Databases: ['DB'] }))
    db = await runtime.getD1Database('DB')
    for (const file of ['0001_feedback.sql', '0002_email_outbox.sql']) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
        .replace(/^--.*$/gm, '').replace(/\n/g, ' ')
      await db.exec(sql)
    }
    env = { FEEDBACK_DB: db, FEEDBACK_ENABLED: 'true', PUBLIC_SITE_HOST: 'longleash.dev', PUBLIC_APP_HOST: 'app.longleash.dev',
      FEEDBACK_RATE: { limit: async () => ({ success: true }) } }
  }, 30_000)
  afterAll(async () => { await runtime?.dispose() })
  it('runs the full create, retry, concurrent notify, private read and expiry path', async () => {
    expect((await submit()).status).toBe(200)
    expect((await submit()).status).toBe(200)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM support_email_outbox').first('n')).toBe(1)
    const mailEnv = { ...env, SUPPORT_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test-no-live-key', OWNER_NOTIFICATION_EMAIL: 'owner@example.com' }
    const network = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: '7f6d9b26-ff67-4e20-a856-1387c60bfe12' }))
    await Promise.all([drainSupportMail(mailEnv, network, () => now), drainSupportMail(mailEnv, network, () => now)])
    expect(network).toHaveBeenCalledTimes(1)
    expect(await db.prepare('SELECT state FROM support_email_outbox').first('state')).toBe('accepted')
    const read = await handleFeedback(new Request(`https://longleash.dev/api/feedback/${input.id}`, { headers: { Authorization: `Bearer ${input.accessToken}` } }), env, async () => null, now)
    expect(read.status).toBe(200)
    await db.prepare("UPDATE feedback SET status = 'resolved', closed_at = ?, expires_at = ? WHERE id = ?")
      .bind(now, now + 90 * 86400_000, input.id).run()
    await expireFeedback(env, now + 91 * 86400_000)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM feedback').first('n')).toBe(0)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM support_email_outbox').first('n')).toBe(0)
  })
})
