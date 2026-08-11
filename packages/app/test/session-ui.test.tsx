import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewSessionSheet } from '../src/ui/NewSessionSheet.js'
import { SessionCard } from '../src/ui/SessionCard.js'
import { DetailScreen, Rail } from '../src/App.js'
import { Transcript } from '../src/ui/Transcript.js'

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
    expect(html).toContain('Choose an agent')
    expect(html).toContain('Claude')
    expect(html).toContain('Codex')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('type="search"')
    expect(html).toContain('Close new session')
    expect(html.indexOf('Codex')).toBeLessThan(html.indexOf('Find a project'))
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
    expect(html).toContain('data-agent="codex"')
    expect(html).toContain('data-origin="vscode"')
    expect(html).toContain('Codex')
    expect(html).toContain('in VS Code')
  })

  it('removes Codex IDE metadata from historical user messages', () => {
    const html = renderToStaticMarkup(
      <Transcript
        blocks={[{
          kind: 'user',
          text: '# Context from my IDE setup:\n\n## Open tabs:\n- PLAN.md: PLAN.md\n\n## My request:\nfix the mobile picker',
        }]}
      />,
    )
    expect(html).toContain('fix the mobile picker')
    expect(html).not.toContain('Context from my IDE setup')
    expect(html).not.toContain('Open tabs')
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

  it('does not offer codex resume while VS Code still owns the live writer', () => {
    const html = renderToStaticMarkup(
      <DetailScreen
        session={{
          sessionId: 'ext_live', agent: 'codex', live: true, cwd: '/x', title: 'Live work',
          origin: 'vscode', status: 'waiting', blocks: [], output: '', activity: [],
          resumable: true, resumeId: 'thread-live',
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
    expect(html).toContain('Stop this agent')
    expect(html).not.toContain('Continue in a terminal')
    expect(html).not.toContain('codex resume')
  })

  it('offers codex resume after the previous writer has stopped', () => {
    const html = renderToStaticMarkup(
      <DetailScreen
        session={{
          sessionId: 'ext_old', agent: 'codex', live: false, cwd: '/x', title: 'Dormant work',
          origin: 'vscode', status: 'waiting', blocks: [], output: '', activity: [],
          resumable: true, resumeId: 'thread-old',
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
    expect(html).toContain('Continue in a terminal')
  })

  it('shows a safe release handoff as soon as a phone session has its native id', () => {
    const html = renderToStaticMarkup(
      <DetailScreen
        session={{
          sessionId: 'phone_live', agent: 'codex', live: true, cwd: '/Users/me/a project',
          title: 'Phone work', origin: 'phone', status: 'running', blocks: [], output: '',
          activity: [], resumable: true, resumeId: 'thread-live',
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
    expect(html).toContain('codex resume')
    expect(html).toContain('thread-live')
    expect(html).toContain('Release for terminal')
    expect(html).toContain('Copy unlocks when it is fully stopped')
    expect(html).toContain('one writer')
  })

  it('shows handoff progress instead of silently omitting a new phone session command', () => {
    const html = renderToStaticMarkup(
      <DetailScreen
        session={{
          sessionId: 'phone_new', agent: 'claude', live: true, cwd: '/x', title: 'New work',
          origin: 'phone', status: 'running', blocks: [], output: '', activity: [],
          resumable: false,
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
    expect(html).toContain('Preparing the exact terminal command')
  })

  it('puts an available update in the persistent top rail', () => {
    const html = renderToStaticMarkup(
      <Rail connected via="relay" updateBuild="abc1234" onUpdate={() => {}} />,
    )
    expect(html).toContain('Update')
    expect(html).toContain('Update LongLeash to build abc1234')
    expect(html).toContain('railupdate')
  })
})
