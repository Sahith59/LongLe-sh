import { useEffect, useState } from 'react'
import { motion, useReducedMotion, type Variants } from 'motion/react'
import {
  ArrowRight,
  BellRing,
  BookOpen,
  Check,
  Clipboard,
  FileCode2,
  FolderOpen,
  GitBranch,
  Inbox,
  Lock,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  Timer,
  Wrench,
} from 'lucide-react'
import { SPRING } from '../ui/primitives.js'
import { PublicPageRouter } from './PublicPages.js'
import {
  INSTALL_COMMAND,
  REPOSITORY,
  SiteFooter,
  SiteHeader,
  appHref,
  currentSitePath,
  siteHref,
} from './SiteChrome.js'

const docs = [
  {
    title: 'Start here',
    body: 'Requirements, installation, pairing, daily use, updates, and honest limits.',
    href: '/docs/getting-started',
    icon: BookOpen,
  },
  {
    title: 'Choose your connection',
    body: 'Compare the hosted relay, your own relay, and LAN-only operation before setup.',
    href: '/docs/connectivity',
    icon: Radio,
  },
  {
    title: 'Troubleshooting',
    body: 'Symptom-first fixes for pairing, hooks, stale state, handoffs, and connection errors.',
    href: '/docs/troubleshooting',
    icon: Wrench,
  },
  {
    title: 'Security model',
    body: 'What the laptop, phone, and relay can see, plus where LongLeash deliberately stops.',
    href: '/docs/security',
    icon: ShieldCheck,
  },
  {
    title: 'Session portability',
    body: 'Move work between phone, Terminal, and VS Code without creating two writers.',
    href: '/docs/session-portability',
    icon: SquareTerminal,
  },
]

