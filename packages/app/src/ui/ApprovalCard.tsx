import { Fragment, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowRight, Ban, Check, Plus, ShieldAlert } from 'lucide-react'
import type { PendingApproval } from '../lib/store.js'
import { EXIT, Key, SPRING } from './primitives.js'
import { toolIcon } from './format.js'

/**
 * The decision surface — the reason this product exists. It arrives with a spring so it is
 * impossible to miss, and states plainly what is about to happen before either answer is
 * offered. Deny is given equal weight and its own colour rather than being hidden behind the
 * primary button, because approving by reflex is the failure mode that matters here.
 *
 * Everything optional is collapsed. Two of these have to fit on a phone screen at once, or
 * triaging a busy morning means scrolling past decisions you have not made yet.
 */
export function ApprovalCard({
  approval,
  context,
  onDecide,
  onOpen,
}: {
  approval: PendingApproval
  /** Which session is asking. Only meaningful in the console, where several may be waiting. */
  context?: string
  onDecide: (approval: PendingApproval, verdict: 'allow' | 'deny', reply?: string) => void
  onOpen?: () => void
}) {
  const [reply, setReply] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const Glyph = approval.outsideRoot ? ShieldAlert : toolIcon(approval.toolName)

  return (
    <motion.article
      layout
      className={`approval${approval.outsideRoot ? ' outside' : ''}`}
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: EXIT }}
      transition={SPRING}
    >
      <div className="head">
        <span className="sigil">
          <Glyph size={17} strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="headtext">
          <h3>
            Claude wants to run <strong>{approval.toolName}</strong>
          </h3>
          <p className="who">{context ?? 'Nothing happens until you answer.'}</p>
        </div>
      </div>

      <code className="arg">
        <Breakable text={approval.inputSummary} />
      </code>

      {approval.outsideRoot ? (
        <p className="breach">
          <ShieldAlert size={16} strokeWidth={2.1} aria-hidden="true" />
          <span>
            Outside your project folder —{' '}
            <span className="mono">
              <Breakable text={approval.targetPath ?? ''} />
            </span>
          </span>
        </p>
      ) : null}

      <div className="verdict">
        <Key className="deny" onClick={() => onDecide(approval, 'deny', reply || undefined)}>
          <Ban size={17} strokeWidth={2.2} aria-hidden="true" />
          Deny
        </Key>
        <Key className="primary" onClick={() => onDecide(approval, 'allow')}>
          <Check size={18} strokeWidth={2.6} aria-hidden="true" />
          Approve
        </Key>
      </div>

      {noteOpen ? (
        <motion.input
          className="field note"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Tell Claude what to do instead…"
          aria-label="Note to send with your denial"
          autoFocus
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 48 }}
          transition={SPRING}
        />
      ) : (
        <div className="approvalfoot">
          <button type="button" className="tap quiet" onClick={() => setNoteOpen(true)}>
            <Plus size={14} strokeWidth={2.6} aria-hidden="true" />
            Add a note
          </button>
          {onOpen ? (
            <button type="button" className="tap" onClick={onOpen}>
              Open session
              <ArrowRight size={14} strokeWidth={2.3} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      )}
    </motion.article>
  )
}

/**
 * Long paths have no natural break opportunity, so the browser either overflows the card or
 * chops a word mid-letter. Offering a break after each separator makes it wrap where a reader
 * expects. `<wbr>` leaves the copied text untouched, unlike a zero-width space.
 */
function Breakable({ text }: { text: string }) {
  const parts = text.split('/')
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? '/' : ''}
          {i > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  )
}
