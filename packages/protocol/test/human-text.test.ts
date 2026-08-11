import { describe, expect, it } from 'vitest'
import { humanSaid } from '../src/human-text.js'

describe('human transcript text', () => {
  it('extracts the request from the Codex IDE context envelope', () => {
    expect(humanSaid([
      '# Context from my IDE setup:',
      '',
      '## Open tabs:',
      '- PLAN.md: PLAN.md',
      '',
      '## My request:',
      'Fix the mobile folder picker without losing my session.',
    ].join('\n'))).toBe('Fix the mobile folder picker without losing my session.')
  })

  it('handles the compact one-line IDE envelope rendered in narrow transcripts', () => {
    expect(humanSaid(
      '# Context from my IDE setup: ## Open tabs: - PLAN.md: PLAN.md ## My request: Keep only this question',
    )).toBe('Keep only this question')
  })

  it('drops an IDE context envelope that contains no human request', () => {
    expect(humanSaid('# Context from my IDE setup:\n\n## Open tabs:\n- PLAN.md')).toBe('')
  })

  it('strips tagged machinery beside real speech and preserves ordinary Markdown', () => {
    expect(humanSaid(
      '<recommended_plugins>hidden</recommended_plugins>\nPlease fix it.\n<environment_context>hidden</environment_context>',
    )).toBe('Please fix it.')
    expect(humanSaid('Use this:\n```tsx\n<Button>Save</Button>\n```')).toContain('<Button>')
  })
})
