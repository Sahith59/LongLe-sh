import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAllowedRootAnswer } from '../src/setup-input.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'longleash-setup-input-'))
}

describe('interactive allowed-root input', () => {
  it('accepts an empty answer as the displayed default', () => {
    const root = tempDir()
    expect(resolveAllowedRootAnswer('', root)).toEqual({ ok: true, root: realpathSync(root) })
  })

  it.each(['y', 'Y', 'yes', 'NO'])('does not reinterpret %s as a relative path', (answer) => {
    const root = tempDir()
    const result = resolveAllowedRootAnswer(answer, root)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('Press Enter')
  })

  it('accepts an existing directory and canonicalizes it', () => {
    const root = tempDir()
    const project = join(root, 'project')
    mkdirSync(project)
    expect(resolveAllowedRootAnswer(project, root)).toEqual({ ok: true, root: realpathSync(project) })
  })

  it('rejects a missing directory with an actionable message', () => {
    const root = tempDir()
    const result = resolveAllowedRootAnswer(join(root, 'missing'), root)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('That folder cannot be used')
  })

  it('rejects a file instead of accepting it as a project folder', () => {
    const root = tempDir()
    const file = join(root, 'file.txt')
    writeFileSync(file, 'not a directory')
    const result = resolveAllowedRootAnswer(file, root)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('not a directory')
  })
})
