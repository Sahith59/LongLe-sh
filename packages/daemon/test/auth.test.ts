import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry, PairingError } from '../src/auth.js'
import SqliteDatabase from 'better-sqlite3'

describe('pairing: happy path', () => {
  let reg: DeviceRegistry
  beforeEach(() => {
    reg = new DeviceRegistry(':memory:')
  })
  afterEach(() => reg.close())

  it('challenge -> complete -> token verifies -> device listed', () => {
    const challenge = reg.createPairingChallenge()
    expect(challenge.challengeId).toMatch(/^chl_/)
    expect(challenge.secret.length).toBeGreaterThanOrEqual(32)

    const { device, token } = reg.completePairing({
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'Sahith iPhone',
    })
    expect(device.deviceId).toMatch(/^dev_/)
    expect(token).toMatch(/^llt_/)

    const verified = reg.verifyToken(token)
    expect(verified?.deviceId).toBe(device.deviceId)

    const devices = reg.listDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0]?.name).toBe('Sahith iPhone')
    expect(devices[0]?.revokedAt).toBeNull()
  })

  it('QR payload is parseable JSON carrying version, challengeId and secret', () => {
    const challenge = reg.createPairingChallenge()
    const parsed = JSON.parse(challenge.qrPayload) as Record<string, unknown>
    expect(parsed.v).toBe(1)
    expect(parsed.challengeId).toBe(challenge.challengeId)
    expect(parsed.secret).toBe(challenge.secret)
  })

  it('stores an optional device public key for the future E2E layer', () => {
    const challenge = reg.createPairingChallenge()
    reg.completePairing({
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'phone',
      publicKey: 'base64-public-key-material',
    })
    expect(reg.listDevices()[0]?.publicKey).toBe('base64-public-key-material')
  })
})

describe('pairing: attacks and failure modes', () => {
  let reg: DeviceRegistry
  beforeEach(() => {
    reg = new DeviceRegistry(':memory:')
  })
  afterEach(() => reg.close())

  it('a challenge is single-use: replaying a consumed challenge is rejected', () => {
    const challenge = reg.createPairingChallenge()
    reg.completePairing({ challengeId: challenge.challengeId, secret: challenge.secret, deviceName: 'legit' })
    expect(() =>
      reg.completePairing({ challengeId: challenge.challengeId, secret: challenge.secret, deviceName: 'attacker' }),
    ).toThrowError(PairingError)
    expect(reg.listDevices()).toHaveLength(1)
  })

  it('a wrong secret is rejected and does NOT burn the challenge for the legitimate user', () => {
    const challenge = reg.createPairingChallenge()
    expect(() =>
      reg.completePairing({ challengeId: challenge.challengeId, secret: 'wrong-guess', deviceName: 'attacker' }),
    ).toThrowError(/secret/i)
    const { token } = reg.completePairing({
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'legit',
    })
    expect(reg.verifyToken(token)).not.toBeNull()
  })

  it('an expired challenge is rejected', () => {
    let t = 1_000_000
    const clocked = new DeviceRegistry(':memory:', { now: () => t, challengeTtlMs: 5 * 60_000 })
    const challenge = clocked.createPairingChallenge()
    t += 5 * 60_000 + 1
    expect(() =>
      clocked.completePairing({ challengeId: challenge.challengeId, secret: challenge.secret, deviceName: 'late' }),
    ).toThrowError(/expired/i)
    clocked.close()
  })

  it('expired challenges are swept — a months-running daemon does not leak memory', () => {
    let t = 0
    const clocked = new DeviceRegistry(':memory:', { now: () => t, challengeTtlMs: 1000 })
    for (let i = 0; i < 99; i++) {
      clocked.createPairingChallenge()
      t += 2000
    }
    clocked.createPairingChallenge()
    expect(clocked.pendingChallengeCount()).toBe(1)
    clocked.close()
  })

  it('an unknown challengeId is rejected', () => {
    expect(() =>
      reg.completePairing({ challengeId: 'chl_nope', secret: 'whatever', deviceName: 'x' }),
    ).toThrowError(PairingError)
  })

  it('malformed pairing input is rejected: empty name, missing fields, oversized name', () => {
    const challenge = reg.createPairingChallenge()
    expect(() =>
      reg.completePairing({ challengeId: challenge.challengeId, secret: challenge.secret, deviceName: '' }),
    ).toThrowError()
    expect(() => reg.completePairing({ deviceName: 'x' } as never)).toThrowError()
    expect(() =>
      reg.completePairing({
        challengeId: challenge.challengeId,
        secret: challenge.secret,
        deviceName: 'a'.repeat(65),
      }),
    ).toThrowError()
  })

  it('the plaintext token appears NOWHERE in the database', () => {
    const challenge = reg.createPairingChallenge()
    const { token } = reg.completePairing({
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'phone',
    })
    const rows = reg.rawDb.prepare('SELECT * FROM devices').all() as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string') expect(value).not.toContain(token)
      }
    }
  })
})

