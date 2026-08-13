/**
 * Design harness. Renders the real screens against fixture data so the interface can be looked
 * at — on a phone-sized viewport, in a browser — without pairing a device or running an agent.
 * It imports the shipped components rather than copies, so what is reviewed here is what ships.
 *
 * Not part of the app bundle: `vite build` only emits index.html.
 *   pnpm --filter @longleash/app dev  →  http://localhost:5173/preview.html?screen=console
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence } from 'motion/react'
import { ConsoleScreen, DetailScreen, Rail } from './App.js'
import { NewSessionSheet } from './ui/NewSessionSheet.js'
import { DelegateSheet, type PreviewDelegationInput } from './ui/DelegateSheet.js'
import { ReturnSheet } from './ui/ReturnSheet.js'
import { SessionSettingsSheet, type SettingsUpdateState } from './ui/SessionSettingsSheet.js'
import type { DelegationPreview, DelegationReturnPreview, DelegationSummary } from '@longleash/protocol'
import type { Block, PendingApproval, SessionView, StoreState } from './lib/store.js'
import type { FolderHit } from './lib/client.js'
import './styles.css'

/** Preview fixtures still carry the same stable sequence metadata as a real replayed transcript. */
const demoBlocks = (blocks: Omit<Block, 'firstSeq' | 'lastSeq'>[]): Block[] =>
  blocks.map((block, index) => ({ ...block, firstSeq: index + 1, lastSeq: index + 1 }))

const sticknotes: SessionView = {
  sessionId: 's-1',
  agent: 'claude',
  live: true,
  cwd: '/Users/sahith/Desktop/sticknotes',
  title: 'Add a delete button to each note',
  origin: 'phone',
  status: 'waiting',
  blocks: demoBlocks([
    {
      kind: 'text',
      text: "I'll add a delete control to each note card. Let me look at how the notes are rendered first.",
    },
    { kind: 'tool', text: 'Read: /Users/sahith/Desktop/sticknotes/src/App.tsx' },
    { kind: 'tool', text: 'Grep: onDelete' },
    {
      kind: 'text',
      text: 'Notes render from `notes.map(...)` in `App.tsx`, and state already lives in a `useState` array — so a delete only needs a filter by id. There is **no** persistence layer to update.',
    },
    { kind: 'tool', text: 'Edit: /Users/sahith/Desktop/sticknotes/src/App.tsx' },
    { kind: 'user', text: 'make sure it asks before deleting' },
    {
      kind: 'text',
      text: 'Good call. I added a confirm step: the first tap turns the button into "Delete?" and only a second tap within three seconds removes the note. That avoids a modal on mobile while still making an accidental tap harmless.',
    },
    { kind: 'tool', text: 'Bash: npm run build' },
    { kind: 'text', text: 'Build passes. Want me to commit this?' },
  ]),
  output:
    'Good call. I added a confirm step: the first tap turns the button into "Delete?" and only a second tap within three seconds removes the note.',
  resumeId: '5b642291-c45b-4b9a-aa8b-3cfdcb1091bc',
  activity: [
    { toolName: 'Read', inputSummary: 'src/App.tsx', autoApproved: true },
    { toolName: 'Grep', inputSummary: 'onDelete', autoApproved: true },
    { toolName: 'Glob', inputSummary: 'src/**/*.tsx', autoApproved: true },
  ],
  resumable: true,
}

const resume: SessionView = {
  sessionId: 's-2',
  agent: 'claude',
  live: true,
  cwd: '/Users/sahith/Documents/FD_Engineer',
  title: 'Tailor the resume for the Stripe posting',
  origin: 'phone',
  status: 'running',
  blocks: [],
  output: 'Rewriting the second bullet under Experience to lead with the latency number…',
  activity: [],
  resumable: true,
}

const scraper: SessionView = {
  sessionId: 's-3',
  agent: 'claude',
  live: true,
  cwd: '/Users/sahith/Desktop/scraper',
  title: 'Fix the flaky pagination test',
  origin: 'daemon',
  status: 'ended',
  blocks: [],
  output: 'Root cause was a race on the cursor reset between runs. Fixed and the suite is green.',
  activity: [],
  resumable: true,
}

const migration: SessionView = {
  sessionId: 's-4',
  agent: 'claude',
  live: true,
  cwd: '/Users/sahith/Desktop/longleash',
  title: 'Migrate the events table',
  origin: 'phone',
  status: 'errored',
  blocks: [],
  output: 'no such column: agent_session_id',
  activity: [],
  resumable: false,
}

