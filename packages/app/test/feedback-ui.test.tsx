import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Feedback } from '../src/landing/Feedback.js'
import OwnerFeedback from '../src/ui/OwnerFeedback.js'

describe('feedback initial render', () => {
  it('offers labelled controls and a working email fallback without requiring an account', () => {
    const html = renderToStaticMarkup(<Feedback />)
    expect(html).toContain('id="main"')
    expect(html).toContain('for="feedback-subject"')
    expect(html).toContain('for="feedback-message"')
    expect(html).toMatch(/maxlength="4000"/i)
    expect(html).toContain('mailto:support@longleash.dev')
    expect(html).toContain('mailto:security@longleash.dev')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/)
    expect(html).not.toContain('Report received')
  })
  it('renders the owner view without claiming a count or exposing a sample customer', () => {
    const html = renderToStaticMarkup(<OwnerFeedback getToken={async () => null} />)
    expect(html).toContain('Customer inbox.')
    expect(html).not.toContain('No reports on this page')
    expect(html).toContain('Back to sessions')
  })
})
