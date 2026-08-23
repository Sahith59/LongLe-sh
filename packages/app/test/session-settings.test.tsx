import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionSettingsSheet } from '../src/ui/SessionSettingsSheet.js'
import { settingsDraft, settingsFromDraft } from '../src/ui/SessionSettingsFields.js'
import type { SessionView } from '../src/lib/store.js'

const baseSession: SessionView = {
  sessionId: 'ext_native',
  agent: 'claude',
  live: true,
  controller: 'external',
  cwd: '/Users/dev/LongLeash',
  title: 'LongLeash — VS Code',
  origin: 'vscode',
  status: 'waiting',
  blocks: [],
  output: '',
  activity: [],
  resumable: true,
  resumeId: 'native',
}

describe('session settings editor', () => {
  it('round-trips custom models and bounded Claude thinking', () => {
    const draft = settingsDraft({
      model: 'claude-future-model',
      effort: 'high',
      thinking: { mode: 'fixed', budgetTokens: 16_384 },
    })
    expect(draft.model).toBe('__custom__')
    expect(settingsFromDraft(draft, 'claude')).toEqual({
      settings: {
        mode: 'manual',
        model: 'claude-future-model',
        effort: 'high',
        thinking: { mode: 'fixed', budgetTokens: 16_384 },
      },
    })
  })

  it('blocks an invalid fixed budget before anything reaches the laptop', () => {
    const result = settingsFromDraft({
      mode: 'manual', model: '', customModel: '', effort: '', thinking: 'fixed', thinkingBudget: '500',
    }, 'claude')
    expect(result.error).toContain('1,024')
    expect(result.settings).toEqual({})
  })

  it('shows explicit handoff evidence for a live VS Code-owned conversation', () => {
    const html = renderToStaticMarkup(
      <SessionSettingsSheet
        open
        session={baseSession}
        connected
        update={null}
        onSave={() => true}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('Tune Claude without losing this conversation')
    expect(html).toContain('Working mode')
    expect(html).toContain('still controlled by VS Code')
    expect(html).toContain('Move control to LongLeash')
    expect(html).toContain('preserve conversation native')
  })

  it('explains next-response semantics without a handoff for a managed live session', () => {
    const html = renderToStaticMarkup(
      <SessionSettingsSheet
        open
        session={{ ...baseSession, controller: 'longleash', origin: 'phone' }}
        connected
        update={null}
        onSave={() => true}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('Applies to the next response')
    expect(html).toContain('response already in progress finishes unchanged')
    expect(html).not.toContain('Move control to LongLeash')
  })
})
