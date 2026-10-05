import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { EventLog } from '../src/eventlog.js'
import { DeviceRegistry } from '../src/auth.js'
import { LongLeashServer } from '../src/server.js'
import { startDaemon } from '../src/daemon.js'

describe('following the machine onto a new network', () => {
  it('republishes the authenticated local hook endpoint when the service changes address', async () => {
    const root = mkdtempSync(join(tmpdir(), 'll-rebind-hook-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const dataDir = join(root, 'data')
    const daemon = await startDaemon({ allowedRoots: [project], host: '127.0.0.1', port: 0, dataDir })
    try {
      const endpointPath = join(dataDir, 'hook-endpoint.json')
      const initial = JSON.parse(readFileSync(endpointPath, 'utf8')) as { url: string; secret: string }
      const reboundPort = await daemon.rebindLocal('localhost')
      const current = JSON.parse(readFileSync(endpointPath, 'utf8')) as { url: string; secret: string }
      expect(new URL(current.url).hostname).toBe('localhost')
      expect(new URL(current.url).port).toBe(String(reboundPort))
      expect(current.secret).toBe(initial.secret)
      expect(statSync(endpointPath).mode & 0o777).toBe(0o600)
      const health = await fetch(current.url.replace(/\/hook$/, '/health'), { headers: { 'x-longleash-hook': current.secret } })
      expect(health.ok).toBe(true)
      const idePath = join(dataDir, 'ide-endpoint.json')
      const ide = JSON.parse(readFileSync(idePath, 'utf8')) as { url: string; secret: string }
      expect(statSync(idePath).mode & 0o777).toBe(0o600)
      expect(new URL(ide.url).hostname).toBe('127.0.0.1')
      expect(ide.secret).not.toBe(current.secret)
      const snapshot = await fetch(ide.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-longleash-ide': ide.secret },
        body: JSON.stringify({
          v: 1, type: 'ide.hello', clientInstanceId: 'real-daemon', protocol: { min: 1, max: 1 },
          extension: { version: '0.0.3', build: '0.0.3' },
          vscode: { version: '1.131.0', uriScheme: 'vscode', remoteAuthority: null,
            workspaceTrusted: true, windowFocused: true,
            workspaceFolders: [{ uri: `file://${project}`, canonicalPath: project }] },
          capabilities: ['sessions.read'],
        }),
      })
      expect(snapshot.status).toBe(200)
      expect((await snapshot.json() as { sessions: unknown[] }).sessions).toEqual([])
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rebinds without losing the event log, the pairing registry, or its routes', async () => {
    const log = new EventLog(':memory:')
    const registry = new DeviceRegistry(':memory:')
    const challenge = registry.createPairingChallenge()
    const { token } = registry.completePairing({
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'phone',
    })
    const server = new LongLeashServer({ eventLog: log, registry, host: '127.0.0.1', port: 0 })
    const { port: first } = await server.listen()

    log.append('ses_1', { type: 'stream.delta', payload: { kind: 'text', text: 'before the move' } })
    expect((await (await fetch(`http://127.0.0.1:${first}/health`)).json()).name).toBe('longleash')

    // The move. Same interface here, but the code path is identical to a real hop.
    const second = await server.rebind('127.0.0.1')

    // Routes still answer…
    expect((await (await fetch(`http://127.0.0.1:${second}/health`)).json()).name).toBe('longleash')

    // …the pairing token still works, so devices do not have to re-pair after a move…
    const ws = new WebSocket(`ws://127.0.0.1:${second}/ws?token=${encodeURIComponent(token)}`)
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (raw) => resolve(JSON.parse(String(raw))))
      ws.once('error', reject)
    })
    expect(hello.type).toBe('hello')

    // …and history written before the move is still replayable after it.
    const replayed = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as Record<string, unknown>
        if (m.type === 'stream.delta') resolve(m)
      })
      ws.send(JSON.stringify({ v: 1, type: 'subscribe', sessionId: 'ses_1', fromCursor: 0 }))
    })
    expect((replayed.payload as { text: string }).text).toBe('before the move')

    ws.close()
    await server.close()
    log.close()
    registry.close()
  })

  it('takes any port rather than none when the old one is unavailable there', async () => {
    const log = new EventLog(':memory:')
    const registry = new DeviceRegistry(':memory:')
    const server = new LongLeashServer({ eventLog: log, registry, host: '127.0.0.1', port: 0 })
    await server.listen()
    // A squatter on the port the server would prefer to keep.
    const squatter = new LongLeashServer({ eventLog: log, registry, host: '127.0.0.1', port: 0 })
    const { port: taken } = await squatter.listen()

    const moved = await server.rebind('127.0.0.1')
    expect(moved).not.toBe(taken)
    expect((await (await fetch(`http://127.0.0.1:${moved}/health`)).json()).ok).toBe(true)

    await server.close()
    await squatter.close()
    log.close()
    registry.close()
  })
})
