import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createStore, type PendingApproval, type SessionView } from './lib/store.js'
import {
  checkReachable,
  connect,
  forgetToken,
  pair,
  storedToken,
  type Client,
  type ConnectionState,
  type Hello,
} from './lib/client.js'

const ORIGIN_LABEL: Record<string, string> = {
  phone: 'started from your phone',
  daemon: 'started on the laptop',
  terminal: 'running in a terminal',
  vscode: 'running in VS Code',
  external: 'started outside LongLeash',
  unknown: 'origin unknown',
}

export default function App() {
  const store = useMemo(() => createStore(), [])
  const [, forceRender] = useState(0)
  const [state, setState] = useState<ConnectionState>('connecting')
  const [token, setToken] = useState<string | null>(() => storedToken())
  const [pairError, setPairError] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [roots, setRoots] = useState<string[]>([])
  const [root, setRoot] = useState('')
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<Client | null>(null)

  useEffect(() => {
    return store.subscribe(() => forceRender((n) => n + 1))
  }, [store])

  // Pair from the QR link on first open, then clean the secret out of the URL.
  useEffect(() => {
    if (token) return
    const params = new URLSearchParams(location.search)
    const challengeId = params.get('c')
    const secret = params.get('s')
    if (!challengeId || !secret) return
    pair(challengeId, secret)
      .then((issued) => {
        setToken(issued)
        history.replaceState(null, '', location.pathname)
      })
      .catch((err: Error) => setPairError(err.message))
  }, [token])

  useEffect(() => {
    if (!token) return
    const client = connect(token, store, {
      onState: setState,
      onHello: (hello: Hello) => {
        setRoots(hello.roots)
        // Preselect when there is nothing to choose, so the common case is one tap.
        setRoot((current) => current || hello.roots[0] || '')
      },
      onError: setError,
    })
    clientRef.current = client
    return () => client.close()
  }, [token, store])

  // A stalled connection is usually the network, not the app — say which.
  useEffect(() => {
    if (state !== 'reconnecting' && state !== 'connecting') {
      setDiagnostic(null)
      return
    }
    const timer = setTimeout(() => {
      void checkReachable().then((result) => setDiagnostic(result.reachable ? null : result.detail))
    }, 3000)
    return () => clearTimeout(timer)
  }, [state])

  const decide = useCallback(
    (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => {
      store.markDeciding(approval.approvalId)
      const sent = clientRef.current?.decide(approval.approvalId, verdict, reply)
      if (!sent) store.rollbackDecision(approval.approvalId)
    },
    [store],
  )

  const start = useCallback(() => {
    if (!prompt.trim() || !root.trim()) return
    setError(null)
    // Keep the text until it is actually on the wire — losing a typed task is unforgivable.
    const sent = clientRef.current?.startSession(root.trim(), prompt.trim())
    if (sent) setPrompt('')
  }, [prompt, root])

  if (!token) {
    return (
      <main className="pane">
        <h1>LongLeash</h1>
        <p className="muted">
          Scan the QR code shown on your laptop to pair this device. The link works once.
        </p>
        {pairError ? <p className="bad">Pairing failed: {pairError}</p> : null}
      </main>
    )
  }

  if (state === 'revoked' || state === 'unauthorized') {
    return (
      <main className="pane">
        <h1>Access ended</h1>
        <p className="bad">
          {state === 'revoked'
            ? 'This device was revoked from your laptop.'
            : 'This device is no longer authorized.'}
        </p>
        <button
          className="secondary"
          onClick={() => {
            forgetToken()
            setToken(null)
          }}
        >
          Pair again
        </button>
      </main>
    )
  }

  const snapshot = store.getState()
  const sessions = Object.values(snapshot.sessions).reverse()

  return (
    <>
      <header>
        <strong>LongLeash</strong>
        <span className={state === 'connected' ? 'ok' : 'warn'}>
          {state === 'connected' ? 'connected' : 'reconnecting…'}
        </span>
      </header>

      {diagnostic ? <p className="diagnostic">{diagnostic}</p> : null}
      {error ? (
        <p className="errorbar" onClick={() => setError(null)}>
          {error} <span className="muted small">(tap to dismiss)</span>
        </p>
      ) : null}

      <section>
        <h2>Waiting on you {snapshot.approvals.length > 0 ? `(${snapshot.approvals.length})` : ''}</h2>
        {snapshot.approvals.length === 0 ? (
          <p className="muted pad">Nothing needs a decision right now.</p>
        ) : (
          snapshot.approvals.map((approval) => (
            <ApprovalCard key={approval.approvalId} approval={approval} onDecide={decide} />
          ))
        )}
      </section>

      <section>
        <h2>Start something</h2>
        <div className="composer">
          {roots.length === 0 ? (
            <p className="muted small">
              This daemon has no project directories configured, so nothing can be started.
            </p>
          ) : roots.length === 1 ? (
            <p className="muted small">
              Working in <code>{shortPath(roots[0] ?? '')}</code>
            </p>
          ) : (
            <select value={root} onChange={(e) => setRoot(e.target.value)} aria-label="project">
              {roots.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {shortPath(candidate)}
                </option>
              ))}
            </select>
          )}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Tell Claude what to do…"
            aria-label="task"
          />
          <button onClick={start} disabled={!prompt.trim() || !root.trim() || state !== 'connected'}>
            {state === 'connected' ? 'Send to Claude' : 'Waiting for your laptop…'}
          </button>
        </div>
      </section>

      <section>
        <h2>Sessions</h2>
        {sessions.length === 0 ? (
          <p className="muted pad">No sessions yet.</p>
        ) : (
          sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              onStop={() => clientRef.current?.stopSession(session.sessionId)}
            />
          ))
        )}
        <p className="muted small pad footnote">
          Only sessions started through LongLeash appear here. Ones you started yourself in a
          terminal or in the VS Code chat panel are not visible yet.
        </p>
      </section>
    </>
  )
}