export function Landing() {
  const publicPath = currentSitePath()
  if (publicPath !== '/') return <PublicPageRouter path={publicPath} />

  const openApp = appHref()

  return (
    <div className="land">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <SiteHeader />

      <main id="main">
        <section className="hero" id="top">
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="live-dot" aria-hidden="true" /> Public preview · Open source
            </p>
            <h1>
              Your agents keep working. <em>You can leave the desk.</em>
            </h1>
            <p className="lede">
              Run Claude Code and Codex on your laptop, then read, steer, approve, stop, tune, and
              hand off their sessions from your phone. Your laptop stays in control; LongLeash is
              the secure control surface in your pocket.
            </p>
            <div className="hero-acts">
              <a className="key primary" href={siteHref('/#start')}>
                Install in five minutes
                <ArrowRight size={17} strokeWidth={2.4} aria-hidden="true" />
              </a>
              <a className="tap" href={openApp}>
                Already paired? Open app
              </a>
            </div>
            <p className="hero-fine">
              macOS or Linux · Node.js 22+ · your existing Claude or Codex login · free hosted account
            </p>
          </div>
          <LockPhone />
        </section>

        <section className="signal-strip" aria-label="Current product support">
          <span>
            <b>Claude Code</b> managed + observed sessions
          </span>
          <span>
            <b>Codex</b> managed + observed sessions
          </span>
          <span>
            <b>Anywhere</b> encrypted relay
          </span>
        </section>

        <section className="product" id="product">
          <SectionHeading
            eyebrow="What ships today"
            title="One place to see what needs you."
            body="This is working software, not a concept page. See Claude Code and Codex sessions, make typed decisions, preserve provider conversations, and delegate work with a human review point."
          />
          <div className="feature-grid">
            <Feature
              icon={Inbox}
              title="Sessions and approvals"
              body="See phone, Terminal, and VS Code sessions with clear provider and origin labels. Approve, deny, answer, steer, or stop from the exact session."
            />
            <Feature
              icon={GitBranch}
              title="Safe parallel work"
              body="Start a second writer in the same Git project through an isolated worktree instead of letting two agents overwrite one checkout."
            />
            <Feature
              icon={Settings}
              title="Model and reasoning controls"
              body="Choose model, effort, and supported thinking settings at launch, during a managed conversation, or for a reviewed delegated child."
            />
            <Feature
              icon={Radio}
              title="Reviewed agent delegation"
              body="Build and edit a briefing on your phone, start a Claude or Codex child, then review its return before anything reaches the parent."
            />
            <Feature
              icon={SquareTerminal}
              title="Exact terminal handoff"
              body="Copy a provider-native resume command and move the same conversation back to your keyboard without pretending a new chat is the old one."
            />
            <Feature
              icon={BellRing}
              title="Private notifications"
              body="Push notifications wake the app with identifiers only. Prompt, code, path, and approval content are fetched after the encrypted link reconnects."
            />
          </div>
        </section>

        <section className="system">
          <SectionHeading
            eyebrow="How it works"
            title="The powerful part never leaves your laptop."
            body="LongLeash is a control plane, not a hosted coding environment. Your provider credentials, repositories, agent processes, transcripts, and durable audit data stay local."
          />
          <div className="system-flow" aria-label="LongLeash data flow">
            <div className="flow-node">
              <span className="flow-icon">
                <SquareTerminal aria-hidden="true" />
              </span>
              <div>
                <b>Your laptop</b>
                <span>daemon · agents · code · keys</span>
              </div>
            </div>
            <span className="flow-link">
              <Lock size={13} aria-hidden="true" /> sealed frames
            </span>
            <div className="flow-node">
              <span className="flow-icon">
                <Radio aria-hidden="true" />
              </span>
              <div>
                <b>Relay</b>
                <span>routes ciphertext · stores no history</span>
              </div>
            </div>
            <span className="flow-link">
              <Lock size={13} aria-hidden="true" /> sealed frames
            </span>
            <div className="flow-node">
              <span className="flow-icon">
                <Smartphone aria-hidden="true" />
              </span>
              <div>
                <b>Your phone</b>
                <span>review · decide · steer</span>
              </div>
            </div>
          </div>
          <div className="truth-row">
            <p>
              <b>Two separate locks.</b> Your verified account identifies the hosted user; a fresh QR grants one
              browser authority over one laptop. Local/self-hosted use stays accountless.
            </p>
            <p>
              <b>No generic remote shell.</b> The phone can call a small typed protocol, not execute
              arbitrary commands behind your back.
            </p>
            <p>
              <b>No public port at home.</b> The daemon dials outward to the relay; router changes
              and inbound firewall holes are unnecessary.
            </p>
          </div>
        </section>

        <section className="start" id="start">
          <SectionHeading
            eyebrow="Start in five minutes"
            title="Laptop first. Phone second."
            body="LongLeash does not include Claude or Codex. Install and sign in to at least one provider CLI first, then follow this path."
          />

          <div className="install-shell">
            <div className="install-head">
              <span>
                <SquareTerminal size={17} aria-hidden="true" /> Terminal
              </span>
              <span className="mono">macOS · Linux</span>
            </div>
            <code>{INSTALL_COMMAND}</code>
            <CopyCommand command={INSTALL_COMMAND} />
          </div>
          <p className="inspect-note">
            Prefer to inspect before running?{' '}
            <a href={`${REPOSITORY}/tree/main/packages/cli`}>Read the CLI package source</a> and{' '}
            <a href={`${REPOSITORY}/blob/main/docs/NPM-RELEASE.md`}>release controls</a> first.
          </p>

          <ol className="steps">
            <li>
              <span className="n">01</span>
              <div>
                <h3>Install LongLeash</h3>
                <p>
                  Setup never uses <code>sudo</code>. It verifies the pinned npm package, installs
                  under your home directory, reviews roots and connectivity, and wires supported hooks.
                </p>
              </div>
            </li>
            <li>
              <span className="n">02</span>
              <div>
                <h3>Keep the laptop ready</h3>
                <p>
                  Accept the recommended per-user background service, or deliberately choose{' '}
                  <code>longleash run ~/code</code> and keep that foreground terminal open.
                </p>
              </div>
            </li>
            <li>
              <span className="n">03</span>
              <div>
                <h3>Install the phone app, sign in, then pair</h3>
                <p>
                  On iPhone, open the hosted app in Safari and add it to your home screen first.
                  Open that installed copy, sign in with Google or verified email, then use its
                  scanner on the fresh QR. Require the header to say{' '}
                  <code>linked · relay</code> or <code>linked · direct</code>. Pairing links are
                  single-use secrets.
                </p>
              </div>
            </li>
            <li>
              <span className="n">04</span>
              <div>
                <h3>Verify before relying on it</h3>
                <p>
                  Run <code>longleash doctor</code>. The daemon must be reachable, every installed
                  hook must be current, and laptop, daemon, and relay builds must agree.
                </p>
              </div>
            </li>
          </ol>

          <div className="first-run">
            <div>
              <span className="land-stamp">FIRST REAL TEST</span>
              <h3>Start with a harmless task</h3>
              <p>
                Ask Claude or Codex to inspect a small folder, trigger one approval, answer it from
                the phone, stop the session, then reopen it from the terminal handoff. Only move to
                important work after that loop behaves correctly on your devices and network.
              </p>
            </div>
            <a className="key" href={siteHref('/docs/getting-started#first-test')}>
              Open acceptance checklist
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        </section>

        <section className="docs" id="docs">
          <SectionHeading
            eyebrow="Documentation"
            title="Answers before guesswork."
            body="Read the complete guides here without leaving the product site. GitHub remains available when you want source code or the issue tracker."
          />
          <div className="docs-grid">
            {docs.map(({ title, body, href, icon: Icon }) => (
              <a className="doc-card" href={siteHref(href)} key={title}>
                <span className="doc-icon">
                  <Icon size={19} aria-hidden="true" />
                </span>
                <span>
                  <b>{title}</b>
                  <span>{body}</span>
                </span>
                <ArrowRight size={15} aria-hidden="true" />
              </a>
            ))}
          </div>
          <div className="support-line">
            <span>
              Something failed? Run <code>longleash doctor</code> before restarting anything.
            </span>
            <span>
              <a href={siteHref('/docs/troubleshooting')}>Open troubleshooting</a>
              {' · '}
              <a href={`${REPOSITORY}/issues/new`}>Report on GitHub</a>
            </span>
          </div>
        </section>

        <section className="roadmap" id="roadmap">
          <SectionHeading
            eyebrow="Roadmap"
            title="What works. What comes next."
            body="See the product you can use today and the capabilities we are proving next. Building means active work, not a promised date."
          />
          <div className="roadmap-grid">
            <article>
              <span className="roadmap-card-icon"><Smartphone size={19} aria-hidden="true" /></span>
              <span className="road-state shipped">Available now</span>
              <h3>Phone control and reviewed delegation</h3>
              <p>
                Claude and Codex sessions, approvals, tuning, handoffs, safe parallel phone starts,
                and human-reviewed agent-to-agent briefing and return flows.
              </p>
            </article>
            <article>
              <span className="roadmap-card-icon"><SquareTerminal size={19} aria-hidden="true" /></span>
              <span className="road-state shipped">Available now</span>
              <h3>Reliable install and background service</h3>
              <p>
                Verified npm distribution, a per-user background service, authenticated health,
                redacted logs, clean removal, and safe foreground fallback.
              </p>
            </article>
            <article>
              <span className="roadmap-card-icon"><ShieldCheck size={19} aria-hidden="true" /></span>
              <span className="road-state building">Building</span>
              <h3>Verified pairing and local operations</h3>
              <p>A phone-to-terminal matching code and a local service, device, session, and update dashboard.</p>
            </article>
            <article>
              <span className="roadmap-card-icon"><FileCode2 size={19} aria-hidden="true" /></span>
              <span className="road-state building">Building</span>
              <h3>VS Code companion and agent setup</h3>
              <p>
                Authenticated IDE visibility plus a local MCP that can plan setup, diagnose failures,
                and apply only the changes you approve.
              </p>
            </article>
          </div>
          <div className="honesty">
            <ShieldCheck size={19} aria-hidden="true" />
            <p>
              <b>An honest platform boundary:</b> LongLeash never writes into another extension’s
              private chat webview. Unsupported native-panel continuation fails visibly and keeps
              a copyable terminal fallback. The companion extension will use only documented or
              LongLeash-owned surfaces.
            </p>
          </div>
          <a className="roadmap-link" href={siteHref('/roadmap')}>
            Read the public roadmap <ArrowRight size={16} aria-hidden="true" />
          </a>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string
  title: string
  body: string
}) {
  return (
    <div className="section-heading">
      <p className="land-label">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  )
}

