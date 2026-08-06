import { z } from 'zod'

export const PROTOCOL_VERSION = 1

export const AgentKind = z.enum(['claude', 'gemini', 'codex', 'terminal'])
export type AgentKind = z.infer<typeof AgentKind>

/** Where a session came from, so a person can tell "I started this" from "this was already running". */
export const SessionOrigin = z.enum(['phone', 'daemon', 'terminal', 'vscode', 'external'])
export type SessionOrigin = z.infer<typeof SessionOrigin>

export const Verdict = z.enum(['allow', 'deny'])
export type Verdict = z.infer<typeof Verdict>

const sessionStartedPayload = z
  .object({
    agent: AgentKind,
    cwd: z.string().min(1),
    title: z.string().optional(),
    origin: SessionOrigin.optional(),
  })
  .passthrough()

const sessionStatusPayload = z
  .object({
    status: z.enum(['running', 'waiting', 'errored', 'ended']),
    detail: z.string().optional(),
  })
  .passthrough()

const streamDeltaPayload = z
  .object({
    kind: z.enum(['text', 'tool', 'thinking', 'user']),
    text: z.string(),
  })
  .passthrough()

const approvalRequestedPayload = z
  .object({
    approvalId: z.string().min(1),
    toolName: z.string().min(1),
    inputSummary: z.string(),
    expiresAt: z.number().int().positive(),
    targetPath: z.string().optional(),
    outsideRoot: z.boolean().optional(),
  })
  .passthrough()

const approvalDecidedPayload = z
  .object({
    approvalId: z.string().min(1),
    verdict: Verdict,
    decidedBy: z.string().min(1),
    reply: z.string().optional(),
  })
  .passthrough()

const activityToolPayload = z
  .object({
    toolName: z.string().min(1),
    inputSummary: z.string(),
    autoApproved: z.boolean(),
  })
  .passthrough()

const sessionErroredPayload = z.object({ message: z.string().min(1) }).passthrough()

/**
 * `resumable` rides in this payload — not just in `hello` — because whether a session
 * can be reopened is exactly the fact that changes AT the moment a session ends (a
 * terminal session adopted on stop, an SDK session that only just announced its resume
 * id). A phone already connected and watching must learn this from the live event, or
 * its Reopen button stays wrong until the next reconnect.
 */
const sessionEndedPayload = z
  .object({ reason: z.string().optional(), resumable: z.boolean().optional() })
  .passthrough()

const envelope = {
  v: z.number().int().positive(),
  seq: z.number().int().positive(),
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(),
}

function event<T extends string, P extends z.ZodTypeAny>(type: T, payload: P) {
  return z.object({ ...envelope, type: z.literal(type), payload }).passthrough()
}

export const SessionEventSchema = z.discriminatedUnion('type', [
  event('session.started', sessionStartedPayload),
  event('session.status', sessionStatusPayload),
  event('stream.delta', streamDeltaPayload),
  event('approval.requested', approvalRequestedPayload),
  event('approval.decided', approvalDecidedPayload),
  event('activity.tool', activityToolPayload),
  event('session.errored', sessionErroredPayload),
  event('session.ended', sessionEndedPayload),
])
export type SessionEvent = z.infer<typeof SessionEventSchema>

export function parseEvent(raw: unknown): SessionEvent {
  return SessionEventSchema.parse(raw)
}

const clientBase = { v: z.number().int().positive() }

const subscribeMessage = z
  .object({
    ...clientBase,
    type: z.literal('subscribe'),
    sessionId: z.string().min(1),
    fromCursor: z.number().int().nonnegative(),
  })
  .passthrough()

const decisionMessage = z
  .object({
    ...clientBase,
    type: z.literal('decision'),
    approvalId: z.string().min(1),
    verdict: Verdict,
    reply: z.string().optional(),
  })
  .passthrough()

const sendMessageMessage = z
  .object({
    ...clientBase,
    type: z.literal('sendMessage'),
    sessionId: z.string().min(1),
    text: z.string().min(1),
  })
  .passthrough()

const startSessionMessage = z
  .object({
    ...clientBase,
    type: z.literal('startSession'),
    agent: AgentKind,
    root: z.string().min(1),
    prompt: z.string().min(1),
  })
  .passthrough()

const findFoldersMessage = z
  .object({
    ...clientBase,
    type: z.literal('findFolders'),
    query: z.string().max(200),
  })
  .passthrough()

const resumeSessionMessage = z
  .object({
    ...clientBase,
    type: z.literal('resumeSession'),
    sessionId: z.string().min(1),
  })
  .passthrough()

const stopSessionMessage = z
  .object({
    ...clientBase,
    type: z.literal('stopSession'),
    sessionId: z.string().min(1),
  })
  .passthrough()

/** The browser's PushSubscription, exactly as `subscription.toJSON()` emits it. */
export const PushSubscriptionSchema = z
  .object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).passthrough(),
  })
  .passthrough()
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionSchema>

const pushSubscribeMessage = z
  .object({
    ...clientBase,
    type: z.literal('pushSubscribe'),
    subscription: PushSubscriptionSchema,
  })
  .passthrough()

const pushUnsubscribeMessage = z
  .object({
    ...clientBase,
    type: z.literal('pushUnsubscribe'),
    endpoint: z.string().url(),
  })
  .passthrough()

/** Ask the daemon to send this device a test notification, so "is it working?" has a button. */
const pushTestMessage = z
  .object({
    ...clientBase,
    type: z.literal('pushTest'),
  })
  .passthrough()

/**
 * Take over a terminal-started session: stop its terminal process if still
 * running, then continue the same conversation from the phone with this text.
 */
const takeOverMessage = z
  .object({
    ...clientBase,
    type: z.literal('takeOver'),
    sessionId: z.string().min(1),
    text: z.string().min(1),
  })
  .passthrough()

export const ClientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessage,
  decisionMessage,
  sendMessageMessage,
  startSessionMessage,
  stopSessionMessage,
  resumeSessionMessage,
  findFoldersMessage,
  pushSubscribeMessage,
  pushUnsubscribeMessage,
  pushTestMessage,
  takeOverMessage,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessageSchema.parse(raw)
}

export * from './envelope.js'
