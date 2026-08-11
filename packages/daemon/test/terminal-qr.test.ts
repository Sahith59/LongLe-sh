import { describe, expect, it } from 'vitest'
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
      expect(line.startsWith('\u001b[97;107m▀▀▀▀')).toBe(true)
      expect(line.endsWith('\u001b[0m')).toBe(true)
      expect(line.replace(ANSI, '')).toHaveLength(modules.length + 8)
      expect(line.replace(ANSI, '')).toMatch(/^▀+$/)
    }
    expect(rendered).toContain('\u001b[30;40m')
    expect(rendered).toMatch(/\u001b\[(?:30;107|97;40)m/)
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