describe('token verification', () => {
  let reg: DeviceRegistry
  let token: string
  beforeEach(() => {
    reg = new DeviceRegistry(':memory:')
    const challenge = reg.createPairingChallenge()
    token = reg.completePairing({
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'phone',
    }).token
  })
  afterEach(() => reg.close())

  it('unknown, truncated, empty and absurdly long tokens all return null without throwing', () => {
    expect(reg.verifyToken('llt_completely_made_up')).toBeNull()
    expect(reg.verifyToken(token.slice(0, 10))).toBeNull()
    expect(reg.verifyToken('')).toBeNull()
    expect(reg.verifyToken('x'.repeat(10_000))).toBeNull()
  })

  it('a valid token updates lastSeenAt using the registry clock', () => {
    let t = 2_000_000
    const clocked = new DeviceRegistry(':memory:', { now: () => t })
    const challenge = clocked.createPairingChallenge()
    const paired = clocked.completePairing({
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: 'phone',
    })
    t = 2_345_678
    clocked.verifyToken(paired.token)
    expect(clocked.listDevices()[0]?.lastSeenAt).toBe(2_345_678)
    clocked.close()
  })
})

describe('revocation', () => {
  let reg: DeviceRegistry
  beforeEach(() => {
    reg = new DeviceRegistry(':memory:')
  })
  afterEach(() => reg.close())

  const pair = (name: string) => {
    const challenge = reg.createPairingChallenge()
    return reg.completePairing({ challengeId: challenge.challengeId, secret: challenge.secret, deviceName: name })
  }

  it('a revoked device token stops verifying immediately', () => {
    const { device, token } = pair('phone')
    expect(reg.verifyToken(token)).not.toBeNull()
    expect(reg.revokeDevice(device.deviceId)).toBe(true)
    expect(reg.verifyToken(token)).toBeNull()
  })

  it('revocation notifies listeners exactly once (so live sockets can be dropped)', () => {
    const { device } = pair('phone')
    const seen: string[] = []
    const unsubscribe = reg.onRevoked((id) => seen.push(id))
    reg.revokeDevice(device.deviceId)
    reg.revokeDevice(device.deviceId)
    expect(seen).toEqual([device.deviceId])
    unsubscribe()
  })

  it('a crashing listener breaks neither revocation nor the other listeners', () => {
    const { device, token } = pair('phone')
    const seen: string[] = []
    reg.onRevoked(() => {
      throw new Error('listener bug')
    })
    reg.onRevoked((deviceId) => seen.push(deviceId))
    expect(reg.revokeDevice(device.deviceId)).toBe(true)
    expect(seen).toEqual([device.deviceId])
    expect(reg.verifyToken(token)).toBeNull()
  })

  it('revoking an unknown device returns false and fires nothing', () => {
    const seen: string[] = []
    reg.onRevoked((id) => seen.push(id))
    expect(reg.revokeDevice('dev_ghost')).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it('revoking one device leaves the other device working', () => {
    const a = pair('phone-a')
    const b = pair('phone-b')
    reg.revokeDevice(a.device.deviceId)
    expect(reg.verifyToken(a.token)).toBeNull()
    expect(reg.verifyToken(b.token)).not.toBeNull()
  })
})

describe('durability across restart', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'longleash-auth-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('devices and revocations survive a restart; tokens still verify', () => {
    const dbPath = join(dir, 'auth.db')
    const first = new DeviceRegistry(dbPath)
    const c1 = first.createPairingChallenge()
    const kept = first.completePairing({ challengeId: c1.challengeId, secret: c1.secret, deviceName: 'kept' })
    const c2 = first.createPairingChallenge()
    const revoked = first.completePairing({ challengeId: c2.challengeId, secret: c2.secret, deviceName: 'revoked' })
    first.revokeDevice(revoked.device.deviceId)
    first.close()

    const second = new DeviceRegistry(dbPath)
    expect(second.verifyToken(kept.token)?.name).toBe('kept')
    expect(second.verifyToken(revoked.token)).toBeNull()
    expect(second.listDevices()).toHaveLength(2)
    second.close()
  })

  it('pending challenges do NOT survive a restart (ephemeral by design)', () => {
    const dbPath = join(dir, 'auth.db')
    const first = new DeviceRegistry(dbPath)
    const challenge = first.createPairingChallenge()
    first.close()

    const second = new DeviceRegistry(dbPath)
    expect(() =>
      second.completePairing({ challengeId: challenge.challengeId, secret: challenge.secret, deviceName: 'late' }),
    ).toThrowError(PairingError)
    second.close()
  })
})

