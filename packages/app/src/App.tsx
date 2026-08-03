import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowUp, ChevronLeft, Link2, Plus, RotateCcw, Square } from 'lucide-react'
import {
  approvalsFor,
  createStore,
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
  type LinkPath,
} from './lib/client.js'
import { ApprovalCard } from './ui/ApprovalCard.js'
import { NewSessionSheet } from './ui/NewSessionSheet.js'
import { SessionCard } from './ui/SessionCard.js'
import { Transcript } from './ui/Transcript.js'
import { EASE, EXIT, Key, Led, Notice, SectionLabel, SPRING, listVariants } from './ui/primitives.js'
import { ORIGIN_LABEL, STATUS_LABEL, shortPath } from './ui/format.js'
import { PathChip } from './ui/PathChip.js'

export default function App() {
  const store = useMemo(() => createStore(), [])
  const [, forceRender] = useState(0)
  const [state, setState] = useState<ConnectionState>('connecting')
  const [linkPath, setLinkPath] = useState<LinkPath>('lan')
  const [token, setToken] = useState<string | null>(() => storedToken())
  const [pairError, setPairError] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])
  const [folders, setFolders] = useState<FolderHit[]>([])
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
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
      onPath: setLinkPath,
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

  // A sheet that lets the page behind it scroll feels broken on a phone.
  useEffect(() => {
    if (!sheetOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [sheetOpen])

  const decide = useCallback(
    (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => {
      store.markDeciding(approval.approvalId)
      const sent = clientRef.current?.decide(approval.approvalId, verdict, reply)
      if (!sent) store.rollbackDecision(approval.approvalId)
    },
    [store],
  )

  const search = useCallback((query: string) => clientRef.current?.findFolders(query), [])

  if (!token) {
    return (
      <PairGate
        error={pairError}
        onPair={(challengeId, secret) =>
          pair(challengeId, secret)
            .then((issued) => {
              setToken(issued)
              history.replaceState(null, '', location.pathname)
            })
            .catch((err: Error) => setPairError(err.message))
        }
      />
    )
  }

  if (state === 'revoked' || state === 'unauthorized') {
    return (
      <main className="gate">
        <Mark />
        <h1>Access ended</h1>
        <p>
          {state === 'revoked'
            ? 'This device was revoked from your laptop.'
            : 'This device is no longer authorized.'}
        </p>
        <Key
          onClick={() => {
            forgetToken()
            setToken(null)
          }}
        >
          Pair again
        </Key>
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

  return (
    <>
      <Rail
        connected={connected}
        via={linkPath}
        {...(openSession ? { onBack: () => setOpenSessionId(null) } : {})}
      />

      {/* Both screens live in the same grid cell (.screens), so during a transition
          they overlap instead of stacking — the outgoing one can never push the
          incoming one down the page. That, plus transform-free screen fades, is what
          lets the shared title measure an honest flight path between them. */}
      <div className="screens">
      <AnimatePresence initial={false}>
        {openSession ? (
          <DetailScreen
            key={openSession.sessionId}
            session={openSession}
            approvals={approvalsFor(snapshot, openSession.sessionId)}
            connected={connected}
            diagnostic={diagnostic}
            error={error}
            onClearError={() => setError(null)}
            onDecide={decide}
            onStop={() => clientRef.current?.stopSession(openSession.sessionId)}
            onResume={() => clientRef.current?.resumeSession(openSession.sessionId)}
            onSend={(text) => clientRef.current?.sendMessage(openSession.sessionId, text) ?? false}
          />
        ) : (
          <ConsoleScreen
            key="console"
            approvals={snapshot.approvals}
            active={active}
            past={past}
            snapshot={snapshot}
            diagnostic={diagnostic}
            error={error}
            onClearError={() => setError(null)}
            onDecide={decide}
            onOpen={setOpenSessionId}
            onNew={() => setSheetOpen(true)}
          />
        )}
      </AnimatePresence>
      </div>

      <NewSessionSheet
        open={sheetOpen}
        roots={roots}
        folders={folders}
        connected={connected}
        onSearch={search}
        onStart={(dir, prompt) => {
          setError(null)
          return clientRef.current?.startSession(dir, prompt) ?? false
        }}
        onClose={() => setSheetOpen(false)}
      />
    </>
  )
}


/**
 * The rail never leaves: the link light is the one readout that matters no matter which screen
 * you are on, because everything else in the app is meaningless if the laptop is unreachable.
 */
export function Rail({
  connected,
  via,
  onBack,
}: {
  connected: boolean
  /**
   * Which road the link takes. This describes the ROUTE, never the person's whereabouts —
   * "away" was once shown to someone sitting at home on their own Wi-Fi, which is a lie.
   */
  via?: LinkPath
  onBack?: () => void
}) {
  return (
    <div className="rail">
      <div className="rail-in">
        {onBack ? (
          <button type="button" className="tap" onClick={onBack} aria-label="Back to all sessions">
            <ChevronLeft size={18} strokeWidth={2.4} aria-hidden="true" />
            Sessions
          </button>
        ) : (
          <h1 className="wordmark">
            <LeashGlyph size={20} />
            LongLeash
          </h1>
        )}
        <span className="spacer" />
        <span className={`link-state${connected ? ' on' : ''}`}>
          {connected ? <Led status="running" /> : <Link2 size={13} strokeWidth={2.3} aria-hidden="true" />}
          {connected ? (via === 'relay' ? 'linked · relay' : 'linked · direct') : 'reconnecting'}
        </span>
        <span className="sr" role="status">
          {connected
            ? via === 'relay'
              ? 'Connected to your laptop through the relay, end-to-end encrypted'
              : 'Connected directly to your laptop on this network'
            : 'Reconnecting to your laptop'}
        </span>
      </div>
    </div>
  )
}

/**
 * Pairing, with a paste box as well as the QR.
 *
 * On iOS a scanned QR opens the camera's in-app browser, which keeps its own storage. A
 * pairing done there is invisible to the app on the home screen, so the installed app asks
 * to pair again — and every scan mints another device on the laptop. Pasting the link into
 * the app that will actually run pairs it in the right place, once.
 */
function PairGate({
  error,
  onPair,
}: {
  error: string | null
  onPair: (challengeId: string, secret: string) => void
}) {
  const [link, setLink] = useState('')
  const parsed = parsePairingLink(link)

  return (
    <main className="gate">
      <Mark />
      <h1>LongLeash</h1>
      <p>
        Paste the pairing link your laptop printed. Scanning the QR also works, but only from
        inside this app — a scan from the camera pairs a different browser.
      </p>
      <div className="pairbox">
        <input
          className="field"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://…/?c=…&s=…"
          aria-label="Pairing link from your laptop"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <Key
          className="primary wide"
          disabled={parsed === null}
          onClick={() => {
            if (parsed) onPair(parsed.challengeId, parsed.secret)
          }}
        >
          Pair this device
        </Key>
      </div>
      {error ? <p className="err">Pairing failed: {error}</p> : null}
      <p className="buildtag mono">build {__BUILD__}</p>
    </main>
  )
}

/** Accepts the whole URL or just the query part, so any way of copying it works. */
export function parsePairingLink(raw: string): { challengeId: string; secret: string } | null {
  const text = raw.trim()
  if (text.length === 0) return null
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text
  const params = new URLSearchParams(query)
  const challengeId = params.get('c')
  const secret = params.get('s')
  if (!challengeId || !secret) return null
  return { challengeId, secret }
}

/* ------------------------------------------------------------------ screens */

export function ConsoleScreen({
  approvals,
  active,
  past,
  snapshot,
  diagnostic,
  error,
  onClearError,
  onDecide,
  onOpen,
  onNew,
}: {
  approvals: PendingApproval[]
  active: SessionView[]
  past: SessionView[]
  snapshot: ReturnType<ReturnType<typeof createStore>['getState']>
  diagnostic: string | null
  error: string | null
  onClearError: () => void
  onDecide: (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => void
  onOpen: (sessionId: string) => void
  onNew: () => void
}) {
  const still = useReducedMotion()
  const firstRun = approvals.length === 0 && active.length === 0 && past.length === 0

  return (
    <Screen depth={-1} still={still}>
      <main className="shell hasdock">
        <Banners diagnostic={diagnostic} error={error} onClearError={onClearError} />

        {approvals.length > 0 ? (
          <section aria-live="polite">
            <SectionLabel count={approvals.length} urgent>
              Needs you
            </SectionLabel>
            <div className="stack">
              <AnimatePresence initial={false}>
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    context={
                      snapshot.sessions[approval.sessionId]?.title || 'Untitled session'
                    }
                    onDecide={onDecide}
                    onOpen={() => onOpen(approval.sessionId)}
                  />
                ))}
              </AnimatePresence>
            </div>
          </section>
        ) : null}

        {firstRun ? (
          <FirstRun />
        ) : (
        <section>
          <SectionLabel count={active.length}>Active</SectionLabel>
          {active.length === 0 ? (
            <p className="empty">Nothing running. Start a session below.</p>
          ) : (
            <motion.div
              className="stack"
              variants={listVariants}
              initial="hidden"
              animate="shown"
            >
              {active.map((session) => (
                <SessionCard
                  key={session.sessionId}
                  session={session}
                  pending={approvalsFor(snapshot, session.sessionId).length}
                  onOpen={() => onOpen(session.sessionId)}
                />
              ))}
            </motion.div>
          )}
        </section>
        )}

        {past.length > 0 ? (
          <section>
            <SectionLabel count={past.length}>Earlier</SectionLabel>
            <motion.div className="stack" variants={listVariants} initial="hidden" animate="shown">
              {past.slice(0, 20).map((session) => (
                <SessionCard
                  key={session.sessionId}
                  session={session}
                  pending={0}
                  onOpen={() => onOpen(session.sessionId)}
                />
              ))}
            </motion.div>
          </section>
        ) : null}

        <p className="foot">
          Only sessions started through LongLeash appear here. Ones you started yourself in a
          terminal or in the VS Code chat panel are not visible yet — that is coming in a later
          phase. Conversations survive daemon restarts: reply to any of them and the same agent
          picks up where it left off.
          <span className="buildtag mono">build {__BUILD__}</span>
        </p>
      </main>

      <div className="dock">
        <div className="dock-in">
          <Key className="primary wide" onClick={onNew}>
            <Plus size={19} strokeWidth={2.6} aria-hidden="true" />
            New session
          </Key>
        </div>
      </div>
    </Screen>
  )
}

export function DetailScreen({
  session,
  approvals,
  connected,
  diagnostic,
  error,
  onClearError,
  onDecide,
  onStop,
  onResume,
  onSend,
}: {
  session: SessionView
  approvals: PendingApproval[]
  connected: boolean
  diagnostic: string | null
  error: string | null
  onClearError: () => void
  onDecide: (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => void
  onStop: () => void
  onResume: () => void
  onSend: (text: string) => boolean
}) {
  const [message, setMessage] = useState('')
  const still = useReducedMotion()
  // Typing wakes a dormant conversation, so the composer belongs to anything continuable —
  // not only to what happens to be running right now.
  const live = session.status === 'running' || session.status === 'waiting'
  const canType = live || session.resumable
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const followTail = useRef(true)

  useEffect(() => {
    const node = readoutRef.current
    if (node && followTail.current) node.scrollTop = node.scrollHeight
  }, [session.blocks])

  const send = () => {
    if (onSend(message.trim())) setMessage('')
  }

  return (
    <Screen depth={1} still={still}>
      <main className="shell hasdock">
        <Banners diagnostic={diagnostic} error={error} onClearError={onClearError} />

        <div className="detailhead">
          <div className="toprow">
            <motion.h2
              {...(still ? {} : { layoutId: `title-${session.sessionId}` })}
              transition={SPRING}
            >
              {session.title || session.sessionId}
            </motion.h2>
            {live ? (
              <Key className="sm stopkey" onClick={onStop} label="Stop this agent">
                <Square size={13} strokeWidth={2.6} fill="currentColor" aria-hidden="true" />
                Stop
              </Key>
            ) : session.resumable ? (
              <Key className="sm" onClick={onResume} label="Reopen this conversation">
                <RotateCcw size={14} strokeWidth={2.4} aria-hidden="true" />
                Reopen
              </Key>
            ) : null}
          </div>
          <p className="meta">
            <Led status={session.status} />
            <span className={`state ${session.status}`}>
              {STATUS_LABEL[session.status] ?? session.status}
            </span>
            <span className="dot" aria-hidden="true">·</span>
            <span>{ORIGIN_LABEL[session.origin] ?? session.origin}</span>
            <span className="dot" aria-hidden="true">·</span>
            <PathChip text={session.cwd} kind="folder" max={30} expandable />
          </p>
        </div>

        {approvals.length > 0 ? (
          <section aria-live="polite">
            <SectionLabel count={approvals.length} urgent>
              Needs you
            </SectionLabel>
            <div className="stack">
              <AnimatePresence initial={false}>
                {approvals.map((approval) => (
                  <ApprovalCard key={approval.approvalId} approval={approval} onDecide={onDecide} />
                ))}
              </AnimatePresence>
            </div>
          </section>
        ) : null}

        <section>
          <SectionLabel>Conversation</SectionLabel>
          <div
            className="readout"
            ref={readoutRef}
            onScroll={(e) => {
              const el = e.currentTarget
              followTail.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
            }}
          >
            {session.blocks.length === 0 ? (
              <p className="empty">Nothing yet.</p>
            ) : (
              <Transcript blocks={session.blocks} />
            )}
          </div>
          {session.error ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="bad">{session.error}</Notice>
            </div>
          ) : null}
          {session.activity.length > 0 ? (
            <p className="small dim" style={{ margin: '12px 2px 0' }}>
              Ran without asking:{' '}
              <span className="mono">
                {session.activity.slice(-5).map((a) => a.toolName).join(', ')}
              </span>
            </p>
          ) : null}
        </section>
      </main>

      <div className="dock">
        {canType ? (
          <div className="dock-in">
            <textarea
              className="field"
              rows={1}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={live ? 'Reply to this session…' : 'Type to carry this on…'}
              aria-label="Reply to this session"
            />
            <Key
              className="primary icon"
              onClick={send}
              disabled={!message.trim() || !connected}
              label="Send reply"
            >
              <ArrowUp size={20} strokeWidth={2.6} aria-hidden="true" />
            </Key>
          </div>
        ) : (
          <p className="note">
            This conversation cannot be continued — it has no resume point. Start a new session
            in the same folder to pick the work back up.
          </p>
        )}
      </div>
    </Screen>
  )
}

/* --------------------------------------------------------------- scaffolding */

/**
 * Screens crossfade; the SPACE is carried by the shared title, which physically flies
 * between the card and the headline. When motion is reduced (or a title has no partner,
 * e.g. deep history), the crossfade alone still tells the story.
 */
function Screen({
  children,
}: {
  children: React.ReactNode
  depth: 1 | -1
  still: boolean | null
}) {
  // Opacity ONLY — never a transform. An animating ancestor transform skews the
  // measurement of the shared title's flight path, which sent it sailing to the
  // wrong corner of the screen in testing. The title carries all the motion.
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: EASE }}
      exit={{ opacity: 0, transition: EXIT }}
    >
      {children}
    </motion.div>
  )
}

function Banners({
  diagnostic,
  error,
  onClearError,
}: {
  diagnostic: string | null
  error: string | null
  onClearError: () => void
}) {
  return (
    <AnimatePresence initial={false}>
      {diagnostic ? <Notice key="diag">{diagnostic}</Notice> : null}
      {error ? (
        <Notice key="err" tone="bad" onDismiss={onClearError}>
          {error}
        </Notice>
      ) : null}
    </AnimatePresence>
  )
}

function FirstRun() {
  return (
    <motion.section
      className="firstrun"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={EASE}
    >
      <Mark />
      <h2>Your laptop is linked</h2>
      <p>
        Tap <strong>New session</strong>, name a folder the way you would say it out loud, and
        tell Claude what to do. It asks you before it changes anything.
      </p>
    </motion.section>
  )
}

/** The leash: anchored at your phone, clipped to an agent far away. */
function LeashGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <circle cx="9" cy="26" r="5.5" fill="currentColor" />
      <path
        d="M9 26C21 26 19 11 31 11"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <circle cx="31" cy="11" r="4.2" fill="var(--sage)" />
    </svg>
  )
}

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <LeashGlyph size={40} />
    </span>
  )
}
