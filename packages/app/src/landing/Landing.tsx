import { useEffect, useState } from 'react'
import { motion, useReducedMotion, type Variants } from 'motion/react'
import {
  ArrowRight,
  Check,
  FileCode2,
  FolderOpen,
  GitBranch,
  Inbox,
  Lock,
  Search,
  Settings,
  SquareTerminal,
  Timer,
} from 'lucide-react'
import { SPRING } from '../ui/primitives.js'

/**
 * The landing page tells one story: the approval — the last thing chaining you
 * to the desk — arrives on your lock screen, and you answer it from wherever
 * you are. The hero phone plays that exact moment on a loop.
 */
export function Landing() {
  return (
    <div className="land">
      <header className="land-rail">
        <span className="land-mark">
          <img src="/icon-192.png" alt="" width={30} height={30} />
          Long<i>Leash</i>
        </span>
        <a className="key sm" href="/">
          Open the app
        </a>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Open source · Self-hosted · Free</p>
            <h1>
              Say <em>yes</em> from anywhere.
            </h1>
            <p className="lede">
              Your laptop&rsquo;s AI agents do the work. LongLeash puts their questions on your
              phone — read what an agent is doing, steer it, and approve the risky steps from the
              couch, the queue, or the other side of the world. End-to-end encrypted the whole way.
            </p>
            <div className="hero-acts">
              <a className="key primary" href="/">
                Open the app
                <ArrowRight size={17} strokeWidth={2.4} aria-hidden="true" />
              </a>
              <a className="tap" href="#how">
                See how it works
              </a>
            </div>
          </div>
          <LockPhone />
        </section>

        <section className="how" id="how">
          <h2 className="land-label">How it works</h2>
          <ol className="steps">
            <li>
              <span className="n">01</span>
              <div>
                <h3>Run the daemon</h3>
                <p>
                  <code>longleashd</code> runs on your laptop beside your agents. Nothing opens a
                  port to the internet — it only dials out.
                </p>
              </div>
            </li>
            <li>
              <span className="n">02</span>
              <div>
                <h3>Pair once</h3>
                <p>
                  Paste one link from your terminal into your phone. That exchange creates the
                  keys; there is no account to make and no password to forget.
                </p>
              </div>
            </li>
            <li>
              <span className="n">03</span>
              <div>
                <h3>Answer from anywhere</h3>
                <p>
                  When an agent needs a human, the question lands on your phone. Approve it, deny
                  it, or type what it should do instead.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section className="trust">
          <h2 className="land-label">Built like it matters</h2>
          <ul className="claims">
            <li>
              <h3>End-to-end encrypted</h3>
              <p>
                The relay routes ciphertext it cannot read. Keys live on your two devices and
                nowhere else.
              </p>
            </li>
            <li>
              <h3>No accounts, no user database</h3>
              <p>
                Pairing is the identity. There is no signup wall in front of your own laptop — and
                no honeypot of credentials to breach.
              </p>
            </li>
            <li>
              <h3>Notifications carry nothing</h3>
              <p>
                Push payloads are IDs, never content. Your code and conversations never transit a
                notification service.
              </p>
            </li>
            <li>
              <h3>No remote shell</h3>
              <p>
                The phone speaks a small, typed protocol. There is no generic exec endpoint to
                abuse, and every mutating call is audit-logged.
              </p>
            </li>
          </ul>
          <p className="honesty">
            LongLeash can capture supported Terminal and VS Code sessions, but it cannot inject a
            resumed conversation into a vendor&rsquo;s sealed VS Code chat panel. When something
            can&rsquo;t be done faithfully, it says so — it never pretends.
          </p>
        </section>
      </main>

      <footer className="land-foot">
        <span>
          <LeashGlyph size={16} /> LongLeash
        </span>
        <span className="mono">build {__BUILD__}</span>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------------ hero phone */

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

/**
 * A lock screen, machined from our materials, playing the product's defining
 * moment on a loop: an approval arrives, a thumb answers it, life goes on.
 * Reduced motion holds the notification steady instead of cycling.
 */
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
      for (const t of timers) clearTimeout(t)
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

        <motion.div
          className="notif"
          variants={notifVariants}
          initial="shown"
          animate={phase}
        >
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
            (Glyph, i) => (
              <span className="phone-key" key={i}>
                <Glyph size={20} strokeWidth={1.8} />
                {i === 5 ? <span className="phone-badge">1</span> : null}
              </span>
            ),
          )}
        </div>
      </div>
      <div className="phone-fade" />
      <p className="phone-caption">
        <b>The moment that matters.</b> An agent hit something only you can answer — and you are
        not at your desk. Now that&rsquo;s fine.
      </p>
    </motion.div>
  )
}

/** The leash: anchored at your phone, clipped to an agent far away. */
function LeashGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <circle cx="9" cy="26" r="5.5" fill="currentColor" />
      <path
        d="M9 26C21 26 19 11 31 11"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      <circle cx="31" cy="11" r="4.2" fill="var(--sage)" />
    </svg>
  )
}
