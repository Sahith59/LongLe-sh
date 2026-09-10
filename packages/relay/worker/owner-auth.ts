import { createClerkClient } from '@clerk/backend'
import { authorizedParties, type HostedAuthEnv } from './auth.js'

export interface OwnerAuthConfig extends HostedAuthEnv { OWNER_USER_IDS?: string }

export function ownerAllowed(userId: string | null, configured: string | undefined): boolean {
  return userId !== null && (configured ?? '').split(',').map(s => s.trim())
    .filter(s => /^user_[A-Za-z0-9]+$/.test(s)).includes(userId)
}

/** Only call with claims returned by Clerk's signature/issuer/expiry verification. */
export function recentOwnerMfa(claims: unknown): boolean {
  if (typeof claims !== 'object' || claims === null || !('fva' in claims)) return false
  const ages = claims.fva
  return Array.isArray(ages) && ages.length === 2 && ages.every(age =>
    typeof age === 'number' && Number.isFinite(age) && age >= 0 && age <= 10)
}

/** Separate from normal relay authentication: owner privilege never grants laptop access. */
export async function authenticateOwner(request: Request, env: OwnerAuthConfig): Promise<string | null> {
  const parties = authorizedParties(env)
  if (!env.CLERK_SECRET_KEY?.trim() || !env.CLERK_PUBLISHABLE_KEY?.trim() ||
    !env.OWNER_USER_IDS?.trim() || !request.headers.get('Authorization')?.startsWith('Bearer ') ||
    !parties.includes(new URL(request.url).origin)) return null
  try {
    const state = await createClerkClient({ publishableKey: env.CLERK_PUBLISHABLE_KEY.trim(), secretKey: env.CLERK_SECRET_KEY.trim() })
      .authenticateRequest(request, { acceptsToken: 'session_token', authorizedParties: parties })
    if (!state.isAuthenticated) return null
    const auth = state.toAuth()
    if (!ownerAllowed(auth.userId, env.OWNER_USER_IDS) || !recentOwnerMfa(auth.sessionClaims)) return null
    return auth.userId
  } catch { return null }
}
