import { ClientMessageSchema, IdeSessionInventorySchema, IDE_PROTOCOL_VERSION, SessionEventSchema, type ClientMessage, type IdeClientHello, type IdeSessionInventory, type SessionEvent } from '@longleash/protocol'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'

const TOKEN_KEY = 'longleash.ide.readOnlyToken'

export interface CompanionSession {
  sessionId: string
  agent: 'claude' | 'codex'
  cwd: string
  title: string
  origin: string
  status: string
  live: boolean
  resumable: boolean
  controller?: 'longleash' | 'external'
  control?: 'full' | 'observe'
  workspaceConflict?: unknown
}
export interface OpenRequest { requestId: string; sessionId: string; title: string }
export interface PendingApproval {
  approvalId: string
  toolName: string
  inputSummary: string
  expiresAt: number
  outsideRoot?: boolean
  targetPath?: string | null
  questions?: { question: string; options: { label: string; description: string }[]; multiSelect: boolean }[]
}
export interface ReadResult { events: SessionEvent[]; latestCursor: number; hasMore: boolean; session: CompanionSession; pendingApprovals?: PendingApproval[] }

/** One extension-host identity for inventory and all control requests in this window. */
export class CompanionClient {
  constructor(private readonly context: vscode.ExtensionContext, private readonly clientInstanceId: string) {}

  async inventory(): Promise<IdeSessionInventory> {
    return IdeSessionInventorySchema.parse(await this.post('/snapshot', this.hello(), 3_000))
  }

