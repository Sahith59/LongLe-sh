import { describe, expect, it, vi } from 'vitest'
import { availableAppBuild, publishedBuild } from '../src/lib/app-update.js'

describe('app update detection', () => {
  it('does not invent an update when the public shell is already current', () => {
    expect(availableAppBuild('web-current', 'web-current')).toBeNull()
  })

  it('offers only the build the public origin can actually serve', () => {
    expect(availableAppBuild('web-old', 'web-new')).toBe('web-new')
  })

  it('does not leave a permanent action when the manifest is unreachable', () => {
    expect(availableAppBuild('web-current', null)).toBeNull()
  })

  it('bypasses caches when checking the manifest', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ build: 'live-1' }), { status: 200 }))
    await expect(publishedBuild(fetcher as typeof fetch)).resolves.toBe('live-1')
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/^\/build\.json\?check=\d+$/),
      expect.objectContaining({ cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } }),
    )
  })
})