const approval: PendingApproval = {
  approvalId: 'a-1',
  sessionId: 's-1',
  toolName: 'Write',
  inputSummary: '/Users/sahith/Desktop/sticknotes/src/components/NoteCard.tsx',
  outsideRoot: false,
}

const breach: PendingApproval = {
  approvalId: 'a-2',
  sessionId: 's-1',
  toolName: 'Bash',
  inputSummary: 'rm -rf /tmp/phone_test.txt',
  targetPath: '/tmp/phone_test.txt',
  outsideRoot: true,
}

/** A real AskUserQuestion, exactly as Claude Code's hook payload delivers one. */
const question: PendingApproval = {
  approvalId: 'a-q1',
  sessionId: 's-1',
  toolName: 'AskUserQuestion',
  inputSummary: 'How should the earpiece know a question is meant for you?',
  outsideRoot: false,
  questions: [
    {
      question: 'How should the earpiece know a question is meant for you?',
      header: 'Trigger',
      multiSelect: false,
      options: [
        {
          label: 'Manual trigger (Recommended)',
          description:
            "Double-tap the stem to say 'answer this' — buildable now, sidesteps the hard intent problem, and dodges the legal exposure of recording all day.",
        },
        {
          label: 'Always-on passive detection',
          description:
            'Constantly listening, inferring when a question is aimed at you — much harder to get right, and raises consent issues directly.',
        },
        {
          label: 'Not sure yet, want your take',
          description: "Let's talk through the trade-off before deciding.",
        },
      ],
    },
    {
      question: 'Which surfaces should ship in the MVP?',
      header: 'MVP scope',
      multiSelect: true,
      options: [
        { label: 'iPhone app', description: 'The one everyone already carries.' },
        { label: 'Watch complication', description: 'Glanceable, but a second thing to build.' },
        { label: 'Web dashboard', description: 'Good for review after the fact.' },
      ],
    },
  ],
}

const folders: FolderHit[] = [
  { path: '/Users/sahith/Desktop/FD_Engineer', label: 'Desktop/FD_Engineer', kind: 'folder' },
  { path: '/Users/sahith/Desktop/sticknotes', label: 'Desktop/sticknotes', kind: 'folder' },
  { path: '/Users/sahith/Downloads/test', label: 'Downloads/test', kind: 'folder' },
  {
    path: '/Users/sahith/Desktop/FD_Engineer/resume.tex',
    label: 'Desktop/FD_Engineer/resume.tex',
    kind: 'file',
    parent: 'Desktop/FD_Engineer',
  },
]


/** Deliberately hostile content: this is where a layout that only works on tidy data breaks. */
const monster: SessionView = {
  sessionId: 's-9',
  agent: 'claude',
  live: true,
  cwd: '/Users/sahith/Documents/Projects/2026/experiments/really-deeply-nested-thing/packages/core',
  title:
    'Refactor-the-entire-authentication-subsystem-including-the-token-refresh-path-and-migrate-every-caller',
  origin: 'vscode',
  status: 'running',
  blocks: demoBlocks([
    {
      kind: 'text',
      text: 'Checksum mismatch on `a3f9e2b1c8d74e0fa6b5c9d2e7f10345a3f9e2b1c8d74e0fa6b5c9d2e7f10345` — that token has no spaces at all and must not push the card sideways.',
    },
    {
      kind: 'tool',
      text: 'Bash: find /Users/sahith/Documents/Projects/2026/experiments -name "*.test.ts" -not -path "*/node_modules/*" -print0 | xargs -0 grep -l "refreshToken"',
    },
    { kind: 'thinking', text: 'The caller list is longer than expected; worth checking the adapter layer before editing anything.' },
    { kind: 'user', text: '— reopened —' },
    { kind: 'user', text: 'goaheadbutdonottouchtheproductionconfigfileunderanycircumstanceswhatsoever' },
  ]),
  output: 'Checksum mismatch on a3f9e2b1c8d74e0fa6b5c9d2e7f10345 — that token has no spaces at all.',
  activity: [],
  resumable: true,
}

const monsterApproval: PendingApproval = {
  approvalId: 'a-9',
  sessionId: 's-9',
  toolName: 'Bash',
  inputSummary:
    'psql postgresql://longleash_admin:hunter2@db.internal.example.com:5432/production?sslmode=require -c "SELECT * FROM sessions WHERE agent_session_id IS NOT NULL"',
  targetPath: '/Users/sahith/Library/Application Support/SomeApp/very/deep/config.plist',
  outsideRoot: true,
}


