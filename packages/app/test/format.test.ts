import { describe, expect, it } from 'vitest'
import { FileText, SquareTerminal, Wrench } from 'lucide-react'
import { fileName, parentPath, shortPath, splitTool, toolIcon } from '../src/ui/format.js'

describe('shortening a path for a phone', () => {
  it('keeps the last two segments, which is what identifies the project', () => {
    expect(shortPath('/Users/sam/Desktop/sticknotes')).toBe('…/Desktop/sticknotes')
  })

  it('leaves a short path alone rather than adding a misleading ellipsis', () => {
    expect(shortPath('/Users')).toBe('/Users')
    expect(shortPath('/Users/sam')).toBe('/Users/sam')
  })

  it('survives a trailing slash', () => {
    expect(shortPath('/Users/sam/Desktop/app/')).toBe('…/Desktop/app')
  })

  it('returns the input unchanged when there is nothing to shorten', () => {
    expect(shortPath('')).toBe('')
  })
})

describe('naming files and folders', () => {
  it('takes the last segment as the file name', () => {
    expect(fileName('Desktop/app/index.ts')).toBe('index.ts')
  })

  it('falls back to the whole label when there are no separators', () => {
    expect(fileName('notes.txt')).toBe('notes.txt')
  })

  it('gives the folder an agent would actually run in', () => {
    expect(parentPath('/Users/sam/Desktop/app/index.ts')).toBe('/Users/sam/Desktop/app')
  })
})

describe('splitting a tool call for display', () => {
  it('separates the tool name from its argument', () => {
    expect(splitTool('Read: /Users/sam/app/src/index.ts')).toEqual({
      name: 'Read',
      detail: '…/src/index.ts',
    })
  })

  it('shortens a long absolute path so the file name stays visible', () => {
    const { detail } = splitTool('Edit: /Users/sam/Desktop/project/packages/app/src/App.tsx')
    expect(detail).toBe('…/src/App.tsx')
  })

  it('leaves a shell command intact — truncating it would change what it says it ran', () => {
    expect(splitTool('Bash: /usr/bin/env node --version')).toEqual({
      name: 'Bash',
      detail: '/usr/bin/env node --version',
    })
  })

  it('leaves a search pattern intact', () => {
    expect(splitTool('Grep: TODO|FIXME')).toEqual({ name: 'Grep', detail: 'TODO|FIXME' })
  })

  it('handles a tool reported with no argument at all', () => {
    expect(splitTool('TodoWrite')).toEqual({ name: 'TodoWrite', detail: '' })
  })

  it('only splits on the first separator, so a colon inside the argument survives', () => {
    expect(splitTool('WebFetch: https://example.com/a: b')).toEqual({
      name: 'WebFetch',
      detail: 'https://example.com/a: b',
    })
  })
})

describe('tool glyphs', () => {
  it('gives known tools their own glyph', () => {
    expect(toolIcon('Read')).toBe(FileText)
    expect(toolIcon('Bash')).toBe(SquareTerminal)
  })

  it('falls back to a generic glyph for a tool it has never seen, rather than rendering nothing', () => {
    expect(toolIcon('SomeFutureMcpTool')).toBe(Wrench)
    expect(toolIcon('')).toBe(Wrench)
  })
})
