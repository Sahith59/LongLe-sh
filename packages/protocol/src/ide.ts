import { z } from 'zod'

/**
 * The companion protocol is intentionally separate from the phone protocol. An IDE window is a
 * local, revocable principal with a much smaller trust boundary; it must never inherit a phone
 * device token or the hook secret merely because all three happen to run on one laptop.
 */
export const IDE_PROTOCOL_VERSION = 1
export const IDE_OPERATION_MAX_TTL_MS = 60_000

export const IdeCapability = z.enum([
  'diagnostics.read',
  'sessions.read',
  'transcripts.read',
  'workspace.open',
  'file.open',
  'claude.dispatch',
  'codex.render',
  'approvals.decide',
  'sessions.message',
  'sessions.stop',
  'sessions.delegate',
  'delegations.return',
])
export type IdeCapability = z.infer<typeof IdeCapability>

export const IDE_READ_ONLY_CAPABILITIES = [
  'diagnostics.read',
  'sessions.read',
  'transcripts.read',
] as const satisfies readonly IdeCapability[]

export const IDE_TRUSTED_CAPABILITIES = [
  ...IDE_READ_ONLY_CAPABILITIES,
  'workspace.open',
  'file.open',
  'claude.dispatch',
  'codex.render',
  'approvals.decide',
  'sessions.message',
  'sessions.stop',
  'sessions.delegate',
  'delegations.return',
] as const satisfies readonly IdeCapability[]

const protocolRange = z
  .object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.min <= value.max, 'Protocol minimum must not exceed maximum')

const workspaceFolder = z
  .object({
    /** VS Code's URI form, retained so remote-capable clients never pretend every root is a path. */
    uri: z.string().min(1).max(8_192),
    /** Realpath resolved by the local extension host when this is a local file workspace. */
    canonicalPath: z.string().min(1).max(4_096).optional(),
  })
  .strict()

/** First authenticated frame sent by each VS Code extension host/window. */
export const IdeClientHelloSchema = z
  .object({
    v: z.literal(IDE_PROTOCOL_VERSION),
    type: z.literal('ide.hello'),
    clientInstanceId: z.string().min(1).max(120),
    protocol: protocolRange,
    extension: z
      .object({
        version: z.string().min(1).max(80),
        build: z.string().min(1).max(120),
      })
      .strict(),
    vscode: z
      .object({
        version: z.string().min(1).max(80),
        uriScheme: z.string().min(1).max(40),
        remoteAuthority: z.string().min(1).max(512).nullable(),
        workspaceTrusted: z.boolean(),
        windowFocused: z.boolean(),
        workspaceFolders: z.array(workspaceFolder).max(64),
      })
      .strict(),
    capabilities: z
      .array(IdeCapability)
      .max(IdeCapability.options.length)
      .refine((values) => new Set(values).size === values.length, 'Capabilities must be unique'),
  })
  .strict()
export type IdeClientHello = z.infer<typeof IdeClientHelloSchema>

/** Daemon response after credential, protocol, build, and capability negotiation. */
export const IdeServerHelloSchema = z
  .object({
    v: z.literal(IDE_PROTOCOL_VERSION),
    type: z.literal('ide.welcome'),
    principalId: z.string().min(1).max(120),
    selectedProtocol: z.number().int().positive(),
    daemonBuild: z.string().min(1).max(120),
    grantedCapabilities: z
      .array(IdeCapability)
      .max(IdeCapability.options.length)
      .refine((values) => new Set(values).size === values.length, 'Capabilities must be unique'),
    mutationMode: z.enum(['enabled', 'read-only']),
    reason: z
      .enum([
        'workspace-untrusted',
        'build-mismatch',
        'protocol-incompatible',
        'credential-revoked',
      ])
      .optional(),
  })
  .strict()
export type IdeServerHello = z.infer<typeof IdeServerHelloSchema>

const ideSessionSummary = z
  .object({
    sessionId: z.string().min(1).max(240),
    provider: z.enum(['claude', 'codex']),
    title: z.string().trim().min(1).max(240),
    origin: z.enum(['phone', 'daemon', 'terminal', 'vscode', 'external']),
    status: z.enum(['running', 'waiting', 'ended', 'errored']),
    live: z.boolean(),
    resumable: z.boolean(),
    controller: z.enum(['longleash', 'external']).optional(),
    attention: z.enum(['approval', 'question', 'error']).optional(),
    workspace: z
      .object({
        label: z.string().trim().min(1).max(240),
        branch: z.string().trim().min(1).max(240).optional(),
        mode: z.enum(['shared', 'isolated']),
      })
      .strict(),
    relationship: z
      .object({
        parentSessionId: z.string().min(1).max(240),
        role: z.enum(['investigate', 'review', 'implement', 'test']),
        depth: z.number().int().min(1).max(16),
      })
      .strict()
      .optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.attention === 'error' && value.status !== 'errored') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attention'],
        message: 'Error attention is valid only for an errored session.',
      })
    }
    if (
      (value.attention === 'approval' || value.attention === 'question') &&
      (!value.live || value.status === 'ended' || value.status === 'errored')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attention'],
        message: 'Approval and question attention require a live non-terminal session.',
      })
    }
  })
export type IdeSessionSummary = z.infer<typeof ideSessionSummary>

