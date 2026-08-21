import {
  DelegationPreviewSchema,
  DelegationReturnPreviewSchema,
  DelegationUpdateSchema,
  PROTOCOL_VERSION,
  derivePairingIdentity,
  deriveRelayIdentity,
  open as openEnvelope,
  seal,
  type RelayIdentity,
  type DelegationContextScope,
  type DelegationPreview,
  type DelegationSummary,
  type DelegationReturnPreview,
  type DelegationRole,
  type DelegationTargetAgent,
  type SessionEvent,
  type SessionSettings,
  type WorkspaceMode,
} from '@longleash/protocol'
import type { SessionSeed, Store } from './store.js'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'unauthorized' | 'revoked'
/** How the phone is currently reaching the laptop. */
export type LinkPath = 'lan' | 'relay'

export interface Diagnostics {
  reachable: boolean
  detail: string
}

const TOKEN_KEY = 'longleash.token'
const RELAY_SECRET_KEY = 'longleash.relaySecret'
const RELAY_URL_KEY = 'longleash.relayUrl'
const RELAY_PROTOCOL = 'longleash-v1'

let credentialAccount: string | null = null
let accountToken: (() => Promise<string | null>) | null = null

/**
 * The hosted app calls this before App mounts. Pairing credentials then belong to exactly one
 * signed-in LongLeash account in this browser. LAN/self-hosted mode passes null and retains the
 * original accountless keys. Existing unscoped credentials are deliberately not migrated: a
 * public account must prove ownership by pairing again instead of silently inheriting a device.
 */
export function configureCredentialAccount(userId: string | null): void {
  credentialAccount = userId
}

/** Supplies a short-lived Clerk session token only to the hosted relay-ticket endpoint. */
export function configureAccountToken(provider: (() => Promise<string | null>) | null): void {
  accountToken = provider
}

export function credentialKey(base: string, userId: string | null = credentialAccount): string {
  return userId === null ? base : `${base}.account.${encodeURIComponent(userId)}`
}

function readCredential(base: string): string | null {
  return localStorage.getItem(credentialKey(base))
}

function writeCredential(base: string, value: string): void {
  localStorage.setItem(credentialKey(base), value)
}

function removeCredential(base: string): void {
  localStorage.removeItem(credentialKey(base))
}

/** How long an attempt may sit silent before the other path gets its turn. */
const OPEN_TIMEOUT_MS = 4000
/** Connected to the relay but the laptop is not in the room: how long to wait for it. */
const HOST_WAIT_MS = 8000
/** While away, how often to check whether home is reachable again. */
const HOME_PROBE_MS = 15_000
/**
 * Proxies cull a WebSocket that has carried nothing for roughly 100 seconds. A room where
 * nobody happens to be typing is exactly that, so it must still say something.
 */
const KEEPALIVE_MS = 30_000

export function storedToken(): string | null {
  return readCredential(TOKEN_KEY)
}

export function storedRelaySecret(): string | null {
  return readCredential(RELAY_SECRET_KEY)
}

export function storedRelayUrl(): string | null {
  return readCredential(RELAY_URL_KEY)
}

/**
 * Which kind of server is behind this page's own origin. Served by the daemon (at home),
 * the LAN path exists and comes first; served by the relay (the away entry, HTTPS, where
 * the PWA lives), there is no LAN path behind the origin and pretending otherwise would
 * loop forever — which is exactly what a hand test caught.
 */
export async function detectOrigin(): Promise<'daemon' | 'relay' | 'unknown'> {
  try {
    const res = await fetch('/health', { cache: 'no-store' })
    if (!res.ok) return 'unknown'
    const body = (await res.json()) as { role?: string; name?: string }
    if (body.role === 'relay') return 'relay'
    if (body.name === 'longleash') return 'daemon'
    return 'unknown'
  } catch {
    // Offline shell: no one answered. The stored relay URL is the only road anyway.
    return 'unknown'
  }
}

