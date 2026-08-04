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
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// These only read; the terminal's own permission flow covers them. Gating reads
// from a phone would make the leash a choke chain.
const READ_ONLY = new Set(['Read', 'Glob', 'Grep'])

async function main() {
  const raw = await readStdin()
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return
  }

  const name = event.hook_event_name
  if (name === 'PreToolUse' && READ_ONLY.has(event.tool_name)) return

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

  let response
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-longleash-hook': endpoint.secret },
      body: raw,
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
