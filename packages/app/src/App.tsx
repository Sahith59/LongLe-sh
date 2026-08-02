import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  approvalsFor,
  createStore,
  type Block,
  type PendingApproval,
  type SessionView,
} from './lib/store.js'
import {
  checkReachable,
  connect,
  forgetToken,
  pair,
  storedToken,
  type Client,
  type ConnectionState,
  type FolderHit,
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

const STATUS_LABEL: Record<string, string> = {
  running: 'working',
  waiting: 'waiting for you',
  ended: 'finished',
  errored: 'failed',
}

export default function App() {
  const store = useMemo(() => createStore(), [])
  const [, forceRender] = useState(0)
  const [state, setState] = useState<ConnectionState>('connecting')
  const [token, setToken] = useState<string | null>(() => storedToken())
  const [pairError, setPairError] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])
  const [folders, setFolders] = useState<FolderHit[]>([])
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
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
      },
      onError: setError,
      onFolders: (_query, results) => setFolders(results),
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

  if (!token) {
    return (
      <main className="pane">
        <h1>LongLeash</h1>
        <p className="muted">Scan the QR code on your laptop to pair this device. The link works once.</p>
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
  const allSessions = Object.values(snapshot.sessions).reverse()
  // History persists across daemon restarts, so finished work must not look like running agents.
  const active = allSessions.filter((s) => s.status === 'running' || s.status === 'waiting')
  const past = allSessions.filter((s) => s.status === 'ended' || s.status === 'errored')
  const openSession = openSessionId ? snapshot.sessions[openSessionId] : undefined
  const connected = state === 'connected'

  const banners = (
    <>
      {diagnostic ? <p className="diagnostic">{diagnostic}</p> : null}
      {error ? (
        <p className="errorbar" onClick={() => setError(null)}>
          {error} <span className="muted small">(tap to dismiss)</span>
        </p>
      ) : null}
    </>
  )

  // Focused view: one conversation, its approvals, and a box to keep talking to it.
  if (openSession) {
    return (
      <>
        <header>
          <button className="link" onClick={() => setOpenSessionId(null)}>
            ‹ All sessions
          </button>
          <span className={connected ? 'ok' : 'warn'}>{connected ? 'connected' : 'reconnecting…'}</span>
        </header>
        {banners}
        <SessionDetail
          session={openSession}
          approvals={approvalsFor(snapshot, openSession.sessionId)}
          connected={connected}
          onDecide={decide}
          onStop={() => clientRef.current?.stopSession(openSession.sessionId)}
          onResume={() => clientRef.current?.resumeSession(openSession.sessionId)}
          onSend={(text) => clientRef.current?.sendMessage(openSession.sessionId, text) ?? false}
        />
      </>
    )
  }

  return (
    <>
      <header>
        <strong>LongLeash</strong>
        <span className={connected ? 'ok' : 'warn'}>{connected ? 'connected' : 'reconnecting…'}</span>
      </header>
      {banners}

      <section>
        <h2>Waiting on you {snapshot.approvals.length > 0 ? `(${snapshot.approvals.length})` : ''}</h2>
        {snapshot.approvals.length === 0 ? (
          <p className="muted pad">Nothing needs a decision right now.</p>
        ) : (
          snapshot.approvals.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              onDecide={decide}
              onOpen={() => setOpenSessionId(approval.sessionId)}
            />
          ))
        )}
      </section>

      <section>
        <h2>Start a new session</h2>
        <div className="composer">
          <NewSessionForm
            roots={roots}
            folders={folders}
            connected={connected}
            onSearch={(query) => clientRef.current?.findFolders(query)}
            onStart={(dir, prompt) => {
              setError(null)
              return clientRef.current?.startSession(dir, prompt) ?? false
            }}
          />
        </div>
      </section>

      <section>
        <h2>Active {active.length > 0 ? `(${active.length})` : ''}</h2>
        {active.length === 0 ? (
          <p className="muted pad">Nothing running.</p>
        ) : (
          active.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              pending={approvalsFor(snapshot, session.sessionId).length}
              onOpen={() => setOpenSessionId(session.sessionId)}
            />
          ))
        )}
      </section>

      {past.length > 0 ? (
        <section>
          <h2>Earlier ({past.length})</h2>
          {past.slice(0, 20).map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              pending={0}
              onOpen={() => setOpenSessionId(session.sessionId)}
            />
          ))}
        </section>
      ) : null}

      <p className="muted small pad footnote">
        Only sessions started through LongLeash appear here. Ones you started yourself in a
        terminal or in the VS Code chat panel are not visible yet — that is coming in a later
        phase. Finished sessions stay listed as history; restarting the daemon on your laptop
        ends any that were still running.
      </p>
    </>
  )
}