/** This page's own origin as a relay websocket endpoint. */
function ownRelayEndpoint(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws`
}

/** Both relays accept it; only the Worker needs it. */
function withRoom(endpoint: string, roomTag: string): string {
  const url = new URL(endpoint)
  url.searchParams.set('room', roomTag)
  return url.toString()
}

function withRelayRole(endpoint: string, roomTag: string, role: 'host' | 'guest'): string {
  const url = new URL(withRoom(endpoint, roomTag))
  url.searchParams.set('role', role)
  return url.toString()
}

function relayTicketEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/api/relay-ticket'
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function guestProtocols(endpoint: string, room: string): Promise<string[] | undefined> {
  if (accountToken === null) return undefined
  const token = await accountToken()
  if (token === null) throw new Error('Your LongLeash sign-in expired. Sign in again, then retry.')
  const response = await fetch(relayTicketEndpoint(endpoint), {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ room, role: 'guest' }),
  })
  if (!response.ok) {
    if (response.status === 401) throw new Error('Your LongLeash sign-in expired. Sign in again, then retry.')
    if (response.status === 429) throw new Error('Too many reconnects. Wait one minute, then retry.')
    throw new Error('The hosted relay could not authorize this connection.')
  }
  const body = (await response.json()) as { protocol?: unknown }
  if (typeof body.protocol !== 'string' || !body.protocol.startsWith('ll-ticket.')) {
    throw new Error('The hosted relay returned an invalid connection ticket.')
  }
  return [RELAY_PROTOCOL, body.protocol]
}

async function guestSocket(endpoint: string, room: string): Promise<WebSocket> {
  const protocols = await guestProtocols(endpoint, room)
  const url = withRelayRole(endpoint, room, 'guest')
  return protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols)
}

export async function pair(challengeId: string, secret: string): Promise<string> {
  if ((await detectOrigin()) === 'relay') return pairViaRelay(challengeId, secret)
  const res = await fetch(`/pair?c=${encodeURIComponent(challengeId)}&s=${encodeURIComponent(secret)}`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string }
    throw new Error(body.reason ?? 'pairing rejected')
  }
  const { token, relaySecret } = (await res.json()) as { token: string; relaySecret?: string }
  writeCredential(TOKEN_KEY, token)
  // The E2E root for the relay path. Captured now, at the one moment the laptop and phone
  // share a LAN-only channel, so this pairing works remotely without ever re-pairing.
  if (relaySecret) writeCredential(RELAY_SECRET_KEY, relaySecret)
  return token
}

/**
 * Pairing when the phone can only see the relay: both sides derive a short-lived room and
 * key from the QR's challenge secret, and the whole exchange travels sealed. The relay sees
 * a room open, two joins, two envelopes, a room close — nothing else.
 */
async function pairViaRelay(challengeId: string, secret: string): Promise<string> {
  const identity = await derivePairingIdentity(secret)
  const endpoint = ownRelayEndpoint()
  const socket = await guestSocket(endpoint, identity.roomTag)

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (result: { token: string } | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.close()
      if (result instanceof Error) reject(result)
      else resolve(result.token)
    }
    const deadline = setTimeout(
      () => finish(new Error('Your laptop did not answer — is longleashd running with the relay configured?')),
      15_000,
    )

    socket.onopen = () => {
      socket.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'guest' }))
    }
    socket.onerror = () => finish(new Error('Could not reach the relay.'))
    socket.onmessage = (raw) => {
      let message: { type?: unknown; payload?: unknown; role?: unknown; event?: unknown; host?: unknown }
      try {
        message = JSON.parse(String(raw.data)) as typeof message
      } catch {
        return
      }
      const sendRequest = (): void => {
        void seal(
          identity,
          JSON.stringify({
            v: 1,
            type: 'completePairing',
            challengeId,
            secret,
            deviceName: navigator.userAgent.slice(0, 64),
          }),
        ).then((payload) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ v: 1, type: 'frame', payload }))
          }
        })
      }
      if (message.type === 'joined' && message.host === true) sendRequest()
      if (message.type === 'peer' && message.role === 'host' && message.event === 'joined') sendRequest()
      if (message.type === 'frame' && typeof message.payload === 'string') {
        void openEnvelope(identity, message.payload).then((text) => {
          if (text === null) return
          const reply = JSON.parse(text) as { type?: string; token?: string; relaySecret?: string; reason?: string }
          if (reply.type === 'paired' && reply.token && reply.relaySecret) {
            writeCredential(TOKEN_KEY, reply.token)
            writeCredential(RELAY_SECRET_KEY, reply.relaySecret)
            writeCredential(RELAY_URL_KEY, endpoint)
            finish({ token: reply.token })
          } else if (reply.type === 'pair-error') {
            finish(new Error(`Pairing refused: ${reply.reason ?? 'unknown'}`))
          }
        })
      }
    }
  })
}

export function forgetToken(): void {
  removeCredential(TOKEN_KEY)
  removeCredential(RELAY_SECRET_KEY)
  removeCredential(RELAY_URL_KEY)
}

export function forgetCredentialsFor(userId: string): void {
  localStorage.removeItem(credentialKey(TOKEN_KEY, userId))
  localStorage.removeItem(credentialKey(RELAY_SECRET_KEY, userId))
  localStorage.removeItem(credentialKey(RELAY_URL_KEY, userId))
}

/**
 * Separates "your network cannot reach the laptop" from "pairing failed" — conflating them
 * cost hours during field testing, where a VPN silently swallowed all phone-to-laptop traffic.
 */
export async function checkReachable(): Promise<Diagnostics> {
  try {
    const res = await fetch('/health', { cache: 'no-store' })
    if (!res.ok) return { reachable: false, detail: `Laptop answered with ${res.status}.` }
    return { reachable: true, detail: 'Laptop is reachable.' }
  } catch {
    return {
      reachable: false,
      detail: storedRelayUrl()
        ? 'Your laptop is not on this network — reaching it through the relay instead.'
        : 'Cannot reach your laptop. Check you are on the same network, and turn off any VPN — a full-tunnel VPN blocks phone-to-laptop traffic entirely.',
    }
  }
}

export interface Hello {
  deviceId: string
  roots: string[]
  sessions: SessionSeed[]
  capabilities: {
    startSession: boolean
    stopSession: boolean
    parallelWorkspaces?: 'git-worktree'
    sessionSettings?: Record<'claude' | 'codex', {
      models: string[]
      efforts: string[]
      thinking: string[]
    }>
    delegation?: {
      preview: boolean
      start: boolean
      targets: { claude: boolean; codex: boolean }
      maxDepth: number
      maxActivePerSource: number
      return?: boolean
      workspace?: 'legacy' | 'sequential'
    }
  }
  delegations?: DelegationSummary[]
  relay?: { url: string } | null
  /** VAPID public key for lock-screen alerts; null when the daemon has push disabled. */
  push?: { publicKey: string } | null
  /**
   * The app build this laptop expects. The phone usually loads the app from the RELAY, so a
   * laptop update changes nothing here — and every new feature just appears missing. When this
   * disagrees with our own stamp, the app is running old code and must say so rather than let
   * the product look broken.
   */
  expectsApp?: string | null
}

export type AgentSettingsCatalog = NonNullable<Hello['capabilities']['sessionSettings']>

export interface FolderHit {
  path: string
  label: string
  kind: 'folder' | 'file'
  /** For a file, the folder an agent would actually work in. */
  parent?: string
}

export interface ClientCallbacks {
  onState: (state: ConnectionState) => void
  /** True while durable replay is being folded into one calm, coherent UI snapshot. */
  onHydration?: (hydrating: boolean) => void
  /** The daemon tells us which directories are usable — never make the user type a path. */
  onHello: (hello: Hello) => void
  /** Errors must reach the person. Swallowing them makes the app look broken. */
  onError: (message: string) => void
  /** Folder search results, so a project can be picked by name rather than typed as a path. */
  onFolders: (query: string, results: FolderHit[]) => void
  onSessionStarted?: (requestId: string | undefined, sessionId: string) => void
  onSessionStartError?: (requestId: string | undefined, message: string) => void
  onSessionSettingsUpdated?: (
    requestId: string,
    sessionId: string,
    outcome: 'next-response' | 'next-continuation',
  ) => void
  onSessionSettingsError?: (requestId: string, message: string) => void
  /** Exact deterministic briefing returned for editing; this never means a child was started. */
  onDelegationPreview?: (preview: DelegationPreview) => void
  onDelegationReturnPreview?: (preview: DelegationReturnPreview) => void
  /** Durable launch/status updates; requestId is present only for the initiating device. */
  onDelegationUpdate?: (delegation: DelegationSummary, requestId?: string, created?: boolean) => void
  /** Preview errors are correlated so an older request cannot overwrite the current sheet. */
  onDelegationError?: (requestId: string, message: string) => void
  /** Which path carries the link right now — the UI shows "away" when it is the relay. */
  onPath?: (path: LinkPath) => void
}

/** The two transports look identical from above: text out, text in, and a verdict on death. */
interface Wire {
  send(text: string): boolean
  close(): void
}

interface WireEvents {
  onReady: () => void
  onText: (text: string) => void
  /** auth/revoked are final; net means "try the other road". */
  onDown: (reason: 'auth' | 'revoked' | 'net') => void
}

function lanWire(token: string, events: WireEvents): Wire {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`)
  let opened = false
  // A socket to an unreachable address can hang far longer than a person will wait.
  const timer = setTimeout(() => {
    if (!opened) socket.close()
  }, OPEN_TIMEOUT_MS)

  socket.onopen = () => {
    opened = true
    clearTimeout(timer)
    events.onReady()
  }
  socket.onmessage = (event) => events.onText(String(event.data))
  socket.onclose = (event) => {
    clearTimeout(timer)
    if (event.code === 4401) events.onDown('auth')
    else if (event.code === 4403) events.onDown('revoked')
    else events.onDown('net')
  }
  return {
    send: (text) => {
      if (socket.readyState !== WebSocket.OPEN) return false
      socket.send(text)
      return true
    },
    close: () => {
      socket.onclose = null
      socket.close()
    },
  }
}