/** The exact shape of transcript that looked broken on the phone: markdown-heavy answers. */
const sticky: SessionView = {
  sessionId: 's-md',
  agent: 'claude',
  live: true,
  cwd: '/Users/sahithreddythummala',
  title: 'Can you find the sticknotes app in this root directory.?',
  origin: 'phone',
  status: 'waiting',
  blocks: demoBlocks([
    {
      kind: 'text',
      text: 'Found it. The demo logins are `priya@bold.test` / `marcus@bold.test` / `noor@bold.test`, password `demo1234`.',
    },
    { kind: 'user', text: '— reopened —' },
    { kind: 'user', text: 'where is it and how do I run it?' },
    {
      kind: 'text',
      text: [
        "Same answer as a moment ago — it's at `/Users/sahithreddythummala/Sticknotes-app`.",
        '',
        '### Recap',
        '- Node/Express app: `server.js`, `public/`, `package.json`, Vercel-deployed (`vercel.json`, `.vercel/`)',
        '- Data lives in `notes.json` — **no database**',
        '',
        'To run it locally:',
        '```bash',
        'cd ~/Sticknotes-app',
        'npm install && npm start',
        '```',
        '1. Open http://localhost:3000',
        '2. Add a note and it persists to `notes.json`',
        '',
        'Want me to add auth on top?',
      ].join('\n'),
    },
    { kind: 'tool', text: 'Read: /Users/sahithreddythummala/Sticknotes-app/server.js' },
  ]),
  output: 'Want me to add auth on top?',
  activity: [],
  resumable: true,
}

const sessions = [sticknotes, resume, scraper, migration]
const snapshot: StoreState = {
  sessions: Object.fromEntries(sessions.map((s) => [s.sessionId, s])),
  approvals: [approval, breach],
}

const noop = () => {}
const never = () => false

const screen = new URLSearchParams(location.search).get('screen') ?? 'console'

/**
 * The one stateful preview: console ⇄ detail with the SAME AnimatePresence
 * wiring as the real App, so the shared-element title morph can be exercised
 * and screen-recorded without pairing a phone.
 */
function Flow() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Rail connected via="lan" {...(open ? { onBack: () => setOpen(false) } : {})} />
      <div className="screens">
      <AnimatePresence initial={false}>
        {open ? (
          <DetailScreen
            key="detail"
            session={sticknotes}
            approvals={[]}
            connected
            diagnostic={null}
            error={null}
            onClearError={noop}
            onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
            onStop={noop}
            onResume={noop}
            onSend={never}
          onTakeOver={never}
          onSetGate={noop}
          />
        ) : (
          <ConsoleScreen
            key="console"
            approvals={[]}
            active={[sticknotes, resume]}
            past={[scraper]}
            snapshot={{ sessions: snapshot.sessions, approvals: [] }}
            diagnostic={null}
            error={null}
            onClearError={noop}
            onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
            onOpen={() => setOpen(true)}
            onNew={noop}
          />
        )}
      </AnimatePresence>
      </div>
    </>
  )
}

function DelegatePreview() {
  const [preview, setPreview] = useState<DelegationPreview | null>(null)
  const build = (input: PreviewDelegationInput): boolean => {
    const briefing = [
      'Delegated by the user through LongLeash.',
      'Source: Claude · Add a delete button to each note',
      'Workspace: /Users/sahith/Desktop/sticknotes',
      'Role: review',
      '',
      'Objective',
      'Review the work in the delegated context for correctness, regressions, and missing coverage.',
      '',
      'Relevant context',
      '<delegated_context>',
      '[USER · event 6]',
      'make sure it asks before deleting',
      '</delegated_context>',
      '',
      'Expected deliverable',
      'Return prioritized findings with concrete evidence.',
    ].join('\n')
    setPreview({
      v: 1,
      type: 'delegationPreview',
      requestId: input.requestId,
      source: {
        sessionId: sticknotes.sessionId,
        agent: 'claude',
        cwd: sticknotes.cwd,
        title: sticknotes.title,
        origin: 'phone',
      },
      sourceSeq: input.sourceSeq ?? 6,
      targetAgent: input.targetAgent,
      role: input.role,
      contextScope: input.contextScope,
      briefing,
      context: {
        includedFirstSeq: 6,
        includedLastSeq: 6,
        includedBlocks: 1,
        omittedEvents: 0,
        omittedCharacters: 0,
        truncated: false,
        characterCount: briefing.length,
        maxCharacters: 24_000,
      },
    })
    return true
  }
  return (
    <>
      <Rail connected via="lan" onBack={noop} />
      <DetailScreen
        session={sticknotes}
        approvals={[]}
        connected
        diagnostic={null}
        error={null}
        onClearError={noop}
        onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
        onStop={noop}
        onResume={noop}
        onSend={never}
        onTakeOver={never}
        onSetGate={noop}
        onDelegate={noop}
      />
      <DelegateSheet
        open
        session={sticknotes}
        sourceSeq={6}
        connected
        preview={preview}
        previewError={null}
        onPreview={build}
        launchEnabled
        workspaceMode="sequential"
        availableTargets={{ claude: true, codex: true }}
        onStart={never}
        onClose={noop}
      />
    </>
  )
}

