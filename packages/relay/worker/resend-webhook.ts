import { Webhook } from 'svix'
import { z } from 'zod'
import { feedbackJson } from './feedback.js'

export interface ResendWebhookEnv {
  FEEDBACK_DB?: D1Database
  RESEND_WEBHOOK_SECRET?: string
  PUBLIC_APP_HOST?: string
}

const event = z.object({
  type: z.enum(['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.failed',
    'email.bounced', 'email.complained', 'email.suppressed']),
  created_at: z.string().datetime({ offset: true }),
  data: z.object({ email_id: z.string().uuid() }).passthrough(),
}).passthrough()
const MAX_WEBHOOK_BYTES = 32_000

async function boundedRaw(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('missing body')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let raw = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_WEBHOOK_BYTES) { await reader.cancel(); throw new Error('body too large') }
      raw += decoder.decode(value, { stream: true })
    }
    return raw + decoder.decode()
  } finally { reader.releaseLock() }
}

const deliveryState = {
  'email.sent': 'sent', 'email.delivered': 'delivered', 'email.delivery_delayed': 'delayed',
  'email.failed': 'failed', 'email.bounced': 'bounced', 'email.complained': 'complained',
  'email.suppressed': 'suppressed',
} as const

/** Signed, replay-safe delivery evidence. Recipient, subject and provider payload are never stored. */
export async function handleResendWebhook(request: Request, env: ResendWebhookEnv,
  now = Date.now()): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || url.hostname !== env.PUBLIC_APP_HOST || url.pathname !== '/api/resend/webhook') {
    return feedbackJson({ error: 'Not found' }, 404)
  }
  if (request.method !== 'POST') return feedbackJson({ error: 'Method not allowed' }, 405)
  const secret = env.RESEND_WEBHOOK_SECRET?.trim()
  const id = request.headers.get('svix-id')
  const timestamp = request.headers.get('svix-timestamp')
  const signature = request.headers.get('svix-signature')
  if (!env.FEEDBACK_DB || !secret || !id || !timestamp || !signature || !/^[A-Za-z0-9_-]{8,200}$/.test(id)) {
    return feedbackJson({ error: 'Webhook unavailable' }, 503)
  }
  try {
    const raw = await boundedRaw(request)
    new Webhook(secret).verify(raw, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature })
    const parsed = event.safeParse(JSON.parse(raw))
    if (!parsed.success) return feedbackJson({ received: true, ignored: true })
    const providerId = parsed.data.data.email_id
    const known = await env.FEEDBACK_DB.prepare('SELECT id FROM support_email_outbox WHERE provider_id = ?')
      .bind(providerId).first()
    if (!known) return feedbackJson({ received: true, ignored: true })
    const createdAt = Date.parse(parsed.data.created_at)
    const inserted = await env.FEEDBACK_DB.prepare(`INSERT INTO support_email_webhook_events
      (id, provider_id, event_type, created_at, received_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).bind(id, providerId, parsed.data.type, createdAt, now).run()
    if (inserted.meta.changes === 0) return feedbackJson({ received: true, duplicate: true })
    const state = deliveryState[parsed.data.type]
    await env.FEEDBACK_DB.prepare(`UPDATE support_email_outbox SET
      delivery_state = CASE
        WHEN delivery_state IN ('failed','bounced','complained','suppressed') THEN delivery_state
        WHEN ? IN ('failed','bounced','complained','suppressed') THEN ?
        WHEN delivery_state = 'delivered' THEN delivery_state
        WHEN ? = 'delivered' THEN 'delivered'
        ELSE ? END,
      delivery_updated_at = MAX(COALESCE(delivery_updated_at, 0), ?), updated_at = MAX(updated_at, ?)
      WHERE provider_id = ?`).bind(state, state, state, state, createdAt, now, providerId).run()
    return feedbackJson({ received: true })
  } catch {
    return feedbackJson({ error: 'Invalid webhook' }, 400)
  }
}

export async function expireWebhookEvidence(env: ResendWebhookEnv, now = Date.now()): Promise<void> {
  if (env.FEEDBACK_DB) await env.FEEDBACK_DB.prepare('DELETE FROM support_email_webhook_events WHERE received_at < ?')
    .bind(now - 90 * 86_400_000).run()
}
