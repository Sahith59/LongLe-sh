import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentFactory, AgentRunRequest, AgentStreamMessage } from '../agent.js'

/**
 * Drives real Claude Code through the official Agent SDK.
 *
 * Authentication is inherited from the Claude Code CLI's subscription OAuth — no API key is
 * read or required (verified by spike S0: `apiKeySource: "none"`).
 */
export interface ClaudeAdapterOptions {
  /** Cap turns so a runaway session cannot spin forever. */
  maxTurns?: number
  model?: string
  /**
   * Which tools may run without asking. Passing an explicit list (including an empty one)
   * makes the approval surface predictable instead of inheriting whatever the machine's
   * Claude Code settings happen to allow — the difference between a phone that reliably
   * gets asked and one that silently misses actions.
   */
  allowedTools?: string[]
  /** Ignore on-machine setting sources so behaviour does not vary per developer. */
  isolateFromUserSettings?: boolean
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    const interesting = record.file_path ?? record.path ?? record.command ?? record.pattern
    if (typeof interesting === 'string') return interesting.slice(0, 200)
  }
  return ''
}

export function createClaudeAgentFactory(options: ClaudeAdapterOptions = {}): AgentFactory {
  return (request: AgentRunRequest) => {
    /**
     * PreToolUse fires BEFORE canUseTool, so at hook time we cannot yet tell whether a tool
     * will be gated. Record what actually asked for permission, then report activity from
     * PostToolUse — by which point the answer is known. Reporting from PreToolUse would label
     * every approval-gated action as "auto-approved" on the phone, which is a lie.
     */
    const askedForPermission = new Set<string>()
    const reportedToolUseIds = new Set<string>()
    const toolKey = (name: string, input: unknown) => `${name}:${JSON.stringify(input ?? {})}`

    const run = query({
      prompt: request.prompt,
      options: {
        // Pinned per session. Spike S0 showed an agent writing outside its stated cwd when
        // this is not enforced, and resume is keyed to cwd, so it must never drift.
        cwd: request.cwd,
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
        ...(options.isolateFromUserSettings ? { settingSources: [] } : {}),
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          askedForPermission.add(toolKey(toolName, input))
          const decision = await request.canUseTool(toolName, input)
          if (decision.behavior === 'allow') {
            return { behavior: 'allow' as const, updatedInput: input }
          }
          return { behavior: 'deny' as const, message: decision.message }
        },
        hooks: {
          // canUseTool never fires for auto-approved tools (spike S0 finding), so without this
          // hook a large part of what the agent did would be invisible on the phone.
          PostToolUse: [
            {
              hooks: [
                async (input: unknown) => {
                  const hookInput = input as {
                    tool_name?: string
                    tool_input?: unknown
                    tool_use_id?: string
                  }
                  const id = hookInput.tool_use_id
                  if (id !== undefined) {
                    if (reportedToolUseIds.has(id)) return { continue: true }
                    reportedToolUseIds.add(id)
                  }
                  const name = hookInput.tool_name
                  if (!name) return { continue: true }
                  // Anything that went through an approval is already in the timeline.
                  if (askedForPermission.has(toolKey(name, hookInput.tool_input))) {
                    return { continue: true }
                  }
                  request.onAutoApprovedTool(name, hookInput.tool_input ?? {})
                  return { continue: true }
                },
              ],
            },
          ],
        },
      },
    })

    async function* mapStream(): AsyncGenerator<AgentStreamMessage> {
      for await (const message of run) {
        if (message.type !== 'assistant') continue
        const content = (message as { message?: { content?: unknown[] } }).message?.content ?? []
        for (const rawBlock of content) {
          const block = rawBlock as { type?: string; text?: string; name?: string; input?: unknown }
          if (block.type === 'text' && typeof block.text === 'string') {
            yield { type: 'text', text: block.text }
          } else if (block.type === 'thinking' && typeof block.text === 'string') {
            yield { type: 'thinking', text: block.text }
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const detail = summarizeToolInput(block.input)
            yield { type: 'tool', text: detail ? `${block.name}: ${detail}` : block.name }
          }
        }
      }
    }

    return {
      events: mapStream(),
      interrupt: async () => {
        await run.interrupt?.()
      },
    }
  }
}
