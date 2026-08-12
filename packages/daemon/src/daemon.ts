import { accessSync, constants, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { EventLog } from './eventlog.js'
import { DeviceRegistry } from './auth.js'
import { ApprovalStore } from './approvals.js'
import { SessionManager } from './sessions.js'
import { LongLeashServer } from './server.js'
import { RelayBridge } from './relay-bridge.js'
import { createClaudeAgentFactory } from './adapters/claude.js'
import { createCodexAgentFactory } from './adapters/codex.js'
import { readPermissionPosture, type PermissionPosture } from './posture.js'
import { FolderIndex } from './folders.js'
import { PushNotifier } from './push.js'
import { ExternalSessions } from './external.js'
import { SessionRegistry } from './session-registry.js'
import { StayAwake } from './awake.js'
import { BriefingBuilder } from './briefing.js'
import { DelegationStore } from './delegations.js'
import { DelegationManager } from './delegation-manager.js'
import { WorkspaceLeaseManager } from './workspace-leases.js'
import { ReturnBuilder } from './return-builder.js'

export interface DaemonOptions {
  /** Directories agents may work in. Nothing outside these can be targeted. */
  allowedRoots: string[]
  host: string
  port?: number
  /** Built web app to serve. Omit to run headless. */
  staticRoot?: string
  /** Where SQLite files live. Defaults to ~/.longleash. */
  dataDir?: string
  /** Tools that may run without asking. Everything else comes to the human. */
  allowedTools?: string[]
  denyOutsideRoot?: boolean
  maxConcurrentSessions?: number
  /** Where to report activity. The binary passes console.log so the terminal shows life. */
  log?: (line: string) => void
  /** ws(s):// endpoint of a longleash-relay. Omit to stay LAN-only. */
  relayUrl?: string
  /** Refuse credential/system folders inside allowed roots. On by default. */
  excludeSensitive?: boolean
}

export interface Daemon {
  server: LongLeashServer
  sessions: SessionManager
  registry: DeviceRegistry
  eventLog: EventLog
  approvals: ApprovalStore
  delegations: DelegationManager
  port: number
  /** Approvals reconciled at startup because a previous run died holding them. */
  orphansClosed: number
  /** Whether the user's own Claude settings let some actions bypass the phone. */
  posture: PermissionPosture
  stop: () => Promise<void>
}

const DEFAULT_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep']

function executableOnPath(command: string): boolean {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    try {
      accessSync(join(directory, command), constants.X_OK)
      return true
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return false
}

/**
 * Assembles the whole laptop side: storage, auth, agent sessions, and the socket the phone
 * talks to. Everything is wired here so demos, tests, and the real binary share one path.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const dataDir = options.dataDir ?? join(homedir(), '.longleash')
  mkdirSync(dataDir, { recursive: true })

  const roots = options.allowedRoots.map((root) => resolve(root))
  for (const root of roots) {
    if (!existsSync(root)) throw new Error(`Allowed root does not exist: ${root}`)
  }

  const eventLog = new EventLog(join(dataDir, 'events.db'))
  const registry = new DeviceRegistry(join(dataDir, 'devices.db'))
  const approvals = new ApprovalStore(join(dataDir, 'approvals.db'))
  const workspace = new WorkspaceLeaseManager(approvals.rawDb)
  const push = new PushNotifier({
    dbPath: join(dataDir, 'push.db'),
    keysPath: join(dataDir, 'vapid.json'),
    // Who a push service may contact about this sender: the relay origin when
    // one exists, else a placeholder mailto (LAN-only installs never push far).
    subject:
      process.env.LONGLEASH_PUSH_SUBJECT ??
      (options.relayUrl !== undefined
        ? options.relayUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws\/?$/, '')
        : 'mailto:longleash@localhost.invalid'),
    log: options.log ?? (() => {}),
  })

  const log = options.log ?? (() => {})
  const stamp = () => new Date().toISOString().slice(11, 19)
  const write = (line: string) => log(`[${stamp()}] ${line}`)

  const server = new LongLeashServer({
    eventLog,
    registry,
    host: options.host,
    log: write,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.staticRoot === undefined ? {} : { staticRoot: options.staticRoot }),
    ...(options.relayUrl === undefined ? {} : { relayUrl: options.relayUrl }),
  })

  const awake = new StayAwake({ log: (line) => write(line) })
  let delegationManager: DelegationManager | null = null

  // One mirror for every session source — phone-started agents and terminal sessions
  // alike broadcast, notify, and narrate through the same path.
  /**
   * Hold the machine awake only while agents are actually working. Recomputed from the two
   * session sources on every lifecycle beat rather than counted incrementally, because a
   * counter that drifts either strands the laptop awake or lets it sleep mid-job — and both
   * failures are silent.
   */
  const reconcileAwake = (): void => {
    // `sessions` and `external` are declared below and are still in the temporal dead zone
    // while they are being constructed — and a manager can emit during construction. Reading
    // them defensively keeps a lifecycle event from throwing inside the event handler, which
    // would be an obscure crash for a feature that is only ever a convenience.
    try {
      const isLive = (s: { status: string }) => s.status === 'running' || s.status === 'waiting'
      awake.update(sessions.listSessions().filter(isLive).length + external.listSessions().filter(isLive).length)
    } catch {
      // Not ready yet; the next lifecycle beat reconciles.
    }
  }

  const mirror = (event: import('@longleash/protocol').SessionEvent): void => {
    // Let orchestration commit child lifecycle before phones render the corresponding session
    // event, so lineage and status never briefly contradict one another.
    delegationManager?.handleSessionEvent(event)
    server.broadcastEvent(event)
    if (
      event.type === 'session.started' ||
      event.type === 'session.ended' ||
      event.type === 'session.status'
    ) {
      reconcileAwake()
    }
    // Mirror the important beats to the terminal: a daemon that prints nothing looks dead.
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'session.started') {
      write(`▶ ${event.sessionId} started in ${String(payload.cwd)}`)
    } else if (event.type === 'approval.requested') {
      write(`? ${event.sessionId} needs approval: ${String(payload.inputSummary)}`)
      // The tap on the pocket. IDs only — the notifier enforces it, this comment remembers it.
      push.notifyApproval(
        event.sessionId,
        String(payload.approvalId),
        Array.isArray(payload.questions) ? 'question' : undefined,
      )
    } else if (event.type === 'approval.decided') {
      write(`${payload.verdict === 'allow' ? '✓' : '✗'} ${String(payload.verdict)} by ${String(payload.decidedBy)}`)
    } else if (event.type === 'activity.tool') {
      write(`· ${event.sessionId} auto-approved ${String(payload.inputSummary)}`)
    } else if (event.type === 'session.ended') {
      write(`■ ${event.sessionId} finished`)
    } else if (event.type === 'session.errored') {
      write(`! ${event.sessionId} errored: ${String(payload.message)}`)
    }
  }

  const claudeAvailable = executableOnPath('claude')
  const codexAvailable = executableOnPath('codex')
  if (!claudeAvailable) write('Claude is not on PATH; Claude launch is unavailable.')
  if (!codexAvailable) write('Codex is not on PATH; Codex launch is unavailable.')

  const sessions = new SessionManager({
    eventLog,
    approvals,
    allowedRoots: roots,
    agentFactories: {
      ...(claudeAvailable
        ? {
            claude: createClaudeAgentFactory({
              allowedTools: options.allowedTools ?? DEFAULT_READ_ONLY_TOOLS,
              isolateFromUserSettings: true,
            }),
          }
        : {}),
      // Codex driven through its own app-server, so a session can be STARTED from the phone
      // rather than only observed. `untrusted` makes Codex ask about everything, which is the
      // point: a session started remotely must route its decisions back to that phone.
      ...(codexAvailable
        ? { codex: createCodexAgentFactory({ approvalPolicy: 'untrusted', log: write }) }
        : {}),
    },
    onEvent: mirror,
    ...(options.denyOutsideRoot === undefined ? {} : { denyOutsideRoot: options.denyOutsideRoot }),
    // Broad roots (a whole home directory) are only reasonable with these carved out.
    excludeSensitive: options.excludeSensitive ?? true,
    ...(options.maxConcurrentSessions === undefined
      ? {}
      : { maxConcurrentSessions: options.maxConcurrentSessions }),
    workspace,
  })
  server.attachSessions(sessions)
  server.attachFolders(new FolderIndex(roots))
  server.attachPush(push)

  // Terminal-started sessions, reported by Claude Code's own hooks. The secret is the
  // proof of same-machine: it lives in a 0600 file no phone can ever read.
  const externalApprovals = new ApprovalStore(join(dataDir, 'approvals-external.db'))
  const sessionRegistry = new SessionRegistry(join(dataDir, 'live-sessions.db'))
  const external = new ExternalSessions({
    eventLog,
    approvals: externalApprovals,
    registry: sessionRegistry,
    onEvent: mirror,
    workspace,
    // A live socket means the app is open and can answer in seconds. A push REGISTRATION is
    // permanent and proves nothing about whether anyone is looking — treating it as presence
    // is what froze the keyboard for two minutes with the phone in a drawer.
    audience: () =>
      server.connectionCount() > 0 ? 'connected' : push.count() > 0 ? 'push' : 'none',
    // The baton pass: a finished terminal conversation becomes reopenable from the
    // phone, waking through the SDK under the same resume id.
    onEnded: (info) =>
      sessions.adoptEndedSession({
        sessionId: info.sessionId,
        cwd: info.cwd,
        title: info.title,
        origin: info.surface,
        agent: info.agent,
        startedAt: info.startedAt,
        agentSessionId: info.claudeSessionId,
      }),
  })
  // Keeps the inbox honest: anything whose deadline passed with no live waiter — the state a
  // restarted daemon inherits — is closed out and the phone is told, rather than showing a
  // question forever that nothing can answer.
  external.startSweeping()

  const delegationStore = new DelegationStore(approvals.rawDb)
  // Managed children never survive the daemon process. Externally-owned processes are readopted
  // above and are the only valid live owners at this point; unfinished transfer reservations
  // remain valid only while their delegation is durably `starting`.
  workspace.reconcile({
    activeSessionIds: external.listSessions().map((session) => session.sessionId),
    validReservationIds: delegationStore
      .list()
      .filter((record) => record.status === 'starting')
      .map((record) => record.delegationId),
  })
  external.reconcileWorkspace()
  delegationManager = new DelegationManager({
    store: delegationStore,
    sessions,
    briefings: new BriefingBuilder(eventLog),
    sourceSessions: () => [
      ...sessions.listSessions(),
      ...external.listSessions().map((session) => ({ ...session, live: true })),
    ],
    onUpdate: (delegation) => server.broadcastDelegation(delegation),
    returns: new ReturnBuilder(eventLog),
    workspace,
    pauseSession: async (session, actor, reason) => {
      if (session.origin === 'terminal' || session.origin === 'vscode') {
        return external.stop(session.sessionId, actor)
      }
      return sessions.pauseSession(session.sessionId, actor, reason)
    },
  })
  server.attachDelegations(delegationManager)

  const hookSecret = randomBytes(24).toString('base64url')
  server.attachExternal(external, hookSecret)

  const { port } = await server.listen()
  // Where the hook script finds this daemon — rewritten every boot because the
  // LAN address and port can change between runs.
  writeFileSync(
    join(dataDir, 'hook-endpoint.json'),
    JSON.stringify({ url: `http://${options.host}:${port}/hook`, secret: hookSecret }, null, 2) + '\n',
    { mode: 0o600 },
  )
  const stopMaintenance = sessions.startMaintenance()

  // The daemon's presence in the world beyond the LAN: one E2E room per paired device,
  // kept in lockstep with pairings and revocations. LAN keeps working exactly as before.
  let bridge: RelayBridge | null = null
  if (options.relayUrl !== undefined) {
    bridge = new RelayBridge({ url: options.relayUrl, registry, server, log: write })
    const rooms = bridge.start()
    write(`relay: holding ${rooms} room(s) via ${options.relayUrl}`)
  }

  return {
    server,
    sessions,
    registry,
    eventLog,
    approvals,
    delegations: delegationManager,
    port,
    orphansClosed: sessions.orphansClosed,
    posture: readPermissionPosture(),
    stop: async () => {
      stopMaintenance()
      bridge?.stop()
      // Agents first: a consume loop still writing while the databases close is an
      // unhandled rejection and a corrupted final status.
      await sessions.shutdown()
      awake.release()
      external.shutdown()
      sessionRegistry.close()
      await server.close()
      eventLog.close()
      registry.close()
      approvals.close()
      externalApprovals.close()
      push.close()
    },
  }
}
