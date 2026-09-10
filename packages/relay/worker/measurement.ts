import { z } from 'zod'
import { authenticateAccount, type HostedAuthEnv } from './auth.js'
import { feedbackJson } from './feedback.js'

export interface MeasurementEnv extends HostedAuthEnv {
  MEASUREMENT_ENABLED?: string
  FEEDBACK_DB?: D1Database
  MEASUREMENT_RATE?: { limit(input: { key: string }): Promise<{ success: boolean }> }
  MEASUREMENT_SECRET?: string
}

const eventInput = z.object({
  id: z.string().uuid(),
  type: z.enum(['paired', 'approval', 'reply', 'stop', 'handoff', 'tuning', 'delegation']),
  outcome: z.enum(['success', 'failure', 'unknown']),
  occurredAt: z.number().int(),
  build: z.string().trim().regex(/^[A-Za-z0-9._-]{1,80}$/),
}).strict()
const consentInput = z.object({ enabled: z.boolean() }).strict()
const MAX_BODY_BYTES = 2_048
const DAY_MS = 86_400_000

async function boundedJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('invalid')
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('invalid')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('invalid')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('invalid') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

async function accountKey(secret: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`measurement\0${userId}`)))
  return Array.from(signature.slice(0, 18)).map(value => value.toString(16).padStart(2, '0')).join('')
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function ready(env: MeasurementEnv): env is MeasurementEnv & {
  FEEDBACK_DB: D1Database; MEASUREMENT_RATE: NonNullable<MeasurementEnv['MEASUREMENT_RATE']>; MEASUREMENT_SECRET: string
} {
  return env.MEASUREMENT_ENABLED === 'true' && Boolean(env.FEEDBACK_DB) && Boolean(env.MEASUREMENT_RATE) &&
    (env.MEASUREMENT_SECRET?.trim().length ?? 0) >= 32
}