/** Long absolute paths are unreadable on a phone; show the tail that identifies the project. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: PendingApproval
  onDecide: (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => void
}) {
  const [reply, setReply] = useState('')
  return (
    <article className={`card ${approval.outsideRoot ? 'danger' : ''}`}>
      <h3>Claude wants to run {approval.toolName}</h3>
      <code>{approval.inputSummary}</code>
      {approval.outsideRoot ? (
        <p className="bad">
          This reaches outside your project directory: <code>{approval.targetPath}</code>
        </p>
      ) : null}
      <input
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="optional reply if you deny…"
        aria-label="reply"
      />
      <div className="row">
        <button className="allow" onClick={() => onDecide(approval, 'allow')}>
          Approve
        </button>
        <button className="deny" onClick={() => onDecide(approval, 'deny', reply || undefined)}>
          Deny
        </button>
      </div>
    </article>
  )
}

function SessionCard({ session, onStop }: { session: SessionView; onStop: () => void }) {
  return (
    <article className="card session">
      <div className="row spread">
        <div>
          <h3>{session.title || session.sessionId}</h3>
          <p className="muted small">
            {session.cwd} · {ORIGIN_LABEL[session.origin] ?? session.origin}
          </p>
        </div>
        <div className="right">
          <span className={`pill ${session.status}`}>{session.status}</span>
          {session.status === 'running' ? (
            <button className="secondary small" onClick={onStop}>
              Stop
            </button>
          ) : null}
        </div>
      </div>
      {session.error ? <p className="bad small">{session.error}</p> : null}
      {session.activity.length > 0 ? (
        <p className="muted small">
          auto-approved: {session.activity.slice(-3).map((a) => a.toolName).join(', ')}
        </p>
      ) : null}
      <pre className="output">{session.output || '…'}</pre>
    </article>
  )
}
