import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPermissionPosture } from '../src/posture.js'

const withSettings = (contents: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'longleash-posture-'))
  const path = join(dir, 'settings.json')
  writeFileSync(path, contents)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('permission posture', () => {
  it('reports a clean gate when the user has no allow-rules', () => {
    const { path, cleanup } = withSettings('{"permissions":{"allow":[]}}')
    try {
      const posture = readPermissionPosture(path)
      expect(posture.gateWeakened).toBe(false)
      expect(posture.allowRuleCount).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('warns when the user pre-approved tools, because those bypass the phone', () => {
    const { path, cleanup } = withSettings(
      '{"permissions":{"allow":["Bash(npm run:*)","Bash(git status)","Write"]}}',
    )
    try {
      const posture = readPermissionPosture(path)
      expect(posture.gateWeakened).toBe(true)
      expect(posture.allowRuleCount).toBe(3)
      expect(posture.examples[0]).toContain('npm run')
    } finally {
      cleanup()
    }
  })

  it('treats a missing settings file as a clean gate', () => {
    expect(readPermissionPosture('/nonexistent/settings.json').gateWeakened).toBe(false)
  })

  it('never fails startup on malformed settings', () => {
    const { path, cleanup } = withSettings('{ this is not json')
    try {
      expect(readPermissionPosture(path).gateWeakened).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('ignores non-string entries rather than trusting the shape', () => {
    const { path, cleanup } = withSettings('{"permissions":{"allow":["Bash(ls)",42,null]}}')
    try {
      expect(readPermissionPosture(path).allowRuleCount).toBe(1)
    } finally {
      cleanup()
    }
  })
})
