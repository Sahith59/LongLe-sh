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

it('rejects pending requests when the connection is disposed', async () => {
  const { client } = await setup()
  const request = client.listIdeWindows('conversation')
  client.close()
  await expect(request).rejects.toThrow('connection was closed')
})
