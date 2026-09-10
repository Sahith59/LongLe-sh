import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleMeasurement, measurementSummary, type MeasurementEnv } from '../worker/measurement.js'

function database(sqlite: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    const build = (values: (string | number | null)[] = []) => ({
      bind: (...args: (string | number | null)[]) => build(args),
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      _run: () => sqlite.prepare(sql).run(...values),
    })
    return build()
  }
  return { prepare, batch: async (statements: { _run(): unknown }[]) => statements.map(item => item._run()) } as unknown as D1Database
}

describe('opt-in product measurement', () => {
  let sqlite: DatabaseSync
  let env: MeasurementEnv
  const now = Date.parse('2026-09-10T12:00:00Z')
  const auth = async () => 'user_external'
  const request = (path: string, method = 'GET', body?: unknown, origin = 'https://app.longleash.dev') => new Request(`https://app.longleash.dev${path}`, {
    method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.exec(readFileSync(new URL('../migrations/0003_measurement.sql', import.meta.url), 'utf8'))
    env = { PUBLIC_APP_HOST: 'app.longleash.dev', MEASUREMENT_ENABLED: 'true', MEASUREMENT_SECRET: 's'.repeat(64),
      FEEDBACK_DB: database(sqlite), MEASUREMENT_RATE: { limit: async () => ({ success: true }) } }
  })
  afterEach(() => sqlite.close())

  it('is off by default, requires same origin, and records nothing before opt-in', async () => {
    expect(await (await handleMeasurement(request('/api/measurement/consent'), env, auth, now)).json()).toMatchObject({ enabled: false })
    const event = { id: crypto.randomUUID(), type: 'reply', outcome: 'success', occurredAt: now, build: 'test' }
    expect((await handleMeasurement(request('/api/measurement/events', 'POST', event), env, auth, now)).status).toBe(403)
    expect((await handleMeasurement(request('/api/measurement/consent', 'PUT', { enabled: true }, 'https://evil.example'), env, auth, now)).status).toBe(403)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM measurement_events').get()?.n).toBe(0)
  })

  it('atomically aggregates idempotent acknowledgements and deletes all account measurement on opt-out', async () => {
    expect((await handleMeasurement(request('/api/measurement/consent', 'PUT', { enabled: true }), env, auth, now)).status).toBe(200)
    const id = crypto.randomUUID()
    const event = { id, type: 'reply', outcome: 'success', occurredAt: now - 1000, build: 'test' }
    expect(await (await handleMeasurement(request('/api/measurement/events', 'POST', event), env, auth, now)).json()).toMatchObject({ duplicate: false })
    expect(await (await handleMeasurement(request('/api/measurement/events', 'POST', event), env, auth, now)).json()).toMatchObject({ duplicate: true })
    expect(sqlite.prepare('SELECT successful_actions AS n FROM measurement_daily').get()?.n).toBe(1)
    expect((await measurementSummary(env, now + 86_400_000)).outcomes).toEqual({ success: 1, failure: 0, unknown: 0 })
    expect((await handleMeasurement(request('/api/measurement/consent', 'PUT', { enabled: false }), env, auth, now)).status).toBe(200)
    for (const table of ['measurement_consent', 'measurement_events', 'measurement_daily', 'measurement_daily_actions']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
    }
  })

  it('rejects unknown fields, oversized bodies, stale timestamps, missing auth, and rate excess', async () => {
    expect((await handleMeasurement(request('/api/measurement/consent', 'PUT', { enabled: true, hidden: true }), env, auth, now)).status).toBe(400)
    const stale = { id: crypto.randomUUID(), type: 'paired', outcome: 'success', occurredAt: now - 49 * 3600_000, build: 'test' }
    expect((await handleMeasurement(request('/api/measurement/events', 'POST', stale), env, auth, now)).status).toBe(400)
    expect((await handleMeasurement(request('/api/measurement/consent'), env, async () => null, now)).status).toBe(401)
    env.MEASUREMENT_RATE = { limit: async () => ({ success: false }) }
    expect((await handleMeasurement(request('/api/measurement/consent'), env, auth, now)).status).toBe(429)
  })
})
