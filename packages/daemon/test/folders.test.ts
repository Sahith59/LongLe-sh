import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FolderIndex } from '../src/folders.js'

let root: string
let other: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-folders-')))
  other = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-downloads-')))
  mkdirSync(join(root, 'FD_Engineer', 'src'), { recursive: true })
  mkdirSync(join(root, 'fd-notes'), { recursive: true })
  mkdirSync(join(root, 'photos', 'holiday'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'lodash'), { recursive: true })
  mkdirSync(join(root, '.hidden'), { recursive: true })
  mkdirSync(join(other, 'test'), { recursive: true })
  writeFileSync(join(root, 'notes.txt'), 'a file, not a folder')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

const index = () => new FolderIndex([root, other])

describe('finding a folder by name', () => {
  it('finds a folder from a partial name, so an exact path is never needed', () => {
    const hits = index().search('FD_Eng')
    expect(hits[0]?.path).toBe(join(root, 'FD_Engineer'))
  })

  it('ignores case', () => {
    expect(index().search('fd_engineer')[0]?.path).toBe(join(root, 'FD_Engineer'))
  })

  it('understands a plain-English phrase like "FD_Engineer folder in desktop"', () => {
    const desktopish = index().search(`FD_Engineer folder in ${basename(root)}`)
    expect(desktopish[0]?.path).toBe(join(root, 'FD_Engineer'))
  })

  it('uses the location words to disambiguate between roots', () => {
    const hits = index().search(`test in ${basename(other)}`)
    expect(hits[0]?.path).toBe(join(other, 'test'))
  })

  it('prefers a whole-name match over a substring match', () => {
    const hits = index().search('fd-notes')
    expect(hits[0]?.path).toBe(join(root, 'fd-notes'))
  })

  it('finds nested folders', () => {
    expect(index().search('holiday')[0]?.path).toBe(join(root, 'photos', 'holiday'))
  })

  it('returns the roots themselves when the query is empty', () => {
    const hits = index().search('')
    expect(hits.map((h) => h.path)).toContain(root)
    expect(hits.map((h) => h.path)).toContain(other)
  })

  it('returns nothing rather than a wrong guess when there is no match', () => {
    expect(index().search('zzz-nonexistent')).toHaveLength(0)
  })
})

describe('what it refuses to offer', () => {
  it('never offers files, only folders', () => {
    expect(index().search('notes').map((h) => h.path)).not.toContain(join(root, 'notes.txt'))
  })

  it('skips noise directories that are never a project', () => {
    const paths = index().search('lodash').map((h) => h.path)
    expect(paths.every((p) => !p.includes('node_modules'))).toBe(true)
  })

  it('skips hidden directories', () => {
    expect(index().search('hidden')).toHaveLength(0)
  })

  it('never returns anything outside the allowed roots', () => {
    const escape = realpathSync(mkdtempSync(join(tmpdir(), 'longleash-escape-')))
    mkdirSync(join(escape, 'secrets'), { recursive: true })
    symlinkSync(escape, join(root, 'link-out'))
    try {
      const hits = index().search('secrets')
      expect(hits.every((h) => h.path.startsWith(root) || h.path.startsWith(other))).toBe(true)
    } finally {
      rmSync(escape, { recursive: true, force: true })
    }
  })

  it('caps how many results it returns', () => {
    for (let i = 0; i < 40; i++) mkdirSync(join(root, `project-${i}`), { recursive: true })
    expect(index().search('project').length).toBeLessThanOrEqual(20)
  })
})

describe('labels', () => {
  it('labels each hit with a short readable location', () => {
    const hit = index().search('FD_Eng')[0]
    expect(hit?.label).toContain('FD_Engineer')
    expect(hit?.label.length).toBeLessThan(80)
  })
})

function basename(path: string): string {
  return path.split('/').filter(Boolean).slice(-1)[0] ?? ''
}
