import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readBuild(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')).build
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch { return null }
}

export function compareBuilds(expected: string | null, actual: string | null): 'match' | 'mismatch' | 'unknown' {
  return !expected || !actual ? 'unknown' : expected === actual ? 'match' : 'mismatch'
}

export function daemonIsReady(expectedBuild: string | null, health: { name?: unknown; build?: unknown }): boolean {
  return health.name === 'longleash' && expectedBuild !== null && health.build === expectedBuild
}

/** Configuration evidence only: provider trust and already-running processes need a live check. */
export function inspectHooks(home: string, codexHome: string, hooks: string) {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
  const events = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PermissionRequest']
  let claude = false
  let codex = false
  try {
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
    const command = `${quote(process.execPath)} ${quote(join(hooks, 'longleash-hook.mjs'))}`
    claude = settings.disableAllHooks !== true && events.every((event) =>
      Array.isArray(settings.hooks?.[event]) && settings.hooks[event].some((entry: { hooks?: { command?: string }[] }) =>
        Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook.command === command || hook.command === `${command} --observe`)))
  } catch { /* missing or invalid config is not proof of installed hooks */ }
  try {
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
    const command = `${quote(process.execPath)} ${quote(join(hooks, 'longleash-codex-hook.mjs'))}`
    // Inspect the installer's exact managed entries, not comments mentioning an old path.
    const block = config.split('# >>> LongLeash — managed block, edits between these markers are overwritten')[1]
      ?.split('# <<< LongLeash')[0] ?? ''
    codex = events.every((event) => block.split('\n').some((line) =>
      line.startsWith(`${event} = `) && line.includes(`command = ${JSON.stringify(event === 'PreToolUse' ? `${command} --observe` : command)}`)))
  } catch { /* retain false */ }
  return { claude, codex }
}
