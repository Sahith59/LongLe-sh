import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import webpush from 'web-push'
import type { PushSubscriptionJson } from '@longleash/protocol'

export interface PushNotifierOptions {
  /** SQLite file for subscriptions. */
  dbPath: string
  /** JSON file holding the VAPID keypair; created on first run. */
  keysPath: string
  /**
   * VAPID subject — who a push service may contact about misbehaving senders.
   * An https origin (the relay) or a mailto:.
   */
  subject: string
  log?: (line: string) => void
  /** Test seam: replaces the real webpush.sendNotification. */
  send?: (
    subscription: PushSubscriptionJson,
    payload: string,
    options: { TTL: number; urgency: 'high' },
  ) => Promise<unknown>
}

interface SubscriptionRow {
  endpoint: string
  device_id: string
  json: string
}

/**
 * Lock-screen notifications, under the strictest rule in the product: a push payload
 * carries IDs ONLY — a session id and an approval id — never a tool name, never a path,
 * never a word of the conversation. Push services (Apple's, Google's) are third parties;
 * they route the tap on the shoulder, and the in-app inbox remains the source of truth.
 *
 * Subscriptions are per paired device and survive daemon restarts. A push service
 * answering 404/410 means the subscription is dead (app removed, permission withdrawn);
 * it is deleted rather than retried forever.
 */
export class PushNotifier {
  private readonly db: Database.Database
  private readonly log: (line: string) => void
  private readonly send: NonNullable<PushNotifierOptions['send']>
  readonly publicKey: string

  constructor(options: PushNotifierOptions) {
    this.log = options.log ?? (() => {})

    const keys = loadOrCreateKeys(options.keysPath)
    this.publicKey = keys.publicKey
    webpush.setVapidDetails(options.subject, keys.publicKey, keys.privateKey)

    this.send =
      options.send ??
      (async (subscription, payload, opts) => {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          payload,
          opts,
        )
      })

    this.db = new Database(options.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
  }

  /** Idempotent: re-registering the same endpoint refreshes it in place. */
  register(deviceId: string, subscription: PushSubscriptionJson): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, device_id, json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, json = excluded.json`,
      )
      .run(subscription.endpoint, deviceId, JSON.stringify(subscription), Date.now())
    this.log(`push: registered endpoint for ${deviceId}`)
  }

  remove(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }

  /** A revoked device must stop receiving even content-free taps. */
  removeDevice(deviceId: string): number {
    const info = this.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId)
    return info.changes
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as {
      n: number
    }
    return row.n
  }

  /**
   * Tell every paired phone that a session needs a human. Fire-and-forget by design:
   * a slow push service must never delay the agent loop, and a failed push loses
   * nothing — the approval still sits in the inbox.
   */
  notifyApproval(sessionId: string, approvalId: string): void {
    const rows = this.db
      .prepare('SELECT endpoint, device_id, json FROM push_subscriptions')
      .all() as SubscriptionRow[]
    if (rows.length === 0) return

    // IDs only. Adding any content here is a protocol violation, not a feature.
    const payload = JSON.stringify({ t: 'approval', sessionId, approvalId })

    for (const row of rows) {
      let subscription: PushSubscriptionJson
      try {
        subscription = JSON.parse(row.json) as PushSubscriptionJson
      } catch {
        this.remove(row.endpoint)
        continue
      }
      void this.send(subscription, payload, { TTL: 300, urgency: 'high' })
        .then(() => this.log(`push: notified ${row.device_id}`))
        .catch((err: unknown) => {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) {
            // The phone unsubscribed or the app is gone; the endpoint is dead.
            this.remove(row.endpoint)
            this.log(`push: pruned dead endpoint for ${row.device_id}`)
          } else {
            this.log(`push: delivery failed for ${row.device_id} (${String(status ?? err)})`)
          }
        })
    }
  }

  close(): void {
    this.db.close()
  }
}

function loadOrCreateKeys(path: string): { publicKey: string; privateKey: string } {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      publicKey?: string
      privateKey?: string
    }
    if (parsed.publicKey && parsed.privateKey) {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
    }
  }
  const keys = webpush.generateVAPIDKeys()
  writeFileSync(path, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  return keys
}
