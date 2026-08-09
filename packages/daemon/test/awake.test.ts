import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { StayAwake } from '../src/awake.js'

/**
 * Holding a machine awake is a promise with a sharp edge: get it wrong in one direction and
 * agents stop mid-job; get it wrong in the other and someone's laptop never sleeps again and
 * cooks in a bag. These tests care about both directions equally.
 */

class FakeCaffeinate extends EventEmitter {
  killed: string | null = null
  kill(signal: string): boolean {
    this.killed = signal
    this.emit('exit', 0)
    return true
  }
}

function subject(platform: NodeJS.Platform = 'darwin') {
  const spawned: { command: string; args: string[] }[] = []
  const children: FakeCaffeinate[] = []
  const awake = new StayAwake({
    platform,
    spawnFn: (command, args) => {
      spawned.push({ command, args })
      const child = new FakeCaffeinate()
      children.push(child)
      return child as unknown as ChildProcess
    },
  })
  return { awake, spawned, children }
}

describe('holding the machine awake while agents work', () => {
  it('takes the assertion when the first session starts', () => {
    const { awake, spawned } = subject()
    expect(awake.holding).toBe(false)
    awake.update(1)
    expect(awake.holding).toBe(true)
    expect(spawned).toEqual([{ command: 'caffeinate', args: ['-i'] }])
  })

  it('inhibits IDLE sleep only — never the display', () => {
    // The screen locking is a security control. Holding it on would weaken the user's machine
    // to solve a problem they did not ask us to solve.
    const { awake, spawned } = subject()
    awake.update(1)
    expect(spawned[0]!.args).toEqual(['-i'])
    expect(spawned[0]!.args).not.toContain('-d')
    expect(spawned[0]!.args).not.toContain('-s')
  })

  it('holds exactly one assertion no matter how many sessions run', () => {
    const { awake, spawned } = subject()
    awake.update(1)
    awake.update(2)
    awake.update(5)
    awake.update(5)
    expect(spawned).toHaveLength(1)
    expect(awake.holding).toBe(true)
  })

  it('releases the moment the last session ends', () => {
    const { awake, children } = subject()
    awake.update(2)
    awake.update(1)
    expect(awake.holding).toBe(true) // one still running
    awake.update(0)
    expect(awake.holding).toBe(false)
    expect(children[0]!.killed).toBe('SIGTERM')
  })

  it('can retake the assertion after releasing it', () => {
    const { awake, spawned } = subject()
    awake.update(1)
    awake.update(0)
    awake.update(1)
    expect(spawned).toHaveLength(2)
    expect(awake.holding).toBe(true)
  })

  it('recovers if caffeinate dies underneath us', () => {
    // Otherwise the daemon believes it holds an assertion it lost, and the laptop sleeps
    // through a two-hour job with nothing in the logs to explain it.
    const { awake, children, spawned } = subject()
    awake.update(1)
    children[0]!.emit('exit', 1)
    expect(awake.holding).toBe(false)
    awake.update(2) // still work to do — take it again
    expect(spawned).toHaveLength(2)
    expect(awake.holding).toBe(true)
  })

  it('survives a spawn failure without taking the daemon down', () => {
    const awake = new StayAwake({
      platform: 'darwin',
      spawnFn: () => {
        throw new Error('caffeinate not found')
      },
    })
    expect(() => awake.update(1)).not.toThrow()
    expect(awake.holding).toBe(false)
    // And a later release must not throw either.
    expect(() => awake.release()).not.toThrow()
  })

  it('release is idempotent and safe when nothing is held', () => {
    const { awake } = subject()
    expect(() => awake.release()).not.toThrow()
    awake.update(1)
    awake.release()
    awake.release()
    expect(awake.holding).toBe(false)
  })

  it('treats a negative count as zero rather than holding forever', () => {
    const { awake } = subject()
    awake.update(1)
    awake.update(-3)
    expect(awake.holding).toBe(false)
    expect(awake.count).toBe(0)
  })

  it('is a clean no-op off macOS, and says so instead of pretending', () => {
    for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
      const { awake, spawned } = subject(platform)
      expect(awake.supported).toBe(false)
      awake.update(3)
      expect(spawned).toHaveLength(0)
      expect(awake.holding).toBe(false)
      expect(() => awake.release()).not.toThrow()
    }
  })

  it('the assertion dies with the process — it can never outlive the daemon', () => {
    // Spawned attached (detached: false), so the OS reaps it if the daemon is killed -9.
    // This is why LongLeash cannot leave a laptop permanently unable to sleep.
    const spawnFn = vi.fn((_c: string, _a: string[], opts: { detached: false }) => {
      expect(opts.detached).toBe(false)
      return new FakeCaffeinate() as unknown as ChildProcess
    })
    new StayAwake({ platform: 'darwin', spawnFn }).update(1)
    expect(spawnFn).toHaveBeenCalledOnce()
  })
})
