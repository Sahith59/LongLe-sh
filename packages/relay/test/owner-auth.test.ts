import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }))
vi.mock('@clerk/backend', () => ({ createClerkClient: () => ({ authenticateRequest: mocks.authenticate }) }))
import { authenticateOwner, recentOwnerMfa } from '../worker/owner-auth.js'

const config = { PUBLIC_APP_HOST: 'app.longleash.dev', CLERK_PUBLISHABLE_KEY: 'pk_test_fixture', CLERK_SECRET_KEY: 'sk_test_fixture', OWNER_USER_IDS: 'user_owner' }
const request = () => new Request('https://app.longleash.dev/api/owner/feedback', { headers: { Authorization: 'Bearer fixture' } })
const verified = (userId = 'user_owner', fva: unknown = [0, 0]) => ({ isAuthenticated: true, toAuth: () => ({ userId, sessionClaims: { fva } }) })

describe('owner privilege requires explicit identity and verified recent MFA', () => {
  beforeEach(() => { mocks.authenticate.mockReset() })
  it.each([undefined, {}, { fva: [0, -1] }, { fva: [0, 11] }, { fva: [11, 0] }, { fva: ['0', 0] }, { fva: [0] }, { fva: [0, NaN] }, { fva: [0, Infinity] }])('rejects absent, stale, or malformed factor ages', claims => {
    expect(recentOwnerMfa(claims)).toBe(false)
  })
  it('accepts fresh signed ages including the ten-minute boundary', () => {
    expect(recentOwnerMfa({ fva: [0, 0] })).toBe(true)
    expect(recentOwnerMfa({ fva: [10, 10] })).toBe(true)
  })
  it('uses Clerk verification with an exact authorized party and session tokens only', async () => {
    mocks.authenticate.mockResolvedValue(verified())
    expect(await authenticateOwner(request(), config)).toBe('user_owner')
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), { acceptsToken: 'session_token', authorizedParties: ['https://app.longleash.dev'] })
  })
  it('rejects valid ordinary users even with MFA', async () => {
    mocks.authenticate.mockResolvedValue(verified('user_other'))
    expect(await authenticateOwner(request(), config)).toBeNull()
  })
  it('does not downgrade to first-factor-only authentication', async () => {
    mocks.authenticate.mockResolvedValue(verified('user_owner', [0, -1]))
    expect(await authenticateOwner(request(), config)).toBeNull()
  })
  it('rejects invalid signatures and provider errors without exposing detail', async () => {
    mocks.authenticate.mockResolvedValue({ isAuthenticated: false })
    expect(await authenticateOwner(request(), config)).toBeNull()
    mocks.authenticate.mockRejectedValue(new Error('private provider failure'))
    expect(await authenticateOwner(request(), config)).toBeNull()
  })
  it('rejects noncanonical origins, missing bearer tokens, and unconfigured owner IDs', async () => {
    expect(await authenticateOwner(new Request('https://evil.example/api/owner/feedback', { headers: { Authorization: 'Bearer fixture' } }), config)).toBeNull()
    expect(await authenticateOwner(new Request('https://app.longleash.dev/api/owner/feedback'), config)).toBeNull()
    expect(await authenticateOwner(request(), { ...config, OWNER_USER_IDS: '' })).toBeNull()
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })
})
