import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentFactory,
  AgentRunHandle,
  AgentRunRequest,
  AgentStreamMessage,
  PermissionDecision,
} from '../agent.js'

/**
 * Codex CLI as a first-class LongLeash agent, driven through `codex app-server` — the
 * JSON-RPC interface Codex ships for exactly this, not a screen we scrape.
 *
 * This is what lets a Codex session be STARTED from the phone, as opposed to the hook, which
 * only observes and answers a session someone already opened. Both are needed and they are not
 * the same capability.
 *
 * The protocol was taken from Codex's own generated schema
 * (`codex app-server generate-json-schema`) and confirmed against a live server, so none of the
 * names below are guesses:
 *
 *   client → server   initialize · thread/start · turn/start · turn/interrupt
 *   server → client   item/commandExecution/requestApproval · item/fileChange/requestApproval
 *                     item/permissions/requestApproval · execCommandApproval · applyPatchApproval
 *   notifications     item/agentMessage/delta · item/started · item/completed · turn/completed
 *
 * Framing is newline-delimited JSON, one message per line.
 */

/**
 * How long Codex gets to wind down its own turn after a Stop before the process is killed.
 * Short on purpose: a person who pressed Stop is already waiting.
 */
const INTERRUPT_GRACE_MS = 250

/** Managed app-server threads broker their own lifecycle and approvals; user hooks are external-only. */
const MANAGED_THREAD_CONFIG = {
  hooks: {
    SessionStart: [],
    SessionEnd: [],
    PreToolUse: [],
    PermissionRequest: [],
  },
}

/** Everything the server can ask us that means "a human should decide this". */
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
])

/**
 * How each approval family spells yes and no. They do NOT share a vocabulary, and sending the
 * wrong word is not a soft failure — Codex rejects the response and the turn stalls with no
 * visible cause.
 */
const DECISION_WORDS: Record<string, { allow: string; deny: string }> = {
  // The command/file families answer with ApprovalDecision.
  'item/commandExecution/requestApproval': { allow: 'accept', deny: 'decline' },
  'item/fileChange/requestApproval': { allow: 'accept', deny: 'decline' },
  // The older pair answers with `ReviewDecision`, whose refusal is spelled `abort` —
  // *"User has denied this command and the agent should not do anything"*. Not `decline`,
  // and not `denied`: both are rejected and the turn stalls with nothing to see.
  execCommandApproval: { allow: 'approved', deny: 'abort' },
  applyPatchApproval: { allow: 'approved', deny: 'abort' },
}

export interface CodexAdapterOptions {
  /** Test seam: anything that behaves like a spawned `codex app-server`. */
  spawnServer?: () => ChildProcessWithoutNullStreams
  /**
   * `untrusted` makes Codex ask about everything, which is the point: a session started from a
   * phone must route its decisions to that phone rather than deciding for itself.
   */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  log?: (line: string) => void
  /** Test seam; production uses a hook-free home under LongLeash's data directory. */
  managedHome?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export function createCodexAgentFactory(opts: CodexAdapterOptions = {}): AgentFactory {
  return (request: AgentRunRequest): AgentRunHandle => new CodexRun(request, opts).handle()
}

class CodexRun {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private readonly queue: AgentStreamMessage[] = []
  private waiter: (() => void) | null = null
  private finished = false
  private failure: Error | null = null
  private stopping = false
  private closedByServer = false
  private nextId = 1
  private buffer = ''
  private threadId: string | null = null
  private turnId: string | null = null
  /** Text already emitted for each agent-message item, used to dedupe authoritative completion. */
  private readonly agentMessages = new Map<string, string>()
  /** Tool items wait until completion before they can honestly be called auto-approved. */
  private readonly toolItems = new Map<string, { name: string; input: unknown }>()
  private readonly approvalItems = new Set<string>()
  private readonly log: (line: string) => void

  constructor(
    private readonly request: AgentRunRequest,
    private readonly opts: CodexAdapterOptions,
  ) {
    this.log = opts.log ?? (() => {})
    this.child =
      opts.spawnServer?.() ??
      (spawn('codex', ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Managed sessions have their own structured approval broker. User hooks are for
        // sessions the person starts in Codex/VS Code; loading them here can gate the same
        // action twice, and an older installed LongLeash hook does not know the managed
        // sentinel. The config override makes this process deterministic across upgrades.
        env: {
          ...process.env,
          LONGLEASH_MANAGED: '1',
          CODEX_HOME: managedCodexHome(opts.managedHome),
        },
      }) as ChildProcessWithoutNullStreams)

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    // Codex writes diagnostics to stderr. Losing them is fine; letting them kill us is not.
    this.child.stderr?.on('data', () => {})
    this.child.on('exit', (code, signal) => {
      if (!this.stopping && !this.closedByServer) {
        this.fail(new Error(`Codex app-server exited unexpectedly (${signal ?? code ?? 'unknown'}).`))
      } else this.finish()
    })
    this.child.on('error', (error) => {
      this.fail(new Error(`Codex could not start: ${error.message}`))
    })