/** Complete, cursor-ordered inventory replacement. Delta replay comes with the V1 transport. */
export const IdeSessionInventorySchema = z
  .object({
    v: z.literal(IDE_PROTOCOL_VERSION),
    type: z.literal('ide.sessionInventory'),
    /** Changes whenever the daemon's inventory stream is recreated, including after restart. */
    streamId: z.string().min(1).max(120),
    cursor: z.number().int().nonnegative(),
    generatedAt: z.number().int().nonnegative(),
    sessions: z
      .array(ideSessionSummary)
      .max(1_000)
      .refine(
        (sessions) => new Set(sessions.map((session) => session.sessionId)).size === sessions.length,
        'Inventory session ids must be unique.',
      ),
  })
  .strict()
export type IdeSessionInventory = z.infer<typeof IdeSessionInventorySchema>

const nativeRecord = z
  .object({
    /** The daemon, not the vendor URI, verified this durable conversation record. */
    verifiedAt: z.number().int().nonnegative(),
    canonicalWorkspace: z.string().min(1).max(4_096),
  })
  .strict()

/**
 * A short-lived, idempotent instruction. It travels only over the authenticated local companion
 * channel; the relay and phone never address an extension window directly.
 */
export const IdeOpenSessionInstructionSchema = z
  .object({
    v: z.literal(IDE_PROTOCOL_VERSION),
    type: z.literal('ide.openSession'),
    operationId: z.string().min(1).max(160),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    provider: z.enum(['claude', 'codex']),
    sessionId: z.string().min(1).max(240),
    nativeId: z.string().min(1).max(240),
    canonicalWorkspace: z.string().min(1).max(4_096),
    destination: z.enum(['claude-native', 'codex-longleash']),
    nativeRecord,
    /** The daemon has already resolved or reserved exclusive write ownership. */
    ownership: z.enum(['read-only', 'ide-reserved']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'An IDE operation must expire after it is issued.',
      })
    }
    if (value.expiresAt - value.issuedAt > IDE_OPERATION_MAX_TTL_MS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'An IDE operation must remain short-lived.',
      })
    }
    if (value.provider === 'claude' && value.destination !== 'claude-native') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'Claude sessions may only target the official native destination.',
      })
    }
    if (value.provider === 'codex' && value.destination !== 'codex-longleash') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'Codex sessions may only target the LongLeash-owned editor.',
      })
    }
  })
export type IdeOpenSessionInstruction = z.infer<typeof IdeOpenSessionInstructionSchema>

export const IdeOperationFailure = z.enum([
  'expired',
  'workspace-untrusted',
  'window-not-focused',
  'editor-scheme-unsupported',
  'workspace-not-open',
  'workspace-mismatch',
  'remote-workspace-unsupported',
  'provider-missing',
  'provider-too-old',
  'provider-contract-unverified',
  'native-session-unverified',
  'ownership-not-reserved',
  'build-mismatch',
  'capability-denied',
  'dispatch-refused',
  'thread-snapshot-missing',
  'thread-snapshot-mismatch',
  'internal',
])
export type IdeOperationFailure = z.infer<typeof IdeOperationFailure>

/**
 * `dispatched` is deliberately distinct from `opened`. Claude's public handler has no exact-open
 * acknowledgement and can fall back to a fresh chat. Only a LongLeash-owned Codex editor can
 * truthfully report that the requested thread was rendered and verified.
 */
export const IdeOpenSessionResultSchema = z
  .object({
    v: z.literal(IDE_PROTOCOL_VERSION),
    type: z.literal('ide.openSessionResult'),
    operationId: z.string().min(1).max(160),
    provider: z.enum(['claude', 'codex']),
    destination: z.enum(['claude-native', 'codex-longleash']),
    outcome: z.enum(['blocked', 'dispatched', 'opened']),
    verification: z.enum(['none', 'preflight-only', 'extension-owned']),
    failure: IdeOperationFailure.optional(),
    extensionBuild: z.string().min(1).max(120),
    completedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === 'blocked' && value.failure === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'A blocked IDE operation requires a machine-readable failure.',
      })
    }
    if (value.outcome !== 'blocked' && value.failure !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'A successful IDE operation must not carry a failure.',
      })
    }
    if (value.provider === 'claude' && value.outcome === 'opened') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'The public Claude URI cannot prove an exact native conversation opened.',
      })
    }
    if (value.provider === 'claude' && value.destination !== 'claude-native') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'Claude results must name the official native destination.',
      })
    }
    if (value.provider === 'codex' && value.destination !== 'codex-longleash') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'Codex results must name the LongLeash-owned editor.',
      })
    }
    if (value.outcome === 'dispatched' && value.verification !== 'preflight-only') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verification'],
        message: 'A dispatched native-provider request has preflight-only verification.',
      })
    }
    if (value.outcome === 'opened' && value.verification !== 'extension-owned') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verification'],
        message: 'Only an extension-owned editor can report a verified open.',
      })
    }
    if (value.outcome === 'blocked' && value.verification !== 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verification'],
        message: 'A blocked operation has no open verification.',
      })
    }
  })
export type IdeOpenSessionResult = z.infer<typeof IdeOpenSessionResultSchema>

export function parseIdeClientHello(raw: unknown): IdeClientHello {
  return IdeClientHelloSchema.parse(raw)
}

export function parseIdeSessionInventory(raw: unknown): IdeSessionInventory {
  return IdeSessionInventorySchema.parse(raw)
}

export function parseIdeOpenSessionInstruction(raw: unknown): IdeOpenSessionInstruction {
  return IdeOpenSessionInstructionSchema.parse(raw)
}

export function parseIdeOpenSessionResult(raw: unknown): IdeOpenSessionResult {
  return IdeOpenSessionResultSchema.parse(raw)
}
