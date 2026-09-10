import { describe, expect, it, vi } from 'vitest'
import { EMAIL_RETRY_WINDOW_MS, newFeedbackNotification, sendWithResend } from '../worker/resend.js'

const now = 1_800_000_000_000
const config = { SUPPORT_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test-not-a-live-key' }
const job = newFeedbackNotification('7f6d9b26-ff67-4e20-a856-1387c60bfe12', 'owner@example.com', now)
const providerId = 'cc661b0a-923e-4c7d-bb09-86ee10ae6c77'
const accepted = () => Response.json({ id: providerId })

describe('Resend transactional boundary', () => {
  it.each([{}, { ...config, SUPPORT_EMAIL_ENABLED: 'false' }, { ...config, RESEND_API_KEY: '' }])('fails closed with missing configuration', async settings => {
    const network = vi.fn<typeof fetch>()
    expect(await sendWithResend(settings, job, network, now)).toEqual({ state: 'disabled' })
    expect(network).not.toHaveBeenCalled()
  })
  it('uses the exact sender, fixed HTTPS endpoint and stable idempotency key', async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => accepted())
    expect(await sendWithResend(config, job, network, now)).toEqual({ state: 'accepted', providerId })
    await sendWithResend(config, job, network, now + 60_000)
    const [url, options] = network.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(options?.redirect).toBe('error')
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.headers).toMatchObject({ 'Idempotency-Key': `longleash/support/${job.id}` })
    expect(network.mock.calls[1]?.[1]?.headers).toEqual(options?.headers)
    expect(network.mock.calls[1]?.[1]?.body).toEqual(options?.body)
    expect(JSON.parse(String(options?.body))).toMatchObject({ from: 'LongLeash <support@longleash.dev>', to: ['owner@example.com'], reply_to: 'support@longleash.dev' })
  })
  it('never labels provider acceptance as delivery', async () => {
    expect(JSON.stringify(await sendWithResend(config, job, async () => accepted(), now))).not.toContain('delivered')
  })
  it.each([{ ...job, to: 'bad\r\nBcc: victim@example.com' }, { ...job, from: 'evil@example.com' },
    { ...job, subject: 'subject\r\nBcc: victim@example.com' }, { ...job, text: 'a'.repeat(8001) }, { ...job, createdAt: now + 1 }])('rejects invalid jobs before sending', async invalid => {
    const network = vi.fn<typeof fetch>()
    expect(await sendWithResend(config, invalid, network, now)).toEqual({ state: 'review', reason: 'invalid_job' })
    expect(network).not.toHaveBeenCalled()
  })
  it('stops automatic retries before provider deduplication expires', async () => {
    const network = vi.fn<typeof fetch>()
    expect(await sendWithResend(config, job, network, now + EMAIL_RETRY_WINDOW_MS)).toEqual({ state: 'review', reason: 'retry_window_expired' })
    expect(network).not.toHaveBeenCalled()
  })
  it.each([401, 403, 422])('does not retry permanent rejection %s or leak its response', async status => {
    const result = await sendWithResend(config, job, async () => new Response('private provider details', { status }), now)
    expect(result).toEqual({ state: 'review', reason: 'provider_rejected' })
  })
  it('handles temporary server failure without claiming rejection', async () => {
    expect(await sendWithResend(config, job, async () => new Response('', { status: 503 }), now))
      .toEqual({ state: 'retry', reason: 'provider_unavailable', retryAfterSeconds: 60 })
  })
  it.each([['120', 120], ['9999999', 3600], ['invalid', 60], ['0', 1], [new Date(now + 90_000).toUTCString(), 90]])('bounds Retry-After %s', async (value, seconds) => {
    expect(await sendWithResend(config, job, async () => new Response('', { status: 429, headers: { 'Retry-After': String(value) } }), now))
      .toEqual({ state: 'retry', reason: 'rate_limited', retryAfterSeconds: seconds })
  })
  it('handles concurrent duplicate requests separately from conflicting payloads', async () => {
    expect(await sendWithResend(config, job, async () => Response.json({ name: 'concurrent_idempotent_requests' }, { status: 409 }), now))
      .toMatchObject({ state: 'retry', reason: 'uncertain' })
    expect(await sendWithResend(config, job, async () => Response.json({ name: 'invalid_idempotent_request' }, { status: 409 }), now))
      .toEqual({ state: 'review', reason: 'idempotency_conflict' })
  })
  it.each([async () => { throw new Error('private network error') }, async () => new Response('not json'),
    async () => Response.json({ id: 'not-an-id' }), async () => new Response('a'.repeat(9000))])('treats uncertain acceptance conservatively', async network => {
    expect(await sendWithResend(config, job, network, now)).toEqual({ state: 'retry', reason: 'uncertain', retryAfterSeconds: 60 })
  })
  it('owner notification carries no report, customer or private-access-link fields', () => {
    expect(Object.keys(job).sort()).toEqual(['createdAt', 'html', 'id', 'subject', 'text', 'to'])
    expect(job.html).not.toContain(job.to)
    expect(job.text).not.toContain(job.id)
    expect(job.html).toContain('https://app.longleash.dev/owner/feedback')
  })
})
