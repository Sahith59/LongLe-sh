import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FolderIndex } from '../src/folders.js'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-fuzzy-')))
  mkdirSync(join(root, 'Downloads'), { recursive: true })
  mkdirSync(join(root, 'Desktop', 'RESUMES_diff_roles'), { recursive: true })
  mkdirSync(join(root, 'Desktop', 'FD_Engineer'), { recursive: true })
  mkdirSync(join(root, 'projectx'), { recursive: true })
  writeFileSync(join(root, 'Downloads', 'Sahith_resume.pdf'), 'x')
  writeFileSync(join(root, 'Downloads', 'test.txt'), 'x')
  writeFileSync(join(root, 'Downloads', 'photo.png'), 'x')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const index = () => new FolderIndex([root])

describe('forgiving matching (typos and partial memory)', () => {
  it('finds a folder despite a transposed letter', () => {
    expect(index().search('FD_Enginer')[0]?.label).toContain('FD_Engineer')
  })

  it('finds a folder despite a missing letter', () => {
    expect(index().search('projctx')[0]?.label).toContain('projectx')
  })

  it('matches initials scattered through the name', () => {
    expect(index().search('RESUMES')[0]?.label).toContain('RESUMES_diff_roles')
  })

  it('still refuses to guess when nothing is close', () => {
    expect(index().search('qqqzzzyyy')).toHaveLength(0)
  })
})

describe('finding files, not just folders', () => {
  it('finds a file by name and reports where it lives', () => {
    const hit = index().search('Sahith_resume').find((h) => h.kind === 'file')
    expect(hit?.label).toContain('Sahith_resume.pdf')
    expect(hit?.parent).toContain('Downloads')
  })

  it('finds a file despite a typo', () => {
    const hit = index().search('Sahith_resmue').find((h) => h.kind === 'file')
    expect(hit?.label).toContain('Sahith_resume.pdf')
  })

  it('understands "test in downloads"', () => {
    const hit = index().search('test in downloads')[0]
    expect(hit?.label).toContain('test.txt')
  })

  it('marks folders and files distinctly so the app can show which is which', () => {
    const hits = index().search('Downloads')
    expect(hits.some((h) => h.kind === 'folder')).toBe(true)
  })

  it('does not drown the list in files when a folder matches better', () => {
    const hits = index().search('FD_Engineer')
    expect(hits[0]?.kind).toBe('folder')
  })
})
