import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'

delete process.env.ELECTRON_RUN_AS_NODE
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'longleash-v2-editor-'))
const workspace = path.join(fixtureRoot, 'workspace')
const dataDir = path.join(fixtureRoot, 'daemon')
mkdirSync(workspace)
mkdirSync(dataDir)
const canonicalRoot = realpathSync(workspace)
const secret = randomBytes(32).toString('base64url')
const requestId = randomUUID()
const state = { opened: false, commands: [], returns: 0 }
const now = Date.now()
const managed = { sessionId: 'managed-session', agent: 'claude', cwd: canonicalRoot, title: 'Managed conversation', origin: 'phone', status: 'waiting', live: true, resumable: true, controller: 'longleash', control: 'full', startedAt: now }
const observed = { sessionId: 'external-session', agent: 'codex', cwd: canonicalRoot, title: 'Observed Codex', origin: 'vscode', status: 'running', live: true, resumable: false, controller: 'external', control: 'observe', startedAt: now }
const events = [
  { v: 1, seq: 1, sessionId: managed.sessionId, ts: now, type: 'session.started', payload: { agent: 'claude', cwd: canonicalRoot, title: managed.title, origin: 'phone', controller: 'longleash', control: 'full' } },
  { v: 1, seq: 2, sessionId: managed.sessionId, ts: now, type: 'stream.delta', payload: { kind: 'user', text: 'A real prior prompt' } },
  { v: 1, seq: 3, sessionId: managed.sessionId, ts: now, type: 'stream.delta', payload: { kind: 'text', text: 'A persisted answer' } },
  { v: 1, seq: 4, sessionId: managed.sessionId, ts: now, type: 'approval.requested', payload: { approvalId: 'approval-1', toolName: 'Bash', inputSummary: 'Run a harmless check', expiresAt: now + 60_000 } },
]
const server = createServer(async (request, response) => {
  if (request.url === '/test-state') {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(state)); return
  }
  let body = ''
  for await (const chunk of request) body += String(chunk)
  const parsed = JSON.parse(body)
  const hello = request.url === '/control' ? parsed.hello : parsed
  const authorized = request.headers['x-longleash-ide'] === secret &&
    hello.vscode.workspaceFolders.some((folder) => folder.canonicalPath === canonicalRoot)
  if (!authorized) { response.writeHead(401); response.end('{}'); return }
  let result
  if (request.url === '/snapshot') {
    result = { v: 1, type: 'ide.sessionInventory', streamId: 'editor-host', cursor: 1, generatedAt: now,
      sessions: [managed, observed].map((session) => ({ sessionId: session.sessionId, provider: session.agent,
        title: session.title, origin: session.origin, status: session.status, live: session.live,
        resumable: session.resumable, controller: session.controller, workspace: { label: 'workspace', mode: 'shared' }, updatedAt: now })) }
  } else {
    const op = parsed.operation
    if (op.type === 'poll') result = { windowId: 'fixture-window', requests: state.opened ? [] : [{ requestId, sessionId: managed.sessionId, title: managed.title }] }
    else if (op.type === 'read') {
      const session = op.sessionId === managed.sessionId ? managed : observed
      const selected = op.sessionId === managed.sessionId ? events.filter((event) => event.seq > op.fromCursor) : []
      result = { session, events: selected, latestCursor: selected.at(-1)?.seq ?? op.fromCursor, hasMore: false,
        pendingApprovals: op.sessionId === managed.sessionId ? [events[3].payload] : [] }
    } else if (op.type === 'opened') { state.opened = op.requestId === requestId && op.sessionId === managed.sessionId; result = { outcome: 'confirmed' } }
    else if (op.type === 'command') {
      state.commands.push(op.message)
      result = { v: 1, type: 'ack', of: op.message.type,
        outcome: op.message.type === 'sendMessage' && op.message.text === 'Rejected prompt' ? 'not-running'
          : ({ sendMessage: 'sent', decision: 'decided', stopSession: 'stopped' })[op.message.type] }
    }
    else if (op.type === 'return') { state.returns += 1; result = { outcome: 'opened', sessionId: op.sessionId } }
  }
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
})

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  writeFileSync(path.join(dataDir, 'ide-endpoint.json'), JSON.stringify({ url: `${url}/snapshot`, secret }), { mode: 0o600 })
  const downloaded = await downloadAndUnzipVSCode(process.env.LONGLEASH_V0_VSCODE_VERSION ?? '1.131.0')
  const executable = existsSync(downloaded) ? downloaded : downloaded.replace(/Electron$/u, 'Code')
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, 'dist', 'test-host', 'index.cjs'),
    extensionTestsEnv: {
      LONGLEASH_DATA: dataDir,
      LONGLEASH_V1_HOST_LIVE: '1',
      LONGLEASH_V0_HOST_CASE: JSON.stringify({ caseId: 'editor-flow', expectedRoots: [canonicalRoot], expectedTrusted: true,
        expectedRemote: false, expectedProvider: 'missing', editorFlow: true, editorStateUrl: `${url}/test-state` }),
    },
    launchArgs: [canonicalRoot, `--user-data-dir=${path.join(fixtureRoot, 'user')}`,
      `--extensions-dir=${path.join(fixtureRoot, 'extensions')}`, '--disable-telemetry',
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])],
  })
  process.stdout.write('VS Code editor host: exact render, send, approval, Stop, return, observed-session guard passed\n')
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(fixtureRoot, { recursive: true, force: true })
}
