import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  Bell,
  BellOff,
  Download,
  Square,
  SquareTerminal,
  GitBranchPlus,
  ShieldAlert,
  SlidersHorizontal,
  LogOut,
  Trash2,
  X,
  CircleHelp,
  Search,
  ArrowUpDown,
  Eye,
} from 'lucide-react'
import type { DelegationPreview, DelegationReturnPreview, DelegationSummary } from '@longleash/protocol'
import {
  approvalsFor,
  createStore,
  sortSessionsNewestFirst,
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
  type AgentSettingsCatalog,
  type LinkPath,
} from './lib/client.js'
import { ApprovalCard } from './ui/ApprovalCard.js'
import { QuestionCard } from './ui/QuestionCard.js'
import { NewSessionSheet } from './ui/NewSessionSheet.js'
import { SessionCard } from './ui/SessionCard.js'
import { Transcript } from './ui/Transcript.js'
import {
  DelegateSheet,
  type PreviewDelegationInput,
  type StartDelegationInput,
} from './ui/DelegateSheet.js'
import { removeDelegationDraft } from './lib/delegation-draft.js'
import {
  matchesPendingDelegation,
  type PendingDelegationLaunch,
} from './lib/delegation-launch.js'
import {
  EASE,
  EXIT,
  Key,
  Led,
  Notice,
  SectionLabel,
  SPRING,
  useKeyboardInset,
  useVisualViewportHeight,
} from './ui/primitives.js'
import { AGENT_LABEL, MODE_LABEL, STATUS_LABEL, shortPath } from './ui/format.js'
import { PathChip } from './ui/PathChip.js'
import { enablePush, pushPermission, syncPush } from './lib/push.js'
import { QrScanner } from './ui/QrScanner.js'
import { hasSessionLink, sessionFromSearch } from './lib/deep-link.js'
import { isCurrentFolderReply } from './lib/folder-search.js'
import { ReturnSheet, type ReturnDelegationInput } from './ui/ReturnSheet.js'
import { removeReturnDraft } from './lib/delegation-return-draft.js'
import {
  SessionSettingsSheet,
  type SettingsUpdateState,
  type UpdateSessionSettingsInput,
} from './ui/SessionSettingsSheet.js'
import { useAccount } from './lib/account-context.js'
import { IdentityLegend, ProviderMark, SurfaceMark } from './ui/SessionMarks.js'
import { availableAppBuild, publishedBuild } from './lib/app-update.js'
import {
  browseSessions,
  type SessionAgent,
  type SessionScope,
  type SessionSort,
  type SessionSurface,
} from './lib/session-browser.js'

