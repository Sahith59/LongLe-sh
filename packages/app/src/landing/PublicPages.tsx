import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  BellRing,
  BookOpen,
  Check,
  Clipboard,
  FileCode2,
  GitBranch,
  HelpCircle,
  Laptop,
  Lock,
  Radio,
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import {
  INSTALL_COMMAND,
  REPOSITORY,
  SiteFrame,
  siteHref,
} from './SiteChrome.js'

interface PageMeta {
  path: string
  label: string
  description: string
  icon: typeof BookOpen
}

const guides: PageMeta[] = [
  {
    path: '/docs/getting-started',
    label: 'Getting started',
    description: 'Install, pair, verify, and complete one safe first run.',
    icon: BookOpen,
  },
  {
    path: '/docs/daily-use',
    label: 'Daily use',
    description: 'Sessions, approvals, tuning, handoffs, updates, and stopping.',
    icon: Smartphone,
  },
  {
    path: '/docs/troubleshooting',
    label: 'Troubleshooting',
    description: 'Symptom-first recovery that preserves the evidence needed to diagnose a bug.',
    icon: Wrench,
  },
  {
    path: '/docs/security',
    label: 'Security model',
    description: 'What stays local, what the relay sees, and how device authority works.',
    icon: ShieldCheck,
  },
  {
    path: '/docs/session-portability',
    label: 'Session portability',
    description: 'Move work safely between phone, Terminal, and VS Code.',
    icon: SquareTerminal,
  },
  {
    path: '/docs/faq',
    label: 'FAQ',
    description: 'Straight answers about accounts, providers, platforms, cost, and limitations.',
    icon: HelpCircle,
  },
]

const titles: Record<string, string> = {
  '/docs': 'Documentation',
  '/docs/getting-started': 'Getting started',
  '/docs/daily-use': 'Daily use',
  '/docs/troubleshooting': 'Troubleshooting',
  '/docs/security': 'Security model',
  '/docs/session-portability': 'Session portability',
  '/docs/faq': 'Frequently asked questions',
  '/roadmap': 'Roadmap',
  '/license': 'MIT License',
  '/privacy': 'Privacy',
  '/terms': 'Terms of Service',
}

