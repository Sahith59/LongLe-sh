import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { parseClientMessage, type AskedQuestion, type IdeClientHello } from '@longleash/protocol'
import type { CompanionSession } from './ide-companion.js'

const id = z.string().min(1).max(256)
const Operation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('poll') }).strict(),
  z.object({ type: z.literal('read'), sessionId: id, fromCursor: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('command'), sessionId: id, operationId: z.string().uuid(), message: z.unknown() }).strict(),
  z.object({ type: z.literal('opened'), requestId: z.string().uuid(), sessionId: id }).strict(),
  z.object({ type: z.literal('return'), sessionId: id }).strict(),
])
type OpenRequest = { requestId: string; sessionId: string; title: string }
type Window = { id: string; seen: number; label: string; scope: Set<string>; canOpen: boolean; requests: Map<string, OpenRequest> }

/** Authenticated loopback control. Every operation rechecks the current workspace scope. */
export class IdeControlHub {
  private readonly windows = new Map<string, Window>()
  private readonly windowSecret = randomBytes(32)
  private inFlight = 0
  private readonly operations = new Map<string, { fingerprint: string; result: Promise<unknown> }>()
  private readonly pending = new Map<string, { windowId: string; sessionId: string; resolve: (value: unknown) => void; timer: NodeJS.Timeout }>()
  constructor(private readonly options: {
    read: (sessionId: string, cursor: number) => unknown
    command: (principal: string, message: unknown) => Promise<unknown>
    approvals: () => { approvalId: string; sessionId: string; toolName?: string; inputSummary?: string; expiresAt?: number; outsideRoot?: boolean; targetPath?: string | null; questions?: AskedQuestion[] }[]
    returnToPhone: (sessionId: string) => Promise<unknown>
  }) {}

  list(sessionId: string): { windowId: string; label: string }[] {
    this.prune()
    return [...this.windows.values()].filter((window) => Date.now() - window.seen <= 10_000 && window.canOpen && window.scope.has(sessionId))
      .map((window) => ({ windowId: window.id, label: window.label }))
  }

