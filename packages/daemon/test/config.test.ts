import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRelayUrl } from '../src/config.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'longleash-config-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('remembering the relay url', () => {
  it('saves the url the first time so the next start needs no environment at all', () => {
    const first = resolveRelayUrl('wss://relay.example.com', dir)
    expect(first).toEqual({ url: 'wss://relay.example.com/ws', source: 'flag' })

    const second = resolveRelayUrl(undefined, dir)
    expect(second).toEqual({ url: 'wss://relay.example.com/ws', source: 'remembered' })
  })

  it('a new url replaces the remembered one', () => {
    resolveRelayUrl('wss://old.example.com', dir)
    resolveRelayUrl('wss://new.example.com', dir)
    expect(resolveRelayUrl(undefined, dir)?.url).toBe('wss://new.example.com/ws')
  })

  it('accepts an https origin and normalizes it', () => {
    expect(resolveRelayUrl('https://relay.example.com', dir)?.url).toBe('wss://relay.example.com/ws')
  })

  it('"off" forgets the relay and runs LAN-only from then on', () => {
    resolveRelayUrl('wss://relay.example.com', dir)
    expect(resolveRelayUrl('off', dir)).toBeNull()
    expect(resolveRelayUrl(undefined, dir)).toBeNull()
  })

  it('with nothing set and nothing remembered, there is no relay', () => {
    expect(resolveRelayUrl(undefined, dir)).toBeNull()
  })

  it('survives a corrupt config file rather than refusing to start', () => {
    const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), '{not json')
    expect(resolveRelayUrl(undefined, dir)).toBeNull()
    // And writing over it repairs it.
    resolveRelayUrl('wss://relay.example.com', dir)
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).relayUrl).toBe(
      'wss://relay.example.com/ws',
    )
  })
})