async function relayWire(url: string, identity: RelayIdentity, events: WireEvents): Promise<Wire> {
  // The room tag rides the URL as well as the join message: the Worker relay must pick a
  // Durable Object before the upgrade completes, and the Node relay simply ignores it.
  const socket = await guestSocket(url, identity.roomTag)
  let ready = false
  let incoming = Promise.resolve()
  let outgoing = Promise.resolve()
  let keepalive: ReturnType<typeof setInterval> | null = null
  const stopKeepalive = () => {
    if (keepalive !== null) clearInterval(keepalive)
    keepalive = null
  }
  const startKeepalive = () => {
    stopKeepalive()
    keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ v: 1, type: 'ping' }))
      }
    }, KEEPALIVE_MS)
  }
  const openTimer = setTimeout(() => {
    if (!ready) socket.close()
  }, OPEN_TIMEOUT_MS)
  // Joined but the laptop is absent: give its link a moment to reconnect, then hand the
  // turn back rather than sitting in an empty room forever.
  let hostTimer: ReturnType<typeof setTimeout> | null = null

  socket.onopen = () => {
    socket.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'guest' }))
  }
  socket.onmessage = (raw) => {
    let message: { type?: unknown; payload?: unknown; role?: unknown; event?: unknown; host?: unknown }
    try {
      message = JSON.parse(String(raw.data)) as typeof message
    } catch {
      return // the relay is not trusted; garbage is ignored, never fatal
    }
    if (message.type === 'joined') {
      clearTimeout(openTimer)
      if (message.host === true) {
        ready = true
        startKeepalive()
        events.onReady()
      } else {
        hostTimer = setTimeout(() => socket.close(), HOST_WAIT_MS)
      }
      return
    }
    if (message.type === 'peer' && message.role === 'host') {
      if (message.event === 'joined' && !ready) {
        if (hostTimer) clearTimeout(hostTimer)
        ready = true
        startKeepalive()
        events.onReady()
      }
      if (message.event === 'left') socket.close()
      return
    }
    if (message.type === 'frame' && typeof message.payload === 'string') {
      const payload = message.payload
      incoming = incoming
        .then(async () => {
          const text = await openEnvelope(identity, payload)
          // A frame that fails authentication never existed, as far as the app is concerned.
          if (text !== null) events.onText(text)
        })
        .catch(() => {})
    }
  }
  socket.onclose = () => {
    clearTimeout(openTimer)
    if (hostTimer) clearTimeout(hostTimer)
    stopKeepalive()
    events.onDown('net')
  }
  return {
    send: (text) => {
      if (!ready || socket.readyState !== WebSocket.OPEN) return false
      outgoing = outgoing
        .then(async () => {
          const payload = await seal(identity, text)
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ v: 1, type: 'frame', payload }))
          }
        })
        .catch(() => {})
      return true
    },
    close: () => {
      socket.onclose = null
      stopKeepalive()
      socket.close()
    },
  }
}

