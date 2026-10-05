import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { IdeClientHelloSchema, IdeSessionInventorySchema, IDE_COMPANION_BUILD, IDE_PROTOCOL_VERSION, type IdeSessionSummary } from '@longleash/protocol'
import type { IdeControlHub } from './ide-control.js'

export interface CompanionSession {
  sessionId: string
  agent: string
  cwd: string
  title: string
  origin: string
  status: string
  live: boolean
  resumable: boolean
  controller?: string
  control?: 'full' | 'observe'
  workspaceConflict?: { cwd: string; ownerSessionId: string; processPaused?: boolean }
  startedAt: number
  workspace?: { mode: 'shared' | 'isolated'; branch?: string | undefined }
  relationship?: { parentSessionId: string; role: string; depth: number }
}

/** Separate authenticated loopback transport; never accepts a phone or hook credential. */
export class IdeCompanionServer {
  private readonly server: Server
  private readonly token = randomBytes(32).toString('base64url')
  private readonly streamId = randomUUID()
  private readonly endpointPath: string
  private readonly allowedRoots: string[]
  private readonly cursors = new Map<string, { cursor: number; previous: string }>()

  constructor(private readonly options: {
    dataDir: string
    allowedRoots: string[]
    sessions: () => CompanionSession[]
    latestActivity: (sessionId: string) => number
    pendingApprovals?: () => { sessionId: string; toolName: string }[]
    control?: IdeControlHub
  }) {
    this.endpointPath = join(options.dataDir, 'ide-endpoint.json')
    // An allowed project can be renamed between setup and daemon startup. Skip that
    // root until the operator repairs configuration; never fail the whole daemon.
    this.allowedRoots = options.allowedRoots.flatMap((root) => {
      try { return [realpathSync(root)] } catch { return [] }
    })
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'cache-control': 'no-store' })
        response.end()
      })
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve() })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Companion listener has no TCP port')
    const staged = `${this.endpointPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(staged, JSON.stringify({ url: `http://127.0.0.1:${address.port}/snapshot`, secret: this.token }) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(staged, this.endpointPath)
    } catch (error) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()))
      throw error
    } finally { rmSync(staged, { force: true }) }
  }

  async stop(): Promise<void> {
    this.options.control?.stop()
    try {
      const current = JSON.parse(readFileSync(this.endpointPath, 'utf8')) as { secret?: string }
      if (current.secret === this.token) rmSync(this.endpointPath)
    } catch { /* A removed/replaced credential is not ours to touch. */ }
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(JSON.stringify(body))
    }
    if (request.method !== 'POST' || !['/snapshot', '/control'].includes(request.url ?? '') || request.socket.remoteAddress !== '127.0.0.1' || request.headers.origin !== undefined) {
      send(404, { reason: 'not-found' }); return
    }
    // Removing the user-owned endpoint file revokes every companion window immediately.
    try {
      const current = JSON.parse(readFileSync(this.endpointPath, 'utf8')) as { secret?: string }
      if (current.secret !== this.token) { send(401, { reason: 'revoked' }); return }
    } catch { send(401, { reason: 'revoked' }); return }
    const presented = request.headers['x-longleash-ide']
    if (typeof presented !== 'string' || Buffer.byteLength(presented) !== Buffer.byteLength(this.token) ||
      !timingSafeEqual(Buffer.from(presented), Buffer.from(this.token))) {
      send(401, { reason: 'unauthorized' }); return
    }
    let body = ''
    try {
      for await (const chunk of request) {
        body += String(chunk)
        if (body.length > 64_000) { send(413, { reason: 'too-large' }); return }
      }
      const parsed: unknown = JSON.parse(body)
      const envelope = parsed as { hello?: unknown; operation?: unknown }
      const client = IdeClientHelloSchema.parse(request.url === '/control' ? envelope.hello : parsed)
      if (!client.capabilities.includes('sessions.read') || client.protocol.min > IDE_PROTOCOL_VERSION ||
        client.protocol.max < IDE_PROTOCOL_VERSION) {
        send(403, { reason: 'protocol-or-capability' }); return
      }
      if (client.extension.build !== IDE_COMPANION_BUILD) {
        send(409, { reason: 'companion-build-mismatch' }); return
      }
      if (!client.vscode.workspaceTrusted || client.vscode.remoteAuthority !== null || client.vscode.uriScheme !== 'vscode') {
        send(403, { reason: 'workspace-untrusted-or-unsupported' }); return
      }
      const roots = client.vscode.workspaceFolders.flatMap((folder) => {
        if (!folder.canonicalPath || !isAbsolute(folder.canonicalPath)) return []
        try {
          const canonical = realpathSync(folder.canonicalPath)
          if (!this.allowedRoots.some((root) => within(root, canonical))) return []
          return [canonical]
        } catch { return [] }
      })
      const byId = new Map<string, IdeSessionSummary>()
      const scoped = new Map<string, CompanionSession>()
      const pending = new Map((this.options.pendingApprovals?.() ?? []).map((approval) => [
        approval.sessionId,
        approval.toolName === 'AskUserQuestion' ? 'question' as const : 'approval' as const,
      ]))
      for (const session of this.options.sessions()) {
        let canonicalCwd: string
        try { canonicalCwd = realpathSync(session.cwd) } catch { continue }
        if (!roots.some((root) => within(root, canonicalCwd))) continue
        if (session.agent !== 'claude' && session.agent !== 'codex') continue
        if (!['running', 'waiting', 'ended', 'errored'].includes(session.status)) continue
        if (!['phone', 'daemon', 'terminal', 'vscode', 'external'].includes(session.origin)) continue
        scoped.set(session.sessionId, session)
        const summary: IdeSessionSummary = {
          sessionId: session.sessionId,
          provider: session.agent,
          title: session.title.slice(0, 240) || basename(session.cwd),
          origin: session.origin as IdeSessionSummary['origin'],
          status: session.status as IdeSessionSummary['status'],
          live: session.live,
          resumable: session.resumable,
          ...(session.live && session.status !== 'ended' && session.status !== 'errored' && pending.has(session.sessionId)
            ? { attention: pending.get(session.sessionId)! }
            : {}),
          ...(session.controller === 'external' ? { controller: 'external' as const } : { controller: 'longleash' as const }),
          workspace: {
            label: basename(session.cwd).slice(0, 240) || session.cwd.slice(0, 240),
            mode: session.workspace?.mode ?? 'shared',
            ...(session.workspace?.branch ? { branch: session.workspace.branch.slice(0, 240) } : {}),
          },
          updatedAt: this.options.latestActivity(session.sessionId) || session.startedAt,
        }
        byId.set(session.sessionId, summary)
      }
      if (request.url === '/control') {
        if (!this.options.control) { send(503, { reason: 'control-unavailable' }); return }
        send(200, await this.options.control.handle(envelope.operation, client, [...scoped.values()]))
        return
      }
      const sessions = [...byId.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)).slice(0, 1_000)
      const fingerprint = JSON.stringify(sessions)
      if (!this.cursors.has(client.clientInstanceId) && this.cursors.size >= 128) {
        const oldest = this.cursors.keys().next().value
        if (oldest) this.cursors.delete(oldest)
      }
      const state = this.cursors.get(client.clientInstanceId) ?? { cursor: 0, previous: '' }
      if (fingerprint !== state.previous) { state.cursor += 1; state.previous = fingerprint }
      this.cursors.set(client.clientInstanceId, state)
      const inventory = IdeSessionInventorySchema.parse({
        v: IDE_PROTOCOL_VERSION,
        type: 'ide.sessionInventory',
        streamId: this.streamId,
        cursor: state.cursor,
        generatedAt: Date.now(),
        sessions,
      })
      send(200, inventory)
    } catch (error) {
      send(400, { reason: 'invalid-request', ...(request.url === '/control' && error instanceof Error && error.name !== 'ZodError'
        ? { message: error.message.slice(0, 240) } : {}) })
    }
  }
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
