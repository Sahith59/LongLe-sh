import { z } from 'zod'

export { humanSaid } from './human-text.js'

export const PROTOCOL_VERSION = 1

export const AgentKind = z.enum(['claude', 'gemini', 'codex', 'terminal'])
export type AgentKind = z.infer<typeof AgentKind>

/** Where a session came from, so a person can tell "I started this" from "this was already running". */
export const SessionOrigin = z.enum(['phone', 'daemon', 'terminal', 'vscode', 'external'])
export type SessionOrigin = z.infer<typeof SessionOrigin>

export const Verdict = z.enum(['allow', 'deny'])
export type Verdict = z.infer<typeof Verdict>

/**
 * How much this session should bother the phone. LongLeash's own gate, layered on top of
 * whatever permission mode the agent runs in — it can only ask for LESS, never more,
 * because a mode that auto-approves ignores a refusal no matter who sends it.
 */
export const SessionGate = z.enum(['ask', 'auto'])
export type SessionGate = z.infer<typeof SessionGate>

const sessionStartedPayload = z
  .object({
    agent: AgentKind,
    cwd: z.string().min(1),
    title: z.string().optional(),
    origin: SessionOrigin.optional(),
    /**
     * The agent's own conversation id. Carried to the phone so a person can pick the
     * SAME conversation back up at their keyboard — `claude --resume <id>` in the
     * session's folder — instead of being locked to whichever surface started it.
     */
    resumeId: z.string().optional(),
  })
  .passthrough()

const sessionStatusPayload = z
  .object({
    status: z.enum(['running', 'waiting', 'errored', 'ended']),
    /** Whether a real agent process exists now; waiting can also mean dormant/reopenable. */
    live: z.boolean().optional(),
    detail: z.string().optional(),
    /**
     * A better name, learned after the fact. A terminal session is born knowing only its
     * folder — every session in one directory would otherwise be called the same thing —
     * so it renames itself to the first thing the person actually asked for.
     */
    title: z.string().optional(),
    /**
     * The permission mode the session is running in, as Claude Code reports it. Shown on
     * the phone because "why am I being asked about this?" must never be a mystery.
     */
    permissionMode: z.string().optional(),
    /** LongLeash's own gate for this session: whether it should page the phone at all. */
    gate: SessionGate.optional(),
  })
  .passthrough()

const streamDeltaPayload = z
  .object({
    kind: z.enum(['text', 'tool', 'thinking', 'user']),
    text: z.string(),
  })
  .passthrough()

/**
 * A multiple-choice question Claude is asking — the AskUserQuestion tool, mirrored.
 * Shapes follow Claude Code's own tool schema so nothing is lost in translation.
 */
export const QuestionOption = z
  .object({
    label: z.string().min(1),
    description: z.string().default(''),
    /** Mockups, code snippets, or comparisons rendered when an option is focused. */
    preview: z.string().optional(),
  })
  .passthrough()
export type QuestionOption = z.infer<typeof QuestionOption>

export const AskedQuestion = z
  .object({
    question: z.string().min(1),
    /** Short chip label, e.g. "Auth method". */
    header: z.string().default(''),
    options: z.array(QuestionOption).min(1).max(8),
    multiSelect: z.boolean().default(false),
  })
  .passthrough()
export type AskedQuestion = z.infer<typeof AskedQuestion>

const approvalRequestedPayload = z
  .object({
    approvalId: z.string().min(1),
    toolName: z.string().min(1),
    inputSummary: z.string(),
    expiresAt: z.number().int().positive(),
    targetPath: z.string().optional(),
    outsideRoot: z.boolean().optional(),
    /**
     * Present when this is a QUESTION rather than a permission request. A question is
     * not a yes/no: it carries its own options and is answered, not approved. The phone
     * renders a wholly different surface for it, because confusing "may I?" with
     * "which one?" is how a person answers the wrong thing in a hurry.
     */
    questions: z.array(AskedQuestion).min(1).max(4).optional(),
  })
  .passthrough()

const approvalDecidedPayload = z
  .object({
    approvalId: z.string().min(1),
    verdict: Verdict,
    decidedBy: z.string().min(1),
    reply: z.string().optional(),
    /** For a question: what was actually chosen, so history reads as an answer. */
    answers: z.record(z.string()).optional(),
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
  .object({
    reason: z.string().optional(),
    resumable: z.boolean().optional(),
    resumeId: z.string().optional(),
  })
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
    /**
     * Answers to a question approval: question text → chosen label(s). Multi-select
     * answers are comma-separated, matching Claude Code's own output shape.
     */
    answers: z.record(z.string()).optional(),
    /** Freeform text typed instead of (or alongside) picking an option. */
    response: z.string().optional(),
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

const setGateMessage = z
  .object({
    ...clientBase,
    type: z.literal('setGate'),
    sessionId: z.string().min(1),
    gate: SessionGate,
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
  setGateMessage,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessageSchema.parse(raw)
}

export * from './envelope.js'
