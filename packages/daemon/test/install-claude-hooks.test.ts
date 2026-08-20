import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = resolve(here, '../hooks/install-hooks.mjs')
let home: string

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'll-claude-hooks-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

function install(): Record<string, unknown> {
  execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home } })
  return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>
}

describe('the Claude hook installer', () => {
  it('uses PermissionRequest for permissions and only syncs questions on PreToolUse', () => {
    const settings = install() as { hooks: Record<string, { matcher: string; hooks: Record<string, unknown>[] }[]> }
    expect(settings.hooks.PermissionRequest).toHaveLength(1)
    const pre = settings.hooks.PreToolUse
    expect(pre.some((entry) => entry.matcher === 'AskUserQuestion' && entry.hooks[0]?.async !== true)).toBe(true)
    expect(pre.some((entry) => entry.matcher === '*' && entry.hooks[0]?.async === true)).toBe(true)
  })

  it('installs lifecycle hooks including SessionEnd and remains idempotent', () => {
    install()
    const twice = install() as { hooks: Record<string, unknown[]> }
    expect(twice.hooks.SessionStart).toHaveLength(1)
    expect(twice.hooks.SessionEnd).toHaveLength(1)
    expect(twice.hooks.PermissionRequest).toHaveLength(1)
    expect(twice.hooks.PreToolUse).toHaveLength(2)
  })

  it('quotes the runtime path so managed installs work when the home path contains spaces', () => {
    const runtime = join(home, 'managed runtime', 'hooks')
    cpSync(resolve(here, '../hooks'), runtime, { recursive: true })
    execFileSync(process.execPath, [join(runtime, 'install-hooks.mjs')], { env: { ...process.env, HOME: home } })
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] }
    }
    const command = settings.hooks.SessionStart[0]?.hooks[0]?.command
    expect(command).toContain('managed runtime/hooks/longleash-hook.mjs')
    expect(spawnSync('/bin/sh', ['-c', command], { input: '{}', env: { ...process.env, HOME: home } }).status).toBe(0)
  })
})