  async poll(): Promise<{ requests: OpenRequest[]; windowId: string }> {
    const result = await this.control({ type: 'poll' }) as { requests?: unknown; windowId?: unknown }
    if (!Array.isArray(result.requests) || typeof result.windowId !== 'string') throw new Error('Invalid LongLeash open request response.')
    const requests = result.requests.flatMap((item): OpenRequest[] => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      return typeof value.requestId === 'string' && typeof value.sessionId === 'string' && typeof value.title === 'string'
        ? [{ requestId: value.requestId, sessionId: value.sessionId, title: value.title }]
        : []
    })
    return { requests, windowId: result.windowId }
  }

  async read(sessionId: string, fromCursor: number): Promise<ReadResult> {
    const result = await this.control({ type: 'read', sessionId, fromCursor }) as Record<string, unknown>
    if (!Array.isArray(result.events) || !Number.isSafeInteger(result.latestCursor) || typeof result.hasMore !== 'boolean') {
      throw new Error('Invalid LongLeash transcript response.')
    }
    const session = result.session as CompanionSession | undefined
    if (!session || session.sessionId !== sessionId || !['claude', 'codex'].includes(session.agent) || typeof session.cwd !== 'string') {
      throw new Error('LongLeash returned a different session.')
    }
    const events = result.events.map((event) => SessionEventSchema.parse(event))
    let previous = fromCursor
    for (const event of events) {
      if (event.sessionId !== sessionId || event.seq <= previous) throw new Error('LongLeash transcript cursor mismatch.')
      previous = event.seq
    }
    if (events.length > 0 && result.latestCursor !== previous) throw new Error('LongLeash transcript page cursor mismatch.')
    let pendingApprovals: PendingApproval[] | undefined
    if (Array.isArray(result.pendingApprovals)) {
      pendingApprovals = result.pendingApprovals.flatMap((value): PendingApproval[] => {
        if (!value || typeof value !== 'object') return []
        const item = value as Record<string, unknown>
        if (typeof item.approvalId !== 'string' || typeof item.toolName !== 'string' ||
          typeof item.inputSummary !== 'string' || typeof item.expiresAt !== 'number') return []
        return [item as unknown as PendingApproval]
      })
    }
    return { events, latestCursor: result.latestCursor as number, hasMore: result.hasMore, session,
      ...(pendingApprovals ? { pendingApprovals } : {}) }
  }

  async command(sessionId: string, operationId: string, message: ClientMessage): Promise<unknown> {
    const parsed = ClientMessageSchema.parse(message)
    const result = await this.control({ type: 'command', sessionId, operationId, message: parsed }, 30_000)
    if (result && typeof result === 'object' && (result as { type?: unknown }).type === 'error') {
      throw new Error(String((result as { message?: unknown }).message ?? 'The command was rejected.'))
    }
    const ack = result as { type?: unknown; of?: unknown; outcome?: unknown } | null
    const successful: Record<string, string> = {
      sendMessage: 'sent', resumeSession: 'reopened', reclaimSession: 'phone-ready',
      takeOver: 'taken-over', renameSession: 'renamed', stopSession: 'stopped', decision: 'decided',
    }
    if (!ack || ack.type !== 'ack' || ack.of !== parsed.type || ack.outcome !== successful[parsed.type]) {
      throw new Error(`LongLeash did not confirm ${parsed.type}: ${String(ack?.outcome ?? 'no acknowledgement')}. Check the session before retrying.`)
    }
    return result
  }

  async opened(requestId: string, sessionId: string): Promise<void> { await this.control({ type: 'opened', requestId, sessionId }) }
  async returnToPhone(sessionId: string): Promise<unknown> { return this.control({ type: 'return', sessionId }, 25_000) }

  private async control(operation: Record<string, unknown>, timeoutMs = 3_000): Promise<unknown> {
    return this.post('/control', { hello: this.hello(), operation }, timeoutMs)
  }

  private hello(): IdeClientHello {
    const folders = (vscode.workspace.workspaceFolders ?? []).flatMap((folder) => {
      if (folder.uri.scheme !== 'file') return []
      try { return [{ uri: folder.uri.toString(), canonicalPath: realpathSync(folder.uri.fsPath) }] }
      catch { return [] }
    })
    return {
      v: IDE_PROTOCOL_VERSION, type: 'ide.hello', clientInstanceId: this.clientInstanceId,
      protocol: { min: IDE_PROTOCOL_VERSION, max: IDE_PROTOCOL_VERSION },
      extension: { version: String(this.context.extension.packageJSON.version), build: String(this.context.extension.packageJSON.version) },
      vscode: {
        version: vscode.version, uriScheme: vscode.env.uriScheme, remoteAuthority: vscode.env.remoteName ?? null,
        workspaceTrusted: vscode.workspace.isTrusted, windowFocused: vscode.window.state.focused, workspaceFolders: folders,
      },
      capabilities: ['diagnostics.read', 'sessions.read', 'transcripts.read', 'workspace.open', 'file.open',
        'codex.render', 'approvals.decide', 'sessions.message', 'sessions.stop'],
    }
  }

  private async post(path: '/snapshot' | '/control', body: unknown, timeoutMs: number): Promise<unknown> {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName !== undefined || vscode.env.uriScheme !== 'vscode') {
      throw new Error('Open a trusted local VS Code workspace to use LongLeash.')
    }
    const endpointPath = join(process.env.LONGLEASH_DATA ?? join(homedir(), '.longleash'), 'ide-endpoint.json')
    const file = lstatSync(endpointPath)
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 ||
      (process.getuid && file.uid !== process.getuid()) || file.size > 4_096) throw new Error('The LongLeash companion credential has unsafe file permissions.')
    const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8')) as { url?: string; secret?: string }
    if (typeof endpoint.url !== 'string' || typeof endpoint.secret !== 'string' || endpoint.secret.length < 32) {
      throw new Error('The LongLeash companion endpoint is incomplete.')
    }
    const url = new URL(endpoint.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/snapshot' ||
      url.username || url.password || url.search || url.hash) throw new Error('LongLeash companion endpoints must be loopback only.')
    if (await this.context.secrets.get(TOKEN_KEY) !== endpoint.secret) await this.context.secrets.store(TOKEN_KEY, endpoint.secret)
    url.pathname = path
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-longleash-ide': endpoint.secret },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    })
    const result = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const detail = result && typeof result === 'object' ? result as { reason?: unknown; message?: unknown } : null
      const reason = typeof detail?.message === 'string' ? detail.message : String(detail?.reason ?? response.status)
      throw new Error(`LongLeash request failed: ${reason}.`)
    }
    return result
  }
}

/** Retained for callers and older tests. */
export async function fetchCompanionInventory(context: vscode.ExtensionContext, clientInstanceId: string): Promise<IdeSessionInventory> {
  return new CompanionClient(context, clientInstanceId).inventory()
}
