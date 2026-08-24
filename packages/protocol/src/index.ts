import { z } from 'zod'

export { humanSaid } from './human-text.js'

export const PROTOCOL_VERSION = 1

export const AgentKind = z.enum(['claude', 'gemini', 'codex', 'terminal'])
export type AgentKind = z.infer<typeof AgentKind>

/** Where a session came from, so a person can tell "I started this" from "this was already running". */
export const SessionOrigin = z.enum(['phone', 'daemon', 'terminal', 'vscode', 'external'])
export type SessionOrigin = z.infer<typeof SessionOrigin>

/** How a phone-started session should obtain write ownership of its project. */
export const WorkspaceMode = z.enum(['auto', 'shared', 'isolated'])
export type WorkspaceMode = z.infer<typeof WorkspaceMode>

/** Provider settings that are supported by both the wire and the managed adapters. */
export const AgentEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type AgentEffort = z.infer<typeof AgentEffort>

export const ThinkingMode = z.enum(['adaptive', 'disabled', 'fixed'])
export type ThinkingMode = z.infer<typeof ThinkingMode>

/**
 * A provider-neutral working style for sessions LongLeash controls.
 *
 * `auto` never means unrestricted access: each adapter keeps its provider safety boundary in place.
 * `plan` is read-only by contract, even for providers that do not expose a native plan mode.
 */
export const SessionMode = z.enum(['manual', 'auto', 'plan'])
export type SessionMode = z.infer<typeof SessionMode>

export const SessionSettings = z
  .object({
    /** Omitted means LongLeash's conservative manual mode. */
    mode: SessionMode.optional(),
    /** Omitted means the provider's current default; model ids never enter a shell command. */
    model: z.string().trim().min(1).max(120).optional(),
    effort: AgentEffort.optional(),
    thinking: z
      .object({
        mode: ThinkingMode,
        /** Claude's explicit thinking budget. Only valid with `fixed`. */
        budgetTokens: z.number().int().min(1_024).max(128_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.thinking?.mode === 'fixed' && value.thinking.budgetTokens === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thinking', 'budgetTokens'],
        message: 'A fixed thinking mode requires a token budget.',
      })
    }
    if (value.thinking?.mode !== 'fixed' && value.thinking?.budgetTokens !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thinking', 'budgetTokens'],
        message: 'A token budget is only valid with fixed thinking.',
      })
    }
  })
export type SessionSettings = z.infer<typeof SessionSettings>

/** The checkout actually used by an agent, plus the project the person selected. */
export const SessionWorkspace = z
  .object({
    mode: z.enum(['shared', 'isolated']),
    sourceCwd: z.string().min(1),
    branch: z.string().min(1).optional(),
  })
  .strict()
export type SessionWorkspace = z.infer<typeof SessionWorkspace>

export const Verdict = z.enum(['allow', 'deny'])
export type Verdict = z.infer<typeof Verdict>

/**
 * How much this session should bother the phone. LongLeash's own gate, layered on top of
 * whatever permission mode the agent runs in — it can only ask for LESS, never more,
 * because a mode that auto-approves ignores a refusal no matter who sends it.
 */
export const SessionGate = z.enum(['ask', 'auto'])
export type SessionGate = z.infer<typeof SessionGate>

/** The bounded job a delegated child is expected to perform. */
export const DelegationRole = z.enum(['investigate', 'review', 'implement', 'test'])
export type DelegationRole = z.infer<typeof DelegationRole>

/** How much of the source conversation was deliberately included in a briefing. */
export const DelegationContextScope = z.enum(['selected', 'recent', 'task'])
export type DelegationContextScope = z.infer<typeof DelegationContextScope>

/** Agents that LongLeash can deliberately start as delegated workers in V1. */
export const DelegationTargetAgent = z.enum(['claude', 'codex'])
export type DelegationTargetAgent = z.infer<typeof DelegationTargetAgent>

/** Durable orchestration lifecycle. Only the daemon may advance these states. */
export const DelegationStatus = z.enum([
  'draft',
  'starting',
  'running',
  'ready',
  'returned',
  'cancelled',
  'failed',
])
export type DelegationStatus = z.infer<typeof DelegationStatus>

/** One limit shared by preview, launch validation, persistence, and the phone editor. */
export const MAX_DELEGATION_BRIEFING_CHARACTERS = 24_000
/** A reviewed result uses the same bounded mobile editing budget as its briefing. */
export const MAX_DELEGATION_RETURN_CHARACTERS = 24_000
/** V1 deliberately stays shallow enough that the human can still understand the graph. */
export const MAX_DELEGATION_DEPTH = 2

/**
 * A child session's place in a delegation tree. Kept as one optional object so an older or
 * unrelated session cannot accidentally carry a half-populated relationship.
 */
