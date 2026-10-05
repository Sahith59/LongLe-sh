import { afterEach, expect, it, vi } from 'vitest'
import type { IdeClientHello } from '@longleash/protocol'
import { IdeControlHub } from '../src/ide-control.js'
import type { CompanionSession } from '../src/ide-companion.js'

const session = (sessionId: string): CompanionSession => ({
  sessionId, agent: 'claude', cwd: '/tmp/project', title: sessionId, origin: 'vscode',
  status: 'running', live: true, resumable: true, startedAt: 1,
})
const hello = (clientInstanceId = 'window-a', capabilities: IdeClientHello['capabilities'] = ['sessions.read', 'transcripts.read', 'workspace.open', 'sessions.message', 'approvals.decide']): IdeClientHello => ({
  v: 1, type: 'ide.hello', clientInstanceId, protocol: { min: 1, max: 1 },
  extension: { version: '0.0.3', build: '0.0.3' },
  vscode: { version: '1.94.0', uriScheme: 'vscode', remoteAuthority: null, workspaceTrusted: true,
    windowFocused: true, workspaceFolders: [{ uri: 'file:///tmp/project', canonicalPath: '/tmp/project' }] },
  capabilities,
})
const id = '11111111-1111-4111-8111-111111111111'
afterEach(() => vi.useRealTimers())

it('checks exact session, transcript and approval scope, including cached commands', async () => {
  let approvals = [{ approvalId: 'approve', sessionId: 'one', toolName: 'Bash', inputSummary: 'run test', expiresAt: 100 }]
  const commands: unknown[] = []
  const hub = new IdeControlHub({
    read: (sessionId, cursor) => ({ events: [{ sessionId, cursor }] }),
    command: async (_principal, message) => { commands.push(message); return { outcome: 'ok' } },
    approvals: () => approvals,
    returnToPhone: async () => ({ outcome: 'confirmed' }),
  })
  const a = hello()
  expect(await hub.handle({ type: 'read', sessionId: 'one', fromCursor: 2 }, a, [session('one')]))
    .toMatchObject({ events: [{ sessionId: 'one', cursor: 2 }], pendingApprovals: [{ approvalId: 'approve', toolName: 'Bash' }] })
  await expect(hub.handle({ type: 'read', sessionId: 'two', fromCursor: 0 }, a, [session('one')])).rejects.toThrow('outside')
  await expect(hub.handle({ type: 'read', sessionId: 'one', fromCursor: 0 }, hello('readless', ['sessions.read']), [session('one')])).rejects.toThrow('Transcript capability')

  const decision = { type: 'command', sessionId: 'one', operationId: id,
    message: { v: 1, type: 'decision', approvalId: 'approve', verdict: 'allow' } }
  await expect(hub.handle({ ...decision, sessionId: 'two' }, a, [session('one'), session('two')])).rejects.toThrow('approval')
  expect(await hub.handle(decision, a, [session('one')])).toEqual({ outcome: 'ok' })
  approvals = []
  expect(await hub.handle(decision, a, [session('one')])).toEqual({ outcome: 'ok' })
  expect(commands).toHaveLength(1)
  await expect(hub.handle(decision, hello('window-a', ['sessions.read']), [session('one')])).rejects.toThrow('not granted')
  await expect(hub.handle(decision, a, [])).rejects.toThrow('outside')
  await expect(hub.handle({ ...decision, message: { ...decision.message, verdict: 'deny' } }, a, [session('one')])).rejects.toThrow('different content')
})

it('deduplicates concurrent commands, rejects changed content and bounds fresh work', async () => {
  const finish: (() => void)[] = []
  let count = 0
  const hub = new IdeControlHub({
    read: () => ({}), approvals: () => [], returnToPhone: async () => ({}),
    command: () => { count += 1; return new Promise((resolve) => { finish.push(() => resolve({ outcome: 'ok' })) }) },
  })
  const a = hello()
  const command = (operationId: string) => ({ type: 'command', sessionId: 'one', operationId,
    message: { v: 1, type: 'sendMessage', sessionId: 'one', text: 'hello' } })
  const first = hub.handle(command(id), a, [session('one')])
  const duplicate = hub.handle(command(id), a, [session('one')])
  await Promise.resolve()
  expect(count).toBe(1)
  await expect(hub.handle({ ...command(id), message: { ...command(id).message, text: 'changed' } }, a, [session('one')])).rejects.toThrow('different content')
  const other = Array.from({ length: 31 }, (_, index) => hub.handle(command(`11111111-1111-4111-8111-${String(index + 2).padStart(12, '0')}`), a, [session('one')]))
  await Promise.resolve()
  expect(count).toBe(32)
  await expect(hub.handle(command('22222222-2222-4222-8222-222222222222'), a, [session('one')])).rejects.toThrow('Too many')
  finish.forEach((resolve) => resolve())
  await Promise.all([first, duplicate, ...other])
  expect(count).toBe(32)
})

it('keeps window identity across sleep and requires target-window acknowledgment before expiry', async () => {
  vi.useFakeTimers()
  const hub = new IdeControlHub({ read: () => ({}), command: async () => ({}), approvals: () => [],
    returnToPhone: async () => ({ outcome: 'confirmed' }) })
  const a = hello()
  const b = hello('window-b')
  const poll = { type: 'poll' }
  const windowId = (await hub.handle(poll, a, [session('one')]) as { windowId: string }).windowId
  await hub.handle(poll, b, [session('one')])
  expect(hub.list('one')).toHaveLength(2)
  const pending = hub.open(windowId, 'one', id)
  await expect(hub.handle({ type: 'opened', requestId: id, sessionId: 'one' }, b, [session('one')])).rejects.toThrow('another window')
  expect((await hub.handle(poll, a, [session('one')]) as { requests: unknown[] }).requests).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(11_000)
  expect(hub.list('one')).toEqual([])
  expect((await hub.handle(poll, a, [session('one')]) as { windowId: string }).windowId).toBe(windowId)
  expect(await hub.handle({ type: 'opened', requestId: id, sessionId: 'one' }, a, [session('one')]))
    .toEqual({ outcome: 'confirmed' })
  expect(await pending).toEqual({ outcome: 'opened', sessionId: 'one' })

  const expired = hub.open(windowId, 'one', '22222222-2222-4222-8222-222222222222')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(await expired).toMatchObject({ outcome: 'unconfirmed' })
  expect(hub.list('one')).toEqual([])
  await expect(hub.handle({ type: 'opened', requestId: '22222222-2222-4222-8222-222222222222', sessionId: 'one' }, a, [session('one')])).rejects.toThrow('expired')
})

it('waits for an acknowledged return and gates it on the current session and opening grant', async () => {
  let finish!: (value: unknown) => void
  const hub = new IdeControlHub({ read: () => ({}), command: async () => ({}), approvals: () => [],
    returnToPhone: () => new Promise((resolve) => { finish = resolve }) })
  const pending = hub.handle({ type: 'return', sessionId: 'one' }, hello(), [session('one')])
  await Promise.resolve()
  let settled = false
  void pending.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish({ outcome: 'confirmed' })
  expect(await pending).toEqual({ outcome: 'confirmed' })
  await expect(hub.handle({ type: 'return', sessionId: 'two' }, hello(), [session('one')])).rejects.toThrow('outside')
  await expect(hub.handle({ type: 'return', sessionId: 'one' }, hello('read-only', ['sessions.read']), [session('one')])).rejects.toThrow('not granted')
})
