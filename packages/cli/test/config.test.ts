import { lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  captureConfigSnapshot,
  HOSTED_RELAY,
  loadConfig,
  normalizeRelay,
  normalizeRoots,
  restoreConfigSnapshot,
  saveConfig,
} from '../src/config.js'

describe('CLI configuration boundary', () => {
  it('canonicalizes existing project roots and refuses the whole filesystem', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-root-'))
    expect(normalizeRoots([root, root])).toEqual([realpathSync(root)])
    expect(() => normalizeRoots(['/'])).toThrow('entire filesystem')
  })

  it('requires encrypted remote relays and permits explicit loopback development', () => {
    expect(normalizeRelay('hosted')).toBe(HOSTED_RELAY)
    expect(normalizeRelay('lan')).toBeNull()
    expect(normalizeRelay('wss://relay.example')).toBe('wss://relay.example/ws')
    expect(normalizeRelay('ws://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/ws')
    expect(() => normalizeRelay('ws://relay.example/ws')).toThrow('must use wss://')
    expect(() => normalizeRelay('https://relay.example/ws')).toThrow('must use wss://')
    expect(() => normalizeRelay('wss://relay.example/not-ws')).toThrow('path must be /ws')
  })

  it('writes mode-0600 JSON atomically, preserves unknown fields, and keeps one rollback copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'longleash-config-'))
    const path = join(dir, 'nested', 'config.json')
    saveConfig({ existing: true, allowedRoots: [dir] }, path)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    saveConfig({ existing: true, allowedRoots: [dir], relayUrl: HOSTED_RELAY }, path)
    expect(JSON.parse(readFileSync(`${path}.previous`, 'utf8'))).toEqual({ existing: true, allowedRoots: [dir] })
    expect(loadConfig(path)).toMatchObject({ existing: true, relayUrl: HOSTED_RELAY })
  })

  it('refuses a symlinked configuration target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'longleash-config-link-'))
    mkdirSync(join(dir, 'data'))
    const target = join(dir, 'target.json')
    writeFileSync(target, '{}')
    const path = join(dir, 'data', 'config.json')
    symlinkSync(target, path)
    expect(() => loadConfig(path)).toThrow('symlinked configuration')
    expect(() => saveConfig({}, path)).toThrow('symlinked configuration')
  })

  it('restores both configuration files after a failed setup transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'longleash-config-rollback-'))
    const path = join(dir, 'config.json')
    saveConfig({ generation: 1 }, path)
    saveConfig({ generation: 2 }, path)
    const snapshot = captureConfigSnapshot(path)
    saveConfig({ generation: 3 }, path)

    restoreConfigSnapshot(snapshot)

    expect(loadConfig(path)).toEqual({ generation: 2 })
    expect(JSON.parse(readFileSync(`${path}.previous`, 'utf8'))).toEqual({ generation: 1 })
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
  })
})