export default function App() {
  const store = useMemo(() => createStore(), [])
  const [, forceRender] = useState(0)
  const [state, setState] = useState<ConnectionState>('connecting')
  const [hydrating, setHydrating] = useState(false)
  const [linkPath, setLinkPath] = useState<LinkPath>('lan')
  const [token, setToken] = useState<string | null>(() => storedToken())
  const [pairError, setPairError] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])
  const [folders, setFolders] = useState<FolderHit[]>([])
  const [settingsCatalog, setSettingsCatalog] = useState<AgentSettingsCatalog | undefined>()
  const [settingsSessionId, setSettingsSessionId] = useState<string | null>(null)
  const [settingsUpdate, setSettingsUpdate] = useState<SettingsUpdateState | null>(null)
  const settingsUpdateRef = useRef<string | null>(null)
  const folderQueryRef = useRef('')
  const [openSessionId, setOpenSessionId] = useState<string | null>(
    // A cold start FROM a notification: the service worker put the session in the URL, so the
    // app opens on the thing that interrupted you instead of the home screen.
    () => sessionFromSearch(window.location.search),
  )
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sessionStart, setSessionStart] = useState<{
    requestId: string
    state: 'starting' | 'failed'
    error?: string
  } | null>(null)
  const sessionStartRef = useRef<string | null>(null)
  const [delegationSource, setDelegationSource] = useState<{
    sessionId: string
    sourceSeq?: number
  } | null>(null)
  const [delegationPreview, setDelegationPreview] = useState<DelegationPreview | null>(null)
  const [delegationError, setDelegationError] = useState<{ requestId: string; message: string } | null>(null)
  const [delegations, setDelegations] = useState<Record<string, DelegationSummary>>({})
  const [returnDelegationId, setReturnDelegationId] = useState<string | null>(null)
  const [returnPreview, setReturnPreview] = useState<DelegationReturnPreview | null>(null)
  const pendingReturn = useRef<{ requestId: string; idempotencyKey: string; delegationId: string } | null>(null)
  const [delegationCapabilities, setDelegationCapabilities] = useState({
    start: false,
    targets: { claude: false, codex: false },
    return: false,
    workspace: 'legacy' as 'legacy' | 'sequential',
  })
  const pendingDelegation = useRef<PendingDelegationLaunch | null>(null)
  const [pushKey, setPushKey] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<AlertsState | null>(null)
  /** Set only when the public origin proves it serves a newer app bundle. */
  const [staleApp, setStaleApp] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const updateCheckRef = useRef(0)
  const clientRef = useRef<Client | null>(null)

  // Update availability belongs to the public app origin, not to a daemon commit hash. Check
  // independently of laptop connectivity so the action also appears (and clears) while the
  // daemon is reconnecting. Focus/visibility checks make returning to an installed PWA enough;
  // nobody should need to close it or wait for an arbitrary WebSocket hello.
  useEffect(() => {
    let mounted = true
    const check = () => {
      const request = ++updateCheckRef.current
      void publishedBuild().then((published) => {
        if (!mounted || request !== updateCheckRef.current) return
        setStaleApp(availableAppBuild(__BUILD__, published))
        if (published === __BUILD__) setUpdating(false)
      })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    check()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', onVisible)
    const interval = window.setInterval(check, 5 * 60_000)
    return () => {
      mounted = false
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(interval)
    }
  }, [])

  /**
   * A notification tapped while the app is ALREADY open. The service worker cannot navigate a
   * live client, so it posts the session id instead — no reload, no lost place.
   */
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string } | null
      if (data?.type === 'longleash:open-session' && typeof data.sessionId === 'string') {
        setOpenSessionId(data.sessionId)
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  // Once the deep link has been consumed, take it out of the address bar: a reload later
  // should show where you are, not reopen where a notification once sent you.
  useEffect(() => {
    if (hasSessionLink(window.location.search)) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  useEffect(() => {
    return store.subscribe(() => forceRender((n) => n + 1))
  }, [store])

  // Pair from the QR link on first open, then clean the secret out of the URL.
  useEffect(() => {
    if (token) return
    const pairing = parsePairingLink(location.href)
    if (pairing === null) return
    pair(pairing.challengeId, pairing.secret)
      .then((issued) => {
        setToken(issued)
        history.replaceState(null, '', location.pathname)
      })
      .catch((err: Error) => setPairError(err.message))
  }, [token])

  useEffect(() => {
    if (!token) return
    const settlePendingLaunch = (delegation: DelegationSummary, requestId?: string): void => {
      const pending = pendingDelegation.current
      if (!matchesPendingDelegation(pending, delegation, requestId)) return
      if (delegation.status === 'failed' || delegation.status === 'cancelled') {
        pendingDelegation.current = null
        setDelegationError({
          requestId: pending.requestId,
          message: delegation.failure ?? 'The delegated child could not be started.',
        })
        return
      }
      if (delegation.targetSessionId === undefined) return
      removeDelegationDraft(pending.sourceSessionId, pending.sourceSeq)
      pendingDelegation.current = null
      setDelegationPreview(null)
      setDelegationError(null)
      setDelegationSource(null)
      setOpenSessionId(delegation.targetSessionId)
    }
    const settlePendingReturn = (delegation: DelegationSummary, requestId?: string): void => {
      const pending = pendingReturn.current
      if (pending === null || delegation.delegationId !== pending.delegationId) return
      const correlated = requestId === pending.requestId || delegation.returnIdempotencyKey === pending.idempotencyKey
      if (!correlated || delegation.status !== 'returned') return
      removeReturnDraft(delegation.delegationId)
      pendingReturn.current = null
      setReturnPreview(null)
      setDelegationError(null)
      setReturnDelegationId(null)
      setOpenSessionId(delegation.sourceSessionId)
    }
    const client = connect(token, store, {
      onState: setState,
      onHydration: setHydrating,
      onHello: (hello: Hello) => {
        setRoots(hello.roots)
        setSettingsCatalog(hello.capabilities.sessionSettings)
        const restoredDelegations = hello.delegations ?? []
        setDelegations(
          Object.fromEntries(restoredDelegations.map((delegation) => [delegation.delegationId, delegation])),
        )
        for (const delegation of restoredDelegations) settlePendingLaunch(delegation)
        for (const delegation of restoredDelegations) settlePendingReturn(delegation)
        setDelegationCapabilities({
          start: hello.capabilities.delegation?.start === true,
          targets: hello.capabilities.delegation?.targets ?? { claude: false, codex: false },
          return: hello.capabilities.delegation?.return === true,
          workspace: hello.capabilities.delegation?.workspace ?? 'legacy',
        })
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
      onFolders: (query, results) => {
        // Search replies can cross in flight. Never let an older empty-query/root response
        // replace the results for what the person is currently typing.
        if (isCurrentFolderReply(folderQueryRef.current, query)) setFolders(results)
      },
      onSessionStarted: (requestId, sessionId) => {
        if (requestId !== undefined && sessionStartRef.current !== requestId) return
        sessionStartRef.current = null
        setSessionStart(null)
        setSheetOpen(false)
        setOpenSessionId(sessionId)
      },
      onSessionStartError: (requestId, message) => {
        if (requestId !== undefined && sessionStartRef.current !== requestId) return
        setSessionStart((current) => current === null
          ? { requestId: requestId ?? 'legacy', state: 'failed', error: message }
          : { ...current, state: 'failed', error: message })
      },
      onSessionSettingsUpdated: (requestId, _sessionId, outcome) => {
        if (settingsUpdateRef.current !== requestId) return
        settingsUpdateRef.current = null
        setSettingsUpdate((current) =>
          current?.requestId === requestId
            ? { requestId, state: 'saved', outcome }
            : current,
        )
      },
      onSessionSettingsError: (requestId, message) => {
        if (settingsUpdateRef.current !== requestId) return
        settingsUpdateRef.current = null
        setSettingsUpdate((current) =>
          current?.requestId === requestId
            ? { requestId, state: 'failed', error: message }
            : current,
        )
      },
      onDelegationPreview: (preview) => {
        setDelegationError(null)
        setDelegationPreview(preview)
      },
      onDelegationReturnPreview: (preview) => {
        setDelegationError(null)
        setReturnPreview(preview)
      },
      onDelegationUpdate: (delegation, requestId) => {
        setDelegations((current) => ({ ...current, [delegation.delegationId]: delegation }))
        settlePendingLaunch(delegation, requestId)
        settlePendingReturn(delegation, requestId)
      },
      onDelegationError: (requestId, message) => setDelegationError({ requestId, message }),
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
    if (!sheetOpen && delegationSource === null && returnDelegationId === null) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [sheetOpen, delegationSource, returnDelegationId])

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

  const search = useCallback((query: string) => {
    folderQueryRef.current = query
    clientRef.current?.findFolders(query)
  }, [])

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

  const updateApp = useCallback(() => {
    if (updating) return
    setUpdating(true)
    void (async () => {
      const published = await publishedBuild()
      if (published === null) {
        // Keep the last proven update visible. Going offline must not silently claim success.
        setUpdating(false)
        return
      }
      if (availableAppBuild(__BUILD__, published) === null) {
        setStaleApp(null)
        setUpdating(false)
        return
      }
      try {
        // The relay owns the phone bundle. Remove every cached shell, ask the worker to
        // re-check now, then reload from the public release rather than an old local copy.
        for (const name of await caches.keys()) await caches.delete(name)
        const registrations = await navigator.serviceWorker?.getRegistrations?.()
        for (const registration of registrations ?? []) await registration.update()
      } catch {
        // Cache access can be denied in private mode. Reloading still gives the network path
        // its chance, and the build banner remains if that did not work.
      }
      window.location.replace(`${window.location.pathname}?updated=${encodeURIComponent(published ?? 'latest')}`)
    })()
  }, [updating])

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
  const allSessions = sortSessionsNewestFirst(Object.values(snapshot.sessions))
  // History persists across daemon restarts, so finished work must not look like running agents.
  /**
   * What is happening NOW, as opposed to what can be picked back up.
   *
   * `waiting` alone is not enough. A daemon restart parks every resumable conversation as
   * `waiting` so it can be reopened — correct, but it meant every conversation ever had piled
   * into this list saying "waiting for you", including ones from days earlier. A conversation
   * with no process behind it is dormant: worth keeping, not worth announcing as live.
   */
  const active = allSessions.filter(
    (s) => s.live && (s.status === 'running' || s.status === 'waiting'),
  )
  const past = allSessions.filter(
    (s) => s.status === 'ended' || s.status === 'errored' || !s.live,
  )
  const openSession = openSessionId ? snapshot.sessions[openSessionId] : undefined
  const delegationSession = delegationSource
    ? snapshot.sessions[delegationSource.sessionId]
    : undefined
  const connected = state === 'connected'
  const relatedDelegations = openSession
    ? Object.values(delegations).filter(
        (delegation) =>
          delegation.sourceSessionId === openSession.sessionId ||
          delegation.targetSessionId === openSession.sessionId,
      )
    : []

  return (
    <>
      <Rail
        connected={connected}
        via={linkPath}
        {...(staleApp === null
          ? {}
          : { updateBuild: staleApp, updating, onUpdate: updateApp })}
        {...(openSession ? { onBack: () => setOpenSessionId(null) } : {})}
      />

      {/* Both screens live in the same grid cell (.screens), so an outgoing detail can
          never push the console down the page while it leaves. Cold loads render at
          their final position; only an intentional screen change gets an exit fade. */}
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
              onSetGate={(gate) => clientRef.current?.setGate(openSession.sessionId, gate)}
              onTune={() => {
                setSettingsUpdate(null)
                setSettingsSessionId(openSession.sessionId)
              }}
              delegations={relatedDelegations}
              sessions={snapshot.sessions}
              onOpenSession={setOpenSessionId}
              onReviewReturn={(delegationId) => {
                setDelegationError(null)
                setReturnPreview(null)
                setReturnDelegationId(delegationId)
              }}
              onDelegate={(sourceSeq) => {
                setDelegationPreview(null)
                setDelegationError(null)
                setDelegationSource({
                  sessionId: openSession.sessionId,
                  ...(sourceSeq === undefined ? {} : { sourceSeq }),
                })
              }}
            />
          ) : (
            <ConsoleScreen
              key="console"
              approvals={snapshot.approvals}
              active={active}
              past={past}
              snapshot={snapshot}
              delegations={Object.values(delegations)}
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
              settling={hydrating}
            />
          )}
        </AnimatePresence>
      </div>

      <NewSessionSheet
        open={sheetOpen}
        roots={roots}
        folders={folders}
        connected={connected}
        {...(settingsCatalog === undefined ? {} : { settingsCatalog })}
        starting={sessionStart?.state === 'starting'}
        {...(sessionStart?.state === 'failed' && sessionStart.error !== undefined
          ? { startError: sessionStart.error }
          : {})}
        onSearch={search}
        onStart={(dir, prompt, agent, options) => {
          setError(null)
          const requestId = `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const sent = clientRef.current?.startSession(dir, prompt, agent, { ...options, requestId }) ?? false
          if (sent) {
            sessionStartRef.current = requestId
            setSessionStart({ requestId, state: 'starting' })
            setTimeout(() => {
              if (sessionStartRef.current !== requestId) return
              setSessionStart({
                requestId,
                state: 'failed',
                error: 'The laptop did not confirm the launch. Close this sheet and check the session list before retrying, so you do not start a duplicate.',
              })
            }, 20_000)
          }
          return sent
        }}
        onClose={() => {
          if (sessionStart?.state === 'starting') return
          sessionStartRef.current = null
          setSessionStart(null)
          setSheetOpen(false)
        }}
      />
      {delegationSource && delegationSession ? (
        <DelegateSheet
          open
          session={delegationSession}
          {...(delegationSource.sourceSeq === undefined ? {} : { sourceSeq: delegationSource.sourceSeq })}
          connected={connected}
          preview={delegationPreview}
          previewError={delegationError}
          onPreview={(input: PreviewDelegationInput) => {
            setDelegationError(null)
            return clientRef.current?.previewDelegation(input) ?? false
          }}
          launchEnabled={delegationCapabilities.start}
          workspaceMode={delegationCapabilities.workspace}
          availableTargets={delegationCapabilities.targets}
          {...(settingsCatalog === undefined ? {} : { settingsCatalog })}
          onStart={(input: StartDelegationInput) => {
            setDelegationError(null)
            pendingDelegation.current = {
              requestId: input.requestId,
              idempotencyKey: input.idempotencyKey,
              sourceSessionId: input.sourceSessionId,
              ...(input.sourceSeq === undefined ? {} : { sourceSeq: input.sourceSeq }),
            }
            return clientRef.current?.startDelegation(input) ?? false
          }}
          onClose={() => setDelegationSource(null)}
        />
      ) : null}
      {settingsSessionId && snapshot.sessions[settingsSessionId] ? (
        <SessionSettingsSheet
          open
          session={snapshot.sessions[settingsSessionId]}
          connected={connected}
          update={settingsUpdate}
          {...(settingsCatalog === undefined ? {} : { catalog: settingsCatalog })}
          onSave={(input: UpdateSessionSettingsInput) => {
            settingsUpdateRef.current = input.requestId
            setSettingsUpdate({ requestId: input.requestId, state: 'saving' })
            const sent = clientRef.current?.updateSessionSettings(input) ?? false
            if (!sent) {
              settingsUpdateRef.current = null
              setSettingsUpdate({
                requestId: input.requestId,
                state: 'failed',
                error: 'Not connected to your laptop — settings were not changed.',
              })
            } else {
              setTimeout(() => {
                if (settingsUpdateRef.current !== input.requestId) return
                settingsUpdateRef.current = null
                setSettingsUpdate({
                  requestId: input.requestId,
                  state: 'failed',
                  error: 'The laptop did not confirm the change. The current session state was left visible; reconnect and verify before retrying.',
                })
              }, 20_000)
            }
            return sent
          }}
          onClose={() => {
            if (settingsUpdate?.state === 'saving') return
            settingsUpdateRef.current = null
            setSettingsSessionId(null)
            setSettingsUpdate(null)
          }}
        />
      ) : null}
      {returnDelegationId && delegations[returnDelegationId] ? (
        <ReturnSheet
          open
          delegation={delegations[returnDelegationId]}
          preview={returnPreview}
          error={delegationError}
          connected={connected && delegationCapabilities.return}
          onPrepare={(input) => {
            setDelegationError(null)
            return clientRef.current?.prepareReturn(input) ?? false
          }}
          onReturn={(input: ReturnDelegationInput) => {
            setDelegationError(null)
            pendingReturn.current = {
              requestId: input.requestId,
              idempotencyKey: input.idempotencyKey,
              delegationId: input.delegationId,
            }
            return clientRef.current?.returnDelegation(input) ?? false
          }}
          onClose={() => setReturnDelegationId(null)}
        />
      ) : null}
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
  updateBuild,
  updating = false,
  onUpdate,
}: {
  connected: boolean
  /**
   * Which road the link takes. This describes the ROUTE, never the person's whereabouts —
   * "away" was once shown to someone sitting at home on their own Wi-Fi, which is a lie.
   */
  via?: LinkPath
  onBack?: () => void
  updateBuild?: string
  updating?: boolean
  onUpdate?: () => void
}) {
  const account = useAccount()
  const [accountOpen, setAccountOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const closeAccount = useCallback(() => setAccountOpen(false), [])
  const closeHelp = useCallback(() => setHelpOpen(false), [])
  return (
    <div className={`rail${onUpdate ? ' has-update' : ''}`}>
      <div className="rail-in">
        {onBack ? (
          <button type="button" className="tap" onClick={onBack} aria-label="Back to all sessions">
            <ChevronLeft size={18} strokeWidth={2.4} aria-hidden="true" />
            <span className="back-label">Sessions</span>
          </button>
        ) : (
          <h1 className="wordmark">
            <img src="/icon-192.png" alt="" width={26} height={26} />
            <span>LongLeash</span>
          </h1>
        )}
        <span className="spacer" />
        {onUpdate ? (
          <Key
            className="railupdate"
            onClick={onUpdate}
            disabled={updating}
            label={`Update LongLeash to build ${updateBuild ?? 'latest'}`}
          >
            <Download size={14} strokeWidth={2.4} aria-hidden="true" />
            <span className="railupdate-label">{updating ? 'Updating…' : 'Update'}</span>
          </Key>
        ) : null}
        <button
          type="button"
          className="rail-icon"
          onClick={() => setHelpOpen(true)}
          title="How to use LongLeash"
          aria-label="How to use LongLeash"
          aria-expanded={helpOpen}
        >
          <CircleHelp size={18} strokeWidth={2.1} aria-hidden="true" />
        </button>
        {account.hosted && account.signOut ? (
          <button
            type="button"
            className="account-pill"
            onClick={() => setAccountOpen(true)}
            title={account.label ? `Signed in as ${account.label}. Account settings` : 'Account settings'}
            aria-label={account.label ? `Signed in as ${account.label}. Account settings` : 'Account settings'}
            aria-expanded={accountOpen}
          >
            <span aria-hidden="true">{account.label?.slice(0, 1).toUpperCase() ?? 'L'}</span>
            <LogOut size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : null}
        <span className={`link-state${connected ? ' on' : ''}`}>
          {connected ? <Led status="running" /> : <Link2 size={13} strokeWidth={2.3} aria-hidden="true" />}
          {connected ? (
            <>
              linked<span className="route-detail">{via === 'relay' ? ' · relay' : ' · direct'}</span>
            </>
          ) : 'reconnecting'}
        </span>
        <span className="sr" role="status">
          {connected
            ? via === 'relay'
              ? 'Connected to your laptop through the relay, end-to-end encrypted'
              : 'Connected directly to your laptop on this network'
            : 'Reconnecting to your laptop'}
        </span>
      </div>
      {helpOpen ? <HelpSheet connected={connected} {...(via === undefined ? {} : { via })} onClose={closeHelp} /> : null}
      {accountOpen ? <AccountSheet account={account} onClose={closeAccount} /> : null}
    </div>
  )
}

export function HelpSheet({ connected, via, onClose }: { connected: boolean; via?: LinkPath; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const viewportHeight = useVisualViewportHeight(true)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const previousBodyOverflow = document.body.style.overflow
    const previousRootOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), summary, a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])
    const frame = window.requestAnimationFrame(() => focusable()[0]?.focus())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousRootOverflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  return createPortal(
    <div className="account-sheet-scrim" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        ref={dialogRef}
        className="help-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-sheet-title"
        style={viewportHeight === null ? undefined : { height: `${Math.max(360, viewportHeight - 76)}px` }}
      >
        <span className="help-sheet-handle" aria-hidden="true" />
        <header className="help-sheet-header">
          <div>
            <p className="account-kicker">Pocket field guide</p>
            <h2 id="help-sheet-title">Operate LongLeash</h2>
          </div>
          <button className="help-sheet-close" type="button" onClick={onClose} aria-label="Close help">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className={`help-connection${connected ? ' connected' : ''}`}>
          <Led status={connected ? 'running' : 'ended'} />
          <span>{connected ? `Laptop linked ${via === 'relay' ? 'through relay' : 'directly'}` : 'Laptop reconnecting'}</span>
        </div>
        <div className="help-sheet-scroll">
          <section className="help-quick" aria-labelledby="help-quick-title">
            <h3 id="help-quick-title">Start a session</h3>
            <ol>
              <li><span>1</span><p>Keep the laptop on and awake.</p></li>
              <li><span>2</span><p>Tap <strong>New session</strong> and choose the agent and project.</p></li>
              <li><span>3</span><p>Choose Manual, Auto, or Plan, then send one concrete task.</p></li>
              <li><span>4</span><p>Review approvals, reply, tune, hand off, or stop here.</p></li>
            </ol>
          </section>

          <details className="help-topic">
            <summary>Modes and safety</summary>
            <dl>
              <div><dt>Manual</dt><dd>Commands and edits ask first.</dd></div>
              <div><dt>Auto</dt><dd>Uses each provider's guarded automation. Unrestricted access stays off.</dd></div>
              <div><dt>Plan</dt><dd>Inspects and designs with workspace writes disabled.</dd></div>
            </dl>
            <p>Changes apply to the next turn, never work already in progress.</p>
          </details>

          <details className="help-topic">
            <summary>Read the session marks</summary>
            <IdentityLegend />
            <p>The provider mark identifies Claude or Codex. The surface mark shows Phone, Terminal, or VS Code.</p>
          </details>

          <details className="help-topic">
            <summary>Move between phone and laptop</summary>
            <p>A native session stays with Terminal or VS Code until you explicitly move control. LongLeash preserves the conversation ID and continues the same transcript.</p>
          </details>

          <details className="help-topic">
            <summary>Fix a laptop that will not link</summary>
            <div className="help-commands">
              <code>longleash service status</code>
              <code>longleash doctor</code>
              <code>longleash service restart</code>
              <code>longleash pair</code>
            </div>
            <p>Run them in order. Pairing links are single-use, so print a fresh one after a failed attempt.</p>
          </details>
        </div>

        <a className="help-docs" href="/docs/getting-started">Open the full guide</a>
      </section>
    </div>,
    document.body,
  )
}

function AccountSheet({ account, onClose }: { account: ReturnType<typeof useAccount>; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const keyboard = useKeyboardInset(true)
  const viewportHeight = useVisualViewportHeight(true)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const body = document.body
    const root = document.documentElement
    const previousBodyOverflow = body.style.overflow
    const previousRootOverflow = root.style.overflow
    body.style.overflow = 'hidden'
    root.style.overflow = 'hidden'

    const focusable = () => Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((node) => node.getAttribute('aria-hidden') !== 'true')
    const frame = window.requestAnimationFrame(() => focusable()[0]?.focus())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      body.style.overflow = previousBodyOverflow
      root.style.overflow = previousRootOverflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  const remove = async () => {
    if (confirmation !== 'DELETE' || !account.deleteAccount || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await account.deleteAccount()
    } catch {
      setDeleteError('The account could not be deleted. Nothing was removed; retry or contact privacy@longleash.dev.')
      setDeleting(false)
    }
  }

  return createPortal(
    <div
      className="account-sheet-scrim"
      role="presentation"
      style={keyboard > 0 ? { bottom: keyboard } : undefined}
      onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="account-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-sheet-title"
        aria-describedby="account-sheet-boundary"
        style={viewportHeight === null ? undefined : { maxHeight: `${Math.max(240, viewportHeight - 24)}px` }}
      >
        <button className="sheetclose" type="button" onClick={onClose} aria-label="Close account settings">
          <X size={20} aria-hidden="true" />
        </button>
        <p className="account-kicker">Hosted identity</p>
        <h2 id="account-sheet-title">Your LongLeash account</h2>
        <p className="account-sheet-label mono">{account.label ?? 'Signed in'}</p>
        <div className="account-sheet-actions">
          <Key className="wide" {...(account.signOut ? { onClick: account.signOut } : {})} disabled={!account.signOut}>
            <LogOut size={16} aria-hidden="true" /> Sign out
          </Key>
          <Key className="wide" {...(account.exportAccount ? { onClick: account.exportAccount } : {})} disabled={!account.exportAccount}>
            <Download size={16} aria-hidden="true" /> Download account data
          </Key>
        </div>
        <div className="account-data-boundary" id="account-sheet-boundary">
          This account identifies you to the hosted app. Laptop code, transcripts, provider
          credentials, and pairing secrets are outside the account database.
        </div>
        {!confirming ? (
          <button className="account-delete-link" type="button" onClick={() => setConfirming(true)}>
            <Trash2 size={14} aria-hidden="true" /> Delete account
          </button>
        ) : (
          <div className="account-delete-confirm">
            <strong>Delete hosted identity?</strong>
            <p>
              This permanently deletes the account and this browser’s paired credentials. It does
              not delete local laptop transcripts. Type <code>DELETE</code> to continue.
            </p>
            <input
              className="field"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="DELETE"
              aria-label="Type DELETE to confirm account deletion"
              autoCapitalize="characters"
              autoComplete="off"
            />
            <div className="account-delete-actions">
              <Key onClick={() => { setConfirming(false); setConfirmation(''); setDeleteError(null) }}>Keep account</Key>
              <Key className="danger" onClick={() => void remove()} disabled={confirmation !== 'DELETE' || deleting}>
                <Trash2 size={15} aria-hidden="true" /> {deleting ? 'Deleting…' : 'Delete permanently'}
              </Key>
            </div>
            {deleteError ? <p className="err" role="alert">{deleteError}</p> : null}
          </div>
        )}
      </section>
    </div>,
    document.body,
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
          placeholder="…or paste the link: https://…/#c=…&s=…"
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

/**
 * Accepts the current fragment form, legacy query links, or only the copied parameter text.
 * Fragment credentials never leave the browser in an HTTP request; query support remains only so
 * an already-printed single-use QR from an older daemon does not become mysteriously unreadable.
 */
export function parsePairingLink(raw: string): { challengeId: string; secret: string } | null {
  const text = raw.trim()
  if (text.length === 0) return null

  const candidates: string[] = []
  const hashAt = text.indexOf('#')
  if (hashAt >= 0) candidates.push(text.slice(hashAt + 1))
  const queryAt = text.indexOf('?')
  if (queryAt >= 0) {
    const end = hashAt > queryAt ? hashAt : text.length
    candidates.push(text.slice(queryAt + 1, end))
  }
  if (hashAt < 0 && queryAt < 0) candidates.push(text.replace(/^[?#]/, ''))

  for (const candidate of candidates) {
    const params = new URLSearchParams(candidate)
    const challengeId = params.get('c')
    const secret = params.get('s')
    if (challengeId && secret) return { challengeId, secret }
  }
  return null
}

/* ------------------------------------------------------------------ screens */

function SessionBrowserControls({
  query,
  onQuery,
  scope,
  onScope,
  agent,
  onAgent,
  surface,
  onSurface,
  sort,
  onSort,
  filtersOpen,
  onToggleFilters,
  filterCount,
  resultCount,
}: {
  query: string
  onQuery: (value: string) => void
  scope: SessionScope
  onScope: (value: SessionScope) => void
  agent: SessionAgent
  onAgent: (value: SessionAgent) => void
  surface: SessionSurface
  onSurface: (value: SessionSurface) => void
  sort: SessionSort
  onSort: (value: SessionSort) => void
  filtersOpen: boolean
  onToggleFilters: () => void
  filterCount: number
  resultCount: number
}) {
  const choice = <T extends string>(
    value: T,
    selected: T,
    select: (next: T) => void,
    label: string,
  ) => (
    <button
      key={value}
      type="button"
      className="sessionfilter-chip"
      aria-pressed={selected === value}
      onClick={() => select(value)}
    >
      {selected === value ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : null}
      {label}
    </button>
  )

  return (
    <section className="sessionbrowser" aria-label="Find and organize sessions">
      <div className="sessionsearch">
        <Search size={18} strokeWidth={2.1} aria-hidden="true" />
        <label className="sr" htmlFor="session-search">Search sessions and messages</label>
        <input
          id="session-search"
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search sessions or messages"
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button type="button" onClick={() => onQuery('')} aria-label="Clear session search">
            <X size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="sessionbrowser-bar">
        <button
          type="button"
          className="sessionfilter-toggle"
          onClick={onToggleFilters}
          aria-expanded={filtersOpen}
          aria-controls="session-filter-panel"
        >
          <SlidersHorizontal size={16} strokeWidth={2.1} aria-hidden="true" />
          Filters{filterCount > 0 ? <span>{filterCount}</span> : null}
        </button>
        <label className="sessionsort">
          <span className="sr">Sort sessions</span>
          <ArrowUpDown size={15} strokeWidth={2.1} aria-hidden="true" />
          <select value={sort} onChange={(event) => onSort(event.target.value as SessionSort)}>
            <option value="recommended">Priority</option>
            <option value="recent">Recent activity</option>
            <option value="oldest">Oldest activity</option>
            <option value="name">Name</option>
            <option value="project">Project</option>
          </select>
        </label>
        <span className="sessionresult-count" aria-live="polite">{resultCount} shown</span>
      </div>
      {filtersOpen ? (
        <div className="sessionfilter-panel" id="session-filter-panel">
          <fieldset>
            <legend>State</legend>
            <div>
              {choice('all', scope, onScope, 'All')}
              {choice('active', scope, onScope, 'Active')}
              {choice('needs', scope, onScope, 'Needs you')}
              {choice('history', scope, onScope, 'History')}
            </div>
          </fieldset>
          <fieldset>
            <legend>Agent</legend>
            <div>
              {choice('all', agent, onAgent, 'All')}
              {choice('claude', agent, onAgent, 'Claude')}
              {choice('codex', agent, onAgent, 'Codex')}
            </div>
          </fieldset>
          <fieldset>
            <legend>Started in</legend>
            <div>
              {choice('all', surface, onSurface, 'Everywhere')}
              {choice('phone', surface, onSurface, 'Phone')}
              {choice('terminal', surface, onSurface, 'Terminal')}
              {choice('vscode', surface, onSurface, 'VS Code')}
            </div>
          </fieldset>
        </div>
      ) : null}
    </section>
  )
}

export function ConsoleScreen({
  approvals,
  active,
  past,
  snapshot,
  delegations = [],
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
  settling = false,
}: {
  approvals: PendingApproval[]
  active: SessionView[]
  past: SessionView[]
  snapshot: ReturnType<ReturnType<typeof createStore>['getState']>
  delegations?: DelegationSummary[]
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
  settling?: boolean
}) {
  const still = useReducedMotion()
  const firstRun = approvals.length === 0 && active.length === 0 && past.length === 0
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [scope, setScope] = useState<SessionScope>('all')
  const [agent, setAgent] = useState<SessionAgent>('all')
  const [surface, setSurface] = useState<SessionSurface>('all')
  const [sort, setSort] = useState<SessionSort>('recommended')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const pendingBySession = useMemo(() => approvals.reduce<Record<string, number>>((counts, approval) => {
    counts[approval.sessionId] = (counts[approval.sessionId] ?? 0) + 1
    return counts
  }, {}), [approvals])
  const results = useMemo(() => browseSessions([...active, ...past], {
    query: deferredQuery,
    scope,
    agent,
    surface,
    sort,
    pendingBySession,
  }), [active, past, deferredQuery, scope, agent, surface, sort, pendingBySession])
  const visibleActive = results.filter(({ session }) =>
    session.live && (session.status === 'running' || session.status === 'waiting'))
  const visiblePast = results.filter(({ session }) =>
    !session.live || session.status === 'ended' || session.status === 'errored')
  const refined = query.trim() !== '' || scope !== 'all' || agent !== 'all' || surface !== 'all'
  const filterCount = Number(scope !== 'all') + Number(agent !== 'all') + Number(surface !== 'all')
  const resetBrowser = () => {
    setQuery('')
    setScope('all')
    setAgent('all')
    setSurface('all')
    setSort('recommended')
  }

  return (
    <Screen depth={-1} still={still}>
      <main className="shell hasdock" aria-busy={settling}>
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
          <SessionBrowserControls
            query={query}
            onQuery={setQuery}
            scope={scope}
            onScope={setScope}
            agent={agent}
            onAgent={setAgent}
            surface={surface}
            onSurface={setSurface}
            sort={sort}
            onSort={setSort}
            filtersOpen={filtersOpen}
            onToggleFilters={() => setFiltersOpen((open) => !open)}
            filterCount={filterCount}
            resultCount={results.length}
          />
        )}

        {!firstRun && visibleActive.length > 0 ? (
          <section>
            <SectionLabel count={visibleActive.length}>Active</SectionLabel>
            <div className="stack">
              {visibleActive.map(({ session, match }) => (
                <SessionCard
                  key={session.sessionId}
                  session={session}
                  pending={approvalsFor(snapshot, session.sessionId).length}
                  children={delegationCounts(delegations, session.sessionId)}
                  onOpen={() => onOpen(session.sessionId)}
                  settling={settling}
                  {...(match === undefined ? {} : { searchMatch: match })}
                />
              ))}
            </div>
          </section>
        ) : null}

        {!firstRun && visiblePast.length > 0 ? (
          <section>
            <SectionLabel count={visiblePast.length}>History</SectionLabel>
            <div className="stack">
              {visiblePast.slice(0, 50).map(({ session, match }) => (
                <SessionCard
                  key={session.sessionId}
                  session={session}
                  pending={0}
                  children={delegationCounts(delegations, session.sessionId)}
                  onOpen={() => onOpen(session.sessionId)}
                  settling={settling}
                  {...(match === undefined ? {} : { searchMatch: match })}
                />
              ))}
            </div>
          </section>
        ) : null}

        {!firstRun && results.length === 0 ? (
          <section className="sessionbrowser-empty" aria-live="polite">
            <Search size={19} strokeWidth={2} aria-hidden="true" />
            <strong>{refined ? 'No sessions match' : 'Nothing running yet'}</strong>
            <p>{refined ? 'Try fewer words or clear the filters.' : 'Start a session from the button below.'}</p>
            {refined ? <button type="button" onClick={resetBrowser}>Clear search and filters</button> : null}
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
          Sessions started here, in a terminal, and in VS Code all appear after the agent's
          first lifecycle event or tool call (the laptop hooks must be installed).
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

function delegationCounts(delegations: DelegationSummary[], sourceSessionId: string) {
  const children = delegations.filter((delegation) => delegation.sourceSessionId === sourceSessionId)
  return {
    total: children.length,
    active: children.filter(
      (delegation) => delegation.status === 'starting' || delegation.status === 'running',
    ).length,
    ready: children.filter((delegation) => delegation.status === 'ready').length,
  }
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
  onSetGate,
  onTune,
  onDelegate,
  delegations,
  sessions,
  onOpenSession,
  onReviewReturn,
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
  onSetGate: (gate: 'ask' | 'auto') => void
  onTune?: () => void
  onDelegate?: (sourceSeq?: number) => void
  delegations?: DelegationSummary[]
  sessions?: Record<string, SessionView>
  onOpenSession?: (sessionId: string) => void
  onReviewReturn?: (delegationId: string) => void
}) {
  const [message, setMessage] = useState('')
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const still = useReducedMotion()
  const keyboard = useKeyboardInset(true)
  // A terminal session belongs to the keyboard it was started at — until you type here.
  // Sending a message TAKES IT OVER: the daemon ends the terminal process (verified) and
  // continues the same conversation through the SDK, one driver at a time. What never
  // happens is faking keystrokes into a terminal.
  const externallyDriven = session.controller === 'external' || (
    session.controller === undefined && (session.origin === 'terminal' || session.origin === 'vscode')
  )
  // Typing wakes a dormant conversation, so the composer belongs to anything continuable —
  // not only to what happens to be running right now.
  const live = session.live && (session.status === 'running' || session.status === 'waiting')
  const observedOnly = session.control === 'observe'
  const canType = !observedOnly && (live || session.resumable) && session.workspaceConflict === undefined
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const followTail = useRef(true)

  useEffect(() => {
    const node = readoutRef.current
    if (node && followTail.current) node.scrollTop = node.scrollHeight
  }, [session.blocks])

  const send = () => {
    const text = message.trim()
    if (text === '') return
    if (externallyDriven && live) {
      setConfirmTakeover(true)
      return
    }
    // Terminal sessions are continued by taking them over — never by typing into them.
    if ((externallyDriven ? onTakeOver : onSend)(text)) setMessage('')
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
            <div className="detailactions">
              {onTune && !observedOnly && (session.agent === 'claude' || session.agent === 'codex') ? (
                <Key className="sm tunekey" onClick={onTune} label="Change model and reasoning for this conversation">
                  <SlidersHorizontal size={14} strokeWidth={2.3} aria-hidden="true" />
                  Tune
                </Key>
              ) : null}
              {onDelegate && !observedOnly ? (
                <Key className="sm delegatekey" onClick={() => onDelegate()} label="Delegate from this session">
                  <GitBranchPlus size={14} strokeWidth={2.3} aria-hidden="true" />
                  Delegate
                </Key>
              ) : null}
              {live && !observedOnly ? (
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
          </div>
          <p className="meta">
            <span className="sessionidentity detailidentity">
              <Led status={session.status} />
              <span className={`state ${session.status}`}>
                {observedOnly
                  ? 'observed in VS Code'
                  : !session.live && session.status === 'waiting'
                  ? 'ready to reopen'
                  : (STATUS_LABEL[session.status] ?? session.status)}
              </span>
              <span className="identitydivider" aria-hidden="true" />
              <ProviderMark agent={session.agent} />
              <SurfaceMark origin={session.origin} />
            </span>
            {session.settings?.mode ? (
              <span className="sessiontag modetag">{session.settings.mode}</span>
            ) : null}
            {session.permissionMode ? (
              <span title="The permission mode this session is running in">
                {MODE_LABEL[session.permissionMode] ?? session.permissionMode}
              </span>
            ) : null}
            {session.settings?.model ? (
              <span className="sessiontag settingtag">{session.settings.model}</span>
            ) : null}
            {session.settings?.effort ? (
              <span>{session.settings.effort} effort</span>
            ) : null}
            {session.settings?.thinking ? (
              <span>
                {session.settings.thinking.mode === 'fixed'
                  ? `${session.settings.thinking.budgetTokens?.toLocaleString()} thinking tokens`
                  : session.settings.thinking.mode === 'disabled'
                    ? 'thinking off'
                    : 'adaptive thinking'}
              </span>
            ) : null}
            {session.workspace?.mode === 'isolated' ? (
              <span className="sessiontag isolatedtag" title={session.workspace.branch}>
                isolated branch
              </span>
            ) : null}
            <PathChip text={session.cwd} kind="folder" max={30} expandable />
          </p>
          {externallyDriven && live && !observedOnly ? (
            <GateSwitch
              gate={session.gate ?? 'ask'}
              {...(session.permissionMode ? { permissionMode: session.permissionMode } : {})}
              onSet={onSetGate}
            />
          ) : null}
          {!observedOnly && (session.agent === 'claude' || session.agent === 'codex') ? (
            <TerminalHandoff
              cwd={session.cwd}
              resumeId={session.resumeId}
              agent={session.agent}
              live={live}
              expandedByDefault={session.origin === 'phone' || session.resumeId !== undefined}
              onRelease={onStop}
            />
          ) : null}
        </div>

        {observedOnly ? (
          <div className="observed-session" role="status">
            <Eye size={18} strokeWidth={2.1} aria-hidden="true" />
            <div>
              <strong>Live activity from Codex in VS Code</strong>
              <p>This conversation was already open when LongLeash connected. It stays visible and searchable here; continue or stop it in VS Code until its next lifecycle hook grants full control.</p>
            </div>
          </div>
        ) : null}

        {session.workspaceConflict ? (
          <div className="workspace-conflict" role="alert">
            <ShieldAlert size={18} strokeWidth={2.2} aria-hidden="true" />
            <div>
              <strong>
                {session.workspaceConflict.processPaused
                  ? 'Checkout process paused to prevent two writers'
                  : 'Conflict detected — process pause not verified'}
              </strong>
              <p>
                {sessions?.[session.workspaceConflict.ownerSessionId]?.title
                  ? <><strong>{sessions[session.workspaceConflict.ownerSessionId]?.title}</strong> owns</>
                  : 'Another active session owns'}
                <span className="mono"> {shortPath(session.workspaceConflict.cwd)}</span>.
                {session.workspaceConflict.processPaused
                  ? ' Open or stop it, or start a new Safe parallel session to work in an isolated branch.'
                  : ' Permission requests are denied, but auto-approved activity cannot be guaranteed. Stop this session immediately before continuing.'}
              </p>
              {onOpenSession && sessions?.[session.workspaceConflict.ownerSessionId] ? (
                <button
                  type="button"
                  className="tap quiet conflict-open"
                  onClick={() => onOpenSession(session.workspaceConflict?.ownerSessionId ?? '')}
                >
                  Open controlling session
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {onOpenSession && sessions ? (
          <DelegationLineage
            session={session}
            delegations={delegations ?? []}
            sessions={sessions}
            onOpen={onOpenSession}
            {...(onReviewReturn ? { onReviewReturn } : {})}
          />
        ) : null}

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
              <Transcript
                blocks={session.blocks}
                {...(onDelegate ? { onDelegate: (block) => onDelegate(block.firstSeq) } : {})}
              />
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
        {confirmTakeover ? (
          <div className="transfer-confirm" role="alertdialog" aria-label="Transfer session to phone">
            <div>
              <strong>Move this conversation to your phone?</strong>
              <p>The current {session.origin === 'vscode' ? 'VS Code' : 'terminal'} run will close first. LongLeash waits for it to release the transcript before sending your message.</p>
            </div>
            <div className="transfer-actions">
              <Key className="sm" onClick={() => setConfirmTakeover(false)}>Keep it there</Key>
              <Key
                className="sm primary"
                onClick={() => {
                  const text = message.trim()
                  if (text !== '' && onTakeOver(text)) {
                    setMessage('')
                    setConfirmTakeover(false)
                  }
                }}
                disabled={!connected}
              >
                End there &amp; continue here
              </Key>
            </div>
          </div>
        ) : canType ? (
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
                externallyDriven ? 'Take over and reply…' : live ? 'Reply…' : 'Carry this on…'
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
            {session.workspaceConflict
              ? 'This checkout is paused while another session owns it. No message or tool is sent from here.'
              : 'This conversation cannot be continued — it has no resume point. Start a new session in the same folder to pick the work back up.'}
          </p>
        )}
      </div>
    </Screen>
  )
}

function DelegationLineage({
  session,
  delegations,
  sessions,
  onOpen,
  onReviewReturn,
}: {
  session: SessionView
  delegations: DelegationSummary[]
  sessions: Record<string, SessionView>
  onOpen: (sessionId: string) => void
  onReviewReturn?: (delegationId: string) => void
}) {
  const incoming = delegations.find((delegation) => delegation.targetSessionId === session.sessionId)
  const parentId = incoming?.sourceSessionId ?? session.relationship?.parentSessionId
  const outgoing = delegations.filter((delegation) => delegation.sourceSessionId === session.sessionId)
  if (parentId === undefined && outgoing.length === 0) return null

  return (
    <section className="lineage" aria-label="Delegated work">
      {parentId ? (
        <div className="lineage-source-row">
          <button
            type="button"
            className="lineage-parent"
            onClick={() => onOpen(parentId)}
            disabled={sessions[parentId] === undefined}
          >
            <GitBranchPlus size={16} strokeWidth={2.3} aria-hidden="true" />
            <span>
              <small>Delegated from</small>
              <strong>{sessions[parentId]?.title || 'Source session'}</strong>
            </span>
            <span className="lineage-open">Open source</span>
          </button>
          {incoming?.status === 'ready' && onReviewReturn ? (
            <button
              type="button"
              className="lineage-return"
              onClick={() => onReviewReturn(incoming.delegationId)}
            >
              Review return
            </button>
          ) : null}
        </div>
      ) : null}
      {outgoing.length > 0 ? (
        <div className="lineage-children">
          <div className="lineage-label">
            <span>Delegated work</span>
            <span className="mono">{outgoing.length}</span>
          </div>
          {outgoing.map((delegation) => {
            const child = delegation.targetSessionId
              ? sessions[delegation.targetSessionId]
              : undefined
            const canOpen = delegation.targetSessionId !== undefined && child !== undefined
            return (
              <div className="lineage-row" key={delegation.delegationId}>
                <button
                  type="button"
                  className="lineage-child"
                  onClick={() => delegation.targetSessionId && onOpen(delegation.targetSessionId)}
                  disabled={!canOpen}
                >
                  <span className="lineage-agent" data-agent={delegation.targetAgent}>
                    {AGENT_LABEL[delegation.targetAgent] ?? delegation.targetAgent}
                  </span>
                  <span className="lineage-role">{delegation.role}</span>
                  <span className={`lineage-status ${delegation.status}`}>
                    {delegationStatusLabel(delegation, child)}
                  </span>
                  {delegation.failure ? (
                    <small>
                      {delegation.targetSessionId === undefined
                        ? `No child was created. ${delegation.failure}`
                        : delegation.failure}
                    </small>
                  ) : null}
                </button>
                {delegation.status === 'ready' && onReviewReturn ? (
                  <button
                    type="button"
                    className="lineage-return"
                    onClick={() => onReviewReturn(delegation.delegationId)}
                  >
                    Review return
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

function delegationStatusLabel(delegation: DelegationSummary, child?: SessionView): string {
  if (delegation.status === 'ready') return 'ready to review'
  if (delegation.status === 'starting') return 'starting…'
  // A launch that stopped at the safety gate did not create a broken child. Calling that
  // child "failed" made people look for a process that never existed.
  if (delegation.status === 'failed' && delegation.targetSessionId === undefined) return 'not started'
  if (delegation.status !== 'running') return delegation.status
  if (child?.status === 'waiting') return child.live ? 'waiting for you' : 'ready to reopen'
  if (child?.status === 'errored') return 'failed'
  if (child?.status === 'ended') return 'ready to review'
  return 'working'
}

/* ------------------------------------------------------------------ the gate */

/**
 * Whether this session may page your phone at all.
 *
 * It only ever asks for LESS. A session whose permission mode auto-approves ignores a
 * refusal from anyone — so paging you about it is a question whose answer cannot matter,
 * and muting is the honest remedy. The label says what the mode actually is beside it,
 * so the two are never confused for one another.
 */
function GateSwitch({
  gate,
  permissionMode,
  onSet,
}: {
  gate: 'ask' | 'auto'
  permissionMode?: string
  onSet: (gate: 'ask' | 'auto') => void
}) {
  const muted = gate === 'auto'
  return (
    <div className="gateswitch">
      <button
        type="button"
        className="tap quiet"
        aria-pressed={muted}
        onClick={() => onSet(muted ? 'ask' : 'auto')}
      >
        {muted ? (
          <BellOff size={14} strokeWidth={2.2} aria-hidden="true" />
        ) : (
          <Bell size={14} strokeWidth={2.2} aria-hidden="true" />
        )}
        {muted ? 'Not asking you — tap to ask again' : 'Asking you first — tap to stop asking'}
      </button>
      {muted ? (
        <p className="gatenote">
          Tools run without reaching your phone. The transcript still shows everything.
        </p>
      ) : permissionMode === 'bypassPermissions' ? (
        <p className="gatenote">
          This session auto-approves everything on the laptop, so your answer cannot stop
          it. Stop asking, or Stop the session.
        </p>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------- resume in terminal */

/**
 * The escape hatch that keeps a conversation from belonging to any one surface.
 * Claude Code stores transcripts per project folder, so resuming needs both the
 * folder and the id — this hands over the whole command rather than an id the
 * person then has to assemble something around.
 */
function TerminalHandoff({
  cwd,
  resumeId,
  agent,
  live,
  expandedByDefault = false,
  onRelease,
}: {
  cwd: string
  resumeId: string | undefined
  agent: string
  live: boolean
  expandedByDefault?: boolean
  onRelease?: () => void
}) {
  const [open, setOpen] = useState(expandedByDefault)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [releaseRequested, setReleaseRequested] = useState(false)
  const [target, setTarget] = useState<'terminal' | 'vscode'>('terminal')
  const quotedId = resumeId === undefined ? '' : JSON.stringify(resumeId)
  const resume = agent === 'codex' ? `codex resume ${quotedId}` : `claude --resume ${quotedId}`
  const ideResume = agent === 'codex'
    ? `codex resume ${quotedId}`
    : `claude --ide --resume ${quotedId}`
  const command = target === 'terminal'
    ? `cd ${JSON.stringify(cwd)} && ${resume}`
    : `code -r ${JSON.stringify(cwd)} && cd ${JSON.stringify(cwd)} && ${ideResume}`

  const copy = () => {
    if (resumeId === undefined) return
    setCopyError(false)
    const clipboard = navigator.clipboard
    if (!clipboard) {
      setCopyError(true)
      return
    }
    void clipboard.writeText(command)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
      })
      .catch(() => {
        // The visible command remains selectable as the recovery path on browsers that block
        // programmatic clipboard access.
        setCopyError(true)
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
        {open
          ? 'Hide terminal handoff'
          : live
            ? 'Move to a terminal'
            : 'Continue in a terminal'}
      </button>
      {open ? (
        <motion.div
          className="resumebody"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={EASE}
        >
          {resumeId === undefined ? (
            <p className="handoffpending" role="status">
              Preparing the exact terminal command…
            </p>
          ) : (
            <>
              <div className="handoff-target" role="group" aria-label="Handoff destination">
                <button
                  type="button"
                  aria-pressed={target === 'terminal'}
                  onClick={() => setTarget('terminal')}
                >
                  Terminal
                </button>
                <button
                  type="button"
                  aria-pressed={target === 'vscode'}
                  onClick={() => setTarget('vscode')}
                >
                  VS Code workspace
                </button>
              </div>
              <code className="resumecmd">{command}</code>
              <div className="handoff-actions">
                <Key className="wide" onClick={copy}>
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
              {live ? (
                <Key
                  className="wide"
                  onClick={() => {
                    setReleaseRequested(true)
                    onRelease?.()
                    // A dropped stop command must not leave the only retry control disabled.
                    setTimeout(() => setReleaseRequested(false), 8000)
                  }}
                  disabled={releaseRequested}
                >
                  <Square size={14} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
                  {releaseRequested ? 'Releasing…' : 'Release current run'}
                </Key>
              ) : null}
              </div>
              <p className="resumenote">
                {target === 'vscode'
                  ? agent === 'claude'
                    ? 'This opens the project and resumes Claude with its VS Code IDE connection. It does not inject the conversation into Claude’s chat panel.'
                    : 'This opens the project in VS Code, then resumes Codex in the terminal where you run this command. It cannot inject the conversation into Codex’s chat panel.'
                  : live
                    ? 'Copy now if you want, but release this running session before executing it. That prevents active-writer conflicts.'
                    : 'Paste this in any terminal to continue this exact conversation at your keyboard.'}
              </p>
              {copyError ? (
                <p className="handofferror" role="alert">
                  Clipboard access was blocked. Long-press the command to copy it.
                </p>
              ) : null}
            </>
          )}
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
 * Refreshes render the final screen immediately. An outgoing screen may fade when a person
 * navigates, but no mount-time opacity/position animation makes a reloaded list rebuild itself.
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
      initial={false}
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
    <section className="firstrun">
      <Mark />
      <h2>Your laptop is linked</h2>
      <p>
        Tap <strong>New session</strong>, choose Claude or Codex, name a folder, and tell the
        agent what to do. It asks you before it changes anything.
      </p>
    </section>
  )
}

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <img src="/icon-192.png" alt="" width={76} height={76} />
    </span>
  )
}