export const SessionRelationship = z
  .object({
    delegationId: z.string().min(1),
    parentSessionId: z.string().min(1),
    role: DelegationRole,
    /** V1 allows two edges below the root. The protocol leaves room for a later bounded Crew. */
    depth: z.number().int().min(1).max(16),
  })
  .passthrough()
export type SessionRelationship = z.infer<typeof SessionRelationship>

const sessionStartedPayload = z
  .object({
    agent: AgentKind,
    cwd: z.string().min(1),
    title: z.string().optional(),
    origin: SessionOrigin.optional(),
    /** Who owns the process now; unlike origin, this changes after a safe handoff. */
    controller: z.enum(['longleash', 'external']).optional(),
    /** Observation-only means the native surface is visible but has not exposed process control. */
    control: z.enum(['full', 'observe']).optional(),
    /**
     * The agent's own conversation id. Carried to the phone so a person can pick the
     * SAME conversation back up at their keyboard — `claude --resume <id>` in the
     * session's folder — instead of being locked to whichever surface started it.
     */
    resumeId: z.string().optional(),
    relationship: SessionRelationship.optional(),
    settings: SessionSettings.optional(),
    workspace: SessionWorkspace.optional(),
  })
  .passthrough()

const sessionStatusPayload = z
  .object({
    status: z.enum(['running', 'waiting', 'errored', 'ended']),
    /** Whether a real agent process exists now; waiting can also mean dormant/reopenable. */
    live: z.boolean().optional(),
    /** The native agent has announced a conversation id that can move between surfaces. */
    resumable: z.boolean().optional(),
    /** Claude/Codex's own conversation id, delivered as soon as it is known. */
    resumeId: z.string().optional(),
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
    controller: z.enum(['longleash', 'external']).optional(),
    /** Observation-only sessions are never presented as remotely stoppable or writable. */
    control: z.enum(['full', 'observe']).optional(),
    /** Current overrides. An empty object explicitly means provider defaults. */
    settings: SessionSettings.optional(),
    /** A second writer was observed in this checkout; text accompanies color for accessibility. */
    workspaceConflict: z
      .object({
        cwd: z.string().min(1),
        ownerSessionId: z.string().min(1),
        /** True when LongLeash also suspended the local process, not only its write hooks. */
        processPaused: z.boolean().optional(),
      })
      .optional(),
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
    /** Optional replay barrier. New clients use the echoed id to paint catch-up only once. */
    syncId: z.string().min(1).max(120).optional(),
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
    requestId: z.string().min(1).max(120).optional(),
    workspaceMode: WorkspaceMode.default('auto'),
    settings: SessionSettings.optional(),
  })
  .passthrough()