const returnChild: SessionView = {
  ...sticknotes,
  sessionId: 's-child',
  agent: 'codex',
  title: 'Review · Add a delete button to each note',
  status: 'waiting',
  relationship: {
    delegationId: 'del-return-preview',
    parentSessionId: sticknotes.sessionId,
    role: 'review',
    depth: 1,
  },
}

const returnDelegation: DelegationSummary = {
  delegationId: 'del-return-preview',
  idempotencyKey: 'launch-return-preview',
  sourceSessionId: sticknotes.sessionId,
  targetSessionId: returnChild.sessionId,
  targetAgent: 'codex',
  role: 'review',
  contextScope: 'selected',
  depth: 1,
  status: 'ready',
  createdAt: 1,
  updatedAt: 2,
}

const returnResult = [
  'The confirmation behavior is correct and the build passes.',
  '',
  'One regression remains: keyboard focus is not restored to the delete trigger after the three-second confirmation window expires.',
  '',
  'Recommended return:',
  '- restore focus after cancel and successful deletion',
  '- add a fake-timer test for the confirmation timeout',
].join('\n')

const returnPreview: DelegationReturnPreview = {
  v: 1,
  type: 'delegationReturnPreview',
  requestId: 'prepare-return-preview',
  delegationId: returnDelegation.delegationId,
  parent: {
    sessionId: sticknotes.sessionId,
    agent: sticknotes.agent as 'claude',
    title: sticknotes.title,
    cwd: sticknotes.cwd,
    origin: sticknotes.origin as 'phone',
    live: false,
  },
  child: {
    sessionId: returnChild.sessionId,
    agent: 'codex',
    title: returnChild.title,
  },
  role: 'review',
  returnText: returnResult,
  attribution: `Returned from Codex · Review\nChild session: ${returnChild.title}`,
  requiresTakeover: false,
  context: {
    includedFirstSeq: 7,
    includedLastSeq: 10,
    omittedCharacters: 0,
    truncated: false,
    characterCount: returnResult.length,
    maxCharacters: 24_000,
  },
}

function ReturnPreviewScreen() {
  return (
    <>
      <Rail connected via="lan" onBack={noop} />
      <DetailScreen
        session={returnChild}
        approvals={[]}
        connected
        diagnostic={null}
        error={null}
        onClearError={noop}
        onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
        onStop={noop}
        onResume={noop}
        onSend={never}
        onTakeOver={never}
        onSetGate={noop}
      />
      <ReturnSheet
        open
        delegation={returnDelegation}
        preview={returnPreview}
        error={null}
        connected
        onPrepare={never}
        onReturn={never}
        onClose={noop}
      />
    </>
  )
}

function SettingsPreview() {
  const [update, setUpdate] = useState<SettingsUpdateState | null>(null)
  const externalSession: SessionView = {
    ...sticknotes,
    sessionId: 's-settings',
    title: 'LongLeash — VS Code',
    origin: 'vscode',
    controller: 'external',
    settings: { model: 'sonnet', effort: 'high', thinking: { mode: 'adaptive' } },
  }

  return (
    <>
      <Rail connected via="lan" onBack={noop} />
      <DetailScreen
        session={externalSession}
        approvals={[]}
        connected
        diagnostic={null}
        error={null}
        onClearError={noop}
        onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
        onStop={noop}
        onResume={noop}
        onSend={never}
        onTakeOver={never}
        onSetGate={noop}
      />
      <SessionSettingsSheet
        open
        session={externalSession}
        connected
        catalog={{
          claude: {
            models: ['sonnet', 'opus', 'haiku'],
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            thinking: ['adaptive', 'disabled', 'fixed'],
          },
          codex: {
            models: ['gpt-5.6', 'gpt-5.4', 'gpt-5.3-codex'],
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            thinking: [],
          },
        }}
        update={update}
        onSave={(input) => {
          setUpdate({ requestId: input.requestId, state: 'saved', outcome: 'next-continuation' })
          return true
        }}
        onClose={noop}
      />
    </>
  )
}

