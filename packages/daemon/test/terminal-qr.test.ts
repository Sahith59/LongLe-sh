import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { qrModules, terminalQr } from '../src/terminal-qr.js'

const ANSI = /\u001b\[[0-9;]*m/g

describe('terminal QR', () => {
  it('decodes a square QR module grid', () => {
    const modules = qrModules('https://longleash.example/?c=challenge&s=secret')
    expect(modules.length).toBeGreaterThanOrEqual(21)
    expect(modules.every((row) => row.length === modules.length)).toBe(true)
    expect(modules.flat()).toContain(true)
    expect(modules.flat()).toContain(false)
  })

  it('paints both halves explicitly and preserves a four-module quiet zone', () => {
    const modules = qrModules('https://longleash.example/?c=challenge&s=secret')
    const rendered = terminalQr('https://longleash.example/?c=challenge&s=secret')
    const lines = rendered.split('\n')

    expect(lines).toHaveLength(Math.ceil((modules.length + 8) / 2))
    for (const line of lines) {
      expect(line.startsWith('\u001b[38;2;255;255;255;48;2;255;255;255m████')).toBe(true)
      expect(line.endsWith('\u001b[0m')).toBe(true)
      expect(line.replace(ANSI, '')).toHaveLength(modules.length + 8)
      expect(line.replace(ANSI, '')).toMatch(/^[█▀▄]+$/)
    }
    expect(rendered).toContain('\u001b[38;2;0;0;0;48;2;0;0;0m')
    expect(rendered).toContain('\u001b[38;2;255;255;255;48;2;0;0;0m')
    expect(rendered).not.toContain('\u001b[38;2;0;0;0;48;2;255;255;255m')
    expect(rendered).not.toMatch(/\u001b\[(?:30|40|97|107)(?:;|m)/)
  })

  it('survives a realistic one-pixel terminal glyph seam and decodes to the exact relay URL', () => {
    const payload =
      'https://longleash-relay.tsahith59.workers.dev/?c=chl_oPP14IXT6jNphRf5&s=bsPvYWGUSjcQ8MwNQRnXcNtQ7FOijAhduziMAwAXLBo'
    const rendered = terminalQr(payload)
    const cellWidth = 12
    const cellHeight = 24
    const parsed = rendered.split('\n').map(parseAnsiCells)
    const width = Math.max(...parsed.map((row) => row.length)) * cellWidth
    const height = parsed.length * cellHeight
    const pixels = new Uint8ClampedArray(width * height * 4)

    for (let index = 0; index < pixels.length; index += 4) pixels[index + 3] = 255
    parsed.forEach((row, rowIndex) => {
      row.forEach((terminalCell, columnIndex) => {
        paintCell(pixels, width, rowIndex, columnIndex, terminalCell, cellWidth, cellHeight)
      })
    })

    const decoded = jsQR(pixels, width, height, { inversionAttempts: 'attemptBoth' })
    expect(decoded?.data).toBe(payload)
  })

  it('does not depend on a terminal theme environment variable', () => {
    const before = process.env.COLORFGBG
    process.env.COLORFGBG = '15;0'
    const dark = terminalQr('same payload')
    process.env.COLORFGBG = '0;15'
    const light = terminalQr('same payload')
    if (before === undefined) delete process.env.COLORFGBG
    else process.env.COLORFGBG = before
    expect(light).toBe(dark)
  })
})

interface PaintedCell {
  foreground: number
  background: number
  glyph: '█' | '▀' | '▄'
}

const STYLE = /\u001b\[38;2;(\d+);(\d+);(\d+);48;2;(\d+);(\d+);(\d+)m/g

function parseAnsiCells(line: string): PaintedCell[] {
  const cells: PaintedCell[] = []
  let foreground = 255
  let background = 255
  let cursor = 0
  for (const match of line.matchAll(STYLE)) {
    const start = match.index ?? 0
    appendGlyphs(line.slice(cursor, start), foreground, background, cells)
    foreground = Number(match[1])
    background = Number(match[4])
    cursor = start + match[0].length
  }
  appendGlyphs(line.slice(cursor).replace(/\u001b\[0m$/, ''), foreground, background, cells)
  return cells
}

function appendGlyphs(
  value: string,
  foreground: number,
  background: number,
  cells: PaintedCell[],
): void {
  for (const glyph of value) {
    if (glyph === '█' || glyph === '▀' || glyph === '▄') {
      cells.push({ foreground, background, glyph })
    }
  }
}

function paintCell(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  row: number,
  column: number,
  cell: PaintedCell,
  cellWidth: number,
  cellHeight: number,
): void {
  for (let y = 0; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      // Model the visible seam in the user's macOS terminal screenshot: a glyph ends one pixel
      // before its cell boundary, while an ANSI background still fills the complete cell.
      const insideGlyph = x < cellWidth - 1 && (
        cell.glyph === '█' ||
        (cell.glyph === '▀' && y < cellHeight / 2) ||
        (cell.glyph === '▄' && y >= cellHeight / 2)
      )
      const colour = insideGlyph ? cell.foreground : cell.background
      const pixelX = column * cellWidth + x
      const pixelY = row * cellHeight + y
      const offset = (pixelY * imageWidth + pixelX) * 4
      pixels[offset] = colour
      pixels[offset + 1] = colour
      pixels[offset + 2] = colour
      pixels[offset + 3] = 255
    }
  }
}
