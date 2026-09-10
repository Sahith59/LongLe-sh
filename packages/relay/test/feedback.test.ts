import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleFeedback, ownerAllowed, expireFeedback, type FeedbackEnv } from '../worker/feedback.js'

describe('private feedback authority and storage', () => {
  let sqlite: DatabaseSync
  let env: FeedbackEnv
  const now = 1_800_000_000_000
  const input = { id: 'cc661b0a-923e-4c7d-bb09-86ee10ae6c77', accessToken: 'a'.repeat(64), category: 'bug', subject: 'Reconnect', message: '<script>alert(1)</script>' }
  const auth = async () => 'user_owner'
  const request = (path = '/api/feedback', method = 'POST', body: unknown = input, headers = {}) => new Request(`https://longleash.dev${path}`, {
    method, headers: { Origin: 'https://longleash.dev', 'Content-Type': 'application/json', ...headers },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  })
  const call = (req = request()) => handleFeedback(req, env, auth, now)
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec(readFileSync(new URL('../migrations/0001_feedback.sql', import.meta.url), 'utf8'))
    env = { PUBLIC_SITE_HOST: 'longleash.dev', PUBLIC_APP_HOST: 'app.longleash.dev', FEEDBACK_ENABLED: 'true', OWNER_USER_IDS: 'user_owner',
      FEEDBACK_RATE: { limit: async () => ({ success: true }) },
      FEEDBACK_DB: { prepare(sql: string) {
        const build = (values: (string | number)[] = []) => ({
          bind: (...args: (string | number)[]) => build(args),
          run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
          first: async () => sqlite.prepare(sql).get(...values) ?? null,
          all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
        })
        return build()
      } } as unknown as D1Database,
    }
  })
  afterEach(() => sqlite.close())
  it('stores only a proof hash and returns no credential', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(JSON.stringify(json)).not.toContain('access_hash')
    expect(JSON.stringify(json)).not.toContain(input.accessToken)
    expect(sqlite.prepare('SELECT access_hash FROM feedback').get()?.access_hash).not.toBe(input.accessToken)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('deduplicates retries without allowing changed content or a different proof', async () => {
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get()?.n).toBe(1)
    expect((await call(request(undefined, 'POST', { ...input, subject: 'Changed' }))).status).toBe(409)
    expect((await call(request(undefined, 'POST', { ...input, accessToken: 'b'.repeat(64) }))).status).toBe(409)
  })
  it('does not enumerate tickets without proof', async () => {
    await call()
    expect((await call(request(`/api/feedback/${input.id}`, 'GET'))).status).toBe(404)
    expect((await call(request(`/api/feedback/${input.id}`, 'GET', null, { Authorization: `Bearer ${'b'.repeat(64)}` }))).status).toBe(404)
    expect((await call(request(`/api/feedback/${input.id}`, 'GET', null, { Authorization: `Bearer ${input.accessToken}` }))).status).toBe(200)
  })
  it('requires same-origin mutations', async () => {
    expect((await call(request(undefined, 'POST', input, { Origin: 'https://evil.example' }))).status).toBe(403)
  })
  it.each([{ ...input, email: 'person@example.com' }, { ...input, subject: '' }, { ...input, message: 'a'.repeat(4001) }, { ...input, category: 'admin' }])('rejects unexpected or invalid fields', async body => {
    expect((await call(request(undefined, 'POST', body))).status).toBe(400)
  })
  it('bounds a body even without a Content-Length header', async () => {
    expect((await call(request(undefined, 'POST', { ...input, message: 'a'.repeat(30_000) }))).status).toBe(400)
  })
  it('fails closed when disabled, storage missing, or rate limiting absent', async () => {
    env.FEEDBACK_ENABLED = 'false'; expect((await call()).status).toBe(503)
    env.FEEDBACK_ENABLED = 'true'; delete env.FEEDBACK_RATE; expect((await call()).status).toBe(503)
  })
  it('limits abuse', async () => {
    env.FEEDBACK_RATE = { limit: async () => ({ success: false }) }
    const response = await call()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
  })
  it('requires server-configured owner identity on the app origin', async () => {
    expect(ownerAllowed('user_attacker', '')).toBe(false)
    expect(ownerAllowed(null, 'user_owner')).toBe(false)
    expect((await call(request('/api/owner/feedback', 'GET', null, { Authorization: 'Bearer signed' }))).status).toBe(403)
    const req = new Request('https://app.longleash.dev/api/owner/feedback', { headers: { Authorization: 'Bearer signed' } })
    expect((await handleFeedback(req, env, async () => 'user_attacker', now)).status).toBe(403)
    expect((await handleFeedback(req, env, auth, now)).status).toBe(200)
    delete env.OWNER_USER_IDS
    expect((await handleFeedback(req, env, auth, now)).status).toBe(403)
  })
  it('uses revision checks so two owner tabs cannot silently overwrite replies', async () => {
    await call()
    const req = () => new Request(`https://app.longleash.dev/api/owner/feedback/${input.id}`, { method: 'PATCH', headers: {
      Origin: 'https://app.longleash.dev', Authorization: 'Bearer signed', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ reply: 'Investigating', status: 'received', revision: 0 }) })
    expect((await handleFeedback(req(), env, auth, now)).status).toBe(200)
    expect((await handleFeedback(req(), env, auth, now)).status).toBe(409)
  })
  it('expires access and removes retained content', async () => {
    await call()
    const later = now + 91 * 86_400_000
    expect((await handleFeedback(request(`/api/feedback/${input.id}`, 'GET', null, { Authorization: `Bearer ${input.accessToken}` }), env, auth, later)).status).toBe(404)
    await expireFeedback(env, later)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get()?.n).toBe(0)
  })
  it('allows deletion only with the ticket proof', async () => {
    await call()
    await call(request(`/api/feedback/${input.id}`, 'DELETE', null, { Authorization: `Bearer ${'b'.repeat(64)}` }))
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get()?.n).toBe(1)
    await call(request(`/api/feedback/${input.id}`, 'DELETE', null, { Authorization: `Bearer ${input.accessToken}` }))
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM feedback').get()?.n).toBe(0)
  })
})
