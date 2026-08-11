#!/usr/bin/env node
/**
 * LongLeash's Claude Code hook.
 *
 * PermissionRequest is the source of truth for real permission prompts. PreToolUse is
 * only synchronous for AskUserQuestion (which needs input rather than permission), and
 * is also installed as an async observer so an already-running VS Code session becomes
 * visible without stealing control from it.
 *
 * The iron rule is graceful degradation: if LongLeash is absent, slow, or unreachable,
 * this exits 0 without a decision and Claude Code's native prompt takes over.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectSurface } from './surface.mjs'
import { findAgentPid } from './agent-pid.mjs'
import { laptopHandoff } from './local-handoff.mjs'

async function main() {
  // A Codex/Claude process launched and owned by LongLeash already has a structured
  // adapter. Letting its user hooks report it again creates a duplicate ghost session.
  if (process.env.LONGLEASH_MANAGED === '1') return

  const raw = await readStdin()
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return
  }

  const observe = process.argv.includes('--observe')
  const name = event.hook_event_name
  if (observe && name !== 'PreToolUse') return
  const askingQuestion = name === 'PreToolUse' && event.tool_name === 'AskUserQuestion'
  const askingPermission = name === 'PermissionRequest'
  if (!observe && !askingQuestion && !askingPermission && name !== 'SessionStart' && name !== 'SessionEnd') {
    return
  }

  let endpoint
  try {
    const dataDir = process.env.LONGLEASH_DATA ?? join(homedir(), '.longleash')
    endpoint = JSON.parse(readFileSync(join(dataDir, 'hook-endpoint.json'), 'utf8'))
  } catch {
    return
  }
  if (!endpoint?.url || !endpoint?.secret) return

  const surface = detectSurface(process.env)
  const pid = findAgentPid(/\bclaude\b/)
  const body = JSON.stringify({
    ...event,
    hook_event_name: observe ? 'SessionObserved' : name,
    ll_agent: 'claude',
    ll_surface: surface,
    ...(pid === null ? {} : { ll_pid: pid }),
  })
  const asking = !observe && (askingPermission || askingQuestion)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), asking ? 150_000 : 3_000)
  timer.unref?.()
  const handoff = asking ? laptopHandoff(surface) : { promise: new Promise(() => {}), close() {} }

  let outcome
  try {
    outcome = await Promise.race([
      fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-longleash-hook': endpoint.secret },
        body,
        signal: controller.signal,
      }).then((response) => ({ kind: 'response', response })),
      handoff.promise.then(() => ({ kind: 'laptop' })),
    ])
  } catch {
    return
  } finally {
    clearTimeout(timer)
    handoff.close()
  }

  if (outcome.kind === 'laptop') {
    controller.abort()
    return // no opinion: Claude Code renders its native prompt immediately
  }
  const response = outcome.response
  if (!response.ok || !asking) return

  let verdict
  try {
    verdict = await response.json()
  } catch {
    return
  }
  if (verdict.decision !== 'allow' && verdict.decision !== 'deny') return

  if (askingPermission) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: verdict.decision,
            ...(verdict.decision === 'deny'
              ? { message: String(verdict.reason ?? 'Denied from your phone') }
              : {}),
          },
        },
      }),
    )
    return
  }

  const answers = verdict.answers
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision,
        permissionDecisionReason: String(verdict.reason ?? 'Answered from your phone'),
        ...(verdict.decision === 'allow' && answers && typeof answers === 'object'
          ? { updatedInput: { ...(event.tool_input ?? {}), answers } }
          : {}),
        ...(verdict.decision === 'allow' && typeof verdict.additionalContext === 'string'
          ? { additionalContext: verdict.additionalContext }
          : {}),
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
