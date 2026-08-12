import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeError, WorktreeManager } from '../src/worktrees.js'

const cleanups: string[] = []

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(path)
  return path
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function repository(): string {
  const root = temporary('longleash-repo-')
  git(root, 'init')
  git(root, 'config', 'user.email', 'tests@longleash.invalid')
  git(root, 'config', 'user.name', 'LongLeash tests')
  writeFileSync(join(root, 'README.md'), 'one\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'initial')
  return root
}

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('safe parallel Git worktrees', () => {
  it('creates a distinct checkout and branch without modifying the source checkout', () => {
    const source = repository()
    const managed = temporary('longleash-managed-')
    const prepared = new WorktreeManager(managed).prepare(source, 'ses_parallel')

    expect(prepared.cwd).not.toBe(source)
    expect(prepared.branch).toBe('longleash/ses_parallel')
    expect(git(prepared.cwd, 'branch', '--show-current')).toBe(prepared.branch)
    expect(git(source, 'branch', '--show-current')).not.toBe(prepared.branch)
    expect(new WorktreeManager(managed).owns(prepared.cwd)).toBe(true)
  })

  it('refuses to hide tracked edits behind an older HEAD snapshot', () => {
    const source = repository()
    writeFileSync(join(source, 'README.md'), 'changed but not committed\n')
    expect(() => new WorktreeManager(temporary('longleash-managed-')).prepare(source, 'ses_dirty'))
      .toThrowError(WorktreeError)
  })

  it('copies non-ignored untracked files into the isolated snapshot without committing them', () => {
    const source = repository()
    writeFileSync(join(source, 'new-file.ts'), 'export const ready = true\n')
    const prepared = new WorktreeManager(temporary('longleash-managed-')).prepare(source, 'ses_untracked')
    expect(existsSync(join(prepared.cwd, 'new-file.ts'))).toBe(true)
    expect(readFileSync(join(prepared.cwd, 'new-file.ts'), 'utf8')).toContain('ready = true')
    expect(git(prepared.cwd, 'status', '--porcelain')).toContain('?? new-file.ts')
  })

  it('explains that non-Git folders cannot be isolated safely', () => {
    const source = temporary('longleash-plain-')
    expect(() => new WorktreeManager(temporary('longleash-managed-')).prepare(source, 'ses_plain'))
      .toThrow(/require a Git project/i)
  })
})
