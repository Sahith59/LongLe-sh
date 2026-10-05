import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connect, type Client, type ClientCallbacks } from '../src/lib/client.js'
import { createStore } from '../src/lib/store.js'

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  sent: Record<string, unknown>[] = []
  constructor(_url: string) { Socket.instances.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3 }
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
}
let client: Client | undefined
beforeEach(() => {
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ name: 'longleash' }) })))
})
afterEach(() => { client?.close(); client = undefined; vi.unstubAllGlobals() })
async function setup(extra: Partial<ClientCallbacks> = {}) {
  const store = createStore()
  client = connect('test-token', store, { onState() {}, onHello() {}, onError() {}, onFolders() {}, ...extra })
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
  const socket = Socket.instances[0]!
  socket.onopen?.()
  return { socket, store, client }
}

it('correlates phone window selection and requires the exact open acknowledgment', async () => {
  const { socket, client } = await setup()
  const list = client.listIdeWindows('conversation')
  const request = socket.sent.at(-1)!
  socket.emit({ type: 'ideWindows', requestId: request.requestId, windows: [{ windowId: 'window-a', label: 'Project' }] })
  expect(await list).toEqual([{ windowId: 'window-a', label: 'Project' }])
  const open = client.openInIde('conversation', 'window-a')
  socket.emit({ type: 'ideResult', requestId: socket.sent.at(-1)!.requestId, outcome: 'unconfirmed', message: 'Window went offline.' })
  await expect(open).rejects.toThrow('Window went offline.')
})

it('acknowledges return only after the phone UI confirms rendering', async () => {
  let render!: () => void
  const { socket } = await setup({ onIdeReturn: () => new Promise<void>((resolve) => { render = resolve }) })
  socket.emit({ type: 'ideReturn', requestId: 'return-a', sessionId: 'conversation' })
  expect(socket.sent.some((message) => message.type === 'ideReturnAck')).toBe(false)
  expect(render).toBeUndefined()
  socket.emit({ type: 'sync.complete', sessionId: 'conversation', syncId: 'ide-return-a', cursor: 0 })
  render()
  await vi.waitFor(() => expect(socket.sent).toContainEqual({ v: 1, type: 'ideReturnAck', requestId: 'return-a', sessionId: 'conversation' }))
})

it('waits for the fresh inventory on reconnect instead of replaying removed aliases', async () => {
  const { socket, client } = await setup()
  client.subscribe('historical-alias')
  socket.sent.length = 0
  socket.onopen?.()
  expect(socket.sent).toEqual([])
  socket.emit({ type: 'hello', sessions: [], roots: [], capabilities: {} })
  expect(socket.sent.some((message) => message.sessionId === 'historical-alias')).toBe(false)
})

it('applies hydration replay in sequence when a live event arrives first', async () => {
  const { socket, store } = await setup()
  socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
  const syncId = socket.sent.find((message) => message.type === 'subscribe' && message.sessionId === 'native-a')?.syncId
  expect(typeof syncId).toBe('string')
  const event = (seq: number, type: string, payload: unknown) => ({ v: 1, sessionId: 'native-a', seq, ts: seq, type, payload })
  socket.emit(event(3, 'stream.delta', { kind: 'text', text: 'Reply' }))
  socket.emit(event(1, 'session.transcript.reset', { blocks: [] }))
  socket.emit(event(2, 'stream.delta', { kind: 'user', text: 'Question' }))
  socket.emit({ v: 1, type: 'sync.complete', sessionId: 'native-a', syncId, cursor: 3 })
  expect(store.getState().sessions['native-a']?.blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
    { kind: 'user', text: 'Question' },
    { kind: 'text', text: 'Reply' },
  ])
})

it('waits for late replay after the paint timeout', async () => {
  const { socket, store } = await setup()
  vi.useFakeTimers()
  try {
    socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
    const syncId = socket.sent.find((message) => message.type === 'subscribe')?.syncId
    const event = (seq: number, type: string, payload: unknown) => ({ v: 1, sessionId: 'native-a', seq, ts: seq, type, payload })
    socket.emit(event(4, 'session.status', { status: 'running' }))
    vi.advanceTimersByTime(1_501)
    expect(store.cursors()['native-a']).toBeUndefined()
    socket.emit(event(1, 'session.transcript.reset', { blocks: [] }))
    socket.emit(event(2, 'stream.delta', { kind: 'user', text: 'Question' }))
    socket.emit(event(3, 'stream.delta', { kind: 'text', text: 'Reply' }))
    socket.emit({ v: 1, type: 'sync.complete', sessionId: 'native-a', syncId, cursor: 4 })
    expect(store.getState().sessions['native-a']?.blocks.map((block) => block.text)).toEqual(['Question', 'Reply'])
  } finally { vi.useRealTimers() }
})

it('ignores events before hello and omitted aliases after hello', async () => {
  const { socket, store } = await setup()
  const event = (sessionId: string, seq: number, type: string, payload: unknown) => ({ v: 1, sessionId, seq, ts: seq, type, payload })
  socket.emit(event('native-a', 9, 'session.status', { status: 'running' }))
  socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
  expect(socket.sent.find((message) => message.type === 'subscribe')?.fromCursor).toBe(0)
  socket.emit(event('omitted-alias', 1, 'stream.delta', { kind: 'text', text: 'ghost' }))
  expect(store.getState().sessions['omitted-alias']).toBeUndefined()
  socket.emit(event('new-session', 1, 'session.started', { agent: 'codex', cwd: '/project' }))
  expect(store.getState().sessions['new-session']).toBeDefined()
})

