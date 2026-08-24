import { describe, expect, it } from 'vitest'
import { activityTime } from '../src/lib/activity-time.js'

describe('session activity time', () => {
  const now = Date.UTC(2026, 7, 24, 16, 30)

  it('is compact but carries an exact machine-readable timestamp', () => {
    expect(activityTime(now - 2 * 60_000, now)).toMatchObject({
      label: '2m ago',
      dateTime: '2026-08-24T16:28:00.000Z',
    })
  })

  it('rejects missing and invalid timestamps', () => {
    expect(activityTime(undefined, now)).toBeNull()
    expect(activityTime(Number.NaN, now)).toBeNull()
  })
})
