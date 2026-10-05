import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
