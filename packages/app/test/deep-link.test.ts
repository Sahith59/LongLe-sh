import { describe, expect, it } from 'vitest'
import { hasSessionLink, sessionFromSearch } from '../src/lib/deep-link.js'

describe('notification deep links', () => {
  it('opens the session named by a current notification URL', () => {
    expect(sessionFromSearch('?session=ext_codex-1')).toBe('ext_codex-1')
    expect(hasSessionLink('?session=ext_codex-1')).toBe(true)
  })

  it('keeps backward compatibility without mistaking a pairing secret for a session', () => {
    expect(sessionFromSearch('?s=ses_old')).toBe('ses_old')
    expect(sessionFromSearch('?c=challenge&s=pairing-secret')).toBeNull()
    expect(hasSessionLink('?c=challenge&s=pairing-secret')).toBe(false)
  })
})
