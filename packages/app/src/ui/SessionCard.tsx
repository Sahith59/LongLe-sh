import { motion } from 'motion/react'
import { ChevronRight, Radio } from 'lucide-react'
import type { SessionView } from '../lib/store.js'
import { Led, SPRING, itemVariants } from './primitives.js'
import { ORIGIN_LABEL, STATUS_LABEL, shortPath } from './format.js'
import { PathChip } from './PathChip.js'

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
  const past = session.status === 'ended' || session.status === 'errored'

  return (
    <motion.button
      type="button"
      variants={itemVariants}
      className={`session${pending > 0 ? ' needs' : ''}${past ? ' past' : ''}`}
      onClick={onOpen}
      whileTap={{ scale: 0.985 }}
      transition={SPRING}
    >
      <div className="top">
        <Led status={session.status} />
        <h3 className="name">{session.title || session.sessionId}</h3>
        <ChevronRight className="chev" size={18} strokeWidth={2.2} aria-hidden="true" />
      </div>

      <p className="meta">
        <span className={`state ${session.status}`}>
          {STATUS_LABEL[session.status] ?? session.status}
        </span>
        <span className="dot" aria-hidden="true">·</span>
        <PathChip text={shortPath(session.cwd)} kind="folder" max={26} />
        <span className="dot" aria-hidden="true">·</span>
        <span>{ORIGIN_LABEL[session.origin] ?? session.origin}</span>
      </p>

      {pending > 0 ? (
        <span className="flag">
          <Radio size={13} strokeWidth={2.4} aria-hidden="true" />
          {pending === 1 ? '1 decision waiting' : `${pending} decisions waiting`}
        </span>
      ) : null}

      {preview ? <p className="preview">{preview}</p> : null}
    </motion.button>
  )
}
