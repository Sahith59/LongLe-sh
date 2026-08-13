import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, SlidersHorizontal, X } from 'lucide-react'
import type { SessionSettings } from '@longleash/protocol'
import type { AgentSettingsCatalog } from '../lib/client.js'
import type { SessionView } from '../lib/store.js'
import { EXIT, Key, SPRING, useKeyboardInset, useVisualViewportHeight } from './primitives.js'
import { AGENT_LABEL, shortPath } from './format.js'
import {
  SessionSettingsFields,
  settingsDraft,
  settingsFromDraft,
} from './SessionSettingsFields.js'

export interface UpdateSessionSettingsInput {
  requestId: string
  sessionId: string
  settings: SessionSettings
  externalTransferConfirmed: boolean
}

export interface SettingsUpdateState {
  requestId: string
  state: 'saving' | 'saved' | 'failed'
  outcome?: 'next-response' | 'next-continuation'
  error?: string
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `settings-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function SessionSettingsSheet({
  open,
  session,
  connected,
  catalog,
  update,
  onSave,
  onClose,
}: {
  open: boolean
  session: SessionView
  connected: boolean
  catalog?: AgentSettingsCatalog
  update: SettingsUpdateState | null
  onSave: (input: UpdateSessionSettingsInput) => boolean
  onClose: () => void
}) {
  const keyboard = useKeyboardInset(open)
  const viewportHeight = useVisualViewportHeight(open)
  const still = useReducedMotion()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const agent = session.agent === 'codex' ? 'codex' : 'claude'
  const [draft, setDraft] = useState(() => settingsDraft(session.settings ?? {}, catalog, agent))
  const [transferConfirmed, setTransferConfirmed] = useState(false)
  const parsed = useMemo(() => settingsFromDraft(draft, agent), [draft, agent])
  const live = session.live && (session.status === 'running' || session.status === 'waiting')
  const externallyControlled = live && session.controller === 'external'
  const externalSurface = session.origin === 'vscode' ? 'VS Code' : 'Terminal'
  const saving = update?.state === 'saving'

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const node = dialogRef.current
    node?.querySelector<HTMLElement>('button, select, input')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [open, onClose, saving])

  const submit = () => {
    if (!connected || saving || parsed.error !== undefined || (externallyControlled && !transferConfirmed)) return
    onSave({
      requestId: requestId(),
      sessionId: session.sessionId,
      settings: parsed.settings,
      externalTransferConfirmed: externallyControlled && transferConfirmed,
    })
  }

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: EXIT }} onClick={saving ? undefined : onClose} />
          <motion.div
            ref={dialogRef}
            className="sheet settings-sheet"
            style={{
              ...(keyboard > 0 ? { bottom: keyboard } : {}),
              ...(viewportHeight === null ? {} : { maxHeight: `${Math.max(180, viewportHeight - 8)}px` }),
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Model and reasoning settings"
            initial={still ? false : { y: '100%' }}
            animate={{ y: 0 }}
            {...(still ? {} : { exit: { y: '100%', transition: EXIT } })}
            transition={SPRING}
          >
            <div className="sheetbar">
              <div className="grab" aria-hidden="true" />
              <button type="button" className="sheetclose" disabled={saving} onClick={onClose} aria-label="Close settings">
                <X size={19} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
            <div className="sheet-in">
              <div className="settings-title">
                <span className="delegate-mark" aria-hidden="true"><SlidersHorizontal size={18} strokeWidth={2.2} /></span>
                <div>
                  <h2>Model &amp; reasoning</h2>
                  <p className="sub">Tune {AGENT_LABEL[agent]} without losing this conversation.</p>
                </div>
              </div>

              <div className="settings-evidence">
                <span className="k">Session</span>
                <strong>{session.title || 'Untitled session'}</strong>
                <span className="mono">{shortPath(session.cwd)}</span>
              </div>

              <SessionSettingsFields
                agent={agent}
                value={draft}
                onChange={setDraft}
                disabled={saving || update?.state === 'saved'}
                {...(catalog === undefined ? {} : { catalog })}
              />

              <p className={`settings-impact${parsed.error ? ' bad' : ''}`} role="status">
                {parsed.error
                  ? parsed.error
                  : externallyControlled
                    ? `This process is still controlled by ${externalSurface}. LongLeash must end that process first; the native conversation ID and transcript are preserved.`
                    : live
                      ? 'Applies to the next response. A response already in progress finishes unchanged.'
                      : 'Saved now and applied when you next continue this conversation.'}
              </p>

              {externallyControlled ? (
                <label className="takeover-confirm settings-transfer">
                  <input
                    type="checkbox"
                    checked={transferConfirmed}
                    disabled={saving}
                    onChange={(event) => setTransferConfirmed(event.target.checked)}
                  />
                  <span className="takeover-check" aria-hidden="true"><Check size={15} strokeWidth={2.7} /></span>
                  <span>
                    <strong>Move control to LongLeash</strong>
                    <small>
                      End the {externalSurface} process, preserve conversation {session.resumeId ?? 'ID'}, and use these settings on the next phone turn.
                    </small>
                  </span>
                </label>
              ) : null}

              <Key
                className="primary wide settings-save"
                disabled={!connected || saving || parsed.error !== undefined || (externallyControlled && !transferConfirmed)}
                onClick={update?.state === 'saved' ? onClose : submit}
              >
                {update?.state === 'saved'
                  ? 'Done'
                  : saving
                    ? 'Applying safely…'
                    : connected
                      ? 'Apply to this conversation'
                      : 'Waiting for your laptop…'}
              </Key>
              <p className={`delegate-status${update?.state === 'failed' ? ' bad' : ''}`} aria-live="polite">
                {update?.state === 'failed'
                  ? update.error
                  : update?.state === 'saved'
                    ? update.outcome === 'next-response'
                      ? `Saved. The next response will request these controls from ${AGENT_LABEL[agent]}.`
                      : `Saved. The next continuation will request these controls from ${AGENT_LABEL[agent]}.`
                    : 'Approval and workspace safety are unchanged.'}
              </p>
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  )
}
