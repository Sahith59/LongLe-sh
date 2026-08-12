import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class WorktreeError extends Error {
  constructor(
    readonly reason: 'not-git' | 'dirty-checkout' | 'create-failed',
    message: string,
  ) {
    super(message)
    this.name = 'WorktreeError'
  }
}

export interface PreparedWorktree {
  cwd: string
  sourceCwd: string
  projectRoot: string
  branch: string
}

type GitRunner = (args: string[]) => string

/**
 * Creates a real Git worktree for a second writer instead of weakening checkout ownership.
 * Worktrees are intentionally retained: deleting one when a session ends could delete the
 * exact uncommitted changes the agent was asked to produce.
 */
export class WorktreeManager {
  private readonly root: string
  private readonly git: GitRunner

  constructor(root: string, opts: { git?: GitRunner } = {}) {
    const resolvedRoot = resolve(root)
    mkdirSync(resolvedRoot, { recursive: true })
    this.root = realpathSync(resolvedRoot)
    this.git = opts.git ?? ((args) => execFileSync('git', args, { encoding: 'utf8' }))
  }

  prepare(source: string, sessionId: string): PreparedWorktree {
    const sourceCwd = realpathSync(source)
    let projectRoot: string
    try {
      projectRoot = realpathSync(this.git(['-C', sourceCwd, 'rev-parse', '--show-toplevel']).trim())
    } catch {
      throw new WorktreeError(
        'not-git',
        'Safe parallel sessions require a Git project. Use the existing session, or initialize Git for this folder.',
      )
    }

    // A worktree starts from HEAD. Refuse tracked edits rather than starting an agent against
    // an older snapshot while the phone misleadingly shows the same project name.
    try {
      const trackedChanges = this.git([
        '-C', projectRoot, 'status', '--porcelain', '--untracked-files=no',
      ])
      if (trackedChanges.trim() !== '') {
        throw new WorktreeError(
          'dirty-checkout',
          'This project has uncommitted tracked changes. Commit or stash them before starting a safe parallel session.',
        )
      }
    } catch (error) {
      if (error instanceof WorktreeError) throw error
      throw new WorktreeError('create-failed', 'Git could not inspect this project before creating an isolated checkout.')
    }

    const repositoryKey = createHash('sha256').update(projectRoot).digest('hex').slice(0, 10)
    const projectName = basename(projectRoot).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'project'
    const leaf = sessionId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48)
    const worktreeRoot = join(this.root, `${projectName}-${repositoryKey}`, leaf)
    const branch = `longleash/${leaf}`
    mkdirSync(join(this.root, `${projectName}-${repositoryKey}`), { recursive: true })
    try {
      this.git(['-C', projectRoot, 'worktree', 'add', '-b', branch, worktreeRoot, 'HEAD'])
      // Git worktrees contain tracked HEAD content only. Copy non-ignored untracked files so
      // “same project” does not secretly mean “missing the new file you just created”. They
      // remain untracked in the isolated checkout and are never committed automatically.
      const untracked = this.git([
        '-C', projectRoot, 'ls-files', '--others', '--exclude-standard', '-z',
      ]).split('\0').filter((path) => path !== '')
      for (const path of untracked) {
        if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
          throw new Error('Git returned an unsafe untracked path')
        }
        const destination = resolve(worktreeRoot, path)
        if (!destination.startsWith(`${resolve(worktreeRoot)}${sep}`)) {
          throw new Error('Untracked path escaped the worktree')
        }
        mkdirSync(dirname(destination), { recursive: true })
        cpSync(join(projectRoot, path), destination, { recursive: true, dereference: false })
      }
    } catch {
      throw new WorktreeError(
        'create-failed',
        'Git could not fully prepare the isolated checkout. Run `git worktree list` on the laptop to inspect preserved worktrees.',
      )
    }

    const insideProject = relative(projectRoot, sourceCwd)
    return {
      cwd: insideProject === '' ? worktreeRoot : join(worktreeRoot, insideProject),
      sourceCwd,
      projectRoot,
      branch,
    }
  }

  owns(path: string): boolean {
    const candidate = resolve(path)
    return candidate === this.root || candidate.startsWith(`${this.root}${sep}`)
  }
}