function Preview() {
  if (screen === 'flow') return <Flow />
  if (screen === 'delegate') return <DelegatePreview />
  if (screen === 'return') return <ReturnPreviewScreen />
  if (screen === 'settings') return <SettingsPreview />

  if (screen === 'question') {
    return (
      <>
        <Rail connected via="lan" />
        <ConsoleScreen
          approvals={[question]}
          active={[sticknotes]}
          past={[]}
          snapshot={{ sessions: snapshot.sessions, approvals: [question] }}
          diagnostic={null}
          error={null}
          onClearError={noop}
          onDecide={noop}
          onAnswer={noop}
          onLeave={noop}
          onOpen={noop}
          onNew={noop}
        />
      </>
    )
  }

  if (screen === 'detail') {
    return (
      <>
        <Rail connected via="lan" onBack={noop} />
        <DetailScreen
          session={sticknotes}
          approvals={[approval]}
          connected
          diagnostic={null}
          error={null}
          onClearError={noop}
          onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
          onStop={noop}
          onResume={noop}
          onSend={never}
          onTakeOver={never}
          onSetGate={noop}
        />
      </>
    )
  }

  if (screen === 'transcript') {
    return (
      <>
        <Rail connected via="lan" onBack={noop} />
        <DetailScreen
          session={sticknotes}
          approvals={[]}
          connected
          diagnostic={null}
          error={null}
          onClearError={noop}
          onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
          onStop={noop}
          onResume={noop}
          onSend={never}
          onTakeOver={never}
          onSetGate={noop}
        />
      </>
    )
  }

  if (screen === 'sheet') {
    return (
      <>
        <Rail connected via="lan" />
        <ConsoleScreen
          approvals={[]}
          active={[resume]}
          past={[scraper]}
          snapshot={{ sessions: snapshot.sessions, approvals: [] }}
          diagnostic={null}
          error={null}
          onClearError={noop}
          onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
          onOpen={noop}
          onNew={noop}
        />
        <NewSessionSheet
          open
          roots={['/Users/sahith']}
          folders={folders}
          connected
          onSearch={noop}
          onStart={never}
          onClose={noop}
        />
      </>
    )
  }

  if (screen === 'markdown') {
    return (
      <>
        <Rail connected via="lan" onBack={noop} />
        <DetailScreen
          session={sticky}
          approvals={[]}
          connected
          diagnostic={null}
          error={null}
          onClearError={noop}
          onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
          onStop={noop}
          onResume={noop}
          onSend={never}
          onTakeOver={never}
          onSetGate={noop}
        />
      </>
    )
  }

  if (screen === 'stress') {
    return (
      <>
        <Rail connected via="lan" />
        <ConsoleScreen
          approvals={[monsterApproval]}
          active={[monster]}
          past={[]}
          snapshot={{ sessions: { 's-9': monster }, approvals: [monsterApproval] }}
          diagnostic={null}
          error={null}
          onClearError={noop}
          onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
          onOpen={noop}
          onNew={noop}
        />
      </>
    )
  }

  if (screen === 'stress-detail') {
    return (
      <>
        <Rail connected via="lan" onBack={noop} />
        <DetailScreen
          session={monster}
          approvals={[monsterApproval]}
          connected
          diagnostic={null}
          error={null}
          onClearError={noop}
          onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
          onStop={noop}
          onResume={noop}
          onSend={never}
          onTakeOver={never}
          onSetGate={noop}
        />
      </>
    )
  }

  if (screen === 'empty') {
    return (
      <>
        <Rail connected via="lan" />
        <ConsoleScreen
          approvals={[]}
          active={[]}
          past={[]}
          snapshot={{ sessions: {}, approvals: [] }}
          diagnostic={null}
          error={null}
          onClearError={noop}
          onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
          onOpen={noop}
          onNew={noop}
        />
      </>
    )
  }

  if (screen === 'offline') {
    return (
      <>
        <Rail connected={false} via="lan" />
        <ConsoleScreen
          approvals={[]}
          active={[]}
          past={[scraper, migration]}
          snapshot={{ sessions: snapshot.sessions, approvals: [] }}
          diagnostic="Cannot reach your laptop. Check you are on the same network, and turn off any VPN — a full-tunnel VPN blocks phone-to-laptop traffic entirely."
          error="Not connected to your laptop — the message was not sent."
          onClearError={noop}
          onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
          onOpen={noop}
          onNew={noop}
        />
      </>
    )
  }

  return (
    <>
      <Rail connected via="lan" />
      <ConsoleScreen
        approvals={snapshot.approvals}
        active={[sticknotes, resume]}
        past={[scraper, migration]}
        snapshot={snapshot}
        diagnostic={null}
        error={null}
        onClearError={noop}
        onDecide={noop}
        onAnswer={noop}
        onLeave={noop}
        onOpen={noop}
        onNew={noop}
      />
    </>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Preview />)
