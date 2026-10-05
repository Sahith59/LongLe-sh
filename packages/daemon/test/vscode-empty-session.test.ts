import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalStore } from '../src/approvals.js'
import { DeviceRegistry } from '../src/auth.js'
import { EventLog } from '../src/eventlog.js'
import { ExternalSessions } from '../src/external.js'
import { LongLeashServer } from '../src/server.js'

const roots: string[] = []
const servers: LongLeashServer[] = []
const externals: ExternalSessions[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const external of externals.splice(0)) external.shutdown()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('does not publish transient Claude VS Code IDs without transcripts, but adopts the real conversation once its file appears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'longleash-vscode-empty-'))
  roots.push(root)
  const log = new EventLog(':memory:')
  const server = new LongLeashServer({ eventLog: log, registry: new DeviceRegistry(':memory:'), host: '127.0.0.1' })
  servers.push(server)
  const external = new ExternalSessions({ eventLog: log, approvals: new ApprovalStore(':memory:') })
  externals.push(external)
  server.attachExternal(external, 'test-hook-secret')
  const { port } = await server.listen()
  const transcript = join(root, 'real-native.jsonl')
  const hook = async (name: string, id: string, path = transcript) => {
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-longleash-hook': 'test-hook-secret' },
      body: JSON.stringify({
        hook_event_name: name,
        session_id: id,
        cwd: root,
        transcript_path: path,
        ll_agent: 'claude',
        ll_surface: 'vscode',
      }),
    })
    expect(response.status).toBe(200)
  }

  await hook('SessionStart', 'ghost-native', join(root, 'ghost-native.jsonl'))
  await hook('SessionObserved', 'ghost-native', join(root, 'ghost-native.jsonl'))
  await hook('SessionEnd', 'ghost-native', join(root, 'ghost-native.jsonl'))
  expect(log.replay('ext_ghost-native', 0).events).toEqual([])

  await hook('SessionStart', 'real-native')
  expect(log.replay('ext_real-native', 0).events).toEqual([])
  writeFileSync(transcript, `${JSON.stringify({ type: 'queue-operation', sessionId: 'real-native' })}\n`)
  const deadline = Date.now() + 2000
  while (log.replay('ext_real-native', 0).events.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const events = log.replay('ext_real-native', 0).events
  expect(events.filter((event) => event.type === 'session.started')).toHaveLength(1)
  await hook('SessionObserved', 'real-native')
  expect(log.replay('ext_real-native', 0).events.filter((event) => event.type === 'session.started')).toHaveLength(1)
  await hook('SessionStart', 'ghost-points-at-real')
  expect(log.replay('ext_ghost-points-at-real', 0).events).toEqual([])
})

it('joins changing Claude hook ids to one durable transcript and ignores per-turn SessionEnd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'longleash-vscode-identity-'))
  roots.push(root)
  const log = new EventLog(':memory:')
  const server = new LongLeashServer({ eventLog: log, registry: new DeviceRegistry(':memory:'), host: '127.0.0.1' })
  servers.push(server)
  const external = new ExternalSessions({ eventLog: log, approvals: new ApprovalStore(':memory:'), audience: () => 'none' })
  externals.push(external)
  server.attachExternal(external, 'test-hook-secret')
  const { port } = await server.listen()
  const durable = '12345678-1234-1234-1234-123456789abc'
  const transcript = join(root, `${durable}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`)
  const hook = async (name: string, id: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-longleash-hook': 'test-hook-secret' },
      body: JSON.stringify({ hook_event_name: name, session_id: id, cwd: root,
        transcript_path: transcript, ll_agent: 'claude', ll_surface: 'vscode', tool_name: 'Bash', tool_input: {} }),
    })
    expect(response.status).toBe(200)
  }
  await hook('SessionStart', 'turn-one')
  await hook('PermissionRequest', 'turn-one')
  await hook('SessionEnd', 'turn-one')
  await hook('PermissionRequest', 'turn-two')
  expect(external.listSessions().map((session) => session.sessionId)).toEqual([`ext_${durable}`])
  expect(log.replay(`ext_${durable}`, 0).events.filter((event) => event.type === 'session.started')).toHaveLength(1)
  expect(log.replay('ext_turn-one', 0).events).toEqual([])
  expect(log.replay('ext_turn-two', 0).events).toEqual([])
  await hook('SessionEnd', durable)
  expect(external.listSessions()).toHaveLength(0)
})