function Feature({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Inbox
  title: string
  body: string
}) {
  return (
    <article className="feature">
      <span className="feature-icon">
        <Icon size={19} aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  )
}

function CopyCommand({ command }: { command: string }) {
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
    <button className="copy-command" type="button" onClick={() => void copy()}>
      {copied ? <Check size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

const NOTIF_CYCLE_MS = 6200

const notifVariants: Variants = {
  hidden: { y: -84, scale: 0.9, opacity: 0, filter: 'blur(6px)' },
  shown: {
    y: 0,
    scale: 1,
    opacity: 1,
    filter: 'blur(0px)',
    transition: { type: 'spring', stiffness: 320, damping: 28 },
  },
  answered: {
    y: -84,
    scale: 0.92,
    opacity: 0,
    filter: 'blur(4px)',
    transition: { duration: 0.3, ease: [0.4, 0, 1, 1] },
  },
}

function LockPhone() {
  const still = useReducedMotion()
  const [phase, setPhase] = useState<'hidden' | 'shown' | 'answered'>('shown')

  useEffect(() => {
    if (still) return
    let alive = true
    const timers: ReturnType<typeof setTimeout>[] = []
    const cycle = () => {
      if (!alive) return
      setPhase('shown')
      timers.push(setTimeout(() => alive && setPhase('answered'), 3600))
      timers.push(setTimeout(() => alive && setPhase('hidden'), 4100))
      timers.push(setTimeout(cycle, NOTIF_CYCLE_MS))
    }
    timers.push(setTimeout(cycle, 1200))
    return () => {
      alive = false
      for (const timer of timers) clearTimeout(timer)
    }
  }, [still])

  return (
    <motion.div
      className="phone"
      initial={{ opacity: 0, y: 26 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      aria-hidden="true"
    >
      <div className="phone-screen">
        <div className="phone-status">
          <span className="phone-time">
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          </span>
          <span className={`phone-lock${phase === 'answered' ? ' open' : ''}`}>
            <Lock size={13} strokeWidth={2.4} />
          </span>
        </div>

        <motion.div className="notif" variants={notifVariants} initial="shown" animate={phase}>
          <span className="notif-icon">
            <img src="/icon-192.png" alt="" width={32} height={32} />
          </span>
          <span className="notif-body">
            <span className="notif-top">
              <b>LongLeash</b>
              <span className="notif-ago">now</span>
            </span>
            <span className="notif-text">
              Claude wants to run <b>Bash</b> in ~/LongLeash
            </span>
          </span>
          <span className="notif-tick" data-on={phase === 'answered' ? 'y' : 'n'}>
            <Check size={13} strokeWidth={3} />
          </span>
        </motion.div>

        <div className="phone-grid">
          {[SquareTerminal, GitBranch, FileCode2, Search, FolderOpen, Inbox, Timer, Settings].map(
            (Glyph, index) => (
              <span className="phone-key" key={index}>
                <Glyph size={20} strokeWidth={1.8} />
                {index === 5 ? <span className="phone-badge">1</span> : null}
              </span>
            ),
          )}
        </div>
      </div>
      <div className="phone-fade" />
      <p className="phone-caption">
        <b>The moment that matters.</b> An agent hit something only you can answer, and you are not
        at your desk. Now that is fine.
      </p>
    </motion.div>
  )
}
