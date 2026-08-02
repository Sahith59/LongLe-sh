import type { ReactNode } from 'react'
import { motion, type Transition, type Variants } from 'motion/react'
import { TriangleAlert, X } from 'lucide-react'

/** One motion vocabulary for the whole app, so nothing feels borrowed from elsewhere. */
export const SPRING: Transition = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 }
export const EASE: Transition = { duration: 0.26, ease: [0.22, 0.61, 0.24, 1] }
export const EXIT: Transition = { duration: 0.16, ease: [0.4, 0, 1, 1] }

export const listVariants: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.04 } },
}

export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: EASE },
}

/**
 * A status light seated in a drilled socket. Colour alone never carries the meaning — every
 * LED in this app sits next to the same state written as words.
 */
export function Led({ status, large }: { status: string; large?: boolean }) {
  return <span className={`led ${status}${large ? ' lg' : ''}`} aria-hidden="true" />
}

export function SectionLabel({
  children,
  count,
  urgent,
  action,
}: {
  children: ReactNode
  count?: number
  urgent?: boolean
  action?: ReactNode
}) {
  return (
    <div className="label">
      <span>{children}</span>
      {count !== undefined && count > 0 ? (
        <span className={`count${urgent ? ' urgent' : ''}`}>{count}</span>
      ) : null}
      <span className="rule" />
      {action}
    </div>
  )
}

/** A key on the panel: extrudes at rest, sinks under the thumb, never moves its neighbours. */
export function Key({
  children,
  onClick,
  className = '',
  disabled,
  label,
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
  disabled?: boolean
  label?: string
}) {
  return (
    <motion.button
      type="button"
      className={`key ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      {...(disabled ? {} : { whileTap: { scale: 0.975 } })}
      transition={SPRING}
    >
      {children}
    </motion.button>
  )
}

export function Notice({
  children,
  tone = 'warn',
  onDismiss,
}: {
  children: ReactNode
  tone?: 'warn' | 'bad'
  onDismiss?: () => void
}) {
  return (
    <motion.div
      className={`notice ${tone === 'bad' ? 'bad' : ''}`}
      role="status"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, transition: EXIT }}
      transition={EASE}
    >
      <TriangleAlert size={17} strokeWidth={2} />
      <span className="body">{children}</span>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss">
          <X size={17} strokeWidth={2.2} />
        </button>
      ) : null}
    </motion.div>
  )
}
