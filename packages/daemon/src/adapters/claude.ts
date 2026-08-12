import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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

    // Streaming input keeps the session open between turns: the generator only ends when the
    // session is stopped, so follow-up messages continue the same conversation and transcript.
    const pending: string[] = [request.prompt]
    let wake: (() => void) | null = null
    let closed = false
    const push = (text: string) => {
      pending.push(text)
      wake?.()
      wake = null
    }

    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (pending.length > 0) {
          const text = pending.shift() as string
          yield {
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            session_id: '',
          } as unknown as SDKUserMessage
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }

    const run = query({
      prompt: input(),
      options: {
        // Pinned per session. Spike S0 showed an agent writing outside its stated cwd when
        // this is not enforced, and resume is keyed to cwd, so it must never drift.
        cwd: request.cwd,
        // A managed SDK session already reports through this adapter. If a caller elects to
        // load user settings, the globally installed LongLeash hook must still not mirror the
        // same process as a second external/ghost session.
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          LONGLEASH_MANAGED: '1',
        },
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        ...(request.settings?.model === undefined && options.model === undefined
          ? {}
          : { model: request.settings?.model ?? options.model }),
        ...(request.settings?.effort === undefined ? {} : { effort: request.settings.effort }),
        ...(request.settings?.thinking === undefined
          ? {}
          : request.settings.thinking.mode === 'fixed'
            ? { thinking: { type: 'enabled' as const, budgetTokens: request.settings.thinking.budgetTokens as number } }
            : request.settings.thinking.mode === 'adaptive'
              ? { thinking: { type: 'adaptive' as const } }
              : { thinking: { type: 'disabled' as const } }),
        ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
        ...(options.isolateFromUserSettings ? { settingSources: [] } : {}),
        // Reopening a closed conversation: Claude replays its own transcript, so the agent
        // picks up with everything it knew before.
        ...(request.resume === undefined ? {} : { resume: request.resume }),
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
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
          const id = (message as { session_id?: string }).session_id
          if (id) request.onAgentSession(id)
          continue
        }
        if (message.type === 'result') {
          // A turn finished; the human may reply, so do not end the session here.
          yield { type: 'turn-end' }
          continue
        }
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
      sendMessage: (text: string) => push(text),
      interrupt: async () => {
        closed = true
        wake?.()
        wake = null
        await run.interrupt?.()
      },
    }
  }
}
