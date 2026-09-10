import { z } from 'zod'
import { type HostedAuthEnv } from './auth.js'
import { authenticateOwner, ownerAllowed } from './owner-auth.js'
export { ownerAllowed } from './owner-auth.js'

export interface FeedbackEnv extends HostedAuthEnv {
  PUBLIC_SITE_HOST?: string
  FEEDBACK_ENABLED?: string
  FEEDBACK_DB?: D1Database
  FEEDBACK_RATE?: { limit(input: { key: string }): Promise<{ success: boolean }> }
  OWNER_USER_IDS?: string
}

const id = z.string().uuid()
const token = z.string().regex(/^[a-f0-9]{64}$/)
const text = (max: number) => z.string().trim().min(1).max(max)
export const feedbackInput = z.object({
  id,
  accessToken: token,
  category: z.enum(['bug', 'feature', 'help']),
  subject: text(120),
  message: text(4000),
}).strict()
const replyInput = z.object({
  messageId: id,
  reply: text(4000),
  revision: z.number().int().min(0),
  status: z.enum(['received', 'needs_information', 'planned', 'resolved', 'not_planned']),
}).strict()
const followUpInput = z.object({ id, accessToken: token, message: text(4000) }).strict()
const RETENTION_MS = 90 * 86_400_000
const MAX_BODY_BYTES = 24_000
const columns = 'id, category, subject, message, reply, status, created_at, updated_at, closed_at, expires_at, revision'

async function ticketWithMessages(db: D1Database, ticketId: string, proofHash: string | null,
  now: number): Promise<Record<string, unknown> | null> {
  const proof = proofHash === null ? '' : ' AND access_hash = ?'
  const binds: (string | number)[] = proofHash === null ? [ticketId, now] : [ticketId, proofHash, now]
  const ticket = await db.prepare(`SELECT ${columns} FROM feedback WHERE id = ?${proof}
    AND (expires_at IS NULL OR expires_at > ?)`).bind(...binds).first<Record<string, unknown>>()
  if (!ticket) return null
  const messages = await db.prepare(`SELECT id, author, body, status_snapshot, created_at
    FROM feedback_messages WHERE feedback_id = ? ORDER BY created_at, id`).bind(ticketId).all()
  return { ...ticket, messages: messages.results }
}

export function feedbackJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Vary': 'Authorization, Origin',
  } })
}

async function boundedJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('invalid')
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

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

