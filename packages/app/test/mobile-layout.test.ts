import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

describe('delegation mobile layout contract', () => {
  it('has an explicit 320-class layout and never relies on horizontal form overflow', () => {
    expect(css).toContain('@media (max-width: 360px)')
    expect(css).toMatch(/@media \(max-width: 360px\)[\s\S]*?\.scopepick\s*{\s*grid-template-columns: 1fr;/)
    expect(css).toMatch(/\.delegate-fieldset\s*{[\s\S]*?min-width: 0;/)
    expect(css).toMatch(/\.sheet-in\s*{[\s\S]*?min-width: 0;/)
  })

  it('keeps the sheet and editor reachable above phone chrome and keyboards', () => {
    expect(css).toMatch(/\.sheet-in\s*{[\s\S]*?env\(safe-area-inset-bottom\)/)
    expect(css).toMatch(/\.delegate-sheet\s*{\s*max-height: 92dvh;/)
    expect(css).toMatch(/textarea\.field\.briefing-field\s*{[\s\S]*?max-height: 48dvh;/)
  })

  it('gives transcript delegation actions a 44 by 44 pixel touch target', () => {
    expect(css).toMatch(/\.delegate-block\s*{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/)
  })

  it('keeps launch and lineage navigation above minimum mobile touch size', () => {
    expect(css).toMatch(/\.delegate-confirm \.key\.delegate-launch\s*{[\s\S]*?min-height: 50px;/)
    expect(css).toMatch(/\.lineage button\s*{[\s\S]*?min-height: 48px;/)
    expect(css).toMatch(/\.sheetclose\s*{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/)
    expect(css).toMatch(/\.takeover-confirm\s*{[\s\S]*?min-height: 54px;/)
    expect(css).toMatch(/\.return-confirm \.return-launch\s*{[\s\S]*?min-height: 50px;/)
    expect(css).toMatch(/@media \(max-width: 360px\)[\s\S]*?\.lineage-child\s*{[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\);/)
  })

  it('keeps long return route labels bounded inside the sheet', () => {
    expect(css).toMatch(/\.return-route\s*{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/)
    expect(css).toMatch(/\.return-route strong\s*{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;/)
    expect(css).toMatch(/\.return-attribution\s*{[\s\S]*?overflow-wrap: anywhere;/)
  })
})
