import { useEffect, useState, type ReactNode } from 'react'
import { motion, type Transition } from 'motion/react'
import { TriangleAlert, X } from 'lucide-react'

/**
 * How much of the layout viewport the on-screen keyboard is covering, in px.
 *
 * On iOS the keyboard does not resize the page — it slides OVER it, and any
 * fixed bottom-anchored surface (the new-session sheet, the reply dock) ends
 * up behind the keys, forcing a manual scroll to reach what you were typing
 * toward. The visual viewport is the only API that knows the keyboard's true
 * size, so those surfaces are lifted by exactly that.
 */
export function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    if (!active) {
      setInset(0)
      return
    }
    const vv = window.visualViewport
    if (!vv) return
    const update = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [active])
  return inset
}

/** The actually visible height after mobile browser chrome and the software keyboard. */
export function useVisualViewportHeight(active: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    if (!active) {
      setHeight(null)
      return
    }
    const vv = window.visualViewport
    if (!vv) {
      setHeight(window.innerHeight)
      return
    }
    const update = () => setHeight(Math.round(vv.height))
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [active])
  return height
}

/** One motion vocabulary for the whole app, so nothing feels borrowed from elsewhere. */
export const SPRING: Transition = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 }
export const EASE: Transition = { duration: 0.26, ease: [0.22, 0.61, 0.24, 1] }
export const EXIT: Transition = { duration: 0.16, ease: [0.4, 0, 1, 1] }

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
  pressed,
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
  disabled?: boolean
  label?: string
  pressed?: boolean
}) {
  return (
    <motion.button
      type="button"
      className={`key ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      {...(disabled ? {} : { whileTap: { y: 1, scale: 0.985 } })}
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
