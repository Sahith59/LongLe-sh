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
import { detectSurface } from './surface.mjs'

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
 * The ONLY modes that stop and ask a human. Everything else — auto, bypassPermissions,
 * plan, and whatever gets added next — decides for itself.
 *
 * Listing what gates, rather than what does not, is deliberate. The first version listed
 * the non-gating modes and missed "auto" entirely, so a VS Code session that approves
 * everything itself paged a phone about every command it ran: questions whose answers
 * could not matter. Erring the other way is harmless by construction — a hook that stays
 * silent hands the decision to the terminal's own prompt, which is exactly where it would
 * have been without LongLeash.
 */
const GATING_MODES = new Set(['default', 'acceptEdits'])

/**
 * The person's own allow rules, from every settings file Claude Code reads.
 * A tool the terminal auto-runs must not interrogate the phone.
 */
function loadAllowRules(cwd) {
  const rules = []
  const candidates = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json'),
  ]
  if (cwd) {
    candidates.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'))
  }
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const allow = parsed?.permissions?.allow
      if (Array.isArray(allow)) rules.push(...allow.filter((r) => typeof r === 'string'))
    } catch {
      // missing or malformed settings never break the hook
    }
  }
  return rules
}

/**
 * Best-effort match of one allow rule. Understood: bare tool names ("Edit") and
 * Bash prefix/exact rules ("Bash(npm run test:*)", "Bash(git status)"). Rules
 * this cannot understand simply do not match — which errs toward asking the
 * phone, never toward silently skipping a question the terminal would raise.
 * A false match is also safe: the hook stays silent and the terminal's own
 * permission engine still evaluates the real rule itself.
 */
function ruleMatches(rule, tool, input) {
  const parsed = rule.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/)
  if (!parsed || parsed[1] !== tool) return false
  if (parsed[2] === undefined) return true
  if (tool === 'Bash') {
    const command = String(input?.command ?? '').trim()
    const spec = parsed[2]
    if (spec.endsWith(':*')) return command.startsWith(spec.slice(0, -2))
    return command === spec
  }
  return false
}

/**
 * The phone asks ONLY when the terminal itself would have asked. Claude Code
 * tells the hook which permission mode the session runs in, and the person's
 * own allowlist auto-runs what it names; mirroring both is what keeps
 * LongLeash an inbox of real decisions instead of a firehose of questions
 * the terminal never would have raised.
 */
function terminalWouldAsk(event) {
  const tool = event.tool_name
  // A QUESTION is not a permission. Claude Code shows its dialog in every permission
  // mode — bypass, acceptEdits, plan, all of them — because it is asking the human to
  // choose, not asking to be allowed. So it always travels to the phone; filtering it
  // by permission mode is what made auto-mode sessions ask their questions to an empty
  // room while the person waited on the other side of the world.
  if (tool === 'AskUserQuestion') return true
  if (READ_ONLY.has(tool)) return false
  // Absent means an older Claude Code that only had the gating behaviour.
  const mode = event.permission_mode ?? 'default'
  if (!GATING_MODES.has(mode)) return false
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(tool)) return false
  const rules = loadAllowRules(event.cwd)
  if (rules.some((rule) => ruleMatches(rule, tool, event.tool_input))) return false
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
    // Where this session lives — a terminal or an editor — so the phone can tell four
    // otherwise-identical sessions apart.
    body = JSON.stringify({
      ...event,
      ...(pid === null ? {} : { ll_pid: pid }),
      ll_surface: detectSurface(process.env),
    })
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
