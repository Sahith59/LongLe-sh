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
const EVENTS = {
  SessionStart: [{ matcher: '*', command: HOOK_COMMAND, timeout: 5 }],
  // PermissionRequest means Claude Code itself was about to render a permission dialog.
  PermissionRequest: [{ matcher: '*', command: HOOK_COMMAND, timeout: 180 }],
  PreToolUse: [
    // AskUserQuestion is not a permission, so PermissionRequest never sees it.
    { matcher: 'AskUserQuestion', command: HOOK_COMMAND, timeout: 180 },
    // An observer makes already-running/auto-mode VS Code sessions discoverable without
    // ever returning a decision or holding up the tool call.
    { matcher: '*', command: `${HOOK_COMMAND} --observe`, timeout: 5, async: true },
  ],
  SessionEnd: [{ matcher: '*', command: HOOK_COMMAND, timeout: 5 }],
}

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

for (const [name, configs] of Object.entries(EVENTS)) {
  const list = Array.isArray(settings.hooks[name]) ? settings.hooks[name] : []
  const kept = list.filter((entry) => !ours(entry))
  if (!removing) {
    for (const config of configs) {
      const { matcher, command, timeout, async } = config
      kept.push({
        matcher,
        hooks: [{ type: 'command', command, timeout, ...(async === true ? { async: true } : {}) }],
      })
    }
  }
  if (kept.length > 0) settings.hooks[name] = kept
  else delete settings.hooks[name]
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks

writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')

if (removing) {
  console.log('LongLeash hooks removed. Terminal sessions are invisible to the phone again.')
} else {
  console.log('LongLeash hooks installed for lifecycle, permissions, and questions.')
  console.log('Terminal and VS Code sessions appear on your phone, including sessions')
  console.log('that were already running when LongLeash started.')
  console.log('At a laptop prompt, press L to return immediately to the native prompt.')
}
