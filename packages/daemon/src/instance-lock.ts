import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const LOCK_NAME = 'daemon.lock'
const LOCK_KIND = 'longleash-daemon'

export interface DaemonInstanceLock {
  path: string
  release(): void
}

/**
 * Serializes daemon ownership by data directory, not by TCP port. A laptop can change address or
 * choose a fallback port, but two processes must never write the same SQLite databases. Dead locks
 * are recoverable; live or unrecognized locks fail closed and remain available for diagnosis.
 */
export function acquireDaemonInstance(dataDir: string): DaemonInstanceLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const path = join(dataDir, LOCK_NAME)
  const token = randomUUID()
  const create = () => {
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify({ kind: LOCK_KIND, pid: process.pid, token, startedAt: Date.now() })}\n`)
    } finally {
      closeSync(fd)
    }
  }

  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked daemon lock: ${path}`)
    let owner: { kind?: string; pid?: number } = {}
    try { owner = JSON.parse(readFileSync(path, 'utf8')) as typeof owner } catch { /* fail closed below */ }
    if (owner.kind !== LOCK_KIND || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0) {
      throw new Error(`Unrecognized daemon lock requires manual inspection: ${path}`)
    }
    if (processAlive(owner.pid!)) {
      throw new Error(`LongLeash already owns this data directory in process ${owner.pid}. Use \`longleash service status\` before starting another instance.`)
    }
    rmSync(path)
    create()
  }

  let held = true
  return {
    path,
    release() {
      if (!held) return
      held = false
      try {
        const owner = JSON.parse(readFileSync(path, 'utf8')) as { token?: string }
        if (owner.token === token) rmSync(path)
      } catch {
        // A missing or replaced lock is not ours to remove.
      }
    },
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
