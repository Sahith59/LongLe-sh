import type { SessionSettings } from '@longleash/protocol'

/**
 * The contract every agent adapter implements. Claude (Agent SDK), ACP agents, and the
 * deterministic test double all satisfy this, so SessionManager never knows which is running.
 */

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }

export type AgentStreamMessage =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; text: string }
  /** The agent finished replying and is waiting for the human — the session stays alive. */
  | { type: 'turn-end' }

export interface AgentRunRequest {
  sessionId: string
  /** Pinned per session: resuming from a different directory silently forks a new session. */
  cwd: string
  prompt: string
  /** Blocks the agent until a human decides. May stay pending indefinitely. */
  canUseTool: (toolName: string, input: unknown) => Promise<PermissionDecision>
  /** Tools that bypassed approval still belong in the activity feed (spike S0 finding). */
  onAutoApprovedTool: (toolName: string, input: unknown) => void
  /** The agent's own session id, captured so the conversation can be reopened later. */
  onAgentSession: (agentSessionId: string) => void
  /** Reopen a previous conversation instead of starting fresh. */
  resume?: string
  /** Validated provider controls pinned to this conversation across wake/reopen. */
  settings?: SessionSettings
}

export interface AgentRunHandle {
  events: AsyncIterable<AgentStreamMessage>
  interrupt: () => Promise<void>
  /** Continue the conversation. A session is a dialogue, not a one-shot command. */
  sendMessage: (text: string) => void
  /**
   * Change provider controls for subsequent responses without restarting the conversation.
   * The in-flight response is deliberately left untouched.
   */
  updateSettings?: (settings: SessionSettings) => Promise<void>
}

export type AgentFactory = (request: AgentRunRequest) => AgentRunHandle
