import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/landing/landing.css', import.meta.url), 'utf8')

describe('landing data-flow icons', () => {
  it('keeps icon centering separate from flow-copy typography', () => {
    expect(css).toMatch(/\.feature-icon,[\s\S]*?\.flow-icon,[\s\S]*?display: grid;[\s\S]*?place-items: center;/)
    expect(css).toContain('.flow-node > div > span')
    expect(css).not.toMatch(/\.flow-node span\s*{/)
  })

  it('uses one crisp optical size and stroke across every flow glyph', () => {
    expect(css).toMatch(/\.flow-icon svg\s*{[\s\S]*?width: 20px;[\s\S]*?height: 20px;[\s\S]*?stroke-width: 1\.8;/)
  })
})
