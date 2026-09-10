import { z } from 'zod'
import { authenticateOwner, type OwnerAuthConfig } from './owner-auth.js'
import { accountTotals, accountWindowTotals, type AccountDirectory, type OwnerAccountsEnv } from './owner-accounts.js'
import { feedbackJson, type FeedbackEnv } from './feedback.js'
import { measurementSummary, type MeasurementEnv } from './measurement.js'
import { deliveryTestNotification, weeklyDigestEmail } from './resend.js'
import type { SupportMailConfig } from './support-mail.js'

export interface ReportingEnv extends OwnerAuthConfig, OwnerAccountsEnv, FeedbackEnv, MeasurementEnv, SupportMailConfig {
  REPORTING_ENABLED?: string
}

const DAY_MS = 86_400_000
const UUID = z.string().uuid()

async function feedbackCounts(db: D1Database, now: number) {
  const rows = await db.prepare(`SELECT status, COUNT(*) AS count FROM feedback
    WHERE expires_at IS NULL OR expires_at > ? GROUP BY status`).bind(now).all()
  const byStatus = { received: 0, needs_information: 0, planned: 0, resolved: 0, not_planned: 0 }
  for (const row of rows.results as { status: keyof typeof byStatus; count: number }[]) byStatus[row.status] = Number(row.count)
  const unanswered = await db.prepare(`SELECT COUNT(*) AS count FROM feedback f WHERE
    (f.expires_at IS NULL OR f.expires_at > ?) AND NOT EXISTS
    (SELECT 1 FROM feedback_messages m WHERE m.feedback_id = f.id AND m.author = 'owner')`)
    .bind(now).first<{ count?: number }>()
  return { byStatus, open: byStatus.received + byStatus.needs_information + byStatus.planned,
    unanswered: Number(unanswered?.count ?? 0) }
}

async function outboxCounts(db: D1Database) {
  const rows = await db.prepare('SELECT state, delivery_state, COUNT(*) AS count FROM support_email_outbox GROUP BY state, delivery_state').all()
  return rows.results.map(row => ({ state: String(row.state), deliveryState: String(row.delivery_state), count: Number(row.count) }))
}

export async function ownerSummary(env: ReportingEnv, now = Date.now(), source?: AccountDirectory) {
  if (!env.FEEDBACK_DB) throw new Error('storage unavailable')
  const [accounts, measurement, feedback, email] = await Promise.all([
    accountTotals(env, source, now), measurementSummary(env, now), feedbackCounts(env.FEEDBACK_DB, now),
    outboxCounts(env.FEEDBACK_DB),
  ])
  return { generatedAt: now, accounts, measurement, feedback, email,
    definitions: { accounts: 'Clerk production', productUse: 'Consenting hosted accounts only',
      delivery: 'Delivered only after a verified Resend webhook' } }
}

function configured(env: ReportingEnv): env is ReportingEnv & { FEEDBACK_DB: D1Database } {
  return env.REPORTING_ENABLED === 'true' && env.FEEDBACK_ENABLED === 'true' && Boolean(env.FEEDBACK_DB)
}

function emailConfigured(env: ReportingEnv): env is ReportingEnv & { FEEDBACK_DB: D1Database; OWNER_NOTIFICATION_EMAIL: string } {
  return configured(env) && env.SUPPORT_EMAIL_ENABLED === 'true' && Boolean(env.RESEND_API_KEY?.trim()) &&
    Boolean(env.OWNER_NOTIFICATION_EMAIL)
}

