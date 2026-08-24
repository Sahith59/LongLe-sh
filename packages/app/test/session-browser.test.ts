import { describe, expect, it } from 'vitest'
import { browseSessions } from '../src/lib/session-browser.js'
import type { SessionView } from '../src/lib/store.js'

function session(overrides: Partial<SessionView> & Pick<SessionView, 'sessionId'>): SessionView {
  return {
    live: false,
    agent: 'codex',
    cwd: '/work/project',
    title: 'Untitled session',
    origin: 'vscode',
    status: 'ended',
    blocks: [],
    output: '',
    activity: [],
    resumable: true,
    ...overrides,
  }
}

const defaults = {
  query: '',
  scope: 'all' as const,
  agent: 'all' as const,
  surface: 'all' as const,
  sort: 'recommended' as const,
  pendingBySession: {},
}

describe('session browser', () => {
  it('orders resumed conversations by durable activity, not original creation time', () => {
    const oldButCurrent = session({ sessionId: 'current', startedAt: 10, lastActivityAt: 300 })
    const newerButQuiet = session({ sessionId: 'quiet', startedAt: 200, lastActivityAt: 200 })
    expect(browseSessions([newerButQuiet, oldButCurrent], defaults).map(({ session: item }) => item.sessionId))
      .toEqual(['current', 'quiet'])
  })

  it('searches transcript messages and returns a useful matching excerpt', () => {
    const target = session({
      sessionId: 'target',
      title: 'Release checklist',
      blocks: [{ kind: 'user', text: 'Please investigate the reconnect ordering regression', firstSeq: 1, lastSeq: 1 }],
    })
    const [result] = browseSessions([target], { ...defaults, query: 'reconnect regression' })
    expect(result?.session.sessionId).toBe('target')
    expect(result?.match).toContain('reconnect ordering regression')
  })

  it('combines state, provider, and surface filters without leaking unrelated sessions', () => {
    const wanted = session({ sessionId: 'wanted', live: true, status: 'waiting', agent: 'claude', origin: 'phone' })
    const wrongAgent = session({ sessionId: 'wrong-agent', live: true, status: 'waiting', agent: 'codex', origin: 'phone' })
    const wrongState = session({ sessionId: 'wrong-state', agent: 'claude', origin: 'phone' })
    const results = browseSessions([wrongAgent, wrongState, wanted], {
      ...defaults,
      scope: 'active',
      agent: 'claude',
      surface: 'phone',
    })
    expect(results.map(({ session: item }) => item.sessionId)).toEqual(['wanted'])
  })

  it('puts sessions needing approval before other active sessions in priority order', () => {
    const active = session({ sessionId: 'active', live: true, status: 'running', lastActivityAt: 500 })
    const needsYou = session({ sessionId: 'needs', live: true, status: 'waiting', lastActivityAt: 100 })
    const results = browseSessions([active, needsYou], {
      ...defaults,
      pendingBySession: { needs: 1 },
    })
    expect(results.map(({ session: item }) => item.sessionId)).toEqual(['needs', 'active'])
  })

  it('renders one card when reconnect hydration momentarily repeats a session', () => {
    const repeated = session({ sessionId: 'one', live: true, status: 'running' })
    expect(browseSessions([repeated, repeated], defaults)).toHaveLength(1)
  })
})
