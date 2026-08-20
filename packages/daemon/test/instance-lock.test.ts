import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireDaemonInstance } from '../src/instance-lock.js'

describe('one daemon owns each data directory', () => {
  it('rejects a live second writer and releases only its own lock', () => {
    const data = mkdtempSync(join(tmpdir(), 'longleash-daemon-lock-'))
    const first = acquireDaemonInstance(data)
    expect(() => acquireDaemonInstance(data)).toThrow('already owns this data directory')
    const path = first.path
    first.release()
    const second = acquireDaemonInstance(data)
    expect(second.path).toBe(path)
    second.release()
  })

  it('recovers a recognized dead owner but fails closed on unknown data', () => {
    const data = mkdtempSync(join(tmpdir(), 'longleash-daemon-stale-'))
    writeFileSync(join(data, 'daemon.lock'), JSON.stringify({ kind: 'longleash-daemon', pid: 99_999_999, token: 'old' }))
    const lock = acquireDaemonInstance(data)
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid)
    lock.release()

    writeFileSync(join(data, 'daemon.lock'), '{not-json')
    expect(() => acquireDaemonInstance(data)).toThrow('manual inspection')
  })

  it('refuses a symlinked lock and never deletes its target', () => {
    const data = mkdtempSync(join(tmpdir(), 'longleash-daemon-symlink-'))
    const target = join(data, 'outside')
    writeFileSync(target, 'do not touch')
    symlinkSync(target, join(data, 'daemon.lock'))
    expect(() => acquireDaemonInstance(data)).toThrow('symlinked daemon lock')
    expect(readFileSync(target, 'utf8')).toBe('do not touch')
  })

  it('does not remove a lock that was replaced after acquisition', () => {
    const data = mkdtempSync(join(tmpdir(), 'longleash-daemon-token-'))
    const lock = acquireDaemonInstance(data)
    writeFileSync(lock.path, JSON.stringify({ kind: 'longleash-daemon', pid: process.pid, token: 'replacement' }))
    lock.release()
    expect(readFileSync(lock.path, 'utf8')).toContain('replacement')
  })
})
