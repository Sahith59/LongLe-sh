import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaudeAgentFactory } from '../src/adapters/claude.js'

const sdk = vi.hoisted(() => ({
  setModel: vi.fn(async () => {}),
  setMaxThinkingTokens: vi.fn(async () => {}),
  applyFlagSettings: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
  query: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdk.query,
}))

beforeEach(() => {
  vi.clearAllMocks()
  sdk.query.mockReturnValue({
    async *[Symbol.asyncIterator]() {},
    setModel: sdk.setModel,
    setMaxThinkingTokens: sdk.setMaxThinkingTokens,
    applyFlagSettings: sdk.applyFlagSettings,
    interrupt: sdk.interrupt,
  })
})

function handle() {
  return createClaudeAgentFactory()({
    sessionId: 'ses_claude',
    cwd: '/tmp/project',
    prompt: 'Review it',
    canUseTool: async () => ({ behavior: 'allow' }),
    onAutoApprovedTool: () => {},
    onAgentSession: () => {},
  })
}

describe('Claude live session controls', () => {
  it('changes model, effort, and adaptive thinking through the streaming SDK', async () => {
    const run = handle()
    await run.updateSettings?.({
      model: 'opus',
      effort: 'high',
      thinking: { mode: 'adaptive' },
    })
    expect(sdk.setModel).toHaveBeenCalledWith('opus')
    expect(sdk.applyFlagSettings).toHaveBeenNthCalledWith(1, { effortLevel: 'high' })
    expect(sdk.applyFlagSettings).toHaveBeenNthCalledWith(2, { alwaysThinkingEnabled: true })
    expect(sdk.setMaxThinkingTokens).toHaveBeenCalledWith(null)
  })

  it('supports fixed budgets, disabled thinking, and clearing back to provider defaults', async () => {
    const run = handle()
    await run.updateSettings?.({ thinking: { mode: 'fixed', budgetTokens: 16_384 } })
    expect(sdk.setMaxThinkingTokens).toHaveBeenLastCalledWith(16_384)

    await run.updateSettings?.({ thinking: { mode: 'disabled' } })
    expect(sdk.applyFlagSettings).toHaveBeenLastCalledWith({ alwaysThinkingEnabled: false })
    expect(sdk.setMaxThinkingTokens).toHaveBeenLastCalledWith(0)

    await run.updateSettings?.({})
    expect(sdk.setModel).toHaveBeenLastCalledWith(undefined)
    expect(sdk.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null })
    expect(sdk.applyFlagSettings).toHaveBeenLastCalledWith({ alwaysThinkingEnabled: null })
    expect(sdk.setMaxThinkingTokens).toHaveBeenLastCalledWith(null)
  })

  it('restores the last acknowledged controls when one part of an update is rejected', async () => {
    const run = handle()
    sdk.applyFlagSettings
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('thinking unavailable'))
    await expect(run.updateSettings?.({
      model: 'opus', effort: 'high', thinking: { mode: 'adaptive' },
    })).rejects.toThrow('thinking unavailable')
    // The rollback returns the session to its initial provider defaults.
    expect(sdk.setModel).toHaveBeenLastCalledWith(undefined)
    expect(sdk.applyFlagSettings).toHaveBeenLastCalledWith({ alwaysThinkingEnabled: null })
    expect(sdk.setMaxThinkingTokens).toHaveBeenLastCalledWith(null)
  })
})
