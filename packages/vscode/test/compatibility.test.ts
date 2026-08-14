import { describe, expect, it } from 'vitest'
import {
  PROVIDER_COMPATIBILITY_LEDGER,
  claudeNativeDispatchVerified,
  codexReadWithoutLoadingVerified,
} from '../src/compatibility.js'

describe('evidence-backed provider compatibility', () => {
  it('does not infer Claude native dispatch from installation or semver', () => {
    expect(claudeNativeDispatchVerified('2.1.229')).toBe(false)
    expect(claudeNativeDispatchVerified('2.1.230')).toBe(false)
    expect(claudeNativeDispatchVerified(undefined)).toBe(false)
  })

  it('enables only the exact Codex app-server build that passed read-without-loading', () => {
    expect(codexReadWithoutLoadingVerified('0.147.0')).toBe(true)
    expect(codexReadWithoutLoadingVerified('0.147.1')).toBe(false)
    expect(codexReadWithoutLoadingVerified(undefined)).toBe(false)
  })

  it('records test date and capability evidence for every entry', () => {
    expect(PROVIDER_COMPATIBILITY_LEDGER).toHaveLength(2)
    for (const record of PROVIDER_COMPATIBILITY_LEDGER) {
      expect(record.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
      expect(record.evidence).toMatch(/^live-(?:pass|fail)$/u)
    }
  })
})