    void this.start()
  }

  handle(): AgentRunHandle {
    return {
      events: this.iterate(),
      interrupt: async () => {
        this.stopping = true
        /**
         * Ask Codex to stop cleanly, but never WAIT on that answer.
         *
         * The moment someone hits Stop is the moment Codex is most likely to be wedged, and an
         * awaited `turn/interrupt` that never comes back would leave the process alive with a
         * phone insisting it had been stopped. Stop has to mean stopped, so the request is
         * fire-and-forget and the kill follows on a short grace period regardless.
         */
        if (this.threadId !== null && this.turnId !== null) {
          void this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
          await new Promise((resolve) => setTimeout(resolve, INTERRUPT_GRACE_MS))
        }
        this.child.kill('SIGTERM')
        this.finish()
      },
      sendMessage: (text: string) => {
        // A session is a dialogue: a reply from the phone starts the next turn.
        if (this.threadId === null) return
        void this.startTurn(text)
      },
    }
  }

  // ----------------------------------------------------------------- lifecycle

  private async start(): Promise<void> {
    try {
      await this.call('initialize', {
        clientInfo: { name: 'longleash', title: 'LongLeash', version: '0.1.0' },
      })
      this.notify('initialized', {})

      const started = (await this.call(
        this.request.resume === undefined ? 'thread/start' : 'thread/resume',
        this.request.resume === undefined
          ? {
            cwd: this.request.cwd,
            ...(this.request.settings?.model === undefined ? {} : { model: this.request.settings.model }),
            approvalPolicy: this.opts.approvalPolicy ?? 'untrusted',
            sandbox: this.opts.sandbox ?? 'workspace-write',
            config: MANAGED_THREAD_CONFIG,
          }
          : {
              threadId: this.request.resume,
              cwd: this.request.cwd,
              ...(this.request.settings?.model === undefined ? {} : { model: this.request.settings.model }),
              approvalPolicy: this.opts.approvalPolicy ?? 'untrusted',
              sandbox: this.opts.sandbox ?? 'workspace-write',
              config: MANAGED_THREAD_CONFIG,
            },
      )) as { thread?: { id?: string } }

      const id = started?.thread?.id
      if (typeof id !== 'string' || id === '') throw new Error('Codex did not return a thread id')
      this.threadId = id
      // Captured so the conversation can be reopened later, exactly like Claude's.
      this.request.onAgentSession(id)

      await this.startTurn(this.request.prompt, true)
    } catch (error) {
      const failure = new Error(
        `Codex session could not start: ${error instanceof Error ? error.message : String(error)}`,
      )
      // Preserve the useful diagnostic in the transcript, then reject the stream so the
      // session/delegation lifecycle is honestly `errored`, never a misleading successful end.
      this.emit({ type: 'text', text: failure.message })
      this.fail(failure)
    }
  }

