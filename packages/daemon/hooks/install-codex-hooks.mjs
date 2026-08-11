#!/usr/bin/env node
/**
 * Installs the LongLeash hook into Codex CLI's ~/.codex/config.toml.
 *
 *   node hooks/install-codex-hooks.mjs            install (or verify already installed)
 *   node hooks/install-codex-hooks.mjs --remove   uninstall cleanly
 *
 * Three things make this different from the Claude installer, and each one is a
 * decision rather than an accident:
 *
 *  1. **It is a surgical text edit, not a parse-and-rewrite.** This is the person's
 *     real config, with their comments and their formatting. A round-trip through a
 *     TOML serialiser would silently reformat a file we were only asked to add two
 *     lines to. Our lines live between markers so removal is exact.
 *
 *  2. **It refuses on old Codex versions.** Codex hooks do not fire below the known
 *     working version — the config parses and then does nothing, with no warning.
 *     A hook that is "installed" and silently inert is worse than one that was never
 *     installed, because the person concludes LongLeash is broken.
 *
 *  3. **It explains Codex's hook-trust prompt instead of evading it.** Codex will ask
 *     the person to review the new hook on next start. There is a flag to bypass that;
 *     we will not use it and will not tell anyone else to.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOOK_COMMAND = `node ${resolve(here, 'longleash-codex-hook.mjs')}`
const CONFIG = process.env.CODEX_HOME
  ? join(process.env.CODEX_HOME, 'config.toml')
  : join(homedir(), '.codex', 'config.toml')

const BEGIN = '# >>> LongLeash — managed block, edits between these markers are overwritten'
const END = '# <<< LongLeash'

/**
 * The oldest Codex known to actually run hooks. 0.147.0 was verified working and
 * 0.136.0 verified silently inert; the boundary between them has not been bisected,
 * so this sits at the proven-good end. Refusing a version that might have worked
 * costs someone one upgrade; accepting one that does not costs them their trust.
 */
const MIN_CODEX = [0, 147, 0]

const removing = process.argv.includes('--remove')

function codexVersion() {
  let out
  try {
    out = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return null // not installed, or not on PATH
  }
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const isOlder = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]
const show = (v) => v.join('.')

/** Remove a previously installed block, wherever it sits, leaving the rest untouched. */
function stripOurBlock(text) {
  const begin = text.indexOf(BEGIN)
  if (begin === -1) return text
  const end = text.indexOf(END, begin)
  if (end === -1) return text
  // Codex records hook-review state in a [hooks.state] table. Current Codex may insert
  // that table before our closing comment. It belongs to Codex/the user, not to us, so
  // an update or uninstall must never erase it with our managed lines.
  const inside = text.slice(begin + BEGIN.length, end)
  const stateAt = inside.search(/^\[hooks\.state\][ \t]*$/m)
  const state = stateAt === -1 ? '' : inside.slice(stateAt).trim()
  const after = end + END.length
  const trailingNewline = text[after] === '\n' ? 1 : 0
  const stripped = text.slice(0, begin) + text.slice(after + trailingNewline)
  if (state === '' || /^\[hooks\.state\][ \t]*$/m.test(stripped)) return stripped
  const base = stripped.replace(/\s*$/, '')
  return `${base}${base === '' ? '' : '\n\n'}${state}\n`
}

/**
 * `withHeader` when we are the ones creating the `[hooks]` table. It has to live
 * INSIDE the markers, or --remove strips our keys and leaves an orphan header behind —
 * a file that no longer matches the one we were handed.
 */
function ourBlock(withHeader) {
  return [
    BEGIN,
    ...(withHeader ? ['[hooks]'] : []),
    '# SessionStart tells LongLeash a Codex session exists.',
    '# PermissionRequest is the decision itself — Codex fires it only when it has',
    '# already decided it needs a human, so LongLeash never has to guess.',
    'SessionStart = [{ hooks = [{ type = "command", command = ' + JSON.stringify(HOOK_COMMAND) + ', timeoutSec = 5 }] }]',
    'SessionEnd = [{ hooks = [{ type = "command", command = ' + JSON.stringify(HOOK_COMMAND) + ', timeoutSec = 5 }] }]',
    '# PreToolUse only observes activity, so already-running VS Code sessions are visible.',
    'PreToolUse = [{ hooks = [{ type = "command", command = ' + JSON.stringify(`${HOOK_COMMAND} --observe`) + ', timeoutSec = 5 }] }]',
    'PermissionRequest = [{ hooks = [{ type = "command", command = ' + JSON.stringify(HOOK_COMMAND) + ', timeoutSec = 180 }] }]',
    END,
  ].join('\n')
}

