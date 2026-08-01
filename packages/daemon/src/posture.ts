import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PermissionPosture {
  /** Rules in the user's own Claude Code settings that pre-approve tools. */
  allowRuleCount: number
  examples: string[]
  /** True when some actions can run without ever reaching the phone. */
  gateWeakened: boolean
}

/**
 * Allow-rules in a user's own Claude Code settings shadow our approval callback: matching
 * commands execute without ever reaching the phone. We cannot override that, so we refuse to
 * quietly promise total coverage — the daemon reports the posture at startup, and such actions
 * still appear in the activity feed so nothing runs invisibly.
 */
export function readPermissionPosture(settingsPath = join(homedir(), '.claude', 'settings.json')): PermissionPosture {
  if (!existsSync(settingsPath)) return { allowRuleCount: 0, examples: [], gateWeakened: false }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions?: { allow?: unknown }
    }
    const allow = parsed.permissions?.allow
    const rules = Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : []
    return {
      allowRuleCount: rules.length,
      examples: rules.slice(0, 3).map((rule) => rule.slice(0, 60)),
      gateWeakened: rules.length > 0,
    }
  } catch {
    // Unreadable settings are not an error worth failing startup over.
    return { allowRuleCount: 0, examples: [], gateWeakened: false }
  }
}
