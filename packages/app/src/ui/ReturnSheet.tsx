import { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowDownLeft, Check, Clipboard, ShieldAlert, X } from 'lucide-react'
import type { DelegationReturnPreview, DelegationSummary } from '@longleash/protocol'
import {
  newReturnIdempotencyKey,
  readReturnDraft,
  removeReturnDraft,
  writeReturnDraft,
} from '../lib/delegation-return-draft.js'
import { EXIT, Key, SPRING, useKeyboardInset, useVisualViewportHeight } from './primitives.js'

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `return-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export interface ReturnDelegationInput {
  requestId: string
  idempotencyKey: string
  delegationId: string
  returnText: string
  takeoverConfirmed: boolean
}

export function ReturnSheet({
  open,
  delegation,
  preview,
  error,
  connected,
  onPrepare,
  onReturn,
  onClose,
}: {
  open: boolean
  delegation: DelegationSummary
  preview: DelegationReturnPreview | null
  error: { requestId: string; message: string } | null
  connected: boolean
  onPrepare: (input: { requestId: string; delegationId: string }) => boolean
  onReturn: (input: ReturnDelegationInput) => boolean
  onClose: () => void
}) {
  const keyboard = useKeyboardInset(open)
  const viewportHeight = useVisualViewportHeight(open)
  const still = useReducedMotion()
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]',
    ) ?? [])
    focusable()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); previous?.focus() }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: EXIT }} onClick={onClose} />
          <motion.div
            ref={dialogRef}
            className="sheet return-sheet"
            style={{
              ...(keyboard > 0 ? { bottom: keyboard } : {}),
              ...(viewportHeight === null ? {} : { maxHeight: `${Math.max(180, viewportHeight - 8)}px` }),
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Review delegated return"
            initial={still ? false : { y: '100%' }}
            animate={{ y: 0 }}
            {...(still ? {} : { exit: { y: '100%', transition: EXIT } })}
            transition={SPRING}
          >
            <div className="sheetbar">
              <div className="grab" aria-hidden="true" />
              <button type="button" className="sheetclose" onClick={onClose} aria-label="Close reviewed return">
                <X size={19} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
            <div className="sheet-in">
              <ReturnBody
                key={delegation.delegationId}
                delegation={delegation}
                preview={preview}
                error={error}
                connected={connected}
                onPrepare={onPrepare}
                onReturn={onReturn}
              />
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  )
}

function ReturnBody({
  delegation,
  preview,
  error,
  connected,
  onPrepare,
  onReturn,
}: {
  delegation: DelegationSummary
  preview: DelegationReturnPreview | null
  error: { requestId: string; message: string } | null
  connected: boolean
  onPrepare: (input: { requestId: string; delegationId: string }) => boolean
  onReturn: (input: ReturnDelegationInput) => boolean
}) {
  const saved = readReturnDraft(delegation.delegationId)
  const matchingPreview = preview?.delegationId === delegation.delegationId ? preview : null
  const [returnText, setReturnText] = useState(saved?.returnText ?? matchingPreview?.returnText ?? '')
  const [idempotencyKey, setIdempotencyKey] = useState(saved?.idempotencyKey ?? newReturnIdempotencyKey())
  const [prepareId, setPrepareId] = useState<string | null>(null)
  const [returnId, setReturnId] = useState<string | null>(null)
  const [takeoverConfirmed, setTakeoverConfirmed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const editorId = useId()
  const currentError = error !== null && (error.requestId === prepareId || error.requestId === returnId)
    ? error.message
    : null
  const preparing = prepareId !== null && matchingPreview?.requestId !== prepareId && currentError === null
  const returning = returnId !== null && currentError === null && delegation.status !== 'returned'
  const limit = matchingPreview?.context.maxCharacters ?? 24_000
  const overLimit = returnText.length > limit
  const canReturn = connected && matchingPreview !== null && returnText.trim() !== '' && !overLimit && !returning &&
    (matchingPreview?.requiresTakeover !== true || takeoverConfirmed)

  useEffect(() => {
    if (matchingPreview === null || matchingPreview.requestId !== prepareId) return
    setReturnText((current) => current === '' ? matchingPreview.returnText : current)
    setPrepareId(null)
  }, [matchingPreview, prepareId])

  useEffect(() => {
    writeReturnDraft({ delegationId: delegation.delegationId, idempotencyKey, returnText, updatedAt: Date.now() })
  }, [delegation.delegationId, idempotencyKey, returnText])

  const prepare = () => {
    const next = requestId()
    setPrepareId(next)
    onPrepare({ requestId: next, delegationId: delegation.delegationId })
  }
  const deliver = () => {
    if (!canReturn) return
    const next = requestId()
    setReturnId(next)
    onReturn({
      requestId: next,
      idempotencyKey,
      delegationId: delegation.delegationId,
      returnText,
      takeoverConfirmed,
    })
  }
  const copy = () => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(returnText).then(() => {
      setCopyState('copied'); setTimeout(() => setCopyState('idle'), 2200)
    }).catch(() => setCopyState('failed'))
  }

  return (
    <>
      <div className="delegate-title">
        <span className="delegate-mark return-mark" aria-hidden="true"><ArrowDownLeft size={18} strokeWidth={2.2} /></span>
        <div>
          <h2>Review return</h2>
          <p className="sub">Read and edit the child’s completed result before it crosses back.</p>
        </div>
      </div>

      <div className="return-route" aria-label="Return route">
        <span><small>From child</small><strong>{matchingPreview?.child.title ?? delegation.targetAgent}</strong></span>
        <ArrowDownLeft size={17} strokeWidth={2.2} aria-hidden="true" />
        <span><small>Into parent</small><strong>{matchingPreview?.parent.title ?? 'source session'}</strong></span>
      </div>
      {matchingPreview ? (
        <p className="return-attribution">
          <span>Attached attribution</span>
          {matchingPreview.attribution}
        </p>
      ) : null}

      {matchingPreview === null && returnText === '' ? (
        <>
          <Key className="primary wide return-prepare" disabled={!connected || preparing} onClick={prepare}>
            {preparing ? 'Preparing completed result…' : 'Prepare return draft'}
          </Key>
          <p className={`delegate-status${currentError ? ' bad' : ''}`} role="status" aria-live="polite">
            {currentError ?? 'Only the child’s last completed prose response is selected. Tools and thinking stay out.'}
          </p>
        </>
      ) : (
        <>
          {matchingPreview === null ? (
            <Key className="secondary wide return-prepare" disabled={!connected || preparing} onClick={prepare}>
              {preparing ? 'Verifying current route…' : 'Verify parent and child'}
            </Key>
          ) : null}
          <div className="briefing-editor return-editor">
            <div className="briefing-head">
              <label htmlFor={editorId}>Reviewed return</label>
              <button type="button" className="tap quiet" onClick={copy} aria-label="Copy reviewed return">
                {copyState === 'copied' ? <Check size={14} strokeWidth={2.4} aria-hidden="true" /> : <Clipboard size={14} strokeWidth={2.2} aria-hidden="true" />}
                {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Select to copy' : 'Copy'}
              </button>
            </div>
            <textarea
              id={editorId}
              className="field briefing-field return-field"
              value={returnText}
              onChange={(event) => setReturnText(event.target.value)}
              disabled={returning}
              rows={14}
              aria-describedby={`${editorId}-meta`}
            />
            <div className="briefing-meta" id={`${editorId}-meta`}>
              <span>{returnText.length.toLocaleString()} / {limit.toLocaleString()} characters</span>
              {matchingPreview?.context.truncated ? <span>Middle shortened — review carefully</span> : null}
              <button type="button" className="tap quiet" onClick={() => {
                removeReturnDraft(delegation.delegationId)
                setReturnText(matchingPreview?.returnText ?? '')
              }}>Reset edits</button>
            </div>
          </div>

          {matchingPreview?.requiresTakeover ? (
            <label className="takeover-confirm">
              <input
                type="checkbox"
                checked={takeoverConfirmed}
                onChange={(event) => setTakeoverConfirmed(event.target.checked)}
                disabled={returning}
              />
              <span className="takeover-check" aria-hidden="true"><Check size={15} strokeWidth={2.7} /></span>
              <span>
                <strong><ShieldAlert size={15} strokeWidth={2.2} aria-hidden="true" /> Take over the parent first</strong>
                <small>Its Terminal or VS Code process will stop, then this reviewed return continues the same conversation from LongLeash.</small>
              </span>
            </label>
          ) : null}

          <div className="delegate-confirm return-confirm">
            <strong>Return exactly this reviewed text</strong>
            <p>The child releases the checkout first. The parent becomes the sole writer and receives visible source attribution.</p>
            <Key className="primary wide return-launch" disabled={!canReturn} onClick={deliver}>
              <ArrowDownLeft size={17} strokeWidth={2.4} aria-hidden="true" />
              {returning ? 'Returning to parent…' : 'Return to parent'}
            </Key>
            <p className={`delegate-status${currentError || overLimit ? ' bad' : ''}`} role="status" aria-live="polite">
              {currentError
                ? currentError
                : overLimit
                  ? `Return is ${(returnText.length - limit).toLocaleString()} characters over the limit.`
                  : !connected
                    ? 'Waiting for your laptop. This edited draft remains saved.'
                    : matchingPreview === null
                      ? 'Verify the current parent, child, and takeover state before delivery.'
                    : matchingPreview?.requiresTakeover && !takeoverConfirmed
                      ? 'Confirm the explicit takeover before delivery.'
                      : returning
                        ? 'Delivery accepted. Waiting for the parent conversation…'
                        : 'Nothing is delivered until you press this button.'}
            </p>
            {currentError !== null && returnId !== null ? (
              <button
                type="button"
                className="tap quiet return-new-attempt"
                onClick={() => {
                  setIdempotencyKey(newReturnIdempotencyKey())
                  setReturnId(null)
                }}
              >
                I checked the parent — create a new delivery attempt
              </button>
            ) : null}
          </div>
        </>
      )}
    </>
  )
}
