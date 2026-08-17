import { useEffect, useState, type ReactNode } from 'react'
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  SignInButton,
  useAuth,
  useClerk,
  useUser,
} from '@clerk/react'
import { ArrowRight, KeyRound, Laptop, LockKeyhole, ShieldCheck, UserRoundCheck } from 'lucide-react'
import App from './App.js'
import { AccountProvider } from './lib/account-context.js'
import { configureAccountToken, configureCredentialAccount, forgetCredentialsFor } from './lib/client.js'

export interface HostedAuthConfig {
  required: boolean
  ready: boolean
  publishableKey?: string
}

const PENDING_PAIRING_KEY = 'longleash.pending-pairing'
const CANONICAL_APP_HOST = 'app.longleash.dev'

function isPairingLocation(url: URL): boolean {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  return (hash.has('c') && hash.has('s')) || (url.searchParams.has('c') && url.searchParams.has('s'))
}

export function rememberPairingLocation(storage: Storage, location: Location): void {
  const url = new URL(location.href)
  if (isPairingLocation(url)) storage.setItem(PENDING_PAIRING_KEY, `${url.pathname}${url.search}${url.hash}`)
}

export function restorePairingLocation(storage: Storage, location: Location, history: History): void {
  const pending = storage.getItem(PENDING_PAIRING_KEY)
  if (pending === null) return
  storage.removeItem(PENDING_PAIRING_KEY)
  if (isPairingLocation(new URL(location.href))) return
  try {
    const target = new URL(pending, location.origin)
    if (target.origin === location.origin && isPairingLocation(target)) {
      history.replaceState(null, '', `${target.pathname}${target.search}${target.hash}`)
    }
  } catch {
    // Corrupt session storage is not authority and is safe to ignore.
  }
}