it('joins Codex hook ids to the session_meta id used by transcript discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'longleash-codex-identity-'))
  roots.push(root)
  const log = new EventLog(':memory:')
  const server = new LongLeashServer({ eventLog: log, registry: new DeviceRegistry(':memory:'), host: '127.0.0.1' })
  servers.push(server)
  const external = new ExternalSessions({ eventLog: log, approvals: new ApprovalStore(':memory:'), audience: () => 'none' })
  externals.push(external)
  server.attachExternal(external, 'test-hook-secret')
  const { port } = await server.listen()
  const transcript = join(root, 'rollout-2026-identity.jsonl')
  writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: {
    id: 'durable-codex', cwd: root, source: 'vscode',
  } })}\n`)
  const hook = async (id: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-longleash-hook': 'test-hook-secret' },
      body: JSON.stringify({ hook_event_name: 'SessionObserved', session_id: id, cwd: root,
        transcript_path: transcript, ll_agent: 'codex', ll_surface: 'vscode' }),
    })
    expect(response.status).toBe(200)
  }
  await hook('turn-one')
  await hook('turn-two')
  external.observeCodexSession({ sessionId: 'durable-codex', cwd: root, transcriptPath: transcript,
    surface: 'vscode', activityAt: Date.now(), snapshot: [] })
  expect(external.listSessions().map((session) => session.sessionId)).toEqual(['ext_durable-codex'])
  expect(log.replay('ext_turn-one', 0).events).toEqual([])
  expect(log.replay('ext_turn-two', 0).events).toEqual([])
})

it('keeps equal folder labels in different repositories as distinct native conversations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'longleash-multi-repo-'))
  roots.push(root)
  const log = new EventLog(':memory:')
  const server = new LongLeashServer({ eventLog: log, registry: new DeviceRegistry(':memory:'), host: '127.0.0.1' })
  servers.push(server)
  const external = new ExternalSessions({ eventLog: log, approvals: new ApprovalStore(':memory:'), audience: () => 'none' })
  externals.push(external)
  server.attachExternal(external, 'test-hook-secret')
  const { port } = await server.listen()
  const ids = ['12345678-1234-1234-1234-123456789abd', '12345678-1234-1234-1234-123456789abe']
  for (const [index, id] of ids.entries()) {
    const cwd = join(root, String(index), 'repo')
    mkdirSync(cwd, { recursive: true })
    const transcript = join(cwd, `${id}.jsonl`)
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'synthetic' } })}\n`)
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-longleash-hook': 'test-hook-secret' },
      body: JSON.stringify({ hook_event_name: 'SessionObserved', session_id: `turn-${index}`,
        cwd, transcript_path: transcript, ll_agent: 'claude', ll_surface: 'vscode' }),
    })
    expect(response.status).toBe(200)
  }
  expect(new Set(external.listSessions().map((session) => session.sessionId)))
    .toEqual(new Set(ids.map((id) => `ext_${id}`)))
  expect(new Set(external.listSessions().map((session) => session.title))).toEqual(new Set(['synthetic']))
})

it('routes a transient hook permission to the durable card and resume id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'longleash-approval-identity-'))
  roots.push(root)
  const log = new EventLog(':memory:')
  const server = new LongLeashServer({ eventLog: log, registry: new DeviceRegistry(':memory:'), host: '127.0.0.1' })
  servers.push(server)
  const approvals = new ApprovalStore(':memory:')
  const external = new ExternalSessions({ eventLog: log, approvals, audience: () => 'connected', waitMs: 5000 })
  externals.push(external)
  server.attachExternal(external, 'test-hook-secret')
  const { port } = await server.listen()
  const durable = '12345678-1234-1234-1234-123456789abf'
  const transcript = join(root, `${durable}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'synthetic' } })}\n`)
  const response = fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-longleash-hook': 'test-hook-secret' },
    body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'transient-turn',
      cwd: root, transcript_path: transcript, ll_agent: 'claude', ll_surface: 'terminal',
      tool_name: 'Bash', tool_input: {} }),
  })
  const deadline = Date.now() + 2000
  while (approvals.listPending().length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const pending = approvals.listPending()
  expect(pending).toHaveLength(1)
  expect(pending[0]?.sessionId).toBe(`ext_${durable}`)
  expect(external.listSessions()).toMatchObject([{ sessionId: `ext_${durable}`, resumeId: durable }])
  expect(external.decide(pending[0]!.approvalId, 'allow', 'test')).toBe('decided')
  expect((await response).status).toBe(200)
  expect(log.replay('ext_transient-turn', 0).events).toEqual([])
})
