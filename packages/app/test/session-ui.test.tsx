import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewSessionSheet } from '../src/ui/NewSessionSheet.js'
import { SessionCard } from '../src/ui/SessionCard.js'
import { DetailScreen } from '../src/App.js'

describe('session controls visible on a phone-sized flow', () => {
  it('shows the Claude/Codex choice before a folder has been selected', () => {
    const html = renderToStaticMarkup(
      <NewSessionSheet
        open
        roots={['/Users/me/projects']}
        folders={[]}
        connected
        onSearch={() => {}}
        onStart={() => true}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('Which agent')
    expect(html).toContain('Claude')
    expect(html).toContain('Codex')
    expect(html.indexOf('Codex')).toBeLessThan(html.indexOf('Find a folder'))
  })

  it('stamps both the agent and VS Code origin on a session card', () => {
    const html = renderToStaticMarkup(
      <SessionCard
        session={{
          sessionId: 'ext_cdx',
          agent: 'codex',
          live: true,
          cwd: '/Users/me/project',
          title: 'Fix it',
          origin: 'vscode',
          status: 'running',
          blocks: [],
          output: '',
          activity: [],
          resumable: false,
        }}
        pending={0}
        onOpen={() => {}}
      />,
    )
    expect(html).toContain('sessiontag')
    expect(html).toContain('Codex')
    expect(html).toContain('in VS Code')
  })

  it('labels dormant waiting history as reopenable, not actively waiting', () => {
    const html = renderToStaticMarkup(
      <SessionCard
        session={{
          sessionId: 'ses_old',
          agent: 'claude',
          live: false,
          cwd: '/Users/me/project',
          title: 'Old work',
          origin: 'terminal',
          status: 'waiting',
          blocks: [],
          output: '',
          activity: [],
          resumable: true,
        }}
        pending={0}
        onOpen={() => {}}
      />,
    )
    expect(html).toContain('ready to reopen')
    expect(html).not.toContain('waiting for you')
  })

  it('offers Reopen—not a dead Stop button—for dormant waiting history', () => {
    const html = renderToStaticMarkup(
      <DetailScreen
        session={{
          sessionId: 'ses_old', agent: 'claude', live: false, cwd: '/x', title: 'Old work',
          origin: 'phone', status: 'waiting', blocks: [], output: '', activity: [], resumable: true,
        }}
        approvals={[]}
        connected
        diagnostic={null}
        error={null}
        onClearError={() => {}}
        onDecide={() => {}}
        onAnswer={() => {}}
        onLeave={() => {}}
        onStop={() => {}}
        onResume={() => {}}
        onSend={() => true}
        onTakeOver={() => true}
        onSetGate={() => {}}
      />,
    )
    expect(html).toContain('Reopen')
    expect(html).not.toContain('Stop this agent')
  })
})
