import { describe, it, expect } from 'vitest'
import WebSocket from 'ws'
import { EventLog } from '../src/eventlog.js'
import { DeviceRegistry } from '../src/auth.js'
import { LongLeashServer } from '../src/server.js'

describe('following the machine onto a new network', () => {
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
