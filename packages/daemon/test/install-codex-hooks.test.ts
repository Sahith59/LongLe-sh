import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Codex installer edits a file the person owns and did not ask us to reformat.
 * These tests hold it to that: everything outside our marked block survives
 * byte-for-byte, and --remove puts the file back exactly as it was found.
 */

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(here, '../hooks/install-codex-hooks.mjs')

let home: string
const CONFIG = () => join(home, 'config.toml')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'll-codexcfg-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Runs the installer with a fake `codex` on PATH reporting the given version. */
function install(args: string[] = [], version = '0.147.0'): { code: number; out: string } {
  const binDir = mkdtempSync(join(tmpdir(), 'll-fakebin-'))
  writeFileSync(join(binDir, 'codex'), `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 })
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    })
    return { code: 0, out }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  } finally {
    rmSync(binDir, { recursive: true, force: true })
  }
}

const read = () => readFileSync(CONFIG(), 'utf8')
const backups = () => readdirSync(home).filter((f) => f.includes('.bak-'))

describe('the Codex installer — it must not damage a file it was only asked to add to', () => {
  it('creates a config when none exists', () => {
    expect(install().code).toBe(0)
    const text = read()
    expect(text).toContain('[hooks]')
    expect(text).toContain('PermissionRequest')
    expect(text).toContain('longleash-codex-hook.mjs')
  })

  it('preserves unrelated settings, comments and formatting exactly', () => {
    const original = [
      '# my own notes, kept',
      'model = "gpt-5.6"',
      '',
      '[tui]',
      'theme  =  "dark"   # spacing on purpose',
      '',
    ].join('\n')
    writeFileSync(CONFIG(), original)
    expect(install().code).toBe(0)
    const text = read()
    for (const line of ['# my own notes, kept', 'model = "gpt-5.6"', '[tui]', 'theme  =  "dark"   # spacing on purpose']) {
      expect(text).toContain(line)
    }
  })

  it('is idempotent — installing twice leaves one block, not two', () => {
    install()
    const once = read()
    install()
    const twice = read()
    expect(twice).toBe(once)
    // Count key DEFINITIONS, not the word — our own explanatory comment mentions it too.
    expect(twice.match(/^PermissionRequest = /gm)).toHaveLength(1)
    expect(twice.match(/^# >>> LongLeash/gm)).toHaveLength(1)
  })

  it('--remove restores the original file byte-for-byte', () => {
    const original = 'model = "gpt-5.6"\n\n[tui]\ntheme = "dark"\n'
    writeFileSync(CONFIG(), original)
    install()
    expect(read()).not.toBe(original)
    expect(install(['--remove']).code).toBe(0)
    expect(read()).toBe(original)
  })

  it('--remove on a never-installed config changes nothing', () => {
    const original = 'model = "gpt-5.6"\n'
    writeFileSync(CONFIG(), original)
    expect(install(['--remove']).code).toBe(0)
    expect(read()).toBe(original)
  })

  it('backs the file up before touching it', () => {
    writeFileSync(CONFIG(), 'model = "gpt-5.6"\n')
    install()
    expect(backups().length).toBeGreaterThan(0)
    expect(readFileSync(join(home, backups()[0]!), 'utf8')).toBe('model = "gpt-5.6"\n')
  })

  it('adds to an existing [hooks] table rather than declaring a second one', () => {
    writeFileSync(CONFIG(), '[hooks]\nPostToolUse = [{ hooks = [{ type = "command", command = "mine" }] }]\n')
    expect(install().code).toBe(0)
    const text = read()
    // Two [hooks] headers would be a TOML error and would break every Codex run.
    expect(text.match(/^\[hooks\]$/gm)).toHaveLength(1)
    expect(text).toContain('command = "mine"')
    expect(text).toContain('PermissionRequest')
  })
})

describe('the Codex installer — it refuses rather than half-working', () => {
  it('refuses a Codex too old to run hooks, and changes nothing', () => {
    writeFileSync(CONFIG(), 'model = "gpt-5.6"\n')
    const { code, out } = install([], '0.136.0')
    expect(code).toBe(1)
    expect(out).toMatch(/do not fire|0\.147\.0/)
    expect(read()).toBe('model = "gpt-5.6"\n') // untouched
  })

  it('accepts a Codex newer than the floor', () => {
    expect(install([], '0.200.1').code).toBe(0)
  })

  it('refuses config shapes it cannot edit safely, and says what to add by hand', () => {
    writeFileSync(CONFIG(), '[hooks.PermissionRequest]\ntype = "command"\ncommand = "mine"\n')
    const { code, out } = install()
    expect(code).toBe(1)
    expect(out).toContain('by hand')
    expect(read()).toContain('command = "mine"') // untouched
  })

  it('--remove works even when Codex is absent from PATH entirely', () => {
    writeFileSync(CONFIG(), 'model = "x"\n')
    install()
    const out = execFileSync(process.execPath, [SCRIPT, '--remove'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: home, PATH: '/nonexistent' },
    })
    expect(out).toContain('removed')
    expect(read()).toBe('model = "x"\n')
  })

  it('never suggests the flag that disables Codex hook review', () => {
    const { out } = install()
    expect(out).not.toContain('dangerously-bypass-hook-trust')
    // It must still warn the person that a review prompt is coming.
    expect(out).toMatch(/review/i)
  })
})

/**
 * The generated TOML is checked against Codex's OWN parser, not our belief about
 * TOML. `codex mcp list` loads and validates config without making an API call;
 * `codex doctor` does not validate hooks at all and must never be used for this.
 */
const codexOnPath = (() => {
  try {
    execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!codexOnPath)('the generated config, judged by Codex itself', () => {
  const validate = (): string => {
    try {
      execFileSync('codex', ['mcp', 'list'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return ''
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      const text = `${e.stdout ?? ''}${e.stderr ?? ''}`
      return /error loading config|invalid type|missing field|unknown variant|expected/i.test(text) ? text : ''
    }
  }

  it('a fresh install parses', () => {
    install()
    expect(validate()).toBe('')
  })

  it('an install beside existing settings parses', () => {
    writeFileSync(CONFIG(), 'model = "gpt-5.6"\n\n[tui]\ntheme = "dark"\n')
    install()
    expect(validate()).toBe('')
  })

  it('an install into an existing [hooks] table parses', () => {
    writeFileSync(CONFIG(), '[hooks]\nPostToolUse = [{ hooks = [{ type = "command", command = "mine" }] }]\n')
    install()
    expect(validate()).toBe('')
  })

  it('control: a deliberately broken config IS rejected, so the check above means something', () => {
    writeFileSync(CONFIG(), 'hooks = "./hooks.json"\n')
    expect(validate()).not.toBe('')
  })
})