  private async startTurn(text: string, fatal = false): Promise<void> {
    if (this.threadId === null) return
    try {
      await this.call('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
        ...(this.request.settings?.model === undefined ? {} : { model: this.request.settings.model }),
        ...(this.request.settings?.effort === undefined ? {} : { effort: this.request.settings.effort }),
      })
    } catch (error) {
      if (fatal) throw error
      this.emit({
        type: 'text',
        text: `Codex refused the turn: ${error instanceof Error ? error.message : String(error)}`,
      })
      // A failed turn/start has no turn/completed notification. Without this the UI keeps the
      // session in a permanent "working" state after already showing the failure.
      this.emit({ type: 'turn-end' })
    }
  }

  // ------------------------------------------------------------------ transport

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const cut = this.buffer.indexOf('\n')
      if (cut === -1) break
      const line = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut + 1)
      if (line === '') continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // a malformed line must never take the session down
      }
      this.log(`codex <- ${line}`)
      this.dispatch(message)
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id
    const method = typeof message.method === 'string' ? message.method : null

    // A reply to something we asked.
    if (id !== undefined && method === null) {
      const waiting = this.pending.get(Number(id))
      if (waiting === undefined) return
      this.pending.delete(Number(id))
      if (message.error !== undefined) {
        const detail = (message.error as { message?: string })?.message ?? 'unknown error'
        waiting.reject(new Error(detail))
      } else {
        waiting.resolve(message.result)
      }
      return
    }

    if (method === null) return

    // A REQUEST from Codex: it needs an answer, and an approval needs a human.
    if (id !== undefined) {
      if (APPROVAL_METHODS.has(method)) {
        void this.askHuman(method, Number(id), (message.params ?? {}) as Record<string, unknown>)
      } else {
        // Everything else the server may ask for is outside what LongLeash brokers. Refusing
        // explicitly keeps the turn moving instead of leaving Codex waiting on a reply that
        // will never come.
        this.respond(Number(id), null, `LongLeash does not handle ${method}`)
      }
      return
    }

    this.onNotification(method, (message.params ?? {}) as Record<string, unknown>)
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'item/agentMessage/delta': {
        if (typeof params.delta === 'string') {
          const id = typeof params.itemId === 'string' ? params.itemId : '__current__'
          this.agentMessages.set(id, (this.agentMessages.get(id) ?? '') + params.delta)
          this.emit({ type: 'text', text: params.delta })
        }
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        if (typeof params.delta === 'string') this.emit({ type: 'thinking', text: params.delta })
        return
      }
      case 'item/started': {
        const summary = describeItem(params.item)
        if (summary !== null) {
          this.emit({ type: 'tool', text: summary })
          const item = params.item as Record<string, unknown> | undefined
          if (typeof item?.id === 'string') {
            this.toolItems.set(item.id, { name: summary.split(':')[0] ?? 'tool', input: item })
          }
        }
        return
      }
      case 'item/completed': {
        const item = params.item as Record<string, unknown> | undefined
        const kind = item?.type ?? item?.itemType
        if (kind === 'agentMessage' && typeof item?.text === 'string') {
          const id = typeof item.id === 'string'
            ? item.id
            : (typeof params.itemId === 'string' ? params.itemId : '__current__')
          const streamed = this.agentMessages.get(id) ?? this.agentMessages.get('__current__') ?? ''
          // item/completed is authoritative. Some app-server builds omit deltas entirely; emit
          // the full final text then. When deltas did arrive, append only the missing suffix.
          if (streamed === '') this.emit({ type: 'text', text: item.text })
          else if (item.text.startsWith(streamed) && item.text.length > streamed.length) {
            this.emit({ type: 'text', text: item.text.slice(streamed.length) })
          }
          this.agentMessages.delete(id)
          this.agentMessages.delete('__current__')
          return
        }
        const id = typeof item?.id === 'string'
          ? item.id
          : (typeof params.itemId === 'string' ? params.itemId : null)
        if (id !== null) {
          const tool = this.toolItems.get(id)
          // `item/started` comes before the approval request. Reporting it there called a
          // command "auto-approved" while the phone was visibly being asked about it.
          if (tool !== undefined && !this.approvalItems.has(id)) {
            this.request.onAutoApprovedTool(tool.name, tool.input)
          }
          this.toolItems.delete(id)
          this.approvalItems.delete(id)
        }
        return
      }
      case 'turn/started': {
        const turn = params.turn as Record<string, unknown> | undefined
        const id = typeof turn?.id === 'string' ? turn.id : params.turnId
        if (typeof id === 'string') this.turnId = id
        return
      }
      case 'turn/completed': {
        const turn = params.turn as Record<string, unknown> | undefined
        const status = turn?.status
        const error = turn?.error as Record<string, unknown> | undefined
        if (status === 'failed') {
          const detail = typeof error?.message === 'string' ? error.message : 'Codex turn failed'
          this.emit({ type: 'text', text: detail })
        }
        this.turnId = null
        // The turn ended but the conversation has not: the session stays alive for a reply.
        this.emit({ type: 'turn-end' })
        return
      }
      case 'thread/closed':
      case 'thread/deleted': {
        this.closedByServer = true
        this.finish()
        return
      }
      case 'error': {
        const error = params.error as Record<string, unknown> | undefined
        const text = typeof error?.message === 'string'
          ? error.message
          : (typeof params.message === 'string' ? params.message : 'Codex reported an error')
        this.emit({ type: 'text', text })
        return
      }
      default:
        return
    }
  }

  /** Route a Codex approval to whoever is holding the phone, then answer in Codex's own words. */
  private async askHuman(method: string, id: number, params: Record<string, unknown>): Promise<void> {
    if (typeof params.itemId === 'string') this.approvalItems.add(params.itemId)
    let decision: PermissionDecision
    try {
      decision = await this.request.canUseTool(toolNameFor(method, params), params)
    } catch {
      // Never leave Codex waiting forever on a broker that failed.
      decision = { behavior: 'deny', message: 'LongLeash could not reach anyone to decide.' }
    }
    if (method === 'item/permissions/requestApproval') {
      // This request is not an ApprovalDecision. Codex expects the granted subset itself.
      this.respond(id, { permissions: decision.behavior === 'allow' ? (params.permissions ?? {}) : {} })
      return
    }
    const words = DECISION_WORDS[method] ?? { allow: 'accept', deny: 'decline' }
    this.respond(id, { decision: decision.behavior === 'allow' ? words.allow : words.deny })
  }

  // -------------------------------------------------------------------- plumbing

  private call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private respond(id: number, result: unknown, errorMessage?: string): void {
    this.write(
      errorMessage === undefined
        ? { jsonrpc: '2.0', id, result }
        : { jsonrpc: '2.0', id, error: { code: -32601, message: errorMessage } },
    )
  }

  private write(message: unknown): void {
    if (this.finished) return
    try {
      const line = JSON.stringify(message)
      this.log(`codex -> ${line}`)
      this.child.stdin.write(`${line}\n`)
    } catch {
      this.finish()
    }
  }

  // ------------------------------------------------------------------- streaming

  private emit(message: AgentStreamMessage): void {
    this.queue.push(message)
    this.wake()
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    for (const [, waiting] of this.pending) waiting.reject(new Error('Codex session ended'))
    this.pending.clear()
    this.wake()
  }

  private fail(error: Error): void {
    if (this.finished) return
    this.failure = error
    this.finish()
  }

  private wake(): void {
    this.waiter?.()
    this.waiter = null
  }

  private async *iterate(): AsyncGenerator<AgentStreamMessage> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift() as AgentStreamMessage
      if (this.finished) {
        if (this.failure !== null) throw this.failure
        return
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

/**
 * Use Codex's real auth/history/cache, but deliberately omit config.toml. User hooks are how
 * terminal and VS Code sessions enter LongLeash; running them inside the app-server session
 * gates the same action twice. A version-skewed old hook can then wait for the old daemon before
 * app-server even emits its own approval request — the phone sees nothing and Codex freezes.
 *
 * Symlinks keep session storage in the user's normal Codex home, so `codex resume <id>` still
 * works at the laptop. Only the configuration layer is isolated.
 */
function managedCodexHome(explicit?: string): string {
  const userHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const dataHome = process.env.LONGLEASH_DATA ?? join(homedir(), '.longleash')
  const managed = explicit ?? join(dataHome, 'codex-managed')
  if (managed === userHome) return userHome

  mkdirSync(managed, { recursive: true, mode: 0o700 })
  if (!existsSync(userHome)) return managed
  for (const entry of readdirSync(userHome, { withFileTypes: true })) {
    if (entry.name === 'config.toml') continue
    const destination = join(managed, entry.name)
    if (existsSync(destination)) continue
    try {
      symlinkSync(join(userHome, entry.name), destination, entry.isDirectory() ? 'dir' : 'file')
    } catch {
      // Another concurrent session may have made the same link; either way, never block Codex.
    }
  }
  // Codex expects a temp directory beneath its home on some builds. If the source home was
  // unusually empty, give it a private one rather than falling back to a shared path.
  mkdirSync(join(managed, 'tmp'), { recursive: true, mode: 0o700 })
  return managed
}

/**
 * Item kinds that are conversation, not action. Codex reports the assistant's own message and
 * the user's prompt as items too, and a live run showed them arriving in the activity feed as
 * "auto-ran agentMessage" — the same wrongness as BUG-3: machinery presented as an event.
 * The feed is for things the agent DID.
 */
const NOT_A_TOOL = new Set(['userMessage', 'agentMessage', 'reasoning', 'todoList', 'plan', 'error'])

/** A readable one-liner for the activity feed, or null when there is nothing worth showing. */
function describeItem(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const kind = typeof record.type === 'string' ? record.type : (record.itemType as string | undefined)
  if (typeof kind !== 'string') return null
  if (NOT_A_TOOL.has(kind)) return null
  const detail =
    (typeof record.command === 'string' && record.command) ||
    (typeof record.path === 'string' && record.path) ||
    (typeof record.name === 'string' && record.name) ||
    ''
  const label = kind === 'commandExecution' ? 'Bash' : kind === 'fileChange' ? 'Edit' : kind
  return detail === '' ? label : `${label}: ${String(detail).slice(0, 200)}`
}

/**
 * A name the approval card can show. Codex describes an action, not a tool, so this maps its
 * families onto the vocabulary the rest of LongLeash and the phone already speak.
 */
function toolNameFor(method: string, params: Record<string, unknown>): string {
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') return 'Edit'
  if (method === 'item/permissions/requestApproval') return 'Permissions'
  const command = params.command
  if (typeof command === 'string' && command !== '') return 'Bash'
  return 'Bash'
}