function NewSessionForm({
  roots,
  folders,
  connected,
  onSearch,
  onStart,
}: {
  roots: string[]
  folders: FolderHit[]
  connected: boolean
  onSearch: (query: string) => void
  onStart: (dir: string, prompt: string) => boolean
}) {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<FolderHit | null>(null)
  const [prompt, setPrompt] = useState('')

  // Search as you type, debounced: nobody should have to recall an absolute path from memory.
  useEffect(() => {
    if (chosen) return
    const timer = setTimeout(() => onSearch(query), 180)
    return () => clearTimeout(timer)
  }, [query, chosen, onSearch])

  if (roots.length === 0) {
    return <p className="muted small">No project directories are configured on the laptop.</p>
  }

  if (chosen) {
    const workingIn = chosen.kind === 'file' ? (chosen.parent ?? chosen.label) : chosen.label
    return (
      <>
        <p className="chosen">
          <span className="muted small">Working in</span> <code>{workingIn}</code>{' '}
          <button
            className="link"
            onClick={() => {
              setChosen(null)
              setQuery('')
            }}
          >
            change
          </button>
        </p>
        {chosen.kind === 'file' ? (
          <p className="muted small">
            Claude will work in that folder, on <code>{fileName(chosen.label)}</code>.
          </p>
        ) : null}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Tell Claude what to do…"
          aria-label="task"
        />
        <button
          onClick={() => {
            const dir = chosen.kind === 'file' ? parentPath(chosen.path) : chosen.path
            const task =
              chosen.kind === 'file'
                ? `In the file ${fileName(chosen.label)}: ${prompt.trim()}`
                : prompt.trim()
            if (onStart(dir, task)) setPrompt('')
          }}
          disabled={!prompt.trim() || !connected}
        >
          {connected ? 'Start session' : 'Waiting for your laptop…'}
        </button>
      </>
    )
  }

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Folder or file — e.g. FD_Engineer, or test in downloads"
        aria-label="find a folder"
      />
      {folders.length === 0 ? (
        <p className="muted small">
          {query.trim() ? 'No folder matches that.' : 'Type a folder name, or pick one below.'}
        </p>
      ) : (
        <ul className="folderlist">
          {folders.map((folder) => (
            <li key={folder.path}>
              <button className="folder" onClick={() => setChosen(folder)}>
                <span className="kind">{folder.kind === 'file' ? '📄' : '📁'}</span> {folder.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function SessionRow({
  session,
  pending,
  onOpen,
}: {
  session: SessionView
  pending: number
  onOpen: () => void
}) {
  const preview = session.output.trim().slice(-140)
  return (
    <button className="card sessionrow" onClick={onOpen}>
      <div className="row spread">
        <h3>{session.title || session.sessionId}</h3>
        <span className={`pill ${session.status}`}>{STATUS_LABEL[session.status] ?? session.status}</span>
      </div>
      <p className="muted small">
        {shortPath(session.cwd)} · {ORIGIN_LABEL[session.origin] ?? session.origin}
      </p>
      {pending > 0 ? <p className="needsyou">{pending} waiting on you</p> : null}
      {preview ? <p className="preview">{preview}</p> : null}
    </button>
  )
}

function SessionDetail({
  session,
  approvals,
  connected,
  onDecide,
  onStop,
  onResume,
  onSend,
}: {
  session: SessionView
  approvals: PendingApproval[]
  connected: boolean
  onDecide: (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => void
  onStop: () => void
  onResume: () => void
  onSend: (text: string) => boolean
}) {
  const [message, setMessage] = useState('')
  const live = session.status === 'running' || session.status === 'waiting'
  const outputRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = outputRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [session.blocks])

  return (
    <>
      <section>
        <div className="detailhead">
          <h3>{session.title || session.sessionId}</h3>
          <p className="muted small">
            {shortPath(session.cwd)} · {ORIGIN_LABEL[session.origin] ?? session.origin} ·{' '}
            {STATUS_LABEL[session.status] ?? session.status}
          </p>
          {live ? (
            <button className="secondary small" onClick={onStop}>
              Stop this agent
            </button>
          ) : (
            <button className="small" onClick={onResume}>
              Reopen this session
            </button>
          )}
        </div>
      </section>

      {approvals.length > 0 ? (
        <section>
          <h2>Waiting on you</h2>
          {approvals.map((approval) => (
            <ApprovalCard key={approval.approvalId} approval={approval} onDecide={onDecide} />
          ))}
        </section>
      ) : null}

      <section>
        <h2>Conversation</h2>
        <div className="transcript" ref={outputRef}>
          {session.blocks.length === 0 ? (
            <p className="muted small">Nothing yet.</p>
          ) : (
            session.blocks.map((block, i) => <TranscriptBlock key={i} block={block} />)
          )}
        </div>
        {session.error ? <p className="bad small pad">{session.error}</p> : null}
        {session.activity.length > 0 ? (
          <p className="muted small pad">
            auto-approved: {session.activity.slice(-4).map((a) => a.toolName).join(', ')}
          </p>
        ) : null}
      </section>

      <div className="composer sticky">
        {live ? (
          <>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Reply to this session…"
              aria-label="reply"
            />
            <button
              onClick={() => {
                if (onSend(message.trim())) setMessage('')
              }}
              disabled={!message.trim() || !connected}
            >
              Send
            </button>
          </>
        ) : (
          <p className="muted small">
            This session has finished. Tap <strong>Reopen this session</strong> above to carry on
            where you left off — the agent picks up knowing everything it knew before.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * Renders one piece of the conversation as what it actually is. Agent prose reads as prose;
 * tool calls are compact and dimmed so a long search does not bury the answer; your own
 * messages stand apart. Flattening all three into one monospace block made the transcript
 * unreadable on a phone.
 */
function TranscriptBlock({ block }: { block: Block }) {
  if (block.kind === 'tool') {
    return (
      <div className="blk tool" title={block.text}>
        {block.text}
      </div>
    )
  }
  if (block.kind === 'user') {
    const text = block.text.replace(/^[\s›]+/, '').trim()
    if (text === '— reopened —') return <div className="blk divider">reopened</div>
    return <div className="blk mine">{text}</div>
  }
  if (block.kind === 'thinking') {
    return <div className="blk thinking">{block.text.trim()}</div>
  }
  return <div className="blk say">{renderProse(block.text)}</div>
}

/** Just enough markdown to stop backticks and asterisks leaking into the reader's face. */
function renderProse(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    return <span key={i}>{part}</span>
  })
}

function ApprovalCard({
  approval,
  onDecide,
  onOpen,
}: {
  approval: PendingApproval
  onDecide: (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => void
  onOpen?: () => void
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
      {onOpen ? (
        <button className="link" onClick={onOpen}>
          open this session ›
        </button>
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

function fileName(label: string): string {
  return label.split('/').filter(Boolean).slice(-1)[0] ?? label
}

function parentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

/** Long absolute paths are unreadable on a phone; show the tail that identifies the project. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}
