export { EventLog, coalesceTextDeltas } from './eventlog.js'
export type { AppendInput, ReplayResult } from './eventlog.js'
export { readPermissionPosture } from './posture.js'
export type { PermissionPosture } from './posture.js'
export { startDaemon } from './daemon.js'
export type { Daemon, DaemonOptions } from './daemon.js'
export { LongLeashServer, CLOSE_UNAUTHORIZED, CLOSE_REVOKED } from './server.js'
export type { ServerOptions } from './server.js'
export { SessionManager, SessionError } from './sessions.js'
export type { SessionSummary, SessionStatus, StartSessionInput, SessionManagerOptions, DecisionOutcome } from './sessions.js'
export { DelegationStore, DelegationError } from './delegations.js'
export type {
  CreateDelegationInput,
  DelegationRecord,
  DelegationTargetAgent,
} from './delegations.js'
export {
  BriefingBuilder,
  BriefingError,
  DEFAULT_BRIEFING_MAX_CHARACTERS,
  HARD_BRIEFING_MAX_CHARACTERS,
} from './briefing.js'
export type { BriefingPreview, BuildBriefingInput } from './briefing.js'
export { ApprovalStore } from './approvals.js'
export type { ApprovalRecord, ApprovalStatus } from './approvals.js'
export type { AgentFactory, AgentRunHandle, AgentRunRequest, AgentStreamMessage, PermissionDecision } from './agent.js'
export { createClaudeAgentFactory } from './adapters/claude.js'
export type { ClaudeAdapterOptions } from './adapters/claude.js'
export { DeviceRegistry, PairingError } from './auth.js'
export type { Device, PairingChallenge, PairingFailure, CompletePairingInput } from './auth.js'
