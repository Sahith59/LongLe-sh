import { afterEach, expect, it } from 'vitest'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdeCompanionServer, type CompanionSession } from '../src/ide-companion.js'

const roots: string[] = []
const servers: IdeCompanionServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('serves only trusted workspace inventory through an independent revocable loopback credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'longleash-ide-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  const workspace = join(root, 'project')
  const outside = join(root, 'outside')
  mkdirSync(dataDir)
  mkdirSync(workspace)
  mkdirSync(outside)
  const sessions: CompanionSession[] = [
    { sessionId: 'real', agent: 'claude', cwd: workspace, title: 'Real conversation', origin: 'vscode', status: 'running', live: true, resumable: true, startedAt: 100 },
    { sessionId: 'other', agent: 'codex', cwd: outside, title: 'Other workspace', origin: 'terminal', status: 'ended', live: false, resumable: true, startedAt: 90 },
  ]
  const server = new IdeCompanionServer({ dataDir, allowedRoots: [root], sessions: () => sessions, latestActivity: () => 120 })
  servers.push(server)
  await server.start()
  const file = join(dataDir, 'ide-endpoint.json')
  expect(lstatSync(file).mode & 0o777).toBe(0o600)
  const endpoint = JSON.parse(readFileSync(file, 'utf8')) as { url: string; secret: string }
  expect(new URL(endpoint.url).hostname).toBe('127.0.0.1')
  const hello = {
    v: 1, type: 'ide.hello', clientInstanceId: 'window-a', protocol: { min: 1, max: 1 },
    extension: { version: '0.0.2', build: '0.0.2' },
    vscode: { version: '1.94.0', uriScheme: 'vscode', remoteAuthority: null, workspaceTrusted: true, windowFocused: true,
      workspaceFolders: [{ uri: `file://${workspace}`, canonicalPath: workspace }] },
    capabilities: ['diagnostics.read', 'sessions.read'],
  }
  const post = async (secret: string, body = hello) => fetch(endpoint.url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-longleash-ide': secret }, body: JSON.stringify(body),
  })
  expect((await post('wrong')).status).toBe(401)
  expect((await post(endpoint.secret, { ...hello, vscode: { ...hello.vscode, workspaceTrusted: false } })).status).toBe(403)
  const first = await (await post(endpoint.secret)).json() as { streamId: string; cursor: number; sessions: { sessionId: string }[] }
  expect(first.sessions.map((session) => session.sessionId)).toEqual(['real'])
  const repeat = await (await post(endpoint.secret)).json() as typeof first
  expect(repeat.streamId).toBe(first.streamId)
  expect(repeat.cursor).toBe(first.cursor)
  sessions[0] = { ...sessions[0]!, title: 'Updated conversation' }
  const changed = await (await post(endpoint.secret)).json() as typeof first
  expect(changed.cursor).toBe(first.cursor + 1)
  rmSync(file)
  expect((await post(endpoint.secret)).status).toBe(401)
})
