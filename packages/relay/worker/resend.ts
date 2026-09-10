import { z } from 'zod'

/** Server-only configuration. A missing flag or key must never fall back to another sender. */
export interface ResendConfig {
  SUPPORT_EMAIL_ENABLED?: string
  RESEND_API_KEY?: string
}

const address = z.string().email().max(254).refine(value => !/[\r\n]/.test(value))
export const outgoingEmail = z.object({
  // Persist this ID and the exact payload before attempting the first delivery.
  id: z.string().uuid(),
  to: address,
  subject: z.string().min(1).max(160).refine(value => !/[\r\n]/.test(value)),
  text: z.string().min(1).max(8000),
  html: z.string().min(1).max(16000),
  createdAt: z.number().int().nonnegative(),
}).strict()
export type OutgoingEmail = z.infer<typeof outgoingEmail>
export type SendResult =
  | { state: 'accepted'; providerId: string }
  | { state: 'disabled' }
  | { state: 'retry'; reason: 'rate_limited' | 'provider_unavailable' | 'uncertain'; retryAfterSeconds: number }
  | { state: 'review'; reason: 'retry_window_expired' | 'invalid_job' | 'provider_rejected' | 'idempotency_conflict' }

const API = 'https://api.resend.com/emails'
// Shorter than Resend's 24h deduplication window. The outbox must NOT reset createdAt on retry.
export const EMAIL_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000

async function boundedResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty response')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let result = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) { await reader.cancel(); throw new Error('response too large') }
      result += decoder.decode(value, { stream: true })
    }
    return JSON.parse(result + decoder.decode())
  } finally { reader.releaseLock() }
}

function retryAfter(value: string | null, now: number): number {
  if (!value) return 60
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000
  return Number.isFinite(seconds) ? Math.max(1, Math.min(3600, Math.ceil(seconds))) : 60
}

/** One attempt, never a sleep/retry loop in a web request. Caller persists all outcomes.
 * 'accepted' means Resend accepted the request, NOT inbox delivery. Only a verified provider
 * delivery event can establish that. Raw provider errors are never returned or logged.
 * This is an internal adapter, not a public arbitrary-recipient sending endpoint.
 */
export async function sendWithResend(config: ResendConfig, raw: unknown,
  fetcher: typeof fetch = fetch, now = Date.now()): Promise<SendResult> {
  if (config.SUPPORT_EMAIL_ENABLED !== 'true' || !config.RESEND_API_KEY?.trim()) return { state: 'disabled' }
  const parsed = outgoingEmail.safeParse(raw)
  if (!parsed.success || parsed.data.createdAt > now) return { state: 'review', reason: 'invalid_job' }
  const job = parsed.data
  if (now - job.createdAt >= EMAIL_RETRY_WINDOW_MS) return { state: 'review', reason: 'retry_window_expired' }
  try {
    const response = await fetcher(API, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY.trim()}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `longleash/support/${job.id}`,
      },
      body: JSON.stringify({
        from: 'LongLeash <support@longleash.dev>', to: [job.to], reply_to: 'support@longleash.dev',
        subject: job.subject, text: job.text, html: job.html,
      }),
    })
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel()
      return { state: 'retry', reason: response.status === 429 ? 'rate_limited' : 'provider_unavailable',
        retryAfterSeconds: retryAfter(response.headers.get('Retry-After'), now) }
    }
    if (response.status === 409) {
      const body = z.object({ name: z.string() }).safeParse(await boundedResponse(response))
      // A simultaneous request is retryable; changed payload for the same key is not.
      if (body.success && body.data.name === 'concurrent_idempotent_requests') {
        return { state: 'retry', reason: 'uncertain', retryAfterSeconds: 60 }
      }
      return { state: 'review', reason: 'idempotency_conflict' }
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { state: 'review', reason: 'provider_rejected' }
    }
    const body = z.object({ id: z.string().uuid() }).safeParse(await boundedResponse(response))
    return body.success ? { state: 'accepted', providerId: body.data.id }
      : { state: 'retry', reason: 'uncertain', retryAfterSeconds: 60 }
  } catch {
    // Network/timeout/invalid response may follow successful acceptance. Preserve the same key.
    return { state: 'retry', reason: 'uncertain', retryAfterSeconds: 60 }
  }
}

/** Owner notification deliberately includes neither report text nor customer identity. */
export function newFeedbackNotification(id: string, destination: string, createdAt: number): OutgoingEmail {
  return outgoingEmail.parse({ id, to: destination, createdAt,
    subject: 'New private feedback in LongLeash',
    text: 'A private report is waiting in your LongLeash owner inbox. Sign in at https://app.longleash.dev/owner/feedback to review it. This notification contains no report content.',
    html: '<p>A private report is waiting in your LongLeash owner inbox.</p><p><a href="https://app.longleash.dev/owner/feedback">Sign in to review feedback</a></p><p>This notification contains no report content.</p>',
  })
}

export function deliveryTestNotification(id: string, destination: string, createdAt: number): OutgoingEmail {
  return outgoingEmail.parse({ id, to: destination, createdAt,
    subject: 'LongLeash email delivery check',
    text: 'This controlled message confirms that the LongLeash support outbox can reach your verified owner inbox. No customer data is included.',
    html: '<p>This controlled message confirms that the LongLeash support outbox can reach your verified owner inbox.</p><p>No customer data is included.</p>',
  })
}

export function weeklyDigestEmail(id: string, destination: string, createdAt: number, text: string): OutgoingEmail {
  const safe = text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
  return outgoingEmail.parse({ id, to: destination, createdAt, subject: 'LongLeash weekly owner summary', text,
    html: `<pre style="font:14px/1.55 ui-monospace,monospace;white-space:pre-wrap">${safe}</pre>`, })
}