describe('relay secrets — minted at pairing, never shown to the relay', () => {
  let reg: DeviceRegistry
  beforeEach(() => {
    reg = new DeviceRegistry(':memory:')
  })
  afterEach(() => reg.close())

  const pairOne = (name = 'iPhone') => {
    const challenge = reg.createPairingChallenge()
    return reg.completePairing({
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      deviceName: name,
    })
  }

  it('every pairing returns a high-entropy relay secret for the phone to keep', () => {
    const { relaySecret } = pairOne()
    expect(relaySecret).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 random bytes, base64url
  })

  it('each device gets its own secret — its own room, its own key', () => {
    expect(pairOne('a').relaySecret).not.toBe(pairOne('b').relaySecret)
  })

  it('lists relay devices so the daemon can hold one room per pairing', () => {
    const { device, relaySecret } = pairOne()
    const endpoints = reg.listRelayDevices()
    expect(endpoints).toEqual([{ deviceId: device.deviceId, relaySecret }])
  })

  it('a revoked device vanishes from the relay list — its room simply stops existing', () => {
    const { device } = pairOne()
    reg.revokeDevice(device.deviceId)
    expect(reg.listRelayDevices()).toEqual([])
  })

  it('an install that paired devices before relays existed migrates cleanly and offers no room', () => {
    // Build the OLD schema directly on a file, the way a pre-relay release left it.
    const dir = mkdtempSync(join(tmpdir(), 'longleash-auth-'))
    const path = join(dir, 'devices.db')
    try {
      const legacy = new SqliteDatabase(path)
      legacy.exec(`
        CREATE TABLE devices (
          device_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          public_key TEXT,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER,
          revoked_at INTEGER
        )
      `)
      legacy
        .prepare("INSERT INTO devices VALUES ('dev_old', 'old phone', 'hash', NULL, 1, NULL, NULL)")
        .run()
      legacy.close()

      // Today's daemon opens the same file: migrate, keep the device, invent no secret.
      const upgraded = new DeviceRegistry(path)
      expect(upgraded.listDevices().map((d) => d.deviceId)).toEqual(['dev_old'])
      expect(upgraded.listRelayDevices()).toEqual([])
      // And pairing a NEW device on the migrated schema works with a secret.
      const challenge = upgraded.createPairingChallenge()
      const paired = upgraded.completePairing({
        challengeId: challenge.challengeId,
        secret: challenge.secret,
        deviceName: 'new phone',
      })
      expect(upgraded.listRelayDevices()).toEqual([
        { deviceId: paired.device.deviceId, relaySecret: paired.relaySecret },
      ])
      upgraded.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
