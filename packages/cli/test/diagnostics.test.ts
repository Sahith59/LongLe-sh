import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareBuilds, inspectHooks, readBuild } from '../src/diagnostics.js'

describe('release diagnostics', () => {
  it('never treats absent build evidence as a match', () => {
    expect(compareBuilds(null, null)).toBe('unknown')
    expect(compareBuilds('new', 'old')).toBe('mismatch')
    expect(compareBuilds('new', 'new')).toBe('match')
    expect(readBuild('/nonexistent/longleash-build.json')).toBeNull()
  })

  it('requires every lifecycle event and rejects disabled, stale and comment-only hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-diagnostics-'))
    try {
      mkdirSync(join(root, '.claude'))
      const config = join(root, '.claude', 'settings.json')
      const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
      const command = `${quote(process.execPath)} ${quote(join(root, 'longleash-hook.mjs'))}`
      const hooks = Object.fromEntries(['SessionStart', 'SessionEnd', 'PreToolUse', 'PermissionRequest'].map(event => [event, [{ hooks: [{ command }] }]]))
      writeFileSync(config, JSON.stringify({ hooks }))
      expect(inspectHooks(root, root, root).claude).toBe(true)
      writeFileSync(config, JSON.stringify({ hooks, disableAllHooks: true }))
      expect(inspectHooks(root, root, root).claude).toBe(false)
      delete hooks.SessionStart
      writeFileSync(config, JSON.stringify({ hooks }))
      expect(inspectHooks(root, root, root).claude).toBe(false)
      writeFileSync(join(root, 'config.toml'), `# ${join(root, 'longleash-codex-hook.mjs')}`)
      expect(inspectHooks(root, root, root).codex).toBe(false)
      expect(inspectHooks(root, root, join(root, 'new-build')).claude).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
