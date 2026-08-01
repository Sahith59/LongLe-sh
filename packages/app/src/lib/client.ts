import { PROTOCOL_VERSION, type SessionEvent } from '@longleash/protocol'
import type { SessionSeed, Store } from './store.js'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'unauthorized' | 'revoked'

export interface Diagnostics {
  reachable: boolean
  detail: string
}

const TOKEN_KEY = 'longleash.token'

export function storedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export async function pair(challengeId: string, secret: string): Promise<string> {
  const res = await fetch(`/pair?c=${encodeURIComponent(challengeId)}&s=${encodeURIComponent(secret)}`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string }
    throw new Error(body.reason ?? 'pairing rejected')
  }
  const { token } = (await res.json()) as { token: string }
  localStorage.setItem(TOKEN_KEY, token)
  return token
}

export function forgetToken(): void {
  localStorage.removeItem(TOKEN_KEY)
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
      detail:
        'Cannot reach your laptop. Check you are on the same network, and turn off any VPN — a full-tunnel VPN blocks phone-to-laptop traffic entirely.',
    }
  }
}

export interface Hello {
  deviceId: string
  roots: string[]
  sessions: SessionSeed[]
  capabilities: { startSession: boolean; stopSession: boolean }
}

export interface FolderHit {
  path: string
  label: string
  kind: 'folder' | 'file'
  /** For a file, the folder an agent would actually work in. */
  parent?: string
}

export interface ClientCallbacks {
  onState: (state: ConnectionState) => void
  /** The daemon tells us which directories are usable — never make the user type a path. */
  onHello: (hello: Hello) => void
  /** Errors must reach the person. Swallowing them makes the app look broken. */
  onError: (message: string) => void
  /** Folder search results, so a project can be picked by name rather than typed as a path. */
  onFolders: (query: string, results: FolderHit[]) => void
}

export function connect(token: string, store: Store, callbacks: ClientCallbacks) {
  let socket: WebSocket | null = null
  let closed = false
  let attempt = 0
  const subscribed = new Set<string>()

  const send = (message: unknown): boolean => {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  const subscribe = (sessionId: string): void => {
    subscribed.add(sessionId)
    send({
      v: PROTOCOL_VERSION,
      type: 'subscribe',
      sessionId,
      fromCursor: store.cursors()[sessionId] ?? 0,
    })
  }

  const open = (): void => {
    if (closed) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`)

    socket.onopen = () => {
      attempt = 0
      callbacks.onState('connected')
      // Every known session resumes from its own cursor, so nothing is missed or repeated.
      for (const sessionId of subscribed) subscribe(sessionId)
    }

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as Record<string, unknown>
      if (message.type === 'gap') {
        store.applyGap(String(message.sessionId))
        subscribe(String(message.sessionId))
        return
      }
      if (message.type === 'ack' && message.of === 'startSession' && typeof message.sessionId === 'string') {
        subscribe(message.sessionId)
        return
      }
      if (message.type === 'hello') {
        const hello = message as unknown as Hello
        // Rebuild the list, then resume each stream from wherever this client left off.
        store.seedSessions(hello.sessions ?? [])
        for (const session of hello.sessions ?? []) subscribe(session.sessionId)
        callbacks.onHello(hello)
        return
      }
      if (message.type === 'folders') {
        callbacks.onFolders(String(message.query ?? ''), (message.results ?? []) as FolderHit[])
        return
      }
      if (message.type === 'error') {
        callbacks.onError(String(message.message ?? message.code ?? 'Something went wrong'))
        return
      }
      if (message.type === 'ack' && message.outcome === 'unknown') {
        callbacks.onError('That approval is no longer waiting — it may have expired.')
        return
      }
      if (typeof message.seq === 'number') store.apply(message as unknown as SessionEvent)
    }

    socket.onclose = (event) => {
      if (closed) return
      if (event.code === 4401) {
        callbacks.onState('unauthorized')
        return
      }
      if (event.code === 4403) {
        callbacks.onState('revoked')
        return
      }
      callbacks.onState('reconnecting')
      // Back off, but stay responsive: a phone leaving a tunnel should reconnect quickly.
      const delay = Math.min(1000 * 2 ** attempt, 15_000)
      attempt += 1
      setTimeout(open, delay)
    }
  }

  callbacks.onState('connecting')
  open()

  return {
    subscribe,
    startSession: (root: string, prompt: string) => {
      const sent = send({ v: PROTOCOL_VERSION, type: 'startSession', agent: 'claude', root, prompt })
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
    decide: (approvalId: string, verdict: 'allow' | 'deny', reply?: string) =>
      send({
        v: PROTOCOL_VERSION,
        type: 'decision',
        approvalId,
        verdict,
        ...(reply ? { reply } : {}),
      }),
    close: () => {
      closed = true
      socket?.close()
    },
  }
}

export type Client = ReturnType<typeof connect>
