import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PushNotifier } from '../src/push.js'
import type { PushSubscriptionJson } from '@longleash/protocol'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'longleash-push-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

type Sent = { subscription: PushSubscriptionJson; payload: string }

function makeNotifier(opts: {
  send?: (s: PushSubscriptionJson, p: string) => Promise<unknown>
  sent?: Sent[]
}): PushNotifier {
  const sent = opts.sent
  return new PushNotifier({
    dbPath: join(dir, 'push.db'),
    keysPath: join(dir, 'vapid.json'),
    subject: 'https://relay.example.dev',
    send:
      opts.send ??
      (async (subscription, payload) => {
        sent?.push({ subscription, payload })
      }),
  })
}

const APPLE: PushSubscriptionJson = {
  endpoint: 'https://web.push.apple.com/device-a',
  keys: { p256dh: 'pk-a', auth: 'auth-a' },
}
const GOOGLE: PushSubscriptionJson = {
  endpoint: 'https://fcm.googleapis.com/send/device-b',
  keys: { p256dh: 'pk-b', auth: 'auth-b' },
}

async function settled(): Promise<void> {
  // notifyApproval is fire-and-forget; let its promises drain.
  await new Promise((r) => setTimeout(r, 20))
}

describe('lock-screen notifications', () => {
  it('generates a VAPID keypair once and keeps it private on disk', () => {
    const first = makeNotifier({})
    const key = first.publicKey
    expect(key.length).toBeGreaterThan(20)
    first.close()

    // A second start reuses the same identity — resubscribing every phone on
    // every daemon restart would be madness.
    const second = makeNotifier({})
    expect(second.publicKey).toBe(key)
    second.close()

    const mode = statSync(join(dir, 'vapid.json')).mode & 0o777
    expect(mode).toBe(0o600)
    expect(JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8')).privateKey).toBeTruthy()
  })

  it('sends one push per registered device when an approval lands', async () => {
    const sent: Sent[] = []
    const notifier = makeNotifier({ sent })
    notifier.register('dev_A', APPLE)
    notifier.register('dev_B', GOOGLE)

    notifier.notifyApproval('ses_1', 'apr_9')
    await settled()

    expect(sent.map((s) => s.subscription.endpoint).sort()).toEqual(
      [APPLE.endpoint, GOOGLE.endpoint].sort(),
    )
    notifier.close()
  })

  it('the payload carries IDs only — never a tool, a path, or a word of content', async () => {
    const sent: Sent[] = []
    const notifier = makeNotifier({ sent })
    notifier.register('dev_A', APPLE)

    notifier.notifyApproval('ses_1', 'apr_9')
    await settled()

    const payload = JSON.parse(sent[0]!.payload) as Record<string, unknown>
    // Exact key set, so a future "helpful" field addition fails loudly here.
    expect(Object.keys(payload).sort()).toEqual(['approvalId', 'sessionId', 't'])
    expect(payload).toEqual({ t: 'approval', sessionId: 'ses_1', approvalId: 'apr_9' })
    notifier.close()
  })

  it('re-registering the same endpoint updates in place instead of duplicating', async () => {
    const sent: Sent[] = []
    const notifier = makeNotifier({ sent })
    notifier.register('dev_A', APPLE)
    notifier.register('dev_A', APPLE)
    expect(notifier.count()).toBe(1)

    notifier.notifyApproval('ses_1', 'apr_1')
    await settled()
    expect(sent).toHaveLength(1)
    notifier.close()
  })

  it('prunes an endpoint the push service reports dead, and keeps the rest', async () => {
    const notifier = makeNotifier({
      send: async (subscription) => {
        if (subscription.endpoint === APPLE.endpoint) {
          throw Object.assign(new Error('gone'), { statusCode: 410 })
        }
      },
    })
    notifier.register('dev_A', APPLE)
    notifier.register('dev_B', GOOGLE)

    notifier.notifyApproval('ses_1', 'apr_1')
    await settled()

    expect(notifier.count()).toBe(1)
    notifier.close()
  })

  it('a transient delivery failure keeps the subscription — the service may just be down', async () => {
    const notifier = makeNotifier({
      send: async () => {
        throw Object.assign(new Error('upstream 500'), { statusCode: 500 })
      },
    })
    notifier.register('dev_A', APPLE)
    notifier.notifyApproval('ses_1', 'apr_1')
    await settled()
    expect(notifier.count()).toBe(1)
    notifier.close()
  })

  it('revoking a device silences it: its subscriptions go with it', () => {
    const notifier = makeNotifier({})
    notifier.register('dev_A', APPLE)
    notifier.register('dev_B', GOOGLE)
    expect(notifier.removeDevice('dev_A')).toBe(1)
    expect(notifier.count()).toBe(1)
    notifier.close()
  })

  it('a test tap goes only to the device that asked for it', async () => {
    const sent: Sent[] = []
    const notifier = makeNotifier({ sent })
    notifier.register('dev_A', APPLE)
    notifier.register('dev_B', GOOGLE)

    expect(notifier.notifyTest('dev_A')).toBe(1)
    await settled()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.subscription.endpoint).toBe(APPLE.endpoint)
    expect(JSON.parse(sent[0]!.payload)).toEqual({ t: 'test' })
    notifier.close()
  })

  it('subscriptions survive a daemon restart', () => {
    const first = makeNotifier({})
    first.register('dev_A', APPLE)
    first.close()

    const second = makeNotifier({})
    expect(second.count()).toBe(1)
    second.close()
  })
})
