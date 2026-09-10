import { EMAIL_RETRY_WINDOW_MS, newFeedbackNotification, sendWithResend, type ResendConfig } from './resend.js'

export interface SupportMailConfig extends ResendConfig {
  FEEDBACK_ENABLED?: string
  FEEDBACK_DB?: D1Database
  OWNER_NOTIFICATION_EMAIL?: string
}

type ClaimedJob = { id: string; kind: string; created_at: number; attempts: number; payload: string | null }
const MAX_ATTEMPTS = 8
const LEASE_MS = 60_000

/** Scheduled, bounded outbox drain. No public request can choose the recipient.
 * Persist payload before network I/O, then keep it immutable across deploys/retries.
 * A crash after provider acceptance is recovered with the same idempotency key.
 */
export async function drainSupportMail(env: SupportMailConfig, network: typeof fetch = fetch,
  clock: () => number = Date.now): Promise<{ processed: number; disabled: boolean }> {
  const db = env.FEEDBACK_DB
  if (!db || env.FEEDBACK_ENABLED !== 'true' || env.SUPPORT_EMAIL_ENABLED !== 'true' ||
    !env.RESEND_API_KEY?.trim() || !env.OWNER_NOTIFICATION_EMAIL) return { processed: 0, disabled: true }
  // Validate configured destination before leasing or changing any job.
  newFeedbackNotification(crypto.randomUUID(), env.OWNER_NOTIFICATION_EMAIL, clock())
  const cutoff = clock()
  await db.prepare(`UPDATE support_email_outbox SET state = 'review', reason = 'retry_window_or_limit',
    updated_at = ?, lease_id = NULL WHERE
    (state = 'pending' OR (state = 'sending' AND lease_until <= ?))
    AND (created_at <= ? OR attempts >= ?)`).bind(cutoff, cutoff, cutoff - EMAIL_RETRY_WINDOW_MS, MAX_ATTEMPTS).run()
  let processed = 0
  for (let slot = 0; slot < 5; slot++) {
    const now = clock()
    const lease = crypto.randomUUID()
    // One atomic write claims a job, including recovery of an abandoned lease.
    const job = await db.prepare(`UPDATE support_email_outbox SET state = 'sending', lease_id = ?,
      lease_until = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = (SELECT id FROM support_email_outbox WHERE
        ((state = 'pending' AND next_attempt_at <= ?) OR (state = 'sending' AND lease_until <= ?))
        AND attempts < ? AND created_at > ? ORDER BY created_at, id LIMIT 1)
      RETURNING id, kind, created_at, attempts, payload`)
      .bind(lease, now + LEASE_MS, now, now, now, MAX_ATTEMPTS, now - EMAIL_RETRY_WINDOW_MS).first<ClaimedJob>()
    if (!job) break
    let raw: unknown
    if (job.payload === null) {
      raw = job.kind === 'new_feedback'
        ? newFeedbackNotification(job.id, env.OWNER_NOTIFICATION_EMAIL, job.created_at)
        : null
      const saved = await db.prepare(`UPDATE support_email_outbox SET payload = ?
        WHERE id = ? AND lease_id = ? AND state = 'sending'`).bind(JSON.stringify(raw), job.id, lease).run()
      if (saved.meta.changes !== 1) continue
    } else {
      try { raw = JSON.parse(job.payload) } catch { raw = null }
    }
    // Recheck lease immediately before outbound I/O in case storage was unusually slow.
    const current = clock()
    const held = await db.prepare(`SELECT id FROM support_email_outbox
      WHERE id = ? AND lease_id = ? AND state = 'sending' AND lease_until > ?`)
      .bind(job.id, lease, current + 15_000).first()
    if (!held) continue
    const result = await sendWithResend(env, raw, network, current)
    const finished = clock()
    const state = result.state === 'accepted' ? 'accepted' : result.state === 'review' ? 'review' : 'pending'
    const reason = 'reason' in result ? result.reason : result.state
    const delay = result.state === 'retry'
      ? Math.max(result.retryAfterSeconds * 1000, Math.min(3600_000, 60_000 * 2 ** (job.attempts - 1))) : 60_000
    await db.prepare(`UPDATE support_email_outbox SET state = ?, provider_id = ?, reason = ?,
      next_attempt_at = ?, lease_id = NULL, lease_until = 0, updated_at = ?
      WHERE id = ? AND lease_id = ? AND state = 'sending'`)
      .bind(state, result.state === 'accepted' ? result.providerId : null, reason,
        finished + delay, finished, job.id, lease).run()
    processed++
    // Credential/quota/outage problems affect subsequent jobs too. Avoid a burst of failures.
    if (result.state !== 'accepted') break
  }
  return { processed, disabled: false }
}