export async function handleOwnerReporting(request: Request, env: ReportingEnv,
  authenticate = authenticateOwner, now = Date.now()): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || url.hostname !== env.PUBLIC_APP_HOST ||
    !['/api/owner/summary', '/api/owner/email-test'].includes(url.pathname)) return feedbackJson({ error: 'Not found' }, 404)
  if (!configured(env)) return feedbackJson({ error: 'Owner reporting is unavailable.' }, 503)
  const ownerId = await authenticate(request, env)
  if (!ownerId || !env.ACCOUNT_API_RATE) return feedbackJson({ error: 'Forbidden' }, 403)
  if (!(await env.ACCOUNT_API_RATE.limit({ key: `owner-reporting:${ownerId}` })).success) {
    const response = feedbackJson({ error: 'Too many requests. Wait one minute.' }, 429)
    response.headers.set('Retry-After', '60'); return response
  }
  try {
    if (url.pathname === '/api/owner/summary' && request.method === 'GET') {
      return feedbackJson(await ownerSummary(env, now))
    }
    if (url.pathname === '/api/owner/email-test' && request.method === 'POST') {
      if (!emailConfigured(env)) return feedbackJson({ error: 'Support email is not fully configured.' }, 503)
      if (request.headers.get('Origin') !== url.origin) return feedbackJson({ error: 'Forbidden' }, 403)
      const id = crypto.randomUUID()
      const payload = deliveryTestNotification(id, env.OWNER_NOTIFICATION_EMAIL, now)
      const result = await env.FEEDBACK_DB.prepare(`INSERT INTO support_email_outbox
        (id, kind, dedupe_key, created_at, payload, next_attempt_at, updated_at)
        VALUES (?, 'email_test', ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`)
        .bind(id, `email-test:${ownerId}:${Math.floor(now / 3_600_000)}`, now, JSON.stringify(payload), now, now).run()
      return feedbackJson({ queued: result.meta.changes === 1,
        detail: result.meta.changes === 1 ? 'Queued for the support outbox.' : 'A test is already queued for this hour.' }, 202)
    }
    return feedbackJson({ error: 'Method not allowed' }, 405)
  } catch {
    return feedbackJson({ error: 'Owner reporting is temporarily unavailable. No stale values were substituted.' }, 503)
  }
}

function previousUtcWeek(now: number) {
  const date = new Date(now)
  date.setUTCHours(0, 0, 0, 0)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  const end = date.getTime() - daysSinceMonday * DAY_MS
  return { start: end - 7 * DAY_MS, end, key: new Date(end - 7 * DAY_MS).toISOString().slice(0, 10) }
}

export function isNewYorkMondayMorning(now: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit',
    hourCycle: 'h23' }).formatToParts(now)
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return value.weekday === 'Mon' && value.hour === '09'
}

export async function scheduleWeeklyDigest(env: ReportingEnv, now = Date.now(), source?: AccountDirectory): Promise<{ queued: boolean; skipped: boolean }> {
  if (!emailConfigured(env) || !isNewYorkMondayMorning(now)) return { queued: false, skipped: true }
  const window = previousUtcWeek(now)
  const [accounts, measurement, feedback] = await Promise.all([
    accountWindowTotals(env, window.start, window.end, source), measurementSummary(env, window.end), feedbackCounts(env.FEEDBACK_DB, now),
  ])
  const label = `${new Date(window.start).toISOString().slice(0, 10)} through ${new Date(window.end - 1).toISOString().slice(0, 10)} UTC`
  const retention = (value: { eligible: number; retained: number } | null) => value === null
    ? 'No eligible cohort' : `${value.retained}/${value.eligible}`
  const text = [
    'LongLeash weekly owner summary', `Window: ${label}`, `Generated: ${new Date(now).toISOString()}`,
    '', 'Accounts (Clerk production)', `Registered: ${accounts.registered}`, `External: ${accounts.external}`,
    `New external in window: ${accounts.newExternal}`, `External account-active in window: ${accounts.activeExternal}`,
    `All new including owner/test: ${accounts.newAccounts}`, `All account-active including owner/test: ${accounts.activeAccounts}`,
    '', 'Observed product use (opt-in hosted accounts only)',
    measurement.state === 'not_measured' ? 'Not measured' : `Consented: ${measurement.consentedAccounts}\nPaired: ${measurement.pairedAccounts}\nActivated: ${measurement.activatedAccounts}\nRepeat: ${measurement.repeatAccounts}\nD7: ${retention(measurement.retention.d7)}\nD30: ${retention(measurement.retention.d30)}`,
    '', 'Private feedback', `Open: ${feedback.open}`, `Unanswered: ${feedback.unanswered}`,
    '', 'This email contains aggregate counts only. It contains no customer list, support text, code, prompts, paths, transcripts, or pairing data.',
  ].join('\n')
  const id = crypto.randomUUID()
  UUID.parse(id)
  const payload = weeklyDigestEmail(id, env.OWNER_NOTIFICATION_EMAIL, now, text)
  const result = await env.FEEDBACK_DB.prepare(`INSERT INTO support_email_outbox
    (id, kind, dedupe_key, created_at, payload, next_attempt_at, updated_at)
    VALUES (?, 'weekly_digest', ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`)
    .bind(id, `weekly:${window.key}`, now, JSON.stringify(payload), now, now).run()
  return { queued: result.meta.changes === 1, skipped: false }
}
