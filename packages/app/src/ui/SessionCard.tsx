import { motion, useReducedMotion } from 'motion/react'
import { ChevronRight, Radio } from 'lucide-react'
import type { SessionView } from '../lib/store.js'
import { Led, SPRING } from './primitives.js'
import { AGENT_LABEL, ORIGIN_LABEL, STATUS_LABEL } from './format.js'
import { PathChip } from './PathChip.js'

/**
 * A machined key the width of the screen. The card itself is a div so the
 * path chip can be a real second button: the opener button stretches its hit
 * area across the whole card (via CSS ::after), while the chip sits above it
 * — tap the card to open the session, tap the path to unfold the full path.
 * Nesting one button inside another would be invalid HTML; this is the
 * accessible version of "a card with two actions".
 */
export function SessionCard({
  session,
  pending,
  onOpen,
}: {
  session: SessionView
  pending: number
  onOpen: () => void
}) {
  const preview = session.output.trim().slice(-180)
  const past = session.status === 'ended' || session.status === 'errored' || !session.live
  const status = !session.live && session.status === 'waiting'
    ? 'ready to reopen'
    : (STATUS_LABEL[session.status] ?? session.status)
  const still = useReducedMotion()

  return (
    <motion.article
      layout="position"
      transition={SPRING}
      className={`session${pending > 0 ? ' needs' : ''}${past ? ' past' : ''}`}
    >
      <button type="button" className="opener" onClick={onOpen}>
        <Led status={session.status} />
        {/* Shared with the detail header: opening a session, its title physically
            glides from this card into the headline — the card does not vanish and
            get replaced, it BECOMES the screen you are now on. */}
        <motion.h3
          className="name"
          {...(still ? {} : { layoutId: `title-${session.sessionId}` })}
          transition={SPRING}
        >
          {session.title || session.sessionId}
        </motion.h3>
        <ChevronRight className="chev" size={18} strokeWidth={2.2} aria-hidden="true" />
      </button>

      <p className="meta">
        <span className="sessiontag agenttag" data-agent={session.agent}>
          {AGENT_LABEL[session.agent] ?? session.agent}
        </span>
        <span className="dot" aria-hidden="true">·</span>
        <span className={`state ${session.status}`}>
          {status}
        </span>
        <span className="dot" aria-hidden="true">·</span>
        <PathChip text={session.cwd} kind="folder" max={26} expandable />
        <span className="dot" aria-hidden="true">·</span>
        <span className="sessiontag origintag" data-origin={session.origin}>
          {ORIGIN_LABEL[session.origin] ?? session.origin}
        </span>
      </p>

      {pending > 0 ? (
        <span className="flag">
          <Radio size={13} strokeWidth={2.4} aria-hidden="true" />
          {pending === 1 ? '1 decision waiting' : `${pending} decisions waiting`}
        </span>
      ) : null}

      {preview ? <p className="preview">{preview}</p> : null}
    </motion.article>
  )
}
