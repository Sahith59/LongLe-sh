import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowUp,
  Check,
  ChevronLeft,
  Copy,
  Link2,
  Plus,
  RotateCcw,
  ScanLine,
  Square,
  SquareTerminal,
} from 'lucide-react'
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
import { QuestionCard } from './ui/QuestionCard.js'
import { NewSessionSheet } from './ui/NewSessionSheet.js'
import { SessionCard } from './ui/SessionCard.js'
import { Transcript } from './ui/Transcript.js'
import {
  EASE,
  EXIT,
  Key,
  Led,
  Notice,
  SectionLabel,
  SPRING,
  listVariants,
  useKeyboardInset,
} from './ui/primitives.js'
import { ORIGIN_LABEL, STATUS_LABEL, shortPath } from './ui/format.js'
import { PathChip } from './ui/PathChip.js'
import { enablePush, pushPermission, syncPush } from './lib/push.js'
import { QrScanner } from './ui/QrScanner.js'

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
  const [pushKey, setPushKey] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<AlertsState | null>(null)
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
        const key = hello.push?.publicKey ?? null
        setPushKey(key)
        const permission = pushPermission()
        if (permission === 'unsupported') setAlerts('unsupported')
        else if (key === null) setAlerts('stale-daemon')
        else if (permission === 'denied') setAlerts('denied')
        else if (permission === 'granted') {
          // Heal silently: a daemon that lost its push database gets the
          // subscription back on the next visit, no taps required.
          void syncPush(key).then((subscription) => {
            if (subscription) {
              clientRef.current?.pushSubscribe(subscription)
              setAlerts('on')
            } else {
              setAlerts('ready')
            }
          })
        } else setAlerts('ready')
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

  /**
   * Answering a question is not approving it. The verdict field still travels (the wire
   * has one), but what the daemon acts on is the answers — it turns them into the reply
   * Claude receives.
   */
  const answer = useCallback(
    (approval: PendingApproval, answers: Record<string, string>, response?: string) => {
      store.markDeciding(approval.approvalId)
      const sent = clientRef.current?.decide(approval.approvalId, 'deny', response, answers)
      if (!sent) store.rollbackDecision(approval.approvalId)
    },
    [store],
  )

  /** Hand a question back to the terminal, unanswered and unspoiled. */
  const leaveQuestion = useCallback(
    (approval: PendingApproval) => {
      store.markDeciding(approval.approvalId)
      const sent = clientRef.current?.decide(approval.approvalId, 'deny')
      if (!sent) store.rollbackDecision(approval.approvalId)
    },
    [store],
  )

  const search = useCallback((query: string) => clientRef.current?.findFolders(query), [])

  const enableAlerts = useCallback(() => {
    if (!pushKey) return
    void enablePush(pushKey).then((subscription) => {
      if (subscription) {
        clientRef.current?.pushSubscribe(subscription)
        setAlerts('on')
      } else {
        setAlerts(pushPermission() === 'denied' ? 'denied' : 'ready')
      }
    })
  }, [pushKey])

  const testAlert = useCallback(() => clientRef.current?.pushTest() ?? false, [])

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
            onAnswer={answer}
            onLeave={leaveQuestion}
            onStop={() => clientRef.current?.stopSession(openSession.sessionId)}
            onResume={() => clientRef.current?.resumeSession(openSession.sessionId)}
            onSend={(text) => clientRef.current?.sendMessage(openSession.sessionId, text) ?? false}
            onTakeOver={(text) => clientRef.current?.takeOver(openSession.sessionId, text) ?? false}
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
            onAnswer={answer}
            onLeave={leaveQuestion}
            onOpen={setOpenSessionId}
            onNew={() => setSheetOpen(true)}
            alerts={alerts}
            onEnableAlerts={enableAlerts}
            onTestAlert={testAlert}
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
            <img src="/icon-192.png" alt="" width={26} height={26} />
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
  const [scanning, setScanning] = useState(false)
  const parsed = parsePairingLink(link)

  // The scanner hands over anything it sees; only a real pairing link counts.
  const onScanned = useCallback(
    (text: string): boolean => {
      const found = parsePairingLink(text)
      if (found === null) return false
      setScanning(false)
      onPair(found.challengeId, found.secret)
      return true
    },
    [onPair],
  )

  return (
    <main className="gate">
      <Mark />
      <h1>LongLeash</h1>
      <p>
        Point this at the QR your laptop printed — scanning from inside the app pairs the right
        browser. Pasting the link works too.
      </p>
      <div className="pairbox">
        <Key className="primary wide" onClick={() => setScanning(true)}>
          <ScanLine size={18} strokeWidth={2.2} aria-hidden="true" />
          Scan the QR
        </Key>
        <input
          className="field"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="…or paste the link: https://…/?c=…&s=…"
          aria-label="Pairing link from your laptop"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {parsed !== null ? (
          <Key
            className="wide"
            onClick={() => onPair(parsed.challengeId, parsed.secret)}
          >
            Pair this device
          </Key>
        ) : null}
      </div>
      {error ? (
        <p className="err">
          Pairing failed: {error}. Pairing links are single-use — press n in the laptop terminal
          for a fresh one, then try again.
        </p>
      ) : null}
      <p className="buildtag mono">build {__BUILD__}</p>
      <AnimatePresence>
        {scanning ? <QrScanner onCode={onScanned} onClose={() => setScanning(false)} /> : null}
      </AnimatePresence>
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
  onAnswer,
  onLeave,
  onOpen,
  onNew,
  alerts,
  onEnableAlerts,
  onTestAlert,
}: {
  approvals: PendingApproval[]
  active: SessionView[]
  past: SessionView[]
  snapshot: ReturnType<ReturnType<typeof createStore>['getState']>
  diagnostic: string | null
  error: string | null
  onClearError: () => void
  onDecide: (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => void
  onAnswer: (approval: PendingApproval, answers: Record<string, string>, response?: string) => void
  onLeave: (approval: PendingApproval) => void
  onOpen: (sessionId: string) => void
  onNew: () => void
  alerts?: AlertsState | null
  onEnableAlerts?: () => void
  onTestAlert?: () => boolean
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
                {approvals.map((approval) =>
                  approval.questions ? (
                    <QuestionCard
                      key={approval.approvalId}
                      approval={approval}
                      questions={approval.questions}
                      context={snapshot.sessions[approval.sessionId]?.title || 'Untitled session'}
                      onAnswer={onAnswer}
                      onLeave={onLeave}
                    />
                  ) : (
                    <ApprovalCard
                      key={approval.approvalId}
                      approval={approval}
                      context={
                        snapshot.sessions[approval.sessionId]?.title || 'Untitled session'
                      }
                      onDecide={onDecide}
                      onOpen={() => onOpen(approval.sessionId)}
                    />
                  ),
                )}
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

        {alerts ? (
          <section>
            <SectionLabel>Alerts</SectionLabel>
            <AlertsPanel
              state={alerts}
              {...(onEnableAlerts ? { onEnable: onEnableAlerts } : {})}
              {...(onTestAlert ? { onTest: onTestAlert } : {})}
            />
          </section>
        ) : null}

        <p className="foot">
          Sessions you start here and `claude` sessions you start in a terminal both appear
          (terminals need the LongLeash hook installed on the laptop). VS Code chat panels are
          sealed and cannot be shown — that is a platform limit, not a coming feature.
          Conversations started here survive daemon restarts: reply to any of them and the same
          agent picks up where it left off.
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
  onAnswer,
  onLeave,
  onStop,
  onResume,
  onSend,
  onTakeOver,
}: {
  session: SessionView
  approvals: PendingApproval[]
  connected: boolean
  diagnostic: string | null
  error: string | null
  onClearError: () => void
  onDecide: (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => void
  onAnswer: (approval: PendingApproval, answers: Record<string, string>, response?: string) => void
  onLeave: (approval: PendingApproval) => void
  onStop: () => void
  onResume: () => void
  onSend: (text: string) => boolean
  onTakeOver: (text: string) => boolean
}) {
  const [message, setMessage] = useState('')
  const still = useReducedMotion()
  const keyboard = useKeyboardInset(true)
  // A terminal session belongs to the keyboard it was started at — until you type here.
  // Sending a message TAKES IT OVER: the daemon ends the terminal process (verified) and
  // continues the same conversation through the SDK, one driver at a time. What never
  // happens is faking keystrokes into a terminal.
  const inTerminal = session.origin === 'terminal'
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
    const text = message.trim()
    if (text === '') return
    // Terminal sessions are continued by taking them over — never by typing into them.
    if ((inTerminal ? onTakeOver : onSend)(text)) setMessage('')
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
          {session.resumeId ? (
            <ResumeInTerminal cwd={session.cwd} resumeId={session.resumeId} />
          ) : null}
        </div>

        {approvals.length > 0 ? (
          <section aria-live="polite">
            <SectionLabel count={approvals.length} urgent>
              Needs you
            </SectionLabel>
            <div className="stack">
              <AnimatePresence initial={false}>
                {approvals.map((approval) =>
                  approval.questions ? (
                    <QuestionCard
                      key={approval.approvalId}
                      approval={approval}
                      questions={approval.questions}
                      onAnswer={onAnswer}
                      onLeave={onLeave}
                    />
                  ) : (
                    <ApprovalCard key={approval.approvalId} approval={approval} onDecide={onDecide} />
                  ),
                )}
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

      <div className="dock" {...(keyboard > 0 ? { style: { bottom: keyboard } } : {})}>
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
              placeholder={
                inTerminal
                  ? live
                    ? 'Take over — ends the terminal side, continues here…'
                    : 'Type to take this conversation over…'
                  : live
                    ? 'Reply to this session…'
                    : 'Type to carry this on…'
              }
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

/* --------------------------------------------------------- resume in terminal */

/**
 * The escape hatch that keeps a conversation from belonging to any one surface.
 * Claude Code stores transcripts per project folder, so resuming needs both the
 * folder and the id — this hands over the whole command rather than an id the
 * person then has to assemble something around.
 */
function ResumeInTerminal({ cwd, resumeId }: { cwd: string; resumeId: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const command = `cd ${JSON.stringify(cwd)} && claude --resume ${resumeId}`

  const copy = () => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {
        // Clipboard refused (older browser, insecure origin). The command is on
        // screen either way, so long-press to select still works.
      })
  }

  return (
    <div className="resumeterm">
      <button
        type="button"
        className="tap quiet"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <SquareTerminal size={14} strokeWidth={2.2} aria-hidden="true" />
        {open ? 'Hide the terminal command' : 'Continue in a terminal'}
      </button>
      {open ? (
        <motion.div
          className="resumebody"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={EASE}
        >
          <code className="resumecmd">{command}</code>
          <Key className="sm wide" onClick={copy}>
            {copied ? (
              <>
                <Check size={15} strokeWidth={2.6} aria-hidden="true" />
                Copied
              </>
            ) : (
              <>
                <Copy size={15} strokeWidth={2.2} aria-hidden="true" />
                Copy command
              </>
            )}
          </Key>
          <p className="resumenote">
            Paste this in any terminal to pick this exact conversation back up at your keyboard.
            It reappears here while it runs.
          </p>
        </motion.div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------- alerts */

/**
 * Every reason lock-screen alerts might not be working, as a state with a name —
 * because "the section just isn't there" cost a real evening of guessing.
 */
export type AlertsState = 'unsupported' | 'stale-daemon' | 'ready' | 'on' | 'denied'

function AlertsPanel({
  state,
  onEnable,
  onTest,
}: {
  state: AlertsState
  onEnable?: () => void
  onTest?: () => boolean
}) {
  const [tested, setTested] = useState(false)

  if (state === 'unsupported') {
    return (
      <div className="pushoffer">
        <p>
          This browser cannot show lock-screen alerts. On iPhone, open LongLeash from its{' '}
          <strong>home-screen icon</strong> — Safari tabs are not allowed to send notifications.
        </p>
      </div>
    )
  }
  if (state === 'stale-daemon') {
    return (
      <div className="pushoffer">
        <p>
          Your laptop is running an older daemon that cannot send alerts yet. In its terminal
          press <span className="mono">q</span>, then start it again with{' '}
          <span className="mono">pnpm start ~</span>.
        </p>
      </div>
    )
  }
  if (state === 'denied') {
    return (
      <div className="pushoffer">
        <p>
          Notifications are switched off for LongLeash. Turn them on in iPhone{' '}
          <strong>Settings → Notifications → LongLeash → Allow</strong>, then reopen this app.
        </p>
      </div>
    )
  }
  if (state === 'on') {
    return (
      <div className="pushoffer">
        <p>
          Lock-screen alerts are <strong>on</strong>. When an agent needs you, your phone gets a
          content-free tap — the words stay in here.
        </p>
        <Key
          onClick={() => {
            if (onTest?.()) setTested(true)
          }}
        >
          {tested ? 'Sent — lock your phone now' : 'Send a test alert'}
        </Key>
        {tested ? (
          <p className="aftertest">The test arrives a few seconds after you lock the screen.</p>
        ) : null}
      </div>
    )
  }
  return (
    <div className="pushoffer">
      <p>
        Get tapped on the shoulder the moment an agent needs you — even with this app closed. The
        notification carries no content, ever; it only says to look here.
      </p>
      <Key {...(onEnable ? { onClick: onEnable } : {})}>Enable lock-screen alerts</Key>
    </div>
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

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <img src="/icon-192.png" alt="" width={76} height={76} />
    </span>
  )
}