/**
 * Home first, world second: the LAN path is tried before the relay on every cycle, so being
 * at home never routes through a server it does not need — and leaving home just means the
 * next attempt lands on the relay. Both paths carry the identical protocol; the relay one
 * carries it sealed.
 */
export function connect(token: string, store: Store, callbacks: ClientCallbacks) {
  let closed = false
  let wire: Wire | null = null
  let attempt = 0
  /** The pending backoff, so a network change can cancel it instead of waiting it out. */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let path: LinkPath = 'lan'
  let relayOrigin = false
  const subscribed = new Set<string>()
  const pendingSync = new Map<string, string>()
  let syncGeneration = 0
  let hydrationTimer: ReturnType<typeof setTimeout> | null = null
  let identity: RelayIdentity | null = null
  let homeProbe: ReturnType<typeof setInterval> | null = null

  const stopHomeProbe = (): void => {
    if (homeProbe !== null) clearInterval(homeProbe)
    homeProbe = null
  }

  /**
   * A healthy relay link never breaks on its own, so without this the app would keep
   * routing through the relay long after you walked back in the door. Probe the home
   * origin quietly; the moment it answers, trade the relay for the direct path.
   */
  const startHomeProbe = (): void => {
    stopHomeProbe()
    homeProbe = setInterval(() => {
      void (async () => {
        try {
          const abort = new AbortController()
          const timer = setTimeout(() => abort.abort(), 3000)
          const res = await fetch('/health', { cache: 'no-store', signal: abort.signal })
          clearTimeout(timer)
          if (!res.ok) return
        } catch {
          return // still away
        }
        stopHomeProbe()
        const old = wire
        wire = null
        old?.close()
        path = 'lan'
        callbacks.onState('reconnecting')
        void attach()
      })()
    }, HOME_PROBE_MS)
  }

  const send = (message: unknown): boolean => wire?.send(JSON.stringify(message)) ?? false

  const finishHydration = (generation: number): void => {
    if (generation !== syncGeneration) return
    if (hydrationTimer !== null) clearTimeout(hydrationTimer)
    hydrationTimer = null
    pendingSync.clear()
    store.endHydration()
    // Keep layout motion disabled for the coherent paint that endHydration just requested.
    const completedGeneration = generation
    setTimeout(() => {
      if (completedGeneration === syncGeneration) callbacks.onHydration?.(false)
    }, 0)
  }

  const subscribe = (sessionId: string, syncId?: string): void => {
    subscribed.add(sessionId)
    send({
      v: PROTOCOL_VERSION,
      type: 'subscribe',
      sessionId,
      fromCursor: store.cursors()[sessionId] ?? 0,
      ...(syncId === undefined ? {} : { syncId }),
    })
  }

  const subscribeForHydration = (sessionId: string): void => {
    const syncId = `sync-${syncGeneration}-${sessionId}-${Math.random().toString(36).slice(2, 8)}`
    pendingSync.set(sessionId, syncId)
    subscribe(sessionId, syncId)
  }

  const handleText = (raw: string): void => {
    const message = JSON.parse(raw) as Record<string, unknown>
    if (message.type === 'gap') {
      store.applyGap(String(message.sessionId))
      if (pendingSync.has(String(message.sessionId))) subscribeForHydration(String(message.sessionId))
      else subscribe(String(message.sessionId))
      return
    }
    if (
      message.type === 'sync.complete' &&
      typeof message.sessionId === 'string' &&
      typeof message.syncId === 'string' &&
      pendingSync.get(message.sessionId) === message.syncId
    ) {
      pendingSync.delete(message.sessionId)
      if (pendingSync.size === 0) finishHydration(syncGeneration)
      return
    }
    if (message.type === 'ack' && message.of === 'startSession' && typeof message.sessionId === 'string') {
      subscribe(message.sessionId)
      callbacks.onSessionStarted?.(
        typeof message.requestId === 'string' ? message.requestId : undefined,
        message.sessionId,
      )
      return
    }
    if (
      message.type === 'ack' &&
      message.of === 'stopSession' &&
      typeof message.sessionId === 'string' &&
      (message.outcome === 'stopped' || message.outcome === 'not-running')
    ) {
      // "not-running" means the requested outcome is already true. Treating it as a no-op
      // left a dead card and dead Stop button on screen forever.
      store.settleSession(message.sessionId)
      return
    }
    if (
      message.type === 'ack' &&
      message.of === 'updateSessionSettings' &&
      typeof message.requestId === 'string' &&
      typeof message.sessionId === 'string' &&
      (message.outcome === 'next-response' || message.outcome === 'next-continuation')
    ) {
      callbacks.onSessionSettingsUpdated?.(
        message.requestId,
        message.sessionId,
        message.outcome,
      )
      return
    }
    if (message.type === 'hello') {
      const hello = message as unknown as Hello
      // Learn where the daemon lives beyond the LAN, so leaving home is survivable.
      if (hello.relay?.url) writeCredential(RELAY_URL_KEY, hello.relay.url)
      // Fold hello plus every historical stream into one render. Painting the individual replay
      // states made cards jump between Active and Earlier while layout animation chased them.
      syncGeneration += 1
      const generation = syncGeneration
      pendingSync.clear()
      store.beginHydration()
      callbacks.onHydration?.(true)
      store.seedSessions(hello.sessions ?? [])
      for (const session of hello.sessions ?? []) subscribeForHydration(session.sessionId)
      if ((hello.sessions ?? []).length === 0) finishHydration(generation)
      else {
        // Compatibility with an older daemon that does not emit sync.complete. Correctness still
        // comes from cursor de-duplication; only the calm single-paint optimization times out.
        if (hydrationTimer !== null) clearTimeout(hydrationTimer)
        hydrationTimer = setTimeout(() => finishHydration(generation), 1_500)
      }
      callbacks.onHello(hello)
      return
    }
    if (message.type === 'folders') {
      callbacks.onFolders(String(message.query ?? ''), (message.results ?? []) as FolderHit[])
      return
    }
    if (message.type === 'delegationPreview') {
      const parsed = DelegationPreviewSchema.safeParse(message)
      if (parsed.success) callbacks.onDelegationPreview?.(parsed.data)
      else callbacks.onError('The laptop returned an invalid delegation preview.')
      return
    }
    if (message.type === 'delegationReturnPreview') {
      const parsed = DelegationReturnPreviewSchema.safeParse(message)
      if (parsed.success) callbacks.onDelegationReturnPreview?.(parsed.data)
      else callbacks.onError('The laptop returned an invalid delegation return preview.')
      return
    }
    if (message.type === 'delegation') {
      const parsed = DelegationUpdateSchema.safeParse(message)
      if (parsed.success) {
        callbacks.onDelegationUpdate?.(
          parsed.data.delegation,
          parsed.data.requestId,
          parsed.data.created,
        )
      } else callbacks.onError('The laptop returned invalid delegation state.')
      return
    }
    if (message.type === 'error') {
      const detail = String(message.message ?? message.code ?? 'Something went wrong')
      if (message.of === 'startSession') {
        callbacks.onSessionStartError?.(
          typeof message.requestId === 'string' ? message.requestId : undefined,
          detail,
        )
      } else if (
        message.of === 'updateSessionSettings' &&
        typeof message.requestId === 'string'
      ) {
        callbacks.onSessionSettingsError?.(message.requestId, detail)
      } else if (typeof message.requestId === 'string' && callbacks.onDelegationError) {
        callbacks.onDelegationError(message.requestId, detail)
      } else callbacks.onError(detail)
      return
    }
    if (message.type === 'ack' && message.outcome === 'unknown') {
      callbacks.onError('That approval is no longer waiting — it may have expired.')
      return
    }
    if (typeof message.seq === 'number') store.apply(message as unknown as SessionEvent)
  }

  const events: WireEvents = {
    onReady: () => {
      attempt = 0
      callbacks.onState('connected')
      callbacks.onPath?.(path)
      // On the relay's own origin /health is the relay itself — "home" would always answer.
      if (path === 'relay' && !relayOrigin) startHomeProbe()
      else stopHomeProbe()
      // Every known session resumes from its own cursor, so nothing is missed or repeated.
      for (const sessionId of subscribed) subscribe(sessionId)
    },
    onText: handleText,
    onDown: (reason) => {
      if (closed) return
      finishHydration(syncGeneration)
      stopHomeProbe()
      wire = null
      if (reason === 'auth') {
        callbacks.onState('unauthorized')
        return
      }
      if (reason === 'revoked') {
        callbacks.onState('revoked')
        return
      }
      callbacks.onState('reconnecting')
      const relayReady = storedRelaySecret() !== null && storedRelayUrl() !== null
      if (!relayOrigin && path === 'lan' && relayReady) {
        // The other road, immediately — the failed LAN attempt already cost its timeout.
        path = 'relay'
        void attach()
        return
      }
      path = relayOrigin ? 'relay' : 'lan'
      const delay = Math.min(1000 * 2 ** attempt, 15_000)
      attempt += 1
      retryTimer = setTimeout(() => void attach(), delay)
    },
  }

  /**
   * Backoff is right for a laptop that keeps refusing, and wrong for a phone that just
   * changed networks. Walking out of the house swaps Wi-Fi for cellular: the socket dies,
   * a backoff of up to fifteen seconds begins, and the app you pull out of your pocket
   * says "reconnecting" for no reason — the new network was ready the whole time.
   *
   * So two things collapse the wait to nothing: the browser reporting it is online again,
   * and the app becoming visible. Both mean the world just changed in our favour, and
   * neither is worth waiting out a timer for.
   */
  const reconnectNow = (): void => {
    if (closed || wire !== null) return
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    attempt = 0
    void attach()
  }
  const onOnline = (): void => reconnectNow()
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') reconnectNow()
  }
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisible)

  const attach = async (): Promise<void> => {
    if (closed) return
    if (path === 'relay') {
      const secret = storedRelaySecret()
      // On the relay's own origin the endpoint is simply this origin.
      const url = relayOrigin ? ownRelayEndpoint() : storedRelayUrl()
      if (secret !== null && url !== null) {
        try {
          identity ??= await deriveRelayIdentity(secret)
          wire = await relayWire(url, identity, events)
          return
        } catch {
          // A corrupt stored secret must not wedge the app; fall through to the LAN.
        }
      }
      path = 'lan'
    }
    wire = lanWire(token, events)
  }

  callbacks.onState('connecting')
  void (async () => {
    relayOrigin = (await detectOrigin()) === 'relay'
    if (relayOrigin) path = 'relay'
    void attach()
  })()

  return {
    subscribe,
    startSession: (
      root: string,
      prompt: string,
      agent: 'claude' | 'codex' = 'claude',
      options: { workspaceMode?: WorkspaceMode; settings?: SessionSettings; requestId?: string } = {},
    ) => {
      const sent = send({
        v: PROTOCOL_VERSION,
        type: 'startSession',
        agent,
        root,
        prompt,
        workspaceMode: options.workspaceMode ?? 'auto',
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        ...(options.settings === undefined ? {} : { settings: options.settings }),
      })
      if (!sent) callbacks.onError('Not connected to your laptop — the task was not sent.')
      return sent
    },
    stopSession: (sessionId: string) => send({ v: PROTOCOL_VERSION, type: 'stopSession', sessionId }),
    findFolders: (query: string) => send({ v: PROTOCOL_VERSION, type: 'findFolders', query }),
    resumeSession: (sessionId: string) => {
      const sent = send({ v: PROTOCOL_VERSION, type: 'resumeSession', sessionId })
      if (!sent) callbacks.onError('Not connected to your laptop.')
      return sent
    },
    sendMessage: (sessionId: string, text: string) => {
      const sent = send({ v: PROTOCOL_VERSION, type: 'sendMessage', sessionId, text })
      if (!sent) callbacks.onError('Not connected to your laptop — the message was not sent.')
      return sent
    },
    pushSubscribe: (subscription: unknown) =>
      send({ v: PROTOCOL_VERSION, type: 'pushSubscribe', subscription }),
    pushTest: () => send({ v: PROTOCOL_VERSION, type: 'pushTest' }),
    setGate: (sessionId: string, gate: 'ask' | 'auto') =>
      send({ v: PROTOCOL_VERSION, type: 'setGate', sessionId, gate }),
    takeOver: (sessionId: string, text: string) =>
      send({ v: PROTOCOL_VERSION, type: 'takeOver', sessionId, text }),
    previewDelegation: (input: {
      requestId: string
      sourceSessionId: string
      sourceSeq?: number
      targetAgent: DelegationTargetAgent
      role: DelegationRole
      contextScope: DelegationContextScope
    }) => {
      const sent = send({ v: PROTOCOL_VERSION, type: 'previewDelegation', ...input })
      if (!sent) {
        const detail = 'Not connected to your laptop — the briefing was not built.'
        if (callbacks.onDelegationError) callbacks.onDelegationError(input.requestId, detail)
        else callbacks.onError(detail)
      }
      return sent
    },
    startDelegation: (input: {
      requestId: string
      idempotencyKey: string
      sourceSessionId: string
      sourceSeq?: number
      targetAgent: DelegationTargetAgent
      role: DelegationRole
      contextScope: DelegationContextScope
      briefing: string
      settings?: SessionSettings
    }) => {
      const sent = send({
        v: PROTOCOL_VERSION,
        type: 'startDelegation',
        ...input,
        confirmed: true,
        workspaceTransferConfirmed: true,
      })
      if (!sent) {
        const detail = 'Not connected to your laptop — no child session was started.'
        if (callbacks.onDelegationError) callbacks.onDelegationError(input.requestId, detail)
        else callbacks.onError(detail)
      }
      return sent
    },
    updateSessionSettings: (input: {
      requestId: string
      sessionId: string
      settings: SessionSettings
      externalTransferConfirmed: boolean
    }) => {
      const sent = send({ v: PROTOCOL_VERSION, type: 'updateSessionSettings', ...input })
      if (!sent) {
        callbacks.onSessionSettingsError?.(
          input.requestId,
          'Not connected to your laptop — settings were not changed.',
        )
      }
      return sent
    },
    prepareReturn: (input: { requestId: string; delegationId: string }) => {
      const sent = send({ v: PROTOCOL_VERSION, type: 'prepareReturn', ...input })
      if (!sent) {
        const detail = 'Not connected to your laptop — the return was not prepared.'
        if (callbacks.onDelegationError) callbacks.onDelegationError(input.requestId, detail)
        else callbacks.onError(detail)
      }
      return sent
    },
    returnDelegation: (input: {
      requestId: string
      idempotencyKey: string
      delegationId: string
      returnText: string
      takeoverConfirmed: boolean
    }) => {
      const sent = send({
        v: PROTOCOL_VERSION,
        type: 'returnDelegation',
        ...input,
        confirmed: true,
      })
      if (!sent) {
        const detail = 'Not connected to your laptop — the reviewed return was not delivered.'
        if (callbacks.onDelegationError) callbacks.onDelegationError(input.requestId, detail)
        else callbacks.onError(detail)
      }
      return sent
    },
    decide: (
      approvalId: string,
      verdict: 'allow' | 'deny',
      reply?: string,
      answers?: Record<string, string>,
    ) =>
      send({
        v: PROTOCOL_VERSION,
        type: 'decision',
        approvalId,
        verdict,
        ...(reply ? { reply } : {}),
        ...(answers ? { answers } : {}),
      }),
    close: () => {
      closed = true
      stopHomeProbe()
      if (retryTimer !== null) clearTimeout(retryTimer)
      if (hydrationTimer !== null) clearTimeout(hydrationTimer)
      store.endHydration()
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      wire?.close()
    },
  }
}

export type Client = ReturnType<typeof connect>