it('resumes pruned history from the earliest retained sequence', async () => {
  const { socket, store } = await setup()
  socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
  socket.emit({ v: 1, type: 'gap', sessionId: 'native-a', reason: 'pruned', earliestSeq: 10 })
  const retry = socket.sent.filter((message) => message.type === 'subscribe').at(-1)!
  expect(retry.fromCursor).toBe(9)
  socket.emit({ v: 1, sessionId: 'native-a', seq: 10, ts: 10, type: 'stream.delta', payload: { kind: 'text', text: 'Retained' } })
  socket.emit({ v: 1, type: 'sync.complete', sessionId: 'native-a', syncId: retry.syncId, cursor: 10 })
  expect(store.getState().sessions['native-a']?.output).toBe('Retained')
})

it('orders IDE return replay before confirming the open', async () => {
  let render!: () => void
  const { socket, store } = await setup({ onIdeReturn: () => new Promise<void>((resolve) => { render = resolve }) })
  socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
  const hydration = socket.sent.find((message) => message.type === 'subscribe')!
  socket.emit({ v: 1, type: 'sync.complete', sessionId: 'native-a', syncId: hydration.syncId, cursor: 0 })
  socket.emit({ type: 'ideReturn', requestId: 'return-a', sessionId: 'native-a' })
  const event = (seq: number, text: string) => ({ v: 1, sessionId: 'native-a', seq, ts: seq, type: 'stream.delta', payload: { kind: 'text', text } })
  socket.emit(event(2, 'B'))
  socket.emit(event(1, 'A'))
  socket.emit({ v: 1, type: 'sync.complete', sessionId: 'native-a', syncId: 'ide-return-a', cursor: 2 })
  expect(store.getState().sessions['native-a']?.output).toBe('AB')
  expect(render).toBeTypeOf('function')
  render()
  await vi.waitFor(() => expect(socket.sent.some((message) => message.type === 'ideReturnAck')).toBe(true))
})

it('replays past a sync marker when a newer live event still has a gap', async () => {
  const { socket, store } = await setup()
  socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
  const firstSync = socket.sent.find((message) => message.type === 'subscribe')?.syncId
  for (let seq = 1; seq <= 10; seq += 1) {
    socket.emit({ v: 1, sessionId: 'native-a', seq, ts: seq, type: 'stream.delta', payload: { kind: 'text', text: String(seq) } })
  }
  socket.emit({ v: 1, sessionId: 'native-a', seq: 12, ts: 12, type: 'stream.delta', payload: { kind: 'text', text: '12' } })
  socket.emit({ v: 1, type: 'sync.complete', sessionId: 'native-a', syncId: firstSync, cursor: 10 })
  const retry = socket.sent.filter((message) => message.type === 'subscribe').at(-1)!
  expect(retry.syncId).not.toBe(firstSync)
  expect(retry.fromCursor).toBe(10)
  socket.emit({ v: 1, sessionId: 'native-a', seq: 11, ts: 11, type: 'stream.delta', payload: { kind: 'text', text: '11' } })
  socket.emit({ v: 1, type: 'sync.complete', sessionId: 'native-a', syncId: retry.syncId, cursor: 12 })
  expect(store.getState().sessions['native-a']?.output).toBe('123456789101112')
})

it('repairs an empty card with an advanced cursor on authoritative hello', async () => {
  const { socket, store } = await setup()
  store.apply({ v: 1, sessionId: 'native-a', seq: 20, ts: 20, type: 'session.status', payload: { status: 'running' } })
  socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
  expect(socket.sent.find((message) => message.type === 'subscribe')?.fromCursor).toBe(0)
})

it('reports an oversized out-of-order gap and reconnects without advancing the cursor', async () => {
  const errors: string[] = []
  const { socket, store } = await setup({ onError: (error) => errors.push(error) })
  socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
  socket.emit({ v: 1, sessionId: 'native-a', seq: 20, ts: 20, type: 'stream.delta', payload: { kind: 'text', text: 'x'.repeat(8_000_000) } })
  expect(errors).toContain('The laptop sent too much out-of-order history. Reconnecting to retry.')
  expect(store.cursors()['native-a']).toBeUndefined()
  expect(socket.readyState).toBe(3)
})

it('rejects pending requests when the connection is disposed', async () => {
  const { client } = await setup()
  const request = client.listIdeWindows('conversation')
  client.close()
  await expect(request).rejects.toThrow('connection was closed')
})


it('does not report replay timeouts after the client is closed', async () => {
  const onError = vi.fn()
  const { socket, client } = await setup({ onError })
  vi.useFakeTimers()
  try {
    socket.emit({ type: 'hello', sessions: [{ sessionId: 'native-a', agent: 'codex', cwd: '/project', title: 'A task', origin: 'vscode', status: 'running', live: true }], roots: [], capabilities: {} })
    client.close()
    await vi.advanceTimersByTimeAsync(21_000)
    expect(onError).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
