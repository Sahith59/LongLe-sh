import { describe, expect, it } from 'vitest'
import { accountClassification, accountTotals, handleOwnerAccounts, type AccountDirectory, type OwnerAccountsEnv } from '../worker/owner-accounts.js'

const env: OwnerAccountsEnv = { PUBLIC_APP_HOST: 'app.longleash.dev', OWNER_USER_IDS: 'user_owner', TEST_USER_IDS: 'user_test',
  ACCOUNT_API_RATE: { limit: async () => ({ success: true }) } }
const source: AccountDirectory = {
  async list() { return { totalCount: 3, data: [{ id: 'user_external', firstName: 'Dev', lastName: null,
    primaryEmailAddress: { emailAddress: 'dev@example.com', verification: { status: 'verified' } }, createdAt: 1,
    lastActiveAt: 2, lastSignInAt: 2, twoFactorEnabled: false, passwordEnabled: true }] } },
  async count(input) { if (!input) return 3; if (input.userId?.includes('user_owner')) return 1; if (input.userId?.includes('user_test')) return 1; return 1 },
}

describe('owner account evidence', () => {
  it('classifies owner and test accounts separately and never stores a duplicate directory', async () => {
    expect(accountClassification('user_owner', ['user_owner'], ['user_test'])).toBe('owner')
    expect(accountClassification('user_test', ['user_owner'], ['user_test'])).toBe('test')
    expect((await accountTotals(env, source)).external).toBe(1)
  })
  it('requires the owner allowlist, app origin, and rate limiter', async () => {
    const good = new Request('https://app.longleash.dev/api/owner/accounts?offset=0', { headers: { Authorization: 'Bearer test' } })
    const response = await handleOwnerAccounts(good, env, async () => 'user_owner', source)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ users: [{ classification: 'external', primaryEmail: 'dev@example.com' }], totals: { registered: 3, external: 1 } })
    expect((await handleOwnerAccounts(good, env, async () => 'user_attacker', source)).status).toBe(403)
    expect((await handleOwnerAccounts(new Request('https://evil.example/api/owner/accounts'), env, async () => 'user_owner', source)).status).toBe(404)
    const limited = { ...env, ACCOUNT_API_RATE: { limit: async () => ({ success: false }) } }
    expect((await handleOwnerAccounts(good, limited, async () => 'user_owner', source)).status).toBe(429)
  })
})
