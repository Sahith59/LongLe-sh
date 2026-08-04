#!/usr/bin/env node
/**
 * Installs the LongLeash hook into ~/.claude/settings.json — with a backup, idempotently,
 * and without touching anything else in the file.
 *
 *   node hooks/install-hooks.mjs            install (or verify already installed)
 *   node hooks/install-hooks.mjs --remove   uninstall cleanly
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOOK_COMMAND = `node ${resolve(here, 'longleash-hook.mjs')}`
const SETTINGS = join(homedir(), '.claude', 'settings.json')
// PreToolUse may hold the terminal while a phone answers; the others must be instant.
const EVENTS = [
  { name: 'SessionStart', timeout: 5 },
  { name: 'PreToolUse', timeout: 180 },
  { name: 'SessionEnd', timeout: 5 },
]

const removing = process.argv.includes('--remove')

let settings = {}
if (existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))
  } catch {
    console.error(`Refusing to touch ${SETTINGS}: it is not valid JSON. Fix it first.`)
    process.exit(1)
  }
  const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(SETTINGS, backup)
  console.log(`Backed up settings to ${backup}`)
} else {
  mkdirSync(dirname(SETTINGS), { recursive: true })
}

settings.hooks ??= {}
const ours = (entry) => entry?.hooks?.some((h) => String(h.command ?? '').includes('longleash-hook'))

for (const { name, timeout } of EVENTS) {
  const list = Array.isArray(settings.hooks[name]) ? settings.hooks[name] : []
  const kept = list.filter((entry) => !ours(entry))
  if (!removing) {
    kept.push({ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout }] })
  }
  if (kept.length > 0) settings.hooks[name] = kept
  else delete settings.hooks[name]
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks

writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')

if (removing) {
  console.log('LongLeash hooks removed. Terminal sessions are invisible to the phone again.')
} else {
  console.log('LongLeash hooks installed for SessionStart, PreToolUse, SessionEnd.')
  console.log('New `claude` sessions in a terminal will now appear on your phone,')
  console.log('and risky tools will wait up to two minutes for your answer there.')
  console.log('If no phone responds, the terminal prompt takes over exactly as before.')
  console.log('\nAlready-running claude sessions pick this up on their next restart.')
}
