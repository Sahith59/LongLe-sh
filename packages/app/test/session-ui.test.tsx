import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewSessionSheet } from '../src/ui/NewSessionSheet.js'
import { SessionCard } from '../src/ui/SessionCard.js'
import { DetailScreen, Rail } from '../src/App.js'
import { Transcript } from '../src/ui/Transcript.js'
import { DelegateSheet } from '../src/ui/DelegateSheet.js'
import { ReturnSheet } from '../src/ui/ReturnSheet.js'
import { SessionModePicker } from '../src/ui/SessionSettingsFields.js'

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
    expect(html).toContain('identitymark')
    expect(html).toContain('data-agent="codex"')
    expect(html).toContain('data-origin="vscode"')
    expect(html).toContain('Codex')
    expect(html).toContain('in VS Code')
  })

  it('makes Manual, Auto, and Plan visible with a truthful sandbox boundary', () => {
    const html = renderToStaticMarkup(
      <SessionModePicker agent="codex" value="manual" onChange={() => {}} />,
    )
    expect(html).toContain('Manual')
    expect(html).toContain('Auto')
    expect(html).toContain('Plan')
    expect(html).toContain('Auto keeps provider safety controls on')
    expect(html).toContain('aria-pressed="true"')
  })

  it('removes Codex IDE metadata from historical user messages', () => {
    const html = renderToStaticMarkup(
      <Transcript
        blocks={[{
          kind: 'user',
          text: '# Context from my IDE setup:\n\n## Open tabs:\n- PLAN.md: PLAN.md\n\n## My request:\nfix the mobile picker',
          firstSeq: 1,
          lastSeq: 1,
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

  it('shows a copyable handoff for a live VS Code session with an explicit release guard', () => {
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
    expect(html).toContain('codex resume')
    expect(html).toContain('Copy command')
    expect(html).toContain('Release current run')
    expect(html).toContain('VS Code')
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
    expect(html).toContain('codex resume')
    expect(html).toContain('Copy command')
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
    expect(html).toContain('Release current run')
    expect(html).toContain('Copy command')
    expect(html).toContain('prevents active-writer conflicts')
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
    expect(html).toContain('How to use LongLeash')
  })

  it('offers delegation from a durable transcript event, not a display index', () => {
    const html = renderToStaticMarkup(
      <Transcript
        blocks={[{ kind: 'text', text: 'Review this result.', firstSeq: 41, lastSeq: 44 }]}
        onDelegate={() => {}}
      />,
    )
    expect(html).toContain('Delegate this agent response')
    expect(html).toContain('delegate-block')
  })

  it('renders a phone-editable preview workflow with explicit no-launch language', () => {
    const html = renderToStaticMarkup(
      <DelegateSheet
        open
        session={{
          sessionId: 'ses_parent', agent: 'claude', live: true, cwd: '/work/project',
          title: 'Fix pairing', origin: 'vscode', status: 'running', blocks: [], output: '',
          activity: [], resumable: true,
        }}
        sourceSeq={18}
        connected
        preview={null}
        previewError={null}
        onPreview={() => true}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('Delegate')
    expect(html).toContain('Target agent')
    expect(html).toContain('Investigate')
    expect(html).toContain('Review')
    expect(html).toContain('This message')
    expect(html).toContain('Build briefing')
    expect(html).toContain('no child session has been started')
    expect(html).toContain('Close delegation')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('role="dialog"')
  })

  it('does not offer message-only context from a session-level delegation entry', () => {
    const html = renderToStaticMarkup(
      <DelegateSheet
        open
        session={{
          sessionId: 'ses_parent', agent: 'codex', live: true, cwd: '/work/project',
          title: 'Review UI', origin: 'phone', status: 'running', blocks: [], output: '',
          activity: [], resumable: true,
        }}
        connected={false}
        preview={null}
        previewError={null}
        onPreview={() => true}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('This message is available when delegating from a transcript message')
    expect(html).toContain('Waiting for your laptop')
    expect(html).toContain('disabled=""')
  })

  it('turns an exact edited preview into one explicit, capability-aware launch confirmation', () => {
    const briefing = 'Edited on the phone — send these exact words.'
    const html = renderToStaticMarkup(
      <DelegateSheet
        open
        session={{
          sessionId: 'ses_parent', agent: 'claude', live: true, cwd: '/work/project',
          title: 'Fix pairing', origin: 'vscode', status: 'running', blocks: [], output: '',
          activity: [], resumable: true,
        }}
        sourceSeq={18}
        connected
        preview={{
          v: 1,
          type: 'delegationPreview',
          requestId: 'preview-1',
          source: {
            sessionId: 'ses_parent', agent: 'claude', cwd: '/work/project',
            title: 'Fix pairing', origin: 'vscode',
          },
          sourceSeq: 18,
          targetAgent: 'codex',
          role: 'review',
          contextScope: 'selected',
          briefing,
          context: {
            includedFirstSeq: 18,
            includedLastSeq: 18,
            includedBlocks: 1,
            omittedEvents: 0,
            omittedCharacters: 0,
            truncated: false,
            characterCount: briefing.length,
            maxCharacters: 24_000,
          },
        }}
        previewError={null}
        launchEnabled
        workspaceMode="sequential"
        availableTargets={{ claude: true, codex: true }}
        onPreview={() => true}
        onStart={() => true}
        onClose={() => {}}
      />,
    )
    expect(html).toContain(briefing)
    expect(html).toContain('Ready to hand off to one attributed child')
    expect(html).toContain('Start Codex child')
    expect(html).toContain('Its approvals, Stop control, errors')
    expect(html).toContain('Move sole workspace control')
    expect(html).toContain('Only the child may write this checkout')
    expect(html).toContain('Confirm the exclusive workspace handoff before launch')
    expect(html).toContain('disabled=""')
  })

  it('renders the completed child result, exact attribution, route, and final return boundary', () => {
    const returnText = 'Reviewed on the child — keep this exact result.'
    const html = renderToStaticMarkup(
      <ReturnSheet
        open
        delegation={{
          delegationId: 'del_return', idempotencyKey: 'launch-return', sourceSessionId: 'ses_parent',
          targetSessionId: 'ses_child', targetAgent: 'codex', role: 'review', contextScope: 'recent',
          depth: 1, status: 'ready', createdAt: 1, updatedAt: 2,
        }}
        preview={{
          v: 1, type: 'delegationReturnPreview', requestId: 'prepare-1', delegationId: 'del_return',
          parent: {
            sessionId: 'ses_parent', agent: 'claude', title: 'Repair pairing',
            cwd: '/work/project', origin: 'phone', live: false,
          },
          child: { sessionId: 'ses_child', agent: 'codex', title: 'Review · Repair pairing' },
          role: 'review', returnText,
          attribution: 'Returned from Codex · Review\nChild session: Review · Repair pairing',
          requiresTakeover: false,
          context: {
            includedFirstSeq: 8, includedLastSeq: 12, omittedCharacters: 0,
            truncated: false, characterCount: returnText.length, maxCharacters: 24_000,
          },
        }}
        error={null}
        connected
        onPrepare={() => true}
        onReturn={() => true}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('Review return')
    expect(html).toContain('Review · Repair pairing')
    expect(html).toContain('Into parent')
    expect(html).toContain('Repair pairing')
    expect(html).toContain(returnText)
    expect(html).toContain('Attached attribution')
    expect(html).toContain('Returned from Codex · Review')
    expect(html).toContain('Return exactly this reviewed text')
    expect(html).toContain('Nothing is delivered until you press this button')
  })

  it('requires explicit takeover when an external parent is still running', () => {
    const html = renderToStaticMarkup(
      <ReturnSheet
        open
        delegation={{
          delegationId: 'del_takeover', idempotencyKey: 'launch-takeover', sourceSessionId: 'ext_parent',
          targetSessionId: 'ses_child', targetAgent: 'claude', role: 'implement', contextScope: 'task',
          depth: 1, status: 'ready', createdAt: 1, updatedAt: 2,
        }}
        preview={{
          v: 1, type: 'delegationReturnPreview', requestId: 'prepare-2', delegationId: 'del_takeover',
          parent: {
            sessionId: 'ext_parent', agent: 'codex', title: 'Terminal parent',
            cwd: '/work/project', origin: 'terminal', live: true,
          },
          child: { sessionId: 'ses_child', agent: 'claude', title: 'Implement · Terminal parent' },
          role: 'implement', returnText: 'Implemented safely.',
          attribution: 'Returned from Claude · Implement', requiresTakeover: true,
          context: {
            includedFirstSeq: 3, includedLastSeq: 5, omittedCharacters: 0,
            truncated: false, characterCount: 19, maxCharacters: 24_000,
          },
        }}
        error={null}
        connected
        onPrepare={() => true}
        onReturn={() => true}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('Take over the parent first')
    expect(html).toContain('Confirm the explicit takeover before delivery')
    expect(html).toContain('disabled=""')
  })

  it('renders durable parent/child navigation and a child identity stamp', () => {
    const parent = {
      sessionId: 'ses_parent', agent: 'claude', live: false, cwd: '/work/project',
      title: 'Parent task', origin: 'vscode', status: 'ended' as const, blocks: [], output: '',
      activity: [], resumable: true,
    }
    const child = {
      sessionId: 'ses_child', agent: 'codex', live: true, cwd: '/work/project',
      title: 'Review · Parent task', origin: 'phone', status: 'running' as const, blocks: [], output: '',
      activity: [], resumable: true,
      relationship: {
        delegationId: 'del_1', parentSessionId: 'ses_parent', role: 'review' as const, depth: 1,
      },
    }
    const card = renderToStaticMarkup(<SessionCard session={child} pending={0} onOpen={() => {}} />)
    expect(card).toContain('child · review')
    const parentCard = renderToStaticMarkup(
      <SessionCard session={parent} pending={0} children={{ total: 2, active: 2, ready: 0 }} onOpen={() => {}} />,
    )
    expect(parentCard).toContain('parent · 2 active')

    const detail = renderToStaticMarkup(
      <DetailScreen
        session={child}
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
        delegations={[{
          delegationId: 'del_1', idempotencyKey: 'phone-op-1', sourceSessionId: 'ses_parent', targetSessionId: 'ses_child',
          targetAgent: 'codex', role: 'review', contextScope: 'recent', depth: 1,
          status: 'running', createdAt: 1, updatedAt: 2,
        }]}
        sessions={{ ses_parent: parent, ses_child: child }}
        onOpenSession={() => {}}
      />,
    )
    expect(detail).toContain('Delegated from')
    expect(detail).toContain('Parent task')
    expect(detail).toContain('Open source')
  })

  it('labels a safety-gated delegation as not started when no child exists', () => {
    const parent = {
      sessionId: 'ses_parent', agent: 'claude', live: true, cwd: '/work/project',
      title: 'Parent task', origin: 'phone', status: 'waiting' as const, blocks: [], output: '',
      activity: [], resumable: true,
    }
    const detail = renderToStaticMarkup(
      <DetailScreen
        session={parent}
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
        delegations={[{
          delegationId: 'del_guarded', idempotencyKey: 'phone-op-guarded',
          sourceSessionId: 'ses_parent', targetAgent: 'codex', role: 'review',
          contextScope: 'recent', depth: 1, status: 'failed', createdAt: 1, updatedAt: 2,
          failure: 'The source process did not stop by the safety deadline.',
        }]}
        sessions={{ ses_parent: parent }}
        onOpenSession={() => {}}
      />,
    )
    expect(detail).toContain('not started')
    expect(detail).toContain('No child was created')
    expect(detail).toContain('source process did not stop by the safety deadline')
  })
})
