import type { SessionView } from './store.js'

export type SessionScope = 'all' | 'active' | 'needs' | 'history'
export type SessionAgent = 'all' | 'claude' | 'codex'
export type SessionSurface = 'all' | 'phone' | 'terminal' | 'vscode'
export type SessionSort = 'recommended' | 'recent' | 'oldest' | 'name' | 'project'

export interface SessionBrowserOptions {
  query: string
  scope: SessionScope
  agent: SessionAgent
  surface: SessionSurface
  sort: SessionSort
  pendingBySession: Record<string, number>
}

export interface SessionBrowserResult {
  session: SessionView
  match?: string
}

export function sessionActivityAt(session: SessionView): number {
  return session.lastActivityAt ?? session.startedAt ?? 0
}

function isActive(session: SessionView): boolean {
  return session.live && (session.status === 'running' || session.status === 'waiting')
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function messageMatch(session: SessionView, terms: string[]): string | undefined {
  if (terms.length === 0) return undefined
  const candidates = [
    ...session.blocks.slice().reverse().map((block) => block.text),
    session.output,
  ]
  for (const candidate of candidates) {
    const clean = candidate.replace(/\s+/g, ' ').trim()
    const haystack = clean.toLocaleLowerCase()
    const first = terms.find((term) => haystack.includes(term))
    if (first === undefined) continue
    const at = haystack.indexOf(first)
    const from = Math.max(0, at - 42)
    const to = Math.min(clean.length, at + Math.max(first.length, 72))
    return `${from > 0 ? '…' : ''}${clean.slice(from, to)}${to < clean.length ? '…' : ''}`
  }
  return undefined
}

export function browseSessions(
  sessions: SessionView[],
  options: SessionBrowserOptions,
): SessionBrowserResult[] {
  const terms = normalized(options.query).split(' ').filter(Boolean)
  // Defensive deduplication: reconnect hydration may momentarily provide the same session
  // through both live and history inputs, but one conversation must always render once.
  const unique = [...new Map(sessions.map((session) => [session.sessionId, session])).values()]
  const filtered = unique.flatMap((session): SessionBrowserResult[] => {
    const pending = options.pendingBySession[session.sessionId] ?? 0
    if (options.scope === 'active' && !isActive(session)) return []
    if (options.scope === 'needs' && pending === 0) return []
    if (options.scope === 'history' && isActive(session)) return []
    if (options.agent !== 'all' && session.agent !== options.agent) return []
    if (options.surface !== 'all' && (session.surface ?? session.origin) !== options.surface) return []

    if (terms.length === 0) return [{ session }]
    const identity = normalized(`${session.title} ${session.cwd} ${session.agent} ${session.surface ?? session.origin}`)
    const message = messageMatch(session, terms)
    const transcript = normalized(`${session.output} ${session.blocks.map((block) => block.text).join(' ')}`)
    if (!terms.every((term) => identity.includes(term) || transcript.includes(term))) return []
    return [{ session, ...(message === undefined ? {} : { match: message }) }]
  })

  return filtered.sort((left, right) => {
    const a = left.session
    const b = right.session
    if (options.sort === 'name') {
      return (a.title || a.sessionId).localeCompare(b.title || b.sessionId) || b.sessionId.localeCompare(a.sessionId)
    }
    if (options.sort === 'project') {
      return a.cwd.localeCompare(b.cwd) || (a.title || a.sessionId).localeCompare(b.title || b.sessionId)
    }
    const activity = sessionActivityAt(b) - sessionActivityAt(a)
    if (options.sort === 'recent') return activity || b.sessionId.localeCompare(a.sessionId)
    if (options.sort === 'oldest') return -activity || a.sessionId.localeCompare(b.sessionId)

    const pending = (options.pendingBySession[b.sessionId] ?? 0) - (options.pendingBySession[a.sessionId] ?? 0)
    if (pending !== 0) return pending
    const active = Number(isActive(b)) - Number(isActive(a))
    return active || activity || b.sessionId.localeCompare(a.sessionId)
  })
}
