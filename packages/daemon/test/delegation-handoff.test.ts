import { describe, expect, it, vi } from 'vitest'
import { pauseCurrentSessionOwner } from '../src/delegation-handoff.js'
import type { SessionListing } from '../src/sessions.js'

const source = (extra: Partial<SessionListing> = {}): SessionListing => ({
  sessionId: 'ext_native-id',
  agent: 'claude',
  cwd: '/project',
  status: 'running',
  startedAt: 1,
  origin: 'vscode',
  title: 'Started in VS Code',
  live: true,
  resumable: true,
  resumeId: 'native-id',
  ...extra,
})

describe('delegation handoff ownership', () => {
  it('pauses the current managed owner even when the conversation originally came from VS Code', async () => {
    const pauseSession = vi.fn(async () => true)
    const stop = vi.fn(async () => true)
    const result = await pauseCurrentSessionOwner(
      { hasLiveSession: () => true, hasResumePoint: () => true, pauseSession },
      { hasLiveSession: () => false, stop },
      source(),
      'dev_phone',
      'delegating',
    )
    expect(result).toEqual({ paused: true })
    expect(pauseSession).toHaveBeenCalledWith('ext_native-id', 'dev_phone', 'delegating')
    expect(stop).not.toHaveBeenCalled()
  })

  it('uses the external stop channel only while Terminal or VS Code still owns the process', async () => {
    const pauseSession = vi.fn(async () => true)
    const stop = vi.fn(async () => true)
    const result = await pauseCurrentSessionOwner(
      { hasLiveSession: () => false, hasResumePoint: () => true, pauseSession },
      { hasLiveSession: () => true, stop },
      source({ origin: 'terminal' }),
      'dev_phone',
      'delegating',
    )
    expect(result.paused).toBe(true)
    expect(stop).toHaveBeenCalledWith('ext_native-id', 'dev_phone')
    expect(pauseSession).not.toHaveBeenCalled()
  })

  it('reports the actual safety gate and never claims a child failed to start', async () => {
    const result = await pauseCurrentSessionOwner(
      { hasLiveSession: () => true, hasResumePoint: () => false, pauseSession: vi.fn(async () => true) },
      { hasLiveSession: () => false, stop: vi.fn(async () => true) },
      source({ resumable: false, resumeId: undefined }),
      'dev_phone',
      'delegating',
    )
    expect(result).toMatchObject({ paused: false })
    expect(result.message).toContain('has not announced its native conversation ID')
    expect(result.message).toContain('No child was started')
  })
})
