import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../src/eventlog.js'
import { DeviceRegistry } from '../src/auth.js'
import { LongLeashServer } from '../src/server.js'

interface Harness {
  server: LongLeashServer
  log: EventLog
  registry: DeviceRegistry
  base: string
  appDir: string
}

async function start(withApp = true): Promise<Harness> {
  const appDir = mkdtempSync(join(tmpdir(), 'longleash-app-'))
  writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>LongLeash</title><div id=root>')
  writeFileSync(join(appDir, 'app.js'), 'console.log("hi")')

  const log = new EventLog(':memory:')
  const registry = new DeviceRegistry(':memory:')
  const server = new LongLeashServer({
    eventLog: log,
    registry,
    host: '127.0.0.1',
    port: 0,
    ...(withApp ? { staticRoot: appDir } : {}),
  })
  const { port } = await server.listen()
  return { server, log, registry, base: `http://127.0.0.1:${port}`, appDir }
}

async function stop(h: Harness): Promise<void> {
  await h.server.close()
  h.log.close()
  h.registry.close()
  rmSync(h.appDir, { recursive: true, force: true })
}

describe('health endpoint', () => {
  let h: Harness
  beforeEach(async () => {
    h = await start()
  })
  afterEach(() => stop(h))

  it('answers without a token so a phone can tell "unreachable" from "unauthorized"', async () => {
    const res = await fetch(`${h.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('longleash')
  })

  it('leaks nothing about the machine beyond liveness', async () => {
    const body = (await (await fetch(`${h.base}/health`)).json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['name', 'ok', 'protocol'])
  })
})

describe('pairing endpoint', () => {
  let h: Harness
  beforeEach(async () => {
    h = await start()
  })
  afterEach(() => stop(h))

  it('issues a token for a valid challenge', async () => {
    const challenge = h.registry.createPairingChallenge()
    const res = await fetch(
      `${h.base}/pair?c=${challenge.challengeId}&s=${encodeURIComponent(challenge.secret)}`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; relaySecret: string; deviceId: string }
    expect(body.token).toMatch(/^llt_/)
    expect(h.registry.verifyToken(body.token)).not.toBeNull()
    // The relay secret must arrive in this same LAN-only response — there is no later
    // moment when the two devices share a channel the relay cannot observe.
    expect(body.relaySecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.deviceId).toMatch(/^dev_/)
  })

  it('refuses a replayed challenge', async () => {
    const challenge = h.registry.createPairingChallenge()
    const url = `${h.base}/pair?c=${challenge.challengeId}&s=${encodeURIComponent(challenge.secret)}`
    await fetch(url, { method: 'POST' })
    const second = await fetch(url, { method: 'POST' })
    expect(second.status).toBe(403)
    expect(((await second.json()) as { reason: string }).reason).toBe('unknown-challenge')
  })

  it('refuses a wrong secret and never issues a token', async () => {
    const challenge = h.registry.createPairingChallenge()
    const res = await fetch(`${h.base}/pair?c=${challenge.challengeId}&s=wrong`, { method: 'POST' })
    expect(res.status).toBe(403)
    expect(h.registry.listDevices()).toHaveLength(0)
  })

  it('refuses a GET so a link preview or crawler cannot burn a one-time challenge', async () => {
    const challenge = h.registry.createPairingChallenge()
    const res = await fetch(`${h.base}/pair?c=${challenge.challengeId}&s=${challenge.secret}`)
    expect(res.status).toBe(405)
    expect(h.registry.listDevices()).toHaveLength(0)
    // The challenge must still work for the real device afterwards.
    const real = await fetch(
      `${h.base}/pair?c=${challenge.challengeId}&s=${encodeURIComponent(challenge.secret)}`,
      { method: 'POST' },
    )
    expect(real.status).toBe(200)
  })
})

describe('serving the app', () => {
  let h: Harness
  beforeEach(async () => {
    h = await start()
  })
  afterEach(() => stop(h))

  it('serves the app at the root', async () => {
    const res = await fetch(`${h.base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('LongLeash')
  })

  it('serves static assets', async () => {
    const res = await fetch(`${h.base}/app.js`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('console.log')
  })

  it('falls back to the app for unknown routes so deep links work', async () => {
    const res = await fetch(`${h.base}/sessions/ses_123`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('LongLeash')
  })

  it('never serves a file from outside the app directory', async () => {
    // Both a normalised and an encoded traversal must fail to reach the filesystem.
    for (const path of ['/../../../etc/passwd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd']) {
      const res = await fetch(`${h.base}${path}`)
      const body = await res.text()
      expect(body).not.toContain('root:')
      expect(body).not.toMatch(/\/bin\/(ba)?sh/)
    }
  })
})

describe('without an app bundle', () => {
  it('still answers health, so a headless daemon is diagnosable', async () => {
    const h = await start(false)
    try {
      expect((await fetch(`${h.base}/health`)).status).toBe(200)
      expect((await fetch(`${h.base}/`)).status).toBe(404)
    } finally {
      await stop(h)
    }
  })
})