export async function loadHostedAuthConfig(
  fetcher: typeof fetch = fetch,
  hostname = window.location.hostname,
): Promise<HostedAuthConfig> {
  try {
    const response = await fetcher('/api/auth/config', { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) {
      throw new Error('not an auth endpoint')
    }
    const raw = (await response.json()) as Partial<HostedAuthConfig>
    if (typeof raw.required !== 'boolean' || typeof raw.ready !== 'boolean') throw new Error('bad auth config')
    if (raw.required && raw.ready && !/^pk_(?:test|live)_/.test(raw.publishableKey ?? '')) {
      throw new Error('bad publishable key')
    }
    return {
      required: raw.required,
      ready: raw.ready,
      ...(typeof raw.publishableKey === 'string' ? { publishableKey: raw.publishableKey } : {}),
    }
  } catch {
    // A missing local endpoint means the daemon is serving the accountless app. The canonical
    // public hostname is different: a network/config failure there must never bypass sign-in.
    return hostname.toLowerCase() === CANONICAL_APP_HOST
      ? { required: true, ready: false }
      : { required: false, ready: true }
  }
}

export default function HostedAuth() {
  const [config, setConfig] = useState<HostedAuthConfig | null>(null)

  useEffect(() => {
    let live = true
    rememberPairingLocation(sessionStorage, window.location)
    void loadHostedAuthConfig().then((loaded) => {
      if (live) setConfig(loaded)
    })
    return () => { live = false }
  }, [])

  if (config === null) return <AccountLoading />
  if (!config.required) {
    configureCredentialAccount(null)
    configureAccountToken(null)
    return <AccountProvider value={{ hosted: false }}><App /></AccountProvider>
  }
  if (!config.ready || config.publishableKey === undefined) return <AccountUnavailable />

  return (
    <ClerkProvider
      publishableKey={config.publishableKey}
      afterSignOutUrl="/"
      signInFallbackRedirectUrl={window.location.href}
      signUpFallbackRedirectUrl={window.location.href}
    >
      <ClerkLoading><AccountLoading /></ClerkLoading>
      <ClerkFailed><AccountUnavailable /></ClerkFailed>
      <ClerkLoaded><HostedAccount /></ClerkLoaded>
    </ClerkProvider>
  )
}

function HostedAccount() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth()
  const { user } = useUser()
  const clerk = useClerk()

  if (!isLoaded) return <AccountLoading />
  if (!isSignedIn || userId === undefined || userId === null) {
    configureCredentialAccount(null)
    configureAccountToken(null)
    return <SignInGate />
  }

  configureCredentialAccount(userId)
  configureAccountToken(() => getToken())
  restorePairingLocation(sessionStorage, window.location, window.history)
  const label = user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? 'LongLeash account'

  const signOut = () => {
    configureAccountToken(null)
    configureCredentialAccount(null)
    void clerk.signOut({ redirectUrl: '/' })
  }

  const exportAccount = () => {
    if (!user) return
    const safe = {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        name: user.fullName,
        primaryEmail: user.primaryEmailAddress?.emailAddress ?? null,
        createdAt: user.createdAt?.toISOString() ?? null,
        lastSignInAt: user.lastSignInAt?.toISOString() ?? null,
      },
      excludedByDesign: [
        'provider credentials',
        'repositories',
        'transcripts',
        'prompts',
        'approval content',
        'pairing secrets',
      ],
      note: 'Development data stays on the paired laptop and is not part of the hosted account.',
    }
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(safe, null, 2)}\n`], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'longleash-account-export.json'
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    // Safari may not begin consuming the object URL synchronously with click().
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  const deleteAccount = async () => {
    if (!user) throw new Error('The account is not loaded.')
    await user.delete()
    // The account is gone. Remove its browser-side device credentials by captured user id so a
    // Clerk re-render cannot accidentally redirect cleanup into the unscoped local slot.
    forgetCredentialsFor(user.id)
    configureAccountToken(null)
    configureCredentialAccount(null)
    try {
      await clerk.signOut({ redirectUrl: '/' })
    } catch {
      // Deletion already succeeded; a stale frontend session must not turn that success into a
      // misleading failure. A hard navigation makes Clerk re-evaluate the now-deleted identity.
      window.location.assign('/')
    }
  }

  return (
    <AccountProvider
      value={{
        hosted: true,
        label,
        signOut,
        exportAccount,
        deleteAccount,
      }}
    >
      <App key={userId} />
    </AccountProvider>
  )
}

function AccountShell({ children }: { children: ReactNode }) {
  return (
    <main className="account-gate">
      <section className="account-panel">{children}</section>
      <p className="buildtag mono">build {__BUILD__}</p>
    </main>
  )
}

export function AccountLoading() {
  return (
    <AccountShell>
      <div className="account-mark"><img src="/icon-192.png" alt="" width={52} height={52} /></div>
      <p className="account-kicker">LongLeash account</p>
      <h1>Opening your control plane…</h1>
      <p className="account-copy">Checking the identity boundary before any paired device is shown.</p>
      <div className="account-loader" aria-label="Loading" />
    </AccountShell>
  )
}

export function AccountUnavailable() {
  return (
    <AccountShell>
      <div className="account-mark danger"><LockKeyhole size={25} aria-hidden="true" /></div>
      <p className="account-kicker">Securely unavailable</p>
      <h1>Sign-in is not ready.</h1>
      <p className="account-copy">
        LongLeash refused to open the hosted control plane without a verified account boundary.
        Nothing on your laptop was exposed. Try again after the launch configuration is complete.
      </p>
      <button className="key account-action" type="button" onClick={() => window.location.reload()}>
        Retry securely <ArrowRight size={17} aria-hidden="true" />
      </button>
    </AccountShell>
  )
}

export function SignInGate() {
  return (
    <AccountShell>
      <div className="account-heading">
        <div className="account-mark"><img src="/icon-192.png" alt="" width={52} height={52} /></div>
        <div>
          <p className="account-kicker">LongLeash account</p>
          <h1>Know who. Prove which laptop.</h1>
        </div>
      </div>
      <p className="account-copy">
        Your verified account confirms who you are. A fresh QR still decides which laptop you
        control. They are separate locks, and neither gives LongLeash your provider credentials.
      </p>
      <div className="account-boundaries" aria-label="LongLeash security boundaries">
        <Boundary icon={<UserRoundCheck />} title="Account" detail="Google or email" />
        <Boundary icon={<KeyRound />} title="Pairing QR" detail="Device authority" />
        <Boundary icon={<Laptop />} title="Your laptop" detail="Code stays here" />
      </div>
      <SignInButton mode="redirect" oauthFlow="redirect" fallbackRedirectUrl={window.location.href} withSignUp>
        <button className="key account-action" type="button">
          <UserRoundCheck size={19} aria-hidden="true" /> Continue to sign in <ArrowRight size={17} aria-hidden="true" />
        </button>
      </SignInButton>
      <p className="account-footnote">
        <ShieldCheck size={15} aria-hidden="true" /> Choose Google, email code, or email and password.
        Clerk handles credentials; repositories, transcripts, prompts, and pairing secrets stay outside your account.
      </p>
    </AccountShell>
  )
}

function Boundary({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="account-boundary"><span>{icon}</span><strong>{title}</strong><small>{detail}</small></div>
}
