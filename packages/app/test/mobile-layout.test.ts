import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

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

  it('stacks parallel-workspace, settings, and handoff controls on narrow phones', () => {
    expect(css).toMatch(/@media \(max-width: 390px\)[\s\S]*?\.workspacepick,[\s\S]*?\.settingsgrid\s*{\s*grid-template-columns: 1fr;/)
    expect(css).toMatch(/\.workspaceoption\s*{[\s\S]*?min-width: 0;[\s\S]*?min-height: 82px;/)
    expect(css).toMatch(/\.settingsgrid select,[\s\S]*?min-width: 0;[\s\S]*?min-height: 44px;/)
    expect(css).toMatch(/@media \(max-width: 390px\)[\s\S]*?\.handoff-actions,[\s\S]*?\.transfer-actions\s*{\s*grid-template-columns: 1fr;/)
  })

  it('mounts account controls at the viewport and keeps sign-out reachable on iPhone', () => {
    expect(app).toContain("import { createPortal } from 'react-dom'")
    expect(app).toMatch(/function AccountSheet[\s\S]*?return createPortal\([\s\S]*?document\.body/)
    expect(app).toMatch(/function AccountSheet[\s\S]*?useVisualViewportHeight\(true\)/)
    expect(app).toMatch(/function AccountSheet[\s\S]*?body\.style\.overflow = 'hidden'/)
    expect(app.indexOf('> Sign out')).toBeLessThan(app.indexOf('id="account-sheet-boundary"'))
    expect(css).toMatch(/\.account-sheet-scrim\s*{[\s\S]*?position: fixed;[\s\S]*?overflow: hidden;/)
    expect(css).toMatch(/\.account-sheet\s*{[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior: contain;/)
    expect(css).toMatch(/\.account-sheet-actions \.key\s*{[\s\S]*?min-height: 50px;/)
  })

  it('keeps the three working modes and Help navigation usable at 320-class widths', () => {
    expect(css).toMatch(/\.modeoptions\s*{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
    expect(css).toMatch(/@media \(max-width: 390px\)[\s\S]*?\.modeoptions\s*{\s*grid-template-columns: 1fr;/)
    expect(css).toMatch(/\.modeoption\s*{[\s\S]*?min-width: 0;[\s\S]*?min-height: 82px;/)
    expect(css).toMatch(/\.rail-icon\s*{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/)
    expect(css).toMatch(/\.help-sheet[\s\S]*?\.help-topic/)
  })

  it('keeps the Help sheet modal, keyboard-contained, and focus-restoring', () => {
    expect(app).toMatch(/function HelpSheet[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/)
    expect(app).toMatch(/function HelpSheet[\s\S]*?event\.key === 'Escape'[\s\S]*?onClose\(\)/)
    expect(app).toMatch(/function HelpSheet[\s\S]*?event\.key !== 'Tab'[\s\S]*?last\.focus\(\)[\s\S]*?first\.focus\(\)/)
    expect(app).toMatch(/function HelpSheet[\s\S]*?previouslyFocused\?\.focus\(\)/)
    expect(app).toContain('href="/docs/getting-started"')
  })
})