if (!removing) {
  const version = codexVersion()
  if (version === null) {
    console.error('Codex CLI was not found on PATH. Install it first, then run this again.')
    console.error('Nothing was changed.')
    process.exit(1)
  }
  if (isOlder(version, MIN_CODEX)) {
    console.error(`Codex ${show(version)} is installed, but its hooks do not fire.`)
    console.error(`LongLeash needs Codex ${show(MIN_CODEX)} or newer to see Codex sessions.`)
    console.error('')
    console.error('This is not a guess: on older builds the configuration is accepted and then')
    console.error('silently ignored, which would leave LongLeash looking installed and broken.')
    console.error('')
    console.error('  Update with:  codex update')
    console.error('')
    console.error('Nothing was changed. Claude Code sessions are unaffected.')
    process.exit(1)
  }
}

let text = ''
if (existsSync(CONFIG)) {
  text = readFileSync(CONFIG, 'utf8')
  const backup = `${CONFIG}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(CONFIG, backup)
  console.log(`Backed up ${CONFIG} to ${backup}`)
} else {
  mkdirSync(dirname(CONFIG), { recursive: true })
}

const withoutOurs = stripOurBlock(text)

if (removing) {
  // Our block was appended after a blank line, so removing it leaves that blank behind.
  // Normalise to exactly one trailing newline — the shape the file had before we touched
  // it. "Uninstall" has to mean the file is genuinely as it was found.
  const restored = withoutOurs.replace(/\s*$/, '')
  writeFileSync(CONFIG, restored === '' ? '' : `${restored}\n`)
  console.log('LongLeash hooks removed from Codex. Codex sessions are invisible to the phone again.')
  process.exit(0)
}

// TOML forbids declaring the same table twice, so where our keys go depends on whether
// the person already has a [hooks] table of their own.
const hasHooksHeader = /^[ \t]*\[hooks\][ \t]*$/m.test(withoutOurs)
const hasHooksSubtable = [...withoutOurs.matchAll(/^[ \t]*\[hooks\.([^\]]+)\][ \t]*$/gm)]
  // Codex owns both the parent table and one quoted child table per reviewed hook.
  // They can be moved out of our managed block during an update, but they are review
  // receipts rather than competing hook definitions and must not make the update refuse.
  .some((match) => match[1] !== 'state' && !match[1]?.startsWith('state.'))
const hasDottedHooks = /^[ \t]*hooks\.[A-Za-z]/m.test(withoutOurs)

if (hasHooksSubtable || hasDottedHooks) {
  console.error(`${CONFIG} already defines Codex hooks in a form this installer will not edit safely.`)
  console.error('Rather than risk corrupting your config, add these two lines to your [hooks] table')
  console.error('by hand:')
  console.error('')
  for (const line of ourBlock().split('\n')) {
    if (!line.startsWith('#')) console.error(`  ${line}`)
  }
  console.error('')
  console.error('Nothing was changed.')
  process.exit(1)
}

let next
if (hasHooksHeader) {
  // Insert our keys directly beneath their existing [hooks] header, which stays theirs.
  next = withoutOurs.replace(/^([ \t]*\[hooks\][ \t]*)$/m, `$1\n${ourBlock(false)}`)
} else {
  const body = withoutOurs.replace(/\s*$/, '')
  next = `${body}${body === '' ? '' : '\n\n'}${ourBlock(true)}\n`
}

writeFileSync(CONFIG, next.endsWith('\n') ? next : `${next}\n`)

console.log('LongLeash hooks installed for Codex lifecycle, discovery, and permissions.')
console.log('Terminal and VS Code sessions appear on your phone, including already-running sessions.')
console.log('At a laptop prompt, press L to return immediately to Codex\'s native prompt.')
console.log('')
console.log('Two things Codex will ask you, both expected:')
console.log('  1. "Hooks need review" — say yes, or the hook will not run.')
console.log('  2. "Do you trust the contents of this directory?" — hooks only load in trusted folders.')
console.log('')
console.log('Already-running codex sessions pick this up on their next restart.')