/** Authenticated and opt-in only. No user, device, room, path, prompt or transcript identifier is accepted. */
export async function handleMeasurement(request: Request, env: MeasurementEnv,
  authenticate = authenticateAccount, now = Date.now()): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || url.hostname !== env.PUBLIC_APP_HOST ||
    !['/api/measurement/consent', '/api/measurement/events'].includes(url.pathname)) {
    return feedbackJson({ error: 'Not found' }, 404)
  }
  if (!ready(env)) return feedbackJson({ error: 'Measurement is unavailable.' }, 503)
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return feedbackJson({ error: 'Forbidden' }, 403)
  const userId = await authenticate(request, env)
  if (!userId) return feedbackJson({ error: 'Unauthorized' }, 401)
  if (!(await env.MEASUREMENT_RATE.limit({ key: `measurement:${userId}` })).success) {
    const response = feedbackJson({ error: 'Too many requests. Wait one minute.' }, 429)
    response.headers.set('Retry-After', '60')
    return response
  }
  const key = await accountKey(env.MEASUREMENT_SECRET, userId)
  const db = env.FEEDBACK_DB
  try {
    if (url.pathname === '/api/measurement/consent' && request.method === 'GET') {
      const row = await db.prepare('SELECT enabled, granted_at, updated_at FROM measurement_consent WHERE account_key = ?')
        .bind(key).first<Record<string, unknown>>()
      return feedbackJson({ enabled: row?.enabled === 1, grantedAt: row?.granted_at ?? null, updatedAt: row?.updated_at ?? null })
    }
    if (url.pathname === '/api/measurement/consent' && request.method === 'PUT') {
      let input: z.infer<typeof consentInput>
      try { input = consentInput.parse(await boundedJson(request)) }
      catch { return feedbackJson({ error: 'Invalid consent choice.' }, 400) }
      if (input.enabled) {
        await db.prepare(`INSERT INTO measurement_consent(account_key, enabled, granted_at, updated_at)
          VALUES (?, 1, ?, ?) ON CONFLICT(account_key) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`)
          .bind(key, now, now).run()
      } else {
        await db.batch([
          db.prepare('DELETE FROM measurement_events WHERE account_key = ?').bind(key),
          db.prepare('DELETE FROM measurement_daily_actions WHERE account_key = ?').bind(key),
          db.prepare('DELETE FROM measurement_daily WHERE account_key = ?').bind(key),
          db.prepare('DELETE FROM measurement_consent WHERE account_key = ?').bind(key),
        ])
      }
      return feedbackJson({ enabled: input.enabled, deleted: !input.enabled })
    }
    if (url.pathname === '/api/measurement/events' && request.method === 'POST') {
      let input: z.infer<typeof eventInput>
      try { input = eventInput.parse(await boundedJson(request)) }
      catch { return feedbackJson({ error: 'Invalid measurement event.' }, 400) }
      if (input.occurredAt < now - 48 * 60 * 60_000 || input.occurredAt > now + 5 * 60_000) {
        return feedbackJson({ error: 'Event time is outside the accepted window.' }, 400)
      }
      const consent = await db.prepare('SELECT enabled FROM measurement_consent WHERE account_key = ?')
        .bind(key).first<Record<string, unknown>>()
      if (consent?.enabled !== 1) return feedbackJson({ error: 'Measurement consent is required.' }, 403)
      const inserted = await db.prepare(`INSERT INTO measurement_events(id, account_key, event_type, outcome, occurred_at, received_at, build)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
        .bind(input.id, key, input.type, input.outcome, input.occurredAt, now, input.build).run()
      return feedbackJson({ accepted: true, duplicate: inserted.meta.changes === 0 }, 202)
    }
    return feedbackJson({ error: 'Method not allowed' }, 405)
  } catch {
    return feedbackJson({ error: 'Measurement could not be recorded. Product control is unaffected.' }, 503)
  }
}

type CountRow = { count?: number | string | null }
async function count(db: D1Database, sql: string, ...binds: (string | number)[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<CountRow>()
  return Number(row?.count ?? 0)
}

export interface MeasurementSummary {
  state: 'not_measured' | 'measured'
  consentedAccounts: number
  pairedAccounts: number | null
  activatedAccounts: number | null
  weeklyActiveAccounts: number | null
  repeatAccounts: number | null
  outcomes: { success: number; failure: number; unknown: number } | null
  actions: Record<string, { success: number; failure: number; unknown: number }> | null
  retention: { d7: { eligible: number; retained: number } | null; d30: { eligible: number; retained: number } | null }
  window: { start: string; endExclusive: string }
}

export async function measurementSummary(env: MeasurementEnv, now = Date.now()): Promise<MeasurementSummary> {
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end.getTime() - 7 * DAY_MS)
  const empty = { state: 'not_measured' as const, consentedAccounts: 0, pairedAccounts: null,
    activatedAccounts: null, weeklyActiveAccounts: null, repeatAccounts: null, outcomes: null, actions: null,
    retention: { d7: null, d30: null }, window: { start: utcDay(start.getTime()), endExclusive: utcDay(end.getTime()) } }
  if (!ready(env)) return empty
  const db = env.FEEDBACK_DB
  const consented = await count(db, 'SELECT COUNT(*) AS count FROM measurement_consent WHERE enabled = 1')
  if (consented === 0) return empty
  const [paired, activated, weekly, repeat, outcomeRows] = await Promise.all([
    count(db, 'SELECT COUNT(DISTINCT account_key) AS count FROM measurement_daily WHERE paired = 1'),
    count(db, 'SELECT COUNT(DISTINCT account_key) AS count FROM measurement_daily WHERE successful_actions > 0'),
    count(db, `SELECT COUNT(DISTINCT account_key) AS count FROM measurement_daily
      WHERE activity_day >= ? AND activity_day < ? AND successful_actions > 0`, utcDay(start.getTime()), utcDay(end.getTime())),
    count(db, `SELECT COUNT(*) AS count FROM (SELECT account_key FROM measurement_daily
      WHERE successful_actions > 0 GROUP BY account_key HAVING COUNT(DISTINCT activity_day) >= 2)`),
    db.prepare(`SELECT event_type, outcome, SUM(event_count) AS count FROM measurement_daily_actions
      WHERE activity_day >= ? AND activity_day < ? GROUP BY event_type, outcome`).bind(utcDay(start.getTime()), utcDay(end.getTime())).all(),
  ])
  const outcomes = { success: 0, failure: 0, unknown: 0 }
  const actions: Record<string, { success: number; failure: number; unknown: number }> = {}
  for (const row of outcomeRows.results as { event_type: string; outcome: keyof typeof outcomes; count: number }[]) {
    outcomes[row.outcome] += Number(row.count)
    actions[row.event_type] ??= { success: 0, failure: 0, unknown: 0 }
    actions[row.event_type]![row.outcome] = Number(row.count)
  }
  const retentionFor = async (days: number) => {
    const eligibility = utcDay(end.getTime() - days * DAY_MS)
    const row = await db.prepare(`WITH firsts AS (
      SELECT account_key, MIN(activity_day) AS first_day FROM measurement_daily
      WHERE successful_actions > 0 GROUP BY account_key
    ) SELECT COUNT(*) AS eligible,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM measurement_daily d WHERE d.account_key = firsts.account_key
        AND d.activity_day = date(firsts.first_day, '+' || ? || ' days') AND d.successful_actions > 0) THEN 1 ELSE 0 END) AS retained
      FROM firsts WHERE first_day <= ?`).bind(days, eligibility).first<{ eligible?: number; retained?: number }>()
    return Number(row?.eligible ?? 0) === 0 ? null : { eligible: Number(row?.eligible), retained: Number(row?.retained ?? 0) }
  }
  return { state: 'measured', consentedAccounts: consented, pairedAccounts: paired, activatedAccounts: activated,
    weeklyActiveAccounts: weekly, repeatAccounts: repeat, outcomes, actions,
    retention: { d7: await retentionFor(7), d30: await retentionFor(30) },
    window: { start: utcDay(start.getTime()), endExclusive: utcDay(end.getTime()) } }
}

export async function expireMeasurement(env: MeasurementEnv, now = Date.now()): Promise<void> {
  if (!env.FEEDBACK_DB) return
  const rawCutoff = now - 30 * DAY_MS
  const aggregateCutoff = utcDay(now - 90 * DAY_MS)
  await env.FEEDBACK_DB.batch([
    env.FEEDBACK_DB.prepare('DELETE FROM measurement_events WHERE received_at < ?').bind(rawCutoff),
    env.FEEDBACK_DB.prepare('DELETE FROM measurement_daily_actions WHERE activity_day < ?').bind(aggregateCutoff),
    env.FEEDBACK_DB.prepare('DELETE FROM measurement_daily WHERE activity_day < ?').bind(aggregateCutoff),
  ])
}
