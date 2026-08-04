#!/usr/bin/env node
/**
 * The LongLeash hook for Claude Code. One script, every event: Claude Code pipes
 * the hook payload to stdin, this forwards it to the local daemon, and — for
 * PreToolUse — relays the phone's verdict back as the hook decision.
 *
 * The iron rule: NEVER break the terminal. Daemon missing, endpoint stale,
 * network weird — every failure path exits 0 with no output, which Claude Code
 * reads as "no opinion", and the session behaves as if LongLeash were not
 * installed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The claude process this hook belongs to, found by walking up the process tree.
 * Hooks are spawned through a shell, so the parent may be sh — climb a few
 * levels and take the first ancestor that is actually claude. This is what lets
 * a phone STOP a terminal session for real.
 */
function findClaudePid() {
  let pid = process.ppid
  for (let hop = 0; hop < 5 && pid > 1; hop += 1) {
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
    if (/\bclaude\b/.test(match[2])) return pid
    pid = Number(match[1])
  }
  return null
}

// These only read; the terminal's own permission flow covers them. Gating reads
// from a phone would make the leash a choke chain.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep'])
// Tools that acceptEdits mode auto-approves — the terminal would not ask, so neither do we.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * The phone asks ONLY when the terminal itself would have asked. Claude Code
 * tells the hook which permission mode the session runs in; mirroring it is
 * what keeps LongLeash an inbox of real decisions instead of a firehose of
 * questions the terminal never would have raised.
 */
function terminalWouldAsk(event) {
  const tool = event.tool_name
  if (READ_ONLY.has(tool)) return false
  const mode = event.permission_mode
  if (mode === 'bypassPermissions' || mode === 'plan') return false
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(tool)) return false
  return true
}

async function main() {
  const raw = await readStdin()
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return
  }

  const name = event.hook_event_name
  if (name === 'PreToolUse' && !terminalWouldAsk(event)) return

  let endpoint
  try {
    const dataDir = process.env.LONGLEASH_DATA ?? join(homedir(), '.longleash')
    endpoint = JSON.parse(readFileSync(join(dataDir, 'hook-endpoint.json'), 'utf8'))
  } catch {
    return // daemon has never run — nothing to report to
  }
  if (!endpoint?.url || !endpoint?.secret) return

  // Lifecycle reports are fire-and-fast; a permission question may wait for a phone.
  const timeoutMs = name === 'PreToolUse' ? 150_000 : 3_000

  // On SessionStart, tell the daemon which process this session IS, so the
  // phone's Stop key can end it for real rather than being decoration.
  let body = raw
  if (name === 'SessionStart') {
    const pid = findClaudePid()
    if (pid !== null) body = JSON.stringify({ ...event, ll_pid: pid })
  }

  let response
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-longleash-hook': endpoint.secret },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return // daemon not running right now — the terminal carries on alone
  }
  if (!response.ok || name !== 'PreToolUse') return

  let verdict
  try {
    verdict = await response.json()
  } catch {
    return
  }
  if (verdict.decision !== 'allow' && verdict.decision !== 'deny') return // "ask" = stay silent

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision,
        permissionDecisionReason: String(verdict.reason ?? 'Decided from your phone'),
      },
    }),
  )
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
