import { motion, useReducedMotion } from 'motion/react'
import { ChevronRight, Radio } from 'lucide-react'
import type { SessionView } from '../lib/store.js'
import { Led, SPRING } from './primitives.js'
import { STATUS_LABEL } from './format.js'
import { PathChip } from './PathChip.js'
import { ProviderMark, SurfaceMark } from './SessionMarks.js'
import { activityTime } from '../lib/activity-time.js'

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
  children,
  onOpen,
  settling = false,
  searchMatch,
}: {
  session: SessionView
  pending: number
  children?: { total: number; active: number; ready: number }
  onOpen: () => void
  /** Reconnect replay is one state replacement, not a sequence the user should watch animate. */
  settling?: boolean
  /** The matching message excerpt when this card was found through transcript search. */
  searchMatch?: string
}) {
  const preview = session.output.trim().slice(-180)
  const past = session.status === 'ended' || session.status === 'errored' || !session.live
  const status = session.control === 'observe'
    ? 'observed in VS Code'
    : !session.live && session.status === 'waiting'
    ? 'ready to reopen'
    : (STATUS_LABEL[session.status] ?? session.status)
  const still = useReducedMotion()
  const activity = activityTime(session.lastActivityAt ?? session.startedAt)

  return (
    <motion.article
      layout={settling ? false : 'position'}
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
        <span className="sessionidentity">
          <ProviderMark agent={session.agent} />
          <span className={`state ${session.status}`}>
            {status}
          </span>
          <span className="identitydivider" aria-hidden="true" />
          <SurfaceMark origin={session.surface ?? session.origin} />
        </span>
        <PathChip text={session.cwd} kind="folder" max={26} expandable />
        {activity ? (
          <time className="sessiontime" dateTime={activity.dateTime} title={activity.title}>
            {activity.label}
          </time>
        ) : null}
        {session.settings?.mode ? (
          <span className="sessiontag modetag">{session.settings.mode}</span>
        ) : null}
        {session.relationship ? (
          <span className="sessiontag childtag">
            child · {session.relationship.role}
          </span>
        ) : null}
        {children && children.total > 0 ? (
          <span className="sessiontag parenttag">
            parent · {children.active > 0
              ? `${children.active} active`
              : children.ready > 0
                ? `${children.ready} ready`
                : `${children.total} ${children.total === 1 ? 'child' : 'children'}`}
          </span>
        ) : null}
      </p>

      {pending > 0 ? (
        <span className="flag">
          <Radio size={13} strokeWidth={2.4} aria-hidden="true" />
          {pending === 1 ? '1 decision waiting' : `${pending} decisions waiting`}
        </span>
      ) : null}

      {searchMatch ? (
        <p className="sessionmatch"><span>Match</span>{searchMatch}</p>
      ) : preview ? <p className="preview">{preview}</p> : null}
    </motion.article>
  )
}