/** No relay credentials, email addresses, or account identities enter guest feedback. */
export async function handleFeedback(request: Request, env: FeedbackEnv,
  authenticate = authenticateOwner, now = Date.now()): Promise<Response> {
  const url = new URL(request.url)
  if (!/^\/api\/(feedback(?:\/config)?|feedback\/[a-f0-9-]{36}(?:\/messages)?|owner\/feedback(?:\/[a-f0-9-]{36})?)$/.test(url.pathname)) {
    return feedbackJson({ error: 'Not found' }, 404)
  }
  const hosted = url.protocol === 'https:' && [env.PUBLIC_SITE_HOST, env.PUBLIC_APP_HOST].includes(url.hostname)
  if (!hosted || env.FEEDBACK_ENABLED !== 'true' || !env.FEEDBACK_DB || !env.FEEDBACK_RATE) {
    return feedbackJson({ error: 'Feedback is not available. Please email support@longleash.dev.' }, 503)
  }
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) {
    return feedbackJson({ error: 'Forbidden' }, 403)
  }
  const ownerRoute = url.pathname.startsWith('/api/owner/feedback')
  try {
    if (ownerRoute) {
      if (url.hostname !== env.PUBLIC_APP_HOST || !request.headers.get('Authorization')?.startsWith('Bearer ') ||
        !ownerAllowed(await authenticate(request, env), env.OWNER_USER_IDS)) {
        return feedbackJson({ error: 'Forbidden' }, 403)
      }
    }
    if (!(await env.FEEDBACK_RATE.limit({ key: `feedback:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` })).success) {
      const response = feedbackJson({ error: 'Too many requests. Please wait one minute.' }, 429)
      response.headers.set('Retry-After', '60')
      return response
    }
    const db = env.FEEDBACK_DB
    if (url.pathname === '/api/feedback/config' && request.method === 'GET') {
      return feedbackJson({ enabled: true, emailDelivery: false, retentionDays: 90 })
    }
    if (url.pathname === '/api/feedback' && request.method === 'POST') {
      let input: z.infer<typeof feedbackInput>
      try { input = feedbackInput.parse(await boundedJson(request)) }
      catch { return feedbackJson({ error: 'Use a subject up to 120 characters and a message up to 4,000 characters.' }, 400) }
      const hash = await digest(input.accessToken)
      // A retry is idempotent only when possession and submitted content match. Never return a
      // different person's report, including when an attacker deliberately reuses its public ID.
      await db.prepare(`INSERT INTO feedback (id, access_hash, category, subject, message, created_at, updated_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, NULL WHERE (SELECT COUNT(*) FROM feedback WHERE created_at >= ?) < 500
        ON CONFLICT(id) DO NOTHING`).bind(input.id, hash, input.category, input.subject, input.message,
          now, now, now - 86_400_000).run()
      const existing = await ticketWithMessages(db, input.id, hash, now)
      if (!existing) return feedbackJson({ error: 'Unable to accept this report. Retry later or email support@longleash.dev.' }, 409)
      if (existing.subject !== input.subject || existing.message !== input.message || existing.category !== input.category) {
        return feedbackJson({ error: 'This report was already received with different content. Start a new report.' }, 409)
      }
      return feedbackJson({ ticket: existing }, 200)
    }
    if (url.pathname === '/api/owner/feedback' && request.method === 'GET') {
      const page = z.coerce.number().int().min(0).max(1000).safeParse(url.searchParams.get('page') ?? 0)
      if (!page.success) return feedbackJson({ error: 'Invalid page' }, 400)
      const rows = await db.prepare(`SELECT ${columns} FROM feedback WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 26 OFFSET ?`)
        .bind(now, page.data * 25).all()
      return feedbackJson({ tickets: rows.results.slice(0, 25), hasMore: rows.results.length > 25 })
    }
    const parts = url.pathname.split('/').filter(Boolean)
    const candidateId = parts.at(-1) === 'messages' ? parts.at(-2) : parts.at(-1)
    const ticketId = id.safeParse(candidateId)
    if (!ticketId.success) return feedbackJson({ error: 'Not found' }, 404)
    if (!ownerRoute) {
      const access = token.safeParse(request.headers.get('Authorization')?.replace(/^Bearer /, ''))
      if (!access.success) return feedbackJson({ error: 'Not found' }, 404)
      const hash = await digest(access.data)
      if (request.method === 'GET') {
        const ticket = await ticketWithMessages(db, ticketId.data, hash, now)
        return ticket ? feedbackJson({ ticket }) : feedbackJson({ error: 'Not found' }, 404)
      }
      if (request.method === 'POST' && parts.at(-1) === 'messages') {
        let input: z.infer<typeof followUpInput>
        try { input = followUpInput.parse(await boundedJson(request)) }
        catch { return feedbackJson({ error: 'Use a message up to 4,000 characters.' }, 400) }
        if (input.accessToken !== access.data) return feedbackJson({ error: 'Not found' }, 404)
        if (!await ticketWithMessages(db, ticketId.data, hash, now)) return feedbackJson({ error: 'Not found' }, 404)
        const inserted = await db.prepare(`INSERT INTO feedback_messages(id, feedback_id, author, body, status_snapshot, created_at)
          VALUES (?, ?, 'customer', ?, 'received', ?) ON CONFLICT(id) DO NOTHING`)
          .bind(input.id, ticketId.data, input.message, now).run()
        if (inserted.meta.changes === 0) {
          const existing = await db.prepare(`SELECT feedback_id, author, body FROM feedback_messages WHERE id = ?`)
            .bind(input.id).first<Record<string, unknown>>()
          if (existing?.feedback_id !== ticketId.data || existing.author !== 'customer' || existing.body !== input.message) {
            return feedbackJson({ error: 'This follow-up identifier was already used. Retry with a new message.' }, 409)
          }
        }
        if (inserted.meta.changes === 1) {
          await db.prepare(`UPDATE feedback SET status = 'received', closed_at = NULL, expires_at = NULL,
            updated_at = ?, revision = revision + 1 WHERE id = ? AND access_hash = ?`)
            .bind(now, ticketId.data, hash).run()
        }
        return feedbackJson({ ticket: await ticketWithMessages(db, ticketId.data, hash, now) })
      }
      if (request.method === 'DELETE') {
        await db.prepare('DELETE FROM feedback WHERE id = ? AND access_hash = ?').bind(ticketId.data, hash).run()
        return feedbackJson({ deleted: true })
      }
    } else if (request.method === 'GET') {
      const ticket = await ticketWithMessages(db, ticketId.data, null, now)
      return ticket ? feedbackJson({ ticket }) : feedbackJson({ error: 'Not found' }, 404)
    } else if (request.method === 'PATCH') {
      let input: z.infer<typeof replyInput>
      try { input = replyInput.parse(await boundedJson(request)) }
      catch { return feedbackJson({ error: 'Invalid reply' }, 400) }
      const duplicate = await db.prepare('SELECT feedback_id, author, body FROM feedback_messages WHERE id = ?')
        .bind(input.messageId).first<Record<string, unknown>>()
      if (duplicate && (duplicate.feedback_id !== ticketId.data || duplicate.author !== 'owner' || duplicate.body !== input.reply)) {
        return feedbackJson({ error: 'This reply identifier was already used. Refresh before replying.' }, 409)
      }
      const closed = input.status === 'resolved' || input.status === 'not_planned'
      const updated = await db.prepare(`UPDATE feedback SET reply = ?, status = ?, updated_at = ?,
        closed_at = ?, expires_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?
        AND (expires_at IS NULL OR expires_at > ?)`)
        .bind(input.reply, input.status, now, closed ? now : null, closed ? now + RETENTION_MS : null,
          ticketId.data, input.revision, now).run()
      if (updated.meta.changes !== 1) return feedbackJson({ error: 'Report changed or expired. Refresh before replying.' }, 409)
      await db.prepare(`INSERT INTO feedback_messages(id, feedback_id, author, body, status_snapshot, created_at)
        VALUES (?, ?, 'owner', ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
        .bind(input.messageId, ticketId.data, input.reply, input.status, now).run()
      return feedbackJson({ saved: true, ticket: await ticketWithMessages(db, ticketId.data, null, now) })
    }
    return feedbackJson({ error: 'Method not allowed' }, 405)
  } catch {
    // Never log submitted text, bearer proofs, SQL errors, or Clerk details.
    return feedbackJson({ error: 'Unable to confirm this request. Keep your draft and retry; a matching retry will not create a duplicate.' }, 503)
  }
}

export async function expireFeedback(env: FeedbackEnv, now = Date.now()): Promise<void> {
  if (env.FEEDBACK_DB) await env.FEEDBACK_DB.prepare('DELETE FROM feedback WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run()
}