const updateSessionSettingsMessage = z
  .object({
    ...clientBase,
    type: z.literal('updateSessionSettings'),
    requestId: z.string().min(1).max(120),
    sessionId: z.string().min(1),
    settings: SessionSettings,
    /** Required before LongLeash ends a process that is still owned by Terminal or VS Code. */
    externalTransferConfirmed: z.boolean().default(false),
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

/**
 * Build the exact prompt a delegated child would receive, without starting anything.
 * The request id makes previews safe when a phone changes controls while an older reply is
 * still crossing a slow relay connection.
 */
const previewDelegationMessage = z
  .object({
    ...clientBase,
    type: z.literal('previewDelegation'),
    requestId: z.string().min(1).max(120),
    sourceSessionId: z.string().min(1),
    sourceSeq: z.number().int().positive().optional(),
    targetAgent: DelegationTargetAgent,
    role: DelegationRole,
    contextScope: DelegationContextScope,
  })
  .passthrough()

/**
 * The only operation that may turn an edited preview into a child session. `confirmed` is a
 * deliberate speed bump in the wire contract: a preview request can never be replayed as a
 * launch, and a future client cannot accidentally omit the final human confirmation.
 */
const startDelegationMessage = z
  .object({
    ...clientBase,
    type: z.literal('startDelegation'),
    requestId: z.string().min(1).max(120),
    idempotencyKey: z.string().min(1).max(200),
    sourceSessionId: z.string().min(1),
    sourceSeq: z.number().int().positive().optional(),
    targetAgent: DelegationTargetAgent,
    role: DelegationRole,
    contextScope: DelegationContextScope,
    briefing: z
      .string()
      .max(MAX_DELEGATION_BRIEFING_CHARACTERS)
      .refine((value) => value.trim().length > 0, 'Briefing must not be empty'),
    settings: SessionSettings.optional(),
    confirmed: z.literal(true),
    /** V1 is sequential: launching moves exclusive checkout ownership from source to child. */
    workspaceTransferConfirmed: z.literal(true),
  })
  .passthrough()

const prepareReturnMessage = z
  .object({
    ...clientBase,
    type: z.literal('prepareReturn'),
    requestId: z.string().min(1).max(120),
    delegationId: z.string().min(1),
  })
  .passthrough()

const returnDelegationMessage = z
  .object({
    ...clientBase,
    type: z.literal('returnDelegation'),
    requestId: z.string().min(1).max(120),
    idempotencyKey: z.string().min(1).max(200),
    delegationId: z.string().min(1),
    returnText: z
      .string()
      .max(MAX_DELEGATION_RETURN_CHARACTERS)
      .refine((value) => value.trim().length > 0, 'Return text must not be empty'),
    confirmed: z.literal(true),
    /** Required by the daemon only while a Terminal/VS Code parent still owns its process. */
    takeoverConfirmed: z.boolean(),
  })
  .passthrough()

/** Private briefing text stays on the laptop; connected devices only need lifecycle metadata. */
export const DelegationSummarySchema = z
  .object({
    delegationId: z.string().min(1),
    /** Lets the initiating phone reconcile a launch whose direct acknowledgement was lost. */
    idempotencyKey: z.string().min(1).max(200),
    sourceSessionId: z.string().min(1),
    sourceSeq: z.number().int().positive().optional(),
    targetSessionId: z.string().min(1).optional(),
    targetAgent: DelegationTargetAgent,
    role: DelegationRole,
    contextScope: DelegationContextScope,
    settings: SessionSettings.optional(),
    depth: z.number().int().min(1).max(MAX_DELEGATION_DEPTH),
    status: DelegationStatus,
    failure: z.string().optional(),
    /** Lets a reconnecting phone settle a return whose direct acknowledgement was lost. */
    returnIdempotencyKey: z.string().min(1).max(200).optional(),
    returnedAt: z.number().int().nonnegative().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .passthrough()
export type DelegationSummary = z.infer<typeof DelegationSummarySchema>

export const DelegationUpdateSchema = z
  .object({
    v: z.number().int().positive(),
    type: z.literal('delegation'),
    requestId: z.string().min(1).optional(),
    /** False means this was an idempotent replay of an already accepted launch. */
    created: z.boolean().optional(),
    delegation: DelegationSummarySchema,
  })
  .passthrough()
export type DelegationUpdate = z.infer<typeof DelegationUpdateSchema>

export const DelegationPreviewSchema = z
  .object({
    v: z.number().int().positive(),
    type: z.literal('delegationPreview'),
    requestId: z.string().min(1),
    source: z
      .object({
        sessionId: z.string().min(1),
        agent: AgentKind,
        cwd: z.string(),
        title: z.string(),
        origin: SessionOrigin,
      })
      .passthrough(),
    sourceSeq: z.number().int().positive().optional(),
    targetAgent: DelegationTargetAgent,
    role: DelegationRole,
    contextScope: DelegationContextScope,
    briefing: z.string().min(1),
    context: z
      .object({
        includedFirstSeq: z.number().int().positive(),
        includedLastSeq: z.number().int().positive(),
        includedBlocks: z.number().int().positive(),
        omittedEvents: z.number().int().nonnegative(),
        omittedCharacters: z.number().int().nonnegative(),
        truncated: z.boolean(),
        characterCount: z.number().int().positive(),
        maxCharacters: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough()
export type DelegationPreview = z.infer<typeof DelegationPreviewSchema>

export const DelegationReturnPreviewSchema = z
  .object({
    v: z.number().int().positive(),
    type: z.literal('delegationReturnPreview'),
    requestId: z.string().min(1),
    delegationId: z.string().min(1),
    parent: z
      .object({
        sessionId: z.string().min(1),
        agent: AgentKind,
        title: z.string(),
        cwd: z.string(),
        origin: SessionOrigin,
        live: z.boolean(),
      })
      .passthrough(),
    child: z
      .object({
        sessionId: z.string().min(1),
        agent: AgentKind,
        title: z.string(),
      })
      .passthrough(),
    role: DelegationRole,
    returnText: z.string().min(1).max(MAX_DELEGATION_RETURN_CHARACTERS),
    attribution: z.string().min(1),
    requiresTakeover: z.boolean(),
    context: z
      .object({
        includedFirstSeq: z.number().int().positive(),
        includedLastSeq: z.number().int().positive(),
        omittedCharacters: z.number().int().nonnegative(),
        truncated: z.boolean(),
        characterCount: z.number().int().positive(),
        maxCharacters: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough()
export type DelegationReturnPreview = z.infer<typeof DelegationReturnPreviewSchema>

export const ClientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessage,
  decisionMessage,
  sendMessageMessage,
  startSessionMessage,
  updateSessionSettingsMessage,
  stopSessionMessage,
  resumeSessionMessage,
  findFoldersMessage,
  pushSubscribeMessage,
  pushUnsubscribeMessage,
  pushTestMessage,
  takeOverMessage,
  setGateMessage,
  previewDelegationMessage,
  startDelegationMessage,
  prepareReturnMessage,
  returnDelegationMessage,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessageSchema.parse(raw)
}

export * from './envelope.js'
export * from './ide.js'
