import { execFileSync } from 'node:child_process'

/**
 * The agent process this hook belongs to, found by walking up the process tree.
 *
 * Hooks are spawned through a shell, so the immediate parent is usually `sh` — climb a few
 * levels and take the first ancestor that is actually the agent. This is what makes Stop on a
 * phone end a real process instead of being decoration.
 *
 * Shared by every agent's hook and matched against the agent's OWN name. The Codex hook
 * originally reported no pid at all, so `stop()` saw `pid === null` and refused every single
 * time — the phone's Stop button did nothing, forever, with nothing to explain why.
 *
 * @param {RegExp} matcher matches the ancestor's command line, e.g. /\bcodex\b/
 * @returns {number | null}
 */
export function findAgentPid(matcher) {
  let pid = process.ppid
  for (let hop = 0; hop < 6 && pid > 1; hop += 1) {
    let line
    try {
      line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1500,
      }).trim()
    } catch {
      return null
    }
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!match) return null
    if (matcher.test(match[2])) return pid
    pid = Number(match[1])
  }
  return null
}