  async open(windowId: string, sessionId: string, requestId: string): Promise<unknown> {
    this.prune()
    const window = [...this.windows.values()].find((item) => item.id === windowId)
    if (!window?.canOpen || Date.now() - window.seen > 10_000 || !window.scope.has(sessionId)) throw new Error('That VS Code window is offline or cannot access this session.')
    if (this.pending.has(requestId) || this.pending.size >= 64) throw new Error('An open request is already pending. Wait for its result.')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        window.requests.delete(requestId)
        resolve({ outcome: 'unconfirmed', message: 'VS Code did not confirm opening the conversation. Control has not changed.' })
      }, 20_000)
      this.pending.set(requestId, { windowId, sessionId, resolve, timer })
      window.requests.set(requestId, { requestId, sessionId, title: 'LongLeash conversation' })
    })
  }

  async handle(raw: unknown, client: IdeClientHello, sessions: CompanionSession[]): Promise<unknown> {
    this.prune()
    const operation = Operation.parse(raw)
    let window = this.windows.get(client.clientInstanceId)
    if (!window) {
      if (this.windows.size >= 64) throw new Error('Too many IDE windows connected.')
      window = { id: this.windowId(client.clientInstanceId), seen: Date.now(), label: '', scope: new Set(), canOpen: false, requests: new Map() }
      this.windows.set(client.clientInstanceId, window)
    }
    window.seen = Date.now()
    window.scope = new Set(sessions.map((session) => session.sessionId))
    window.canOpen = client.capabilities.includes('workspace.open')
    window.label = client.vscode.workspaceFolders.map((folder) => folder.canonicalPath?.split(/[\\/]/u).at(-1) ?? 'Workspace').join(', ').slice(0, 160) || 'VS Code'
    if (operation.type === 'poll') return { windowId: window.id, requests: window.canOpen ? [...window.requests.values()].filter((request) => window!.scope.has(request.sessionId)) : [] }
    const session = sessions.find((candidate) => candidate.sessionId === operation.sessionId)
    if (!session) throw new Error('This session is outside the trusted workspace or no longer exists.')
    if (operation.type === 'opened') {
      if (!window.canOpen) throw new Error('This IDE window is not granted opening control.')
      const pending = this.pending.get(operation.requestId)
      if (!pending || pending.windowId !== window.id || pending.sessionId !== operation.sessionId) throw new Error('The open request expired or belongs to another window.')
      clearTimeout(pending.timer)
      this.pending.delete(operation.requestId)
      window.requests.delete(operation.requestId)
      pending.resolve({ outcome: 'opened', sessionId: operation.sessionId })
      return { outcome: 'confirmed' }
    }
    if (operation.type === 'return') {
      if (!window.canOpen) throw new Error('This IDE window is not granted opening control.')
      return await this.options.returnToPhone(operation.sessionId)
    }
    if (operation.type === 'read') {
      if (!client.capabilities.includes('transcripts.read')) throw new Error('Transcript capability is required.')
      const pendingApprovals = this.options.approvals().filter((approval) => approval.sessionId === operation.sessionId)
        .map(({ approvalId, toolName, inputSummary, expiresAt, outsideRoot, targetPath, questions }) =>
          ({ approvalId, toolName, inputSummary, expiresAt, outsideRoot, targetPath, questions }))
      return { ...this.options.read(operation.sessionId, operation.fromCursor) as object, session, pendingApprovals }
    }
    const message = parseClientMessage(operation.message)
    const key = `${client.clientInstanceId}:${operation.operationId}`
    const fingerprint = JSON.stringify({ sessionId: operation.sessionId, message })
    const capabilities: Record<string, string> = {
      sendMessage: 'sessions.message', resumeSession: 'sessions.message', reclaimSession: 'sessions.message',
      takeOver: 'sessions.message', renameSession: 'sessions.message', stopSession: 'sessions.stop', decision: 'approvals.decide',
    }
    const capability = capabilities[message.type]
    if (!capability || !client.capabilities.some((candidate) => candidate === capability)) throw new Error('This IDE command is not granted.')
    if (message.type !== 'decision' && (!('sessionId' in message) || message.sessionId !== operation.sessionId)) throw new Error('Command conversation does not match.')
    const previous = this.operations.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Operation ID was reused with different content.')
      return previous.result
    }
    if (message.type === 'decision' && !this.options.approvals().some((approval) => approval.approvalId === message.approvalId && approval.sessionId === operation.sessionId)) {
      throw new Error('The approval is no longer pending for this conversation.')
    }
    // Never repeat a mutation after an ambiguous HTTP timeout. Reusing the same ID returns
    // the original result; changing its payload is rejected, including across conversations.
    // Do not evict accepted IDs within a daemon lifetime: callers must reconnect after the
    // bounded ledger fills, rather than make an old mutation executable again.
    if (this.operations.size >= 10_000) throw new Error('IDE operation ledger is full. Restart the laptop service before continuing.')
    if (this.inFlight >= 32) throw new Error('Too many IDE commands are pending. Wait before retrying.')
    this.inFlight += 1
    const result = Promise.resolve().then(() => this.options.command(`ide:${window.id}`, message))
      .finally(() => { this.inFlight -= 1 })
    this.operations.set(key, { fingerprint, result })
    return result
  }

  private prune(): void {
    for (const [key, window] of this.windows) if (Date.now() - window.seen > 10_000 && window.requests.size === 0) this.windows.delete(key)
  }

  private windowId(clientInstanceId: string): string {
    const bytes = createHmac('sha256', this.windowSecret).update(clientInstanceId).digest().subarray(0, 16)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = bytes.toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ outcome: 'unconfirmed', message: 'The laptop service stopped before VS Code confirmed opening.' })
    }
    this.pending.clear()
    this.windows.clear()
  }
}
