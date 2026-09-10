import { createClerkClient } from '@clerk/backend'
import { z } from 'zod'
import { authenticateOwner, type OwnerAuthConfig } from './owner-auth.js'
import { feedbackJson } from './feedback.js'

export interface OwnerAccountsEnv extends OwnerAuthConfig {
  ACCOUNT_API_RATE?: { limit(input: { key: string }): Promise<{ success: boolean }> }
  TEST_USER_IDS?: string
}

export interface DirectoryUser {
  id: string
  firstName: string | null
  lastName: string | null
  primaryEmailAddress: { emailAddress: string; verification: { status: string } | null } | null
  createdAt: number
  lastActiveAt: number | null
  lastSignInAt: number | null
  twoFactorEnabled: boolean
  passwordEnabled: boolean
}

export interface AccountDirectory {
  list(input: { limit: number; offset: number; query?: string; createdAtAfter?: number }):
    Promise<{ data: DirectoryUser[]; totalCount: number }>
  count(input?: { userId?: string[]; createdAtAfter?: number; createdAtBefore?: number;
    lastActiveAtAfter?: number; lastActiveAtBefore?: number }): Promise<number>
}

export function configuredIds(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map(item => item.trim())
    .filter(item => /^user_[A-Za-z0-9]+$/.test(item)))]
}

export function accountClassification(id: string, ownerIds: string[], testIds: string[]): 'owner' | 'test' | 'external' {
  if (ownerIds.includes(id)) return 'owner'
  if (testIds.includes(id)) return 'test'
  return 'external'
}

export function accountDirectory(env: OwnerAccountsEnv): AccountDirectory {
  const users = createClerkClient({ publishableKey: env.CLERK_PUBLISHABLE_KEY!.trim(), secretKey: env.CLERK_SECRET_KEY!.trim() }).users
  return {
    async list(input) {
      const result = await users.getUserList(input)
      return { data: result.data, totalCount: result.totalCount }
    },
    count: input => users.getCount(input),
  }
}

export async function accountTotals(env: OwnerAccountsEnv, source?: AccountDirectory, now = Date.now()) {
  const api = source ?? accountDirectory(env)
  const ownerIds = configuredIds(env.OWNER_USER_IDS)
  const testIds = configuredIds(env.TEST_USER_IDS).filter(value => !ownerIds.includes(value))
  const weekStart = now - 7 * 86_400_000
  const [registered, existingOwners, existingTests, newAccounts, activeAccounts] = await Promise.all([
    api.count(),
    ownerIds.length ? api.count({ userId: ownerIds }) : 0,
    testIds.length ? api.count({ userId: testIds }) : 0,
    api.count({ createdAtAfter: weekStart }),
    api.count({ lastActiveAtAfter: weekStart }),
  ])
  return { registered, owners: existingOwners, tests: existingTests,
    external: Math.max(0, registered - existingOwners - existingTests), newAccounts, activeAccounts }
}

export async function accountWindowTotals(env: OwnerAccountsEnv, start: number, end: number,
  source?: AccountDirectory) {
  const api = source ?? accountDirectory(env)
  const ownerIds = configuredIds(env.OWNER_USER_IDS)
  const testIds = configuredIds(env.TEST_USER_IDS).filter(value => !ownerIds.includes(value))
  const [registered, existingOwners, existingTests, newAccounts, activeAccounts] = await Promise.all([
    api.count(), ownerIds.length ? api.count({ userId: ownerIds }) : 0,
    testIds.length ? api.count({ userId: testIds }) : 0,
    api.count({ createdAtAfter: start, createdAtBefore: end }),
    api.count({ lastActiveAtAfter: start, lastActiveAtBefore: end }),
  ])
  return { registered, owners: existingOwners, tests: existingTests,
    external: Math.max(0, registered - existingOwners - existingTests), newAccounts, activeAccounts }
}

const querySchema = z.string().trim().max(80)
const offsetSchema = z.coerce.number().int().min(0).max(100_000)

/** Clerk remains the source of truth. This handler never persists an email or duplicates a user table. */
export async function handleOwnerAccounts(request: Request, env: OwnerAccountsEnv,
  authenticate = authenticateOwner, source?: AccountDirectory): Promise<Response> {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || url.hostname !== env.PUBLIC_APP_HOST || url.pathname !== '/api/owner/accounts') {
    return feedbackJson({ error: 'Not found' }, 404)
  }
  if (request.method !== 'GET') return feedbackJson({ error: 'Method not allowed' }, 405)
  const ownerId = await authenticate(request, env)
  if (!ownerId || !env.ACCOUNT_API_RATE) return feedbackJson({ error: 'Forbidden' }, 403)
  if (!(await env.ACCOUNT_API_RATE.limit({ key: `owner-accounts:${ownerId}` })).success) {
    const response = feedbackJson({ error: 'Too many requests. Wait one minute.' }, 429)
    response.headers.set('Retry-After', '60')
    return response
  }
  const offset = offsetSchema.safeParse(url.searchParams.get('offset') ?? '0')
  const query = querySchema.safeParse(url.searchParams.get('query') ?? '')
  if (!offset.success || !query.success) return feedbackJson({ error: 'Invalid account query' }, 400)
  const ownerIds = configuredIds(env.OWNER_USER_IDS)
  const testIds = configuredIds(env.TEST_USER_IDS).filter(value => !ownerIds.includes(value))
  if (!ownerIds.includes(ownerId)) return feedbackJson({ error: 'Forbidden' }, 403)
  try {
    const api = source ?? accountDirectory(env)
    const [page, totals] = await Promise.all([
      api.list({ limit: 25, offset: offset.data, ...(query.data ? { query: query.data } : {}) }),
      accountTotals(env, api),
    ])
    const users = page.data.map(user => ({
      id: user.id,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      primaryEmail: user.primaryEmailAddress?.emailAddress ?? null,
      emailVerified: user.primaryEmailAddress?.verification?.status === 'verified',
      createdAt: user.createdAt,
      lastActiveAt: user.lastActiveAt,
      lastSignInAt: user.lastSignInAt,
      twoFactorEnabled: user.twoFactorEnabled,
      passwordEnabled: user.passwordEnabled,
      classification: accountClassification(user.id, ownerIds, testIds),
    }))
    return feedbackJson({
      users,
      pagination: { offset: offset.data, limit: 25, total: page.totalCount,
        hasMore: offset.data + page.data.length < page.totalCount },
      totals,
      source: 'clerk-production',
      generatedAt: Date.now(),
    })
  } catch {
    return feedbackJson({ error: 'The account directory is temporarily unavailable. No cached list was shown.' }, 503)
  }
}