const LICENSE_TEXT = `MIT License

Copyright (c) 2026 Sahith Reddy Thummala

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

export function PublicPageRouter({ path }: { path: string }) {
  useEffect(() => {
    const title = titles[path]
    document.title = title ? `${title} — LongLeash` : 'Page not found — LongLeash'
    window.scrollTo(0, 0)
    const hash = window.location.hash.slice(1)
    if (hash) window.requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView())
  }, [path])

  let page: ReactNode
  switch (path) {
    case '/docs':
      page = <DocsHome />
      break
    case '/docs/getting-started':
      page = <GettingStarted />
      break
    case '/docs/daily-use':
      page = <DailyUse />
      break
    case '/docs/troubleshooting':
      page = <Troubleshooting />
      break
    case '/docs/security':
      page = <Security />
      break
    case '/docs/session-portability':
      page = <Portability />
      break
    case '/docs/faq':
      page = <Faq />
      break
    case '/roadmap':
      page = <Roadmap />
      break
    case '/license':
      page = <License />
      break
    case '/privacy':
      page = <Privacy />
      break
    case '/terms':
      page = <Terms />
      break
    default:
      page = <NotFound />
  }

  return <SiteFrame>{page}</SiteFrame>
}

function DocsLayout({
  path,
  eyebrow = 'Documentation',
  title,
  summary,
  children,
}: {
  path: string
  eyebrow?: string
  title: string
  summary: string
  children: ReactNode
}) {
  return (
    <main className="public-main" id="main">
      <header className="page-intro">
        <p className="land-label">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{summary}</p>
      </header>
      <div className="docs-shell">
        <aside className="docs-sidebar" aria-label="Documentation sections">
          <a className={path === '/docs' ? 'active' : ''} href={siteHref('/docs')}>
            Overview
          </a>
          {guides.map((guide) => (
            <a
              className={path === guide.path ? 'active' : ''}
              href={siteHref(guide.path)}
              aria-current={path === guide.path ? 'page' : undefined}
              key={guide.path}
            >
              {guide.label}
            </a>
          ))}
          <span className="docs-nav-rule" />
          <a className={path === '/roadmap' ? 'active' : ''} href={siteHref('/roadmap')}>
            Roadmap
          </a>
          <a className={path === '/privacy' ? 'active' : ''} href={siteHref('/privacy')}>
            Privacy
          </a>
          <a className={path === '/license' ? 'active' : ''} href={siteHref('/license')}>
            License
          </a>
        </aside>
        <article className="docs-article doc-prose">{children}</article>
      </div>
    </main>
  )
}

function DocsHome() {
  return (
    <DocsLayout
      path="/docs"
      title="Use LongLeash with confidence."
      summary="Clear paths for setup, everyday control, recovery, security review, and moving a real conversation between surfaces."
    >
      <h2 id="mental-model">The 45-second mental model</h2>
      <div className="mental-model" aria-label="LongLeash system model">
        <ModelStep icon={Laptop} title="Laptop" body="Runs the daemon, agents, code, and credentials." />
        <ArrowRight aria-hidden="true" />
        <ModelStep icon={Radio} title="Relay" body="Routes end-to-end encrypted frames; it cannot read them." />
        <ArrowRight aria-hidden="true" />
        <ModelStep icon={Smartphone} title="Phone" body="Shows sessions and sends small, typed decisions." />
      </div>
      <div className="doc-callout safe">
        <ShieldCheck size={19} aria-hidden="true" />
        <p>
          <b>Your laptop remains the authority.</b> LongLeash is not a cloud coding environment and
          does not upload your repository, provider login, or transcript database.
        </p>
      </div>
      <h2>Choose a guide</h2>
      <div className="guide-grid">
        {guides.map(({ path, label, description, icon: Icon }) => (
          <a className="guide-card" href={siteHref(path)} key={path}>
            <span className="doc-icon"><Icon size={19} aria-hidden="true" /></span>
            <span><b>{label}</b><small>{description}</small></span>
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        ))}
      </div>
      <h2>When something feels wrong</h2>
      <p>Do not repeatedly restart, pair, or kill processes. Preserve the first useful evidence:</p>
      <CodeBlock command={'longleash doctor\ntail -n 150 ~/.longleash/daemon.log'} />
      <p>
        Then follow the <a href={siteHref('/docs/troubleshooting')}>symptom-first recovery guide</a>.
        Pairing URLs are secrets—remove them before sharing a screenshot.
      </p>
    </DocsLayout>
  )
}

function GettingStarted() {
  return (
    <DocsLayout
      path="/docs/getting-started"
      title="Laptop first. Phone second."
      summary="Install the local daemon, pair one phone, and prove the whole loop on a harmless task before trusting it with important work."
    >
      <h2 id="requirements">Before you install</h2>
      <ul className="check-list">
        <li>macOS or Linux with Node.js 22 or newer and Git.</li>
        <li>Claude Code, Codex, or both already installed and signed in.</li>
        <li>A terminal you can leave open while LongLeash is running.</li>
      </ul>
      <p>LongLeash does not include an AI subscription and never asks for a provider API key.</p>

      <h2 id="install">1. Install</h2>
      <CodeBlock command={INSTALL_COMMAND} />
      <p>
        The installer checks prerequisites, installs under your home directory, builds the phone
        app, and configures supported lifecycle hooks. It does not use <code>sudo</code>. You can
        inspect the <a href={`${REPOSITORY}/blob/main/scripts/install.sh`}>installer source</a>{' '}
        before running it.
      </p>

      <h2 id="start">2. Start the daemon</h2>
      <CodeBlock command="longleash" />
      <p>
        Keep this terminal open. To limit folder discovery, name the roots agents may use, such as{' '}
        <code>longleash ~/code ~/work</code>. LongLeash binds locally and connects outward to the
        relay; it does not ask you to expose a router port.
      </p>

      <h2 id="pair">3. Pair the installed phone app</h2>
      <ol>
        <li>Open the LongLeash home-screen app and choose <b>Scan the QR</b>.</li>
        <li>Scan the fresh QR shown by the daemon. Keep its entire quiet border in view.</li>
        <li>Require the header to show <code>linked · relay</code> or <code>linked · direct</code>.</li>
      </ol>
      <div className="doc-callout warn">
        <Lock size={19} aria-hidden="true" />
        <p>
          <b>A pairing link is a single-use secret.</b> If it was completed, exposed, or failed in
          another browser, press <code>n</code> then Enter in the daemon terminal for a fresh one.
        </p>
      </div>

      <h2 id="verify">4. Verify the installation</h2>
      <CodeBlock command="longleash doctor" />
      <p>The daemon must be reachable, installed hooks current, and the app, daemon, and relay builds aligned.</p>

      <h2 id="first-test">5. Complete one safe first test</h2>
      <ol>
        <li>Start Claude or Codex on a disposable folder.</li>
        <li>Ask it to inspect files and trigger one harmless approval.</li>
        <li>Answer from the phone and confirm the correct session continues.</li>
        <li>Stop it, reveal the handoff, and copy the native resume command.</li>
        <li>Resume at the laptop and confirm the same conversation is present.</li>
      </ol>
      <p>
        If any step is ambiguous, stop there and use <a href={siteHref('/docs/troubleshooting')}>Troubleshooting</a>.
      </p>
    </DocsLayout>
  )
}

function DailyUse() {
  return (
    <DocsLayout
      path="/docs/daily-use"
      title="One control surface, several kinds of session."
      summary="The origin label tells you where a process lives; the capability state tells you what LongLeash can safely do to it."
    >
      <h2>Read the session labels first</h2>
      <dl className="definition-grid">
        <Definition term="From your phone" body="A managed process LongLeash launched and can steer, stop, tune, and resume." />
        <Definition term="In a terminal" body="A provider process discovered through lifecycle hooks. Observation and takeover depend on its state." />
        <Definition term="In VS Code" body="A provider process associated with the IDE. LongLeash does not scrape or inject into private chat panels." />
        <Definition term="Waiting for you" body="A live question or permission needs a decision. Open that exact item before acting." />
      </dl>

      <h2>Approvals and questions</h2>
      <p>
        Open the notification or Inbox item, verify the session, working folder, tool, and input,
        then approve, deny, or answer. Decisions are idempotent: tapping twice cannot approve two
        operations. Expired or ended-session requests become non-actionable.
      </p>

      <h2>Steer, tune, and stop</h2>
      <ul>
        <li><b>Reply</b> sends the next user turn to a managed session.</li>
        <li><b>Tune</b> applies supported model, effort, or thinking settings to the next turn while preserving the native conversation ID.</li>
        <li><b>Stop</b> asks the real provider process to end and waits for evidence that it exited.</li>
      </ul>
      <p>
        A Terminal or VS Code process must transfer control before phone-side tuning. That explicit
        checkbox prevents LongLeash and the native surface from becoming two writers.
      </p>

      <h2>Move back to the laptop</h2>
      <p>
        Reveal the terminal handoff and copy its provider-native resume command. If the process is
        active, stop or release it first. For the detailed ownership rules, see{' '}
        <a href={siteHref('/docs/session-portability')}>Session portability</a>.
      </p>

      <h2>Update without guessing</h2>
      <CodeBlock command={'longleash update\nlongleash doctor'} />
      <p>Restart the daemon after updating. An already running Node process cannot load the new files from disk.</p>
    </DocsLayout>
  )
}

function Troubleshooting() {
  return (
    <DocsLayout
      path="/docs/troubleshooting"
      title="Diagnose first. Restart second."
      summary="Start with the symptom you can see, preserve the log, and use the smallest recovery action that proves what changed."
    >
      <h2 id="first-minute">The first minute</h2>
      <CodeBlock command={'longleash doctor\ntail -n 150 ~/.longleash/daemon.log'} />
      <p>
        Record the local time, provider, origin label, session title, project path, and the exact
        action that failed. Redact source code and pairing URLs before posting evidence.
      </p>

      <h2 id="pairing">Pairing says the laptop did not answer</h2>
      <ol>
        <li>Leave the terminal running <code>longleash</code> open.</li>
        <li>Run <code>longleash doctor</code> in a second terminal and require <b>reachable</b>.</li>
        <li>Press <code>n</code> then Enter in the daemon terminal for a new single-use QR.</li>
        <li>Scan from inside the installed PWA; Safari and the home-screen app have separate storage on iPhone.</li>
        <li>If scanning remains unreliable, paste the complete fresh link into the app.</li>
      </ol>

      <h2 id="daemon">“Already running” or “connection refused”</h2>
      <p>
        “Already running” means one daemon owns the laptop profile; use it instead of starting a
        second. “Connection refused” means a hook or client reached an address with no listening
        daemon. Do not use a broad <code>pkill</code>. Identify the listener first:
      </p>
      <CodeBlock command={'lsof -nP -iTCP:4321 -sTCP:LISTEN\nps -p <PID> -o pid,ppid,command'} />

      <h2 id="missing-session">A Terminal or VS Code session is missing</h2>
      <ol>
        <li>Run <code>longleash doctor</code>.</li>
        <li>If a hook is stale or missing, run <code>longleash hooks</code>.</li>
        <li>Start a new provider process; an existing one retains its old environment and hook configuration.</li>
        <li>Cause one lifecycle/tool event. LongLeash discovers structured events, not terminal pixels.</li>
      </ol>

      <h2 id="stale">A stale approval or old session remains</h2>
      <p>
        Do not approve again. Record the session and decision time, refresh once, and compare builds
        with <code>longleash doctor</code>. A decided request must close; a dormant conversation may
        remain deliberately as resumable history but must not look live.
      </p>

      <h2 id="writer">“This checkout is already controlled”</h2>
      <p>
        One physical checkout permits one writer. Continue in the owner, stop/release it, or choose
        <b> Safe parallel</b> so LongLeash creates a Git worktree. Dirty tracked changes cause a safe
        refusal because silently copying an older HEAD would lose context.
      </p>

      <h2 id="handoff">Stop, takeover, or handoff did not complete</h2>
      <p>
        LongLeash requires proof that the native process exited before granting another writer.
        Close the relevant Terminal or IDE process on the laptop, wait for its lifecycle event, and
        retry once. If it still fails, keep the log—the refusal is protecting the conversation and checkout.
      </p>

      <div className="doc-callout">
        <BellRing size={19} aria-hidden="true" />
        <p>
          Still stuck? File a <a href={`${REPOSITORY}/issues/new`}>reproducible GitHub issue</a> with
          doctor output and redacted logs. GitHub is the support tracker; this page remains the user guide.
        </p>
      </div>
    </DocsLayout>
  )
}

function Security() {
  return (
    <DocsLayout
      path="/docs/security"
      title="The laptop keeps authority."
      summary="LongLeash gives a paired phone a narrow control protocol. It does not turn your laptop into a generic remote shell or move your development environment into the cloud."
    >
      <h2>What stays on the laptop</h2>
      <ul className="check-list">
        <li>Provider credentials and subscription sessions.</li>
        <li>Repositories, working files, and Git worktrees.</li>
        <li>Provider processes and the durable transcript/audit database.</li>
        <li>The authority to start, stop, approve, tune, and revoke devices.</li>
      </ul>

      <h2>What the hosted relay can see</h2>
      <p>
        The relay routes end-to-end encrypted frames. It can observe operational metadata such as
        opaque room identifiers, timing, frame sizes, joins, leaves, and IP-level connection data.
        It cannot decrypt prompt, code, path, transcript, or approval content, and it stores no conversation history.
      </p>

      <h2>Pairing is device identity</h2>
      <p>
        A fresh QR contains a short-lived, single-use secret. Successful pairing creates revocable
        device credentials. If a phone is lost or a QR is exposed, revoke it from the laptop:
      </p>
      <CodeBlock command={'longleash devices\nlongleash revoke <device-id>'} />

      <h2>Account identity is a separate lock</h2>
      <p>
        The official hosted app requires a verified LongLeash account before it can request a short-lived relay
        connection ticket. That account chooses which browser credential slot is visible; the QR
        still grants authority over a specific laptop. Signing into an account alone cannot control a
        machine, and a pairing secret is never sent to Google or the account provider. LAN and
        self-hosted deployments remain accountless.
      </p>

      <h2>The phone cannot execute arbitrary commands</h2>
      <p>
        It sends validated operations such as start a session, reply, approve a specific request,
        stop, or tune. There is no generic “run any shell command” endpoint. Workspace allowlists,
        one-writer leases, provider approval policy, and audit records remain in force.
      </p>

      <h2>Practical safety rules</h2>
      <ul>
        <li>Never share a pairing URL or unredacted screenshot containing one.</li>
        <li>Keep the OS, Node, provider CLI, browser, and LongLeash current.</li>
        <li>Review the session, folder, tool, and input before approving.</li>
        <li>Revoke devices you no longer control and use a device passcode.</li>
        <li>Run <code>longleash doctor</code> after every update.</li>
      </ul>
      <p>
        For implementation-level review, the{' '}
        <a href={`${REPOSITORY}/blob/main/docs/ARCHITECTURE.md`}>architecture source</a> remains public.
      </p>
    </DocsLayout>
  )
}

function Portability() {
  return (
    <DocsLayout
      path="/docs/session-portability"
      title="One conversation. One active writer."
      summary="LongLeash preserves provider-native conversation IDs and only moves control after the current writer has verifiably released it."
    >
      <h2>Why the one-writer rule exists</h2>
      <p>
        Two interfaces writing the same live provider conversation can reorder messages, duplicate
        tools, or corrupt ownership. LongLeash therefore treats Terminal, VS Code, and phone control
        as mutually exclusive writers to one conversation.
      </p>
      <div className="portable-flow">
        <span>Terminal or VS Code</span><ArrowRight aria-hidden="true" /><span>verified release</span>
        <ArrowRight aria-hidden="true" /><span>LongLeash</span>
      </div>

      <h2>Phone to Terminal</h2>
      <p>
        Open the session, reveal <b>Terminal handoff</b>, stop/release the live process if needed,
        copy the command, and run it on the laptop. Claude and Codex use their own native resume IDs.
      </p>

      <h2>Phone to VS Code</h2>
      <p>
        The workspace handoff opens the correct folder. Claude can resume through its CLI/IDE
        connection. Codex resumes in the VS Code terminal today. LongLeash does not claim it can
        inject an existing thread into another vendor extension’s private chat panel.
      </p>

      <h2>Terminal or VS Code to phone</h2>
      <p>
        Choose the explicit transfer control option. The daemon reserves the checkout, asks the
        verified native process to end, confirms its exit, then resumes the same conversation as a
        managed session. If confirmation fails, the transfer is cancelled and the original owner remains.
      </p>

      <h2>Parallel work in one Git project</h2>
      <p>
        A second managed agent can use <b>Safe parallel</b>. LongLeash creates an isolated worktree
        and branch so each agent writes different filesystems. It never auto-merges, commits, pushes,
        or deletes that work. Non-Git directories remain sequential.
      </p>
      <div className="doc-callout safe">
        <GitBranch size={19} aria-hidden="true" />
        <p><b>Conversation portability and code parallelism are different.</b> A handoff moves one conversation; a worktree isolates a second writer.</p>
      </div>
    </DocsLayout>
  )
}

function Faq() {
  return (
    <DocsLayout
      path="/docs/faq"
      title="Straight answers before you install."
      summary="The current public preview is local-first and honest about hosted identity, provider, and platform boundaries."
    >
      <Question q="Do I need a LongLeash account?">
        The official hosted app requires a free LongLeash account through Google or verified email. A QR is still
        required for each laptop: account identity and device authority are separate. LAN and
        self-hosted use remain accountless. Provider logins stay with Claude Code or Codex.
      </Question>
      <Question q="Does my laptop need to stay awake?">
        Yes. Your laptop runs the agents and daemon. Relay mode reaches it from another network, but
        LongLeash cannot operate a sleeping, powered-off, or disconnected machine.
      </Question>
      <Question q="Can I use cellular data?">
        Yes, when the daemon reports a configured relay and the app shows <code>linked · relay</code>.
        Direct mode is an optional same-network path.
      </Question>
      <Question q="Which agents work today?">
        Claude Code and Codex. LongLeash uses structured provider integrations and lifecycle hooks;
        it does not screen-scrape arbitrary agent TUIs.
      </Question>
      <Question q="Can I change model, effort, or thinking mid-session?">
        Managed sessions expose Tune for settings the provider supports. An externally controlled
        Terminal or VS Code session must explicitly transfer to LongLeash first so there is one writer.
      </Question>
      <Question q="Can two agents work in the same project?">
        Yes for managed sessions in a clean Git repository through Safe parallel worktrees. Two agents
        must not write the same physical checkout. Non-Git folders remain sequential.
      </Question>
      <Question q="Is LongLeash free?">
        The repository is MIT licensed. You still need your own provider access. Hosted relay and
        future team or premium services may develop separate pricing; nothing on this page promises an unshipped tier.
      </Question>
      <Question q="Is the VS Code companion available?">
        Not publicly yet. Its secure protocol, package verification, compatibility checks, and native
        session-tree foundation exist. Authenticated live daemon sync is the next engineering checkpoint.
      </Question>
    </DocsLayout>
  )
}

function Roadmap() {
  return (
    <DocsLayout
      path="/roadmap"
      eyebrow="Product roadmap"
      title="Built in gates, not promises."
      summary="Available means tested and usable today. In development means code or evidence exists but the public release gate has not passed. Planned means direction, not a date."
    >
      <RoadmapStage state="Available now" tone="shipped" title="Phase 1 — control and reviewed delegation">
        Claude and Codex sessions; approvals and replies; stop; provider-aware tuning; terminal
        handoffs; safe parallel phone launches; and human-reviewed agent-to-agent briefings and returns.
      </RoadmapStage>
      <RoadmapStage state="Checkpoint saved" tone="building" title="Phase 2A — VS Code companion">
        The authenticated protocol contract, fail-closed provider compatibility, workspace-trust
        policy, verified VSIX packaging, live host evidence, and typed native session tree are built.
        The exact next slice is authenticated daemon-to-extension snapshot sync with reconnect and stale-cursor tests.
      </RoadmapStage>
      <RoadmapStage state="Next after 2A" tone="planned" title="Parallel specialists and review">
        Multiple isolated children, explicit scope and budgets, comparison, return review, and safe
        merge UX. Human checkpoints remain visible; LongLeash will not hide an unbounded autonomous loop.
      </RoadmapStage>
      <RoadmapStage state="Future" tone="planned" title="Optional commercial services">
        Billing entitlements and team administration may extend the hosted account plane. Provider
        credentials, repositories, and transcripts remain outside it, and local/self-hosted use remains free.
      </RoadmapStage>
      <div className="doc-callout">
        <FileCode2 size={19} aria-hidden="true" />
        <p>
          Maintainers can inspect the granular <a href={`${REPOSITORY}/blob/main/PLAN.md`}>engineering plan</a>{' '}
          and <a href={`${REPOSITORY}/blob/main/docs/PHASE2A-CHECKPOINT.md`}>Phase 2A checkpoint</a> on GitHub.
        </p>
      </div>
    </DocsLayout>
  )
}

function Privacy() {
  return (
    <DocsLayout
      path="/privacy"
      eyebrow="Legal & trust"
      title="Privacy by a smaller data boundary."
      summary="This notice describes the account-enabled public preview and the deliberately small hosted data boundary."
    >
      <p className="effective">Effective 15 August 2026</p>
      <h2>What the hosted account contains</h2>
      <p>
        The official hosted app uses Clerk for authentication. You may sign in with Google, an email
        verification code, or email and password. LongLeash never receives or stores your password. The account
        may contain a stable account identifier, name, email address, profile image, sign-in times,
        and security/session metadata needed to prevent abuse. LongLeash currently has no advertising,
        mailing-list, payment, or product-analytics integration and does not sell personal information.
      </p>
      <h2>Development data stays local</h2>
      <p>
        Repositories, provider credentials, agent processes, transcript history, approval records,
        and the durable audit database stay on the laptop running LongLeash. The phone receives
        current content only after an authenticated, encrypted connection.
      </p>
      <h2>Pairing credentials stay in the browser and laptop</h2>
      <p>
        Each hosted account receives a separate browser storage slot for its paired-device token,
        relay key, and relay address. Those credentials are not uploaded to Clerk or Google. A
        short-lived signed relay ticket contains an opaque one-way account tag, room, role, and
        expiry; it cannot decrypt session traffic and is not stored as conversation history.
      </p>
      <h2>Relay and hosting metadata</h2>
      <p>
        The hosted relay processes encrypted frames and normal network metadata needed to route a
        connection, such as IP addresses, timestamps, frame sizes, and opaque room identifiers. It
        does not have the keys required to read frame content and stores no conversation history.
        Cloudflare may process ordinary security and operational data as the hosting provider.
      </p>
      <h2>Push notifications</h2>
      <p>
        If enabled, push messages contain identifiers needed to wake and route the app—not prompt,
        source code, path, transcript, or approval content. The app fetches the current item after reconnecting.
      </p>
      <h2>Processors and purpose</h2>
      <p>
        Cloudflare hosts the public site, static app, abuse controls, and encrypted relay; Clerk
        provides account, credential, verification, and session management; Google verifies identity
        only when you choose Google sign-in. LongLeash requests only basic OpenID identity scopes—name,
        email, and profile—not Gmail, Drive, source
        repositories, or provider accounts. Each processor may handle ordinary network and security
        metadata under its own terms and privacy notice.
      </p>
      <h2>Retention, export, and deletion</h2>
      <p>
        Account records remain until you delete the account or they must be retained for security or
        legal obligations. Open the account control in the app header to download the hosted account
        fields LongLeash exposes or permanently delete the account. Deletion also clears that
        account’s credentials from the current browser; laptop-local transcripts are outside the
        hosted account and must be managed on the laptop. You may also contact{' '}
        <a href="mailto:privacy@longleash.dev">privacy@longleash.dev</a> for an access, correction,
        export, or deletion request, subject to applicable law and identity verification.
      </p>
      <h2>Security and privacy contact</h2>
      <p>
        Use <a href="mailto:security@longleash.dev">security@longleash.dev</a> for private security
        reports and <a href="mailto:support@longleash.dev">support@longleash.dev</a> for ordinary
        questions. Do not place pairing links, tokens, private code, or exploit details in a public
        issue. The public <a href={`${REPOSITORY}/issues`}>issue tracker</a> is only for redacted,
        non-sensitive reports.
      </p>
    </DocsLayout>
  )
}

function Terms() {
  return (
    <DocsLayout
      path="/terms"
      eyebrow="Legal"
      title="Terms of Service"
      summary="Rules for the free hosted public preview. The MIT license continues to govern the open-source code itself."
    >
      <p className="effective">Effective 15 August 2026</p>
      <h2>Agreement and operator</h2>
      <p>
        These terms govern use of the LongLeash-hosted website, account service, and encrypted relay,
        operated by Sahith Reddy Thummala. By using the hosted service you agree to these terms and
        the <a href={siteHref('/privacy')}>Privacy Notice</a>. If you do not agree, use the MIT-licensed
        source locally or stop using the hosted service.
      </p>
      <h2>Eligibility and your responsibilities</h2>
      <p>
        You must be legally able to enter this agreement and use LongLeash only with computers,
        repositories, provider accounts, and data you are authorized to control. You are responsible
        for securing your LongLeash sign-in method, phone, laptop, pairing links, provider subscriptions, and
        actions approved through the product.
      </p>
      <h2>Acceptable use</h2>
      <p>
        Do not use the hosted service to gain unauthorized access; distribute malware; evade provider
        or network controls; interfere with another user; probe rooms or accounts you do not own;
        overload the relay; violate law or third-party rights; or expose another person’s secrets.
        LongLeash may rate-limit, suspend, or terminate access needed to protect users and infrastructure.
      </p>
      <h2>Third-party services</h2>
      <p>
        Claude, Codex, Google, Clerk, Cloudflare, GitHub, and any other third-party service have their
        own terms, availability, and fees. LongLeash does not include an AI subscription and cannot
        grant rights those providers do not give you.
      </p>
      <h2>Preview availability and changes</h2>
      <p>
        The hosted service is a free public preview. Features may change, be rate-limited, or be
        discontinued, and temporary outages may occur. Material changes to these terms or the hosted
        data boundary will be published before they take effect when reasonably possible.
      </p>
      <h2>Open-source license and feedback</h2>
      <p>
        Repository code is offered under the <a href={siteHref('/license')}>MIT License</a>. These
        service terms do not remove rights granted by that license. You may provide feedback; unless
        separately agreed, LongLeash may use it without obligation while respecting confidential information.
      </p>
      <h2>Disclaimers and liability</h2>
      <p>
        To the maximum extent permitted by applicable law, the preview is provided “as is” and “as
        available,” without warranties. You remain responsible for reviewing agent output, approvals,
        backups, repository state, and consequences of commands. To the maximum extent permitted by
        law, LongLeash is not liable for indirect, incidental, special, consequential, or lost-profit
        damages arising from the free hosted preview. Rights that cannot legally be excluded remain unaffected.
      </p>
      <h2>Ending use and contact</h2>
      <p>
        You may stop using the service and delete your account at any time. LongLeash may suspend or
        end hosted access for breach, abuse, security risk, or service closure. Questions about these
        terms may be sent to <a href="mailto:support@longleash.dev">support@longleash.dev</a>.
      </p>
    </DocsLayout>
  )
}

function License() {
  return (
    <DocsLayout
      path="/license"
      eyebrow="Legal"
      title="MIT License"
      summary="LongLeash is open-source software. This is the complete license text shipped in the repository."
    >
      <pre className="license-copy">{LICENSE_TEXT}</pre>
      <p>
        The canonical plain-text copy is also available in the <a href={`${REPOSITORY}/blob/main/LICENSE`}>source repository</a>.
      </p>
    </DocsLayout>
  )
}

function NotFound() {
  return (
    <main className="public-main not-found" id="main">
      <p className="land-label">404</p>
      <h1>This page is not on the leash.</h1>
      <p>The address may have changed. The documentation index and product remain available.</p>
      <div className="hero-acts">
        <a className="key primary" href={siteHref('/docs')}>Open documentation</a>
        <a className="tap" href={siteHref('/')}>Return home</a>
      </div>
    </main>
  )
}

function ModelStep({ icon: Icon, title, body }: { icon: typeof Laptop; title: string; body: string }) {
  return <span className="model-step"><Icon size={20} aria-hidden="true" /><span><b>{title}</b><small>{body}</small></span></span>
}

function Definition({ term, body }: { term: string; body: string }) {
  return <div><dt>{term}</dt><dd>{body}</dd></div>
}

function Question({ q, children }: { q: string; children: ReactNode }) {
  return <section className="faq-item"><h2>{q}</h2><p>{children}</p></section>
}

function RoadmapStage({ state, tone, title, children }: { state: string; tone: string; title: string; children: ReactNode }) {
  return <section className="roadmap-stage"><span className={`road-state ${tone}`}>{state}</span><h2>{title}</h2><p>{children}</p></section>
}

function CodeBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="doc-code">
      <pre><code>{command}</code></pre>
      <button type="button" onClick={() => void copy()} aria-label="Copy command">
        {copied ? <Check size={15} aria-hidden="true" /> : <Clipboard size={15} aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
