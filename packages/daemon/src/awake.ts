import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Keeps the machine from falling asleep **while agents are actually working**, and lets it
 * sleep the moment they stop.
 *
 * The problem this solves is the one people actually hit: not the closed lid, but a laptop
 * sitting open on a desk that idles out twenty minutes into a long job. You come back to an
 * agent that stopped for no reason you can see. A tool you are asked to trust from a train
 * cannot do that.
 *
 * What this deliberately does NOT do:
 *
 *   - **It does not defeat the lid.** Closing a MacBook on battery sleeps it, and no
 *     userspace process can prevent that. Claiming otherwise would be a lie a user discovers
 *     at the worst possible moment. `docs/REQUIREMENTS.md` says so plainly.
 *   - **It does not change a system setting.** `pmset` would alter the machine globally and
 *     outlive the daemon. This holds an assertion that dies with the process — including if
 *     the daemon is killed — so LongLeash can never leave a laptop unable to sleep.
 *   - **It does not hold the machine awake for nothing.** The assertion exists only while at
 *     least one session is running, which is why it is safe to leave on by default.
 *
 * Implemented with `caffeinate -i`, the documented macOS interface for exactly this. On
 * anything else it is a no-op that reports itself as unsupported rather than pretending.
 */

export interface AwakeOptions {
  platform?: NodeJS.Platform
  /** Test seam. Must behave like `child_process.spawn`. */
  spawnFn?: (command: string, args: string[], opts: { stdio: 'ignore'; detached: false }) => ChildProcess
  log?: (line: string) => void
}

export class StayAwake {
  private held: ChildProcess | null = null
  private reason = 0
  private readonly platform: NodeJS.Platform
  private readonly spawnFn: NonNullable<AwakeOptions['spawnFn']>
  private readonly log: (line: string) => void

  constructor(opts: AwakeOptions = {}) {
    this.platform = opts.platform ?? process.platform
    this.spawnFn = opts.spawnFn ?? ((c, a, o) => spawn(c, a, o))
    this.log = opts.log ?? (() => {})
  }

  /** True where an assertion can actually be taken. Elsewhere every call is a safe no-op. */
  get supported(): boolean {
    return this.platform === 'darwin'
  }

  /** True while the machine is being held awake by us. */
  get holding(): boolean {
    return this.held !== null
  }

  /** How many sessions are currently keeping it awake. */
  get count(): number {
    return this.reason
  }

  /**
   * Reconcile the assertion with how many sessions are running. Idempotent on purpose: it is
   * called from every session start and end, and calling it twice with the same number must
   * not spawn a second `caffeinate`.
   */
  update(runningSessions: number): void {
    this.reason = Math.max(0, runningSessions)
    if (!this.supported) return

    if (this.reason > 0 && this.held === null) {
      try {
        // -i inhibits IDLE sleep only. It does not touch display sleep (your screen still
        // locks, which is a security control we must not weaken) and does not defeat the lid.
        const child = this.spawnFn('caffeinate', ['-i'], { stdio: 'ignore', detached: false })
        // If it dies for any reason, forget it so the next update can retake the assertion
        // rather than believing it still holds one.
        child.once('exit', () => {
          if (this.held === child) this.held = null
        })
        child.once('error', () => {
          if (this.held === child) this.held = null
        })
        this.held = child
        this.log('keeping this Mac awake while agents are working')
      } catch {
        // caffeinate missing or unspawnable: sleeping is a worse outcome than crashing here
        // would be, but not much worse, and it must never take the daemon down with it.
        this.held = null
      }
      return
    }

    if (this.reason === 0 && this.held !== null) {
      this.release()
      this.log('all agents idle — letting this Mac sleep normally again')
    }
  }

  /**
   * Drop the assertion. Called on shutdown, and safe to call at any time: a machine that
   * cannot sleep because LongLeash exited badly is a bug we refuse to be able to have.
   */
  release(): void {
    const child = this.held
    this.held = null
    if (child === null) return
    try {
      child.kill('SIGTERM')
    } catch {
      // already gone
    }
  }
}
