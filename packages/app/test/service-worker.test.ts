import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../public/sw.js'), 'utf8')

type Handler = (event: Record<string, unknown>) => void

function worker(windows: Record<string, unknown>[]) {
  const handlers = new Map<string, Handler>()
  const opened: string[] = []
  const self = {
    location: { origin: 'https://longleash.test' },
    addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
    skipWaiting: () => {},
    registration: { showNotification: async () => {} },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url)
        return null
      },
    },
  }
  runInNewContext(source, {
    self,
    URL,
    location: self.location,
    caches: { keys: async () => [], delete: async () => true, open: async () => ({ put: async () => {} }), match: async () => null },
    fetch: async () => ({ ok: false }),
  })
  return { handler: handlers.get('notificationclick')!, opened }
}

async function tap(handler: Handler, sessionId: string): Promise<void> {
  let pending: Promise<unknown> = Promise.resolve()
  handler({
    notification: { data: { sessionId, approvalId: 'apr_1' }, close: () => {} },
    waitUntil: (promise: Promise<unknown>) => { pending = promise },
  })
  await pending
}

describe('notification navigation', () => {
  it('cold-starts the exact session, not Home', async () => {
    const h = worker([])
    await tap(h.handler, 'ext_codex-1')
    expect(h.opened).toEqual(['/?session=ext_codex-1'])
  })

  it('targets the app shell instead of an arbitrary welcome/preview window', async () => {
    const welcomeMessages: unknown[] = []
    const appMessages: unknown[] = []
    let appFocused = false
    const h = worker([
      {
        url: 'https://longleash.test/welcome.html',
        postMessage: (message: unknown) => welcomeMessages.push(message),
        focus: async () => {},
      },
      {
        url: 'https://longleash.test/',
        postMessage: (message: unknown) => appMessages.push(message),
        focus: async () => { appFocused = true },
      },
    ])
    await tap(h.handler, 'ses_exact')
    expect(welcomeMessages).toEqual([])
    expect(appMessages).toEqual([{ type: 'longleash:open-session', sessionId: 'ses_exact' }])
    expect(appFocused).toBe(true)
    expect(h.opened).toEqual([])
  })
})

describe('service worker trust boundary', () => {
  it('never handles or caches hosted account API responses', () => {
    expect(source).toContain("url.pathname.startsWith('/api/')")
    expect(source).toContain("const CACHE = 'longleash-shell-v3'")
  })
})
