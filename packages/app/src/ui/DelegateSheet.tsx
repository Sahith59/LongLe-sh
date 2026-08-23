import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Check,
  Clipboard,
  FlaskConical,
  GitBranchPlus,
  SearchCheck,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react'
import type {
  DelegationContextScope,
  DelegationPreview,
  DelegationRole,
  DelegationTargetAgent,
  SessionSettings,
} from '@longleash/protocol'
import type { SessionView } from '../lib/store.js'
import type { AgentSettingsCatalog } from '../lib/client.js'
import {
  readDelegationDraft,
  newDelegationIdempotencyKey,
  removeDelegationDraft,
  writeDelegationDraft,
} from '../lib/delegation-draft.js'
import { EXIT, Key, SPRING, useKeyboardInset, useVisualViewportHeight } from './primitives.js'
import {
  SessionSettingsFields,
  settingsDraft,
  settingsFromDraft,
} from './SessionSettingsFields.js'
import { ProviderMark } from './SessionMarks.js'

const AGENT_NAME: Record<DelegationTargetAgent, string> = { claude: 'Claude', codex: 'Codex' }
const AGENT_DETAIL: Record<DelegationTargetAgent, string> = {
  claude: 'Anthropic agent',
  codex: 'OpenAI agent',
}

const ROLES: Array<{
  value: DelegationRole
  label: string
  detail: string
  Icon: typeof SearchCheck
}> = [
  { value: 'investigate', label: 'Investigate', detail: 'Find cause + evidence', Icon: SearchCheck },
  { value: 'review', label: 'Review', detail: 'Check work + gaps', Icon: ShieldCheck },
  { value: 'implement', label: 'Implement', detail: 'Make the change', Icon: Wrench },
  { value: 'test', label: 'Test', detail: 'Verify behavior', Icon: FlaskConical },
]

const SCOPES: Array<{ value: DelegationContextScope; label: string; detail: string }> = [
  { value: 'selected', label: 'This message', detail: 'Exact message only' },
  { value: 'recent', label: 'Recent', detail: 'Last conversation turns' },
  { value: 'task', label: 'Whole task', detail: 'All retained conversation' },
]

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sourceKey(session: SessionView, sourceSeq?: number): string {
  return `${session.sessionId}:${sourceSeq ?? 'session'}`
}

export interface PreviewDelegationInput {
  requestId: string
  sourceSessionId: string
  sourceSeq?: number
  targetAgent: DelegationTargetAgent
  role: DelegationRole
  contextScope: DelegationContextScope
}

export interface StartDelegationInput extends Omit<PreviewDelegationInput, 'requestId'> {
  requestId: string
  idempotencyKey: string
  briefing: string
  settings?: SessionSettings
}

export function DelegateSheet({
  open,
  session,
  sourceSeq,
  connected,
  preview,
  previewError,
  onPreview,
  onStart = () => false,
  launchEnabled = false,
  workspaceMode = 'legacy',
  availableTargets = { claude: false, codex: false },
  settingsCatalog,
  onClose,
}: {
  open: boolean
  session: SessionView
  sourceSeq?: number
  connected: boolean
  preview: DelegationPreview | null
  previewError: { requestId: string; message: string } | null
  onPreview: (input: PreviewDelegationInput) => boolean
  onStart?: (input: StartDelegationInput) => boolean
  launchEnabled?: boolean
  workspaceMode?: 'legacy' | 'sequential'
  availableTargets?: { claude: boolean; codex: boolean }
  settingsCatalog?: AgentSettingsCatalog
  onClose: () => void
}) {
  const keyboard = useKeyboardInset(open)
  const viewportHeight = useVisualViewportHeight(open)
  const still = useReducedMotion()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter((node) => node.getAttribute('aria-hidden') !== 'true')
    focusable()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previouslyFocused?.focus()
    }
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            className="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: EXIT }}
            onClick={onClose}
          />
          <motion.div
            ref={dialogRef}
            className="sheet delegate-sheet"
            style={{
              ...(keyboard > 0 ? { bottom: keyboard } : {}),
              ...(viewportHeight === null ? {} : { maxHeight: `${Math.max(180, viewportHeight - 8)}px` }),
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Delegate work to another agent"
            initial={still ? false : { y: '100%' }}
            animate={{ y: 0 }}
            {...(still ? {} : { exit: { y: '100%', transition: EXIT } })}
            transition={SPRING}
          >
            <div className="sheetbar">
              <div className="grab" aria-hidden="true" />
              <button type="button" className="sheetclose" onClick={onClose} aria-label="Close delegation">
                <X size={19} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
            <div className="sheet-in">
              <DelegateBody
                key={sourceKey(session, sourceSeq)}
                session={session}
                {...(sourceSeq === undefined ? {} : { sourceSeq })}
                connected={connected}
                preview={preview}
                previewError={previewError}
                onPreview={onPreview}
                onStart={onStart}
                launchEnabled={launchEnabled}
                workspaceMode={workspaceMode}
                availableTargets={availableTargets}
                {...(settingsCatalog === undefined ? {} : { settingsCatalog })}
              />
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  )
}

function DelegateBody({
  session,
  sourceSeq,
  connected,
  preview,
  previewError,
  onPreview,
  onStart,
  launchEnabled,
  workspaceMode,
  availableTargets,
  settingsCatalog,
}: {
  session: SessionView
  sourceSeq?: number
  connected: boolean
  preview: DelegationPreview | null
  previewError: { requestId: string; message: string } | null
  onPreview: (input: PreviewDelegationInput) => boolean
  onStart: (input: StartDelegationInput) => boolean
  launchEnabled: boolean
  workspaceMode: 'legacy' | 'sequential'
  availableTargets: { claude: boolean; codex: boolean }
  settingsCatalog?: AgentSettingsCatalog
}) {
  const saved = useMemo(() => readDelegationDraft(session.sessionId, sourceSeq), [session.sessionId, sourceSeq])
  const initialPreview =
    preview?.source.sessionId === session.sessionId && preview.sourceSeq === sourceSeq
      ? preview
      : null
  const defaultTarget: DelegationTargetAgent = session.agent === 'claude' ? 'codex' : 'claude'
  const [targetAgent, setTargetAgent] = useState<DelegationTargetAgent>(
    saved?.targetAgent ?? initialPreview?.targetAgent ?? defaultTarget,
  )
  const [role, setRole] = useState<DelegationRole>(saved?.role ?? initialPreview?.role ?? 'review')
  const [contextScope, setContextScope] = useState<DelegationContextScope>(
    saved?.contextScope ?? initialPreview?.contextScope ?? (sourceSeq === undefined ? 'recent' : 'selected'),
  )
  const [briefing, setBriefing] = useState(saved?.briefing ?? initialPreview?.briefing ?? '')
  const [childSettings, setChildSettings] = useState(() =>
    settingsDraft(saved?.settings ?? {}, settingsCatalog, saved?.targetAgent ?? initialPreview?.targetAgent ?? defaultTarget),
  )
  const [idempotencyKey, setIdempotencyKey] = useState(
    saved?.idempotencyKey ?? newDelegationIdempotencyKey(),
  )
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [launchId, setLaunchId] = useState<string | null>(null)
  const [transferConfirmed, setTransferConfirmed] = useState(false)
  const [builtSignature, setBuiltSignature] = useState<string | null>(
    saved?.briefing
      ? `${saved.targetAgent}:${saved.role}:${saved.contextScope}:${sourceSeq ?? ''}`
      : initialPreview
        ? `${initialPreview.targetAgent}:${initialPreview.role}:${initialPreview.contextScope}:${sourceSeq ?? ''}`
        : null,
  )
  const [lastPreviewId, setLastPreviewId] = useState<string | null>(initialPreview?.requestId ?? null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const skipNextSave = useRef(false)
  const editorId = useId()
  const signature = `${targetAgent}:${role}:${contextScope}:${sourceSeq ?? ''}`
  const currentError = pendingId !== null && previewError?.requestId === pendingId ? previewError.message : null
  const building = pendingId !== null && preview?.requestId !== pendingId && currentError === null
  const stale = briefing !== '' && builtSignature !== null && builtSignature !== signature
  const briefingLimit =
    preview?.requestId === lastPreviewId ? preview.context.maxCharacters : 24_000
  const overLimit = briefing.length > briefingLimit
  const launchError = launchId !== null && previewError?.requestId === launchId ? previewError.message : null
  const launching = launchId !== null && launchError === null
  const targetAvailable = availableTargets[targetAgent]
  const parsedSettings = useMemo(
    () => settingsFromDraft(childSettings, targetAgent),
    [childSettings, targetAgent],
  )
  const canLaunch =
    connected && launchEnabled && workspaceMode === 'sequential' && transferConfirmed &&
    targetAvailable && briefing !== '' && !stale && !overLimit && !launching && parsedSettings.error === undefined

  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    writeDelegationDraft({
      idempotencyKey,
      sourceSessionId: session.sessionId,
      ...(sourceSeq === undefined ? {} : { sourceSeq }),
      targetAgent,
      role,
      contextScope,
      briefing,
      ...(Object.keys(parsedSettings.settings).length === 0 ? {} : { settings: parsedSettings.settings }),
      updatedAt: Date.now(),
    })
  }, [session.sessionId, sourceSeq, targetAgent, role, contextScope, briefing, idempotencyKey, parsedSettings.settings])

  useEffect(() => {
    if (launchError === null) return
    // A refused/failed attempt is durably terminal when it crossed the daemon. A fresh key
    // makes an explicit retry a new operation; transport duplicates keep the old key.
    setIdempotencyKey(newDelegationIdempotencyKey())
  }, [launchError])

  useEffect(() => {
    if (pendingId === null || preview?.requestId !== pendingId) return
    setBriefing(preview.briefing)
    setBuiltSignature(`${preview.targetAgent}:${preview.role}:${preview.contextScope}:${preview.sourceSeq ?? ''}`)
    setLastPreviewId(preview.requestId)
    setPendingId(null)
  }, [pendingId, preview])

  const build = () => {
    const nextRequestId = requestId()
    setPendingId(nextRequestId)
    onPreview({
      requestId: nextRequestId,
      sourceSessionId: session.sessionId,
      ...(sourceSeq === undefined ? {} : { sourceSeq }),
      targetAgent,
      role,
      contextScope,
    })
  }

  const copy = () => {
    if (!navigator.clipboard || briefing === '') return
    void navigator.clipboard.writeText(briefing)
      .then(() => {
        setCopyState('copied')
        setTimeout(() => setCopyState('idle'), 2200)
      })
      .catch(() => setCopyState('failed'))
  }

  const launch = () => {
    if (!canLaunch) return
    const nextRequestId = requestId()
    setLaunchId(nextRequestId)
    onStart({
      requestId: nextRequestId,
      idempotencyKey,
      sourceSessionId: session.sessionId,
      ...(sourceSeq === undefined ? {} : { sourceSeq }),
      targetAgent,
      role,
      contextScope,
      briefing,
      ...(Object.keys(parsedSettings.settings).length === 0 ? {} : { settings: parsedSettings.settings }),
    })
  }

  return (
    <>
      <div className="delegate-title">
        <span className="delegate-mark" aria-hidden="true"><GitBranchPlus size={18} strokeWidth={2.2} /></span>
        <div>
          <h2>Delegate</h2>
          <p className="sub">
            Build the exact handoff, edit it on your phone, then review it before anything starts.
          </p>
        </div>
      </div>

      <div className="delegate-source" aria-label="Delegation source">
        <span className="k">From</span>
        <strong>{session.title || 'Untitled session'}</strong>
        <span className="mono">{sourceSeq === undefined ? 'recent context' : `message ${sourceSeq}`}</span>
      </div>

      <fieldset className="delegate-fieldset">
        <legend><span className="step-number" aria-hidden="true">1</span> Agent</legend>
        <div className="agentpick" role="group" aria-label="Target agent">
          {(['claude', 'codex'] as const).map((option) => {
            const picked = targetAgent === option
            return (
              <Key
                key={option}
                className={`agentoption${picked ? ' picked' : ''}`}
                pressed={picked}
                label={`Delegate to ${AGENT_NAME[option]}`}
                disabled={launching || !availableTargets[option]}
                onClick={() => {
                  setTargetAgent(option)
                  setChildSettings(settingsDraft({}, settingsCatalog, option))
                }}
              >
                <ProviderMark agent={option} decorative />
                <span className="agentcopy"><strong>{AGENT_NAME[option]}</strong><small>{availableTargets[option] ? AGENT_DETAIL[option] : 'Not available on laptop'}</small></span>
                <Check className="agentcheck" size={17} strokeWidth={2.7} aria-hidden="true" />
              </Key>
            )
          })}
        </div>
      </fieldset>

      <details className="session-settings delegate-settings">
        <summary>Child model &amp; reasoning</summary>
        <p>Optional. These controls belong only to the new child and can be changed later.</p>
        <SessionSettingsFields
          agent={targetAgent}
          value={childSettings}
          onChange={setChildSettings}
          disabled={launching}
          {...(settingsCatalog === undefined ? {} : { catalog: settingsCatalog })}
        />
        <small className="settingsnote">
          {parsedSettings.error ?? 'Provider defaults are used for anything you leave unchanged.'}
        </small>
      </details>

      <fieldset className="delegate-fieldset">
        <legend><span className="step-number" aria-hidden="true">2</span> Role</legend>
        <div className="rolepick">
          {ROLES.map(({ value, label, detail, Icon }) => (
            <Key
              key={value}
              className={`roleoption${role === value ? ' picked' : ''}`}
              pressed={role === value}
              disabled={launching}
              onClick={() => setRole(value)}
            >
              <Icon size={16} strokeWidth={2.1} aria-hidden="true" />
              <span><strong>{label}</strong><small>{detail}</small></span>
            </Key>
          ))}
        </div>
      </fieldset>

      <fieldset className="delegate-fieldset">
        <legend><span className="step-number" aria-hidden="true">3</span> Context</legend>
        <div className="scopepick">
          {SCOPES.map(({ value, label, detail }) => {
            const disabled = value === 'selected' && sourceSeq === undefined
            return (
              <Key
                key={value}
                className={`scopeoption${contextScope === value ? ' picked' : ''}`}
                pressed={contextScope === value}
                disabled={disabled || launching}
                {...(disabled
                  ? { label: 'This message is available when delegating from a transcript message' }
                  : {})}
                onClick={() => setContextScope(value)}
              >
                <strong>{label}</strong><small>{detail}</small>
              </Key>
            )
          })}
        </div>
      </fieldset>

      <Key className="primary wide delegate-build" disabled={!connected || building} onClick={build}>
        {building ? 'Building exact briefing…' : briefing === '' ? 'Build briefing' : 'Rebuild briefing'}
      </Key>
      <p className={`delegate-status${overLimit ? ' bad' : ''}`} aria-live="polite">
        {!connected
          ? 'Waiting for your laptop. Your choices and edits stay saved on this phone.'
          : currentError
            ? currentError
            : overLimit
              ? `Briefing is ${(briefing.length - briefingLimit).toLocaleString()} characters over the limit. Shorten it before launch.`
            : stale
              ? 'Controls changed. Rebuild before this briefing can be launched.'
              : saved?.briefing && lastPreviewId === null
                ? 'Draft restored from this phone.'
                : briefing
                  ? 'Briefing ready. Your edits are saved automatically.'
                  : 'Nothing starts while you build or edit this preview.'}
      </p>

      {briefing !== '' ? (
        <div className="briefing-editor">
          <div className="briefing-head">
            <label htmlFor={editorId}>Briefing</label>
            <button type="button" className="tap quiet" onClick={copy} aria-label="Copy briefing">
              {copyState === 'copied' ? <Check size={14} strokeWidth={2.4} aria-hidden="true" /> : <Clipboard size={14} strokeWidth={2.2} aria-hidden="true" />}
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Select to copy' : 'Copy'}
            </button>
          </div>
          <textarea
            id={editorId}
            className="field briefing-field"
            value={briefing}
            onChange={(event) => setBriefing(event.target.value)}
            disabled={launching}
            rows={14}
            spellCheck
            aria-describedby={`${editorId}-meta`}
          />
          <div className="briefing-meta" id={`${editorId}-meta`}>
            <span>{briefing.length.toLocaleString()} / {briefingLimit.toLocaleString()} characters</span>
            {preview?.requestId === lastPreviewId && preview.context.truncated ? <span>Context limit applied</span> : null}
            <button
              type="button"
              className="tap quiet"
              onClick={() => {
                skipNextSave.current = true
                removeDelegationDraft(session.sessionId, sourceSeq)
                setBriefing('')
                setBuiltSignature(null)
              }}
            >
              Discard draft
            </button>
          </div>
        </div>
      ) : null}

      {briefing !== '' ? (
        <div className="delegate-confirm">
          <div>
            <strong>Ready to hand off to one attributed child</strong>
            <p>
              {AGENT_NAME[targetAgent]} will receive exactly the editable briefing above in
              <span className="mono"> {session.cwd}</span>. Its approvals, Stop control, errors,
              and transcript stay independent.
            </p>
          </div>
          <label className="takeover-confirm transfer-confirm">
            <input
              type="checkbox"
              checked={transferConfirmed}
              onChange={(event) => setTransferConfirmed(event.target.checked)}
              disabled={launching || workspaceMode !== 'sequential'}
            />
            <span className="takeover-check" aria-hidden="true"><Check size={15} strokeWidth={2.7} /></span>
            <span>
              <strong><ShieldCheck size={15} strokeWidth={2.2} aria-hidden="true" /> Move sole workspace control</strong>
              <small>The parent pauses if active. Only the child may write this checkout until you review and return its result.</small>
            </span>
          </label>
          <Key
            className="primary wide delegate-launch"
            disabled={!canLaunch}
            onClick={launch}
            label={`Start one ${AGENT_NAME[targetAgent]} child session`}
          >
            <GitBranchPlus size={17} strokeWidth={2.4} aria-hidden="true" />
            {launching ? `Starting ${AGENT_NAME[targetAgent]}…` : `Start ${AGENT_NAME[targetAgent]} child`}
          </Key>
          <p className={`delegate-status${launchError ? ' bad' : ''}`} role="status" aria-live="polite">
            {launchError
              ? launchError
              : !launchEnabled || workspaceMode !== 'sequential'
                ? 'Update the laptop daemon to enable protected workspace handoffs.'
                : !targetAvailable
                  ? `${AGENT_NAME[targetAgent]} is not configured on this laptop.`
                  : parsedSettings.error
                    ? parsedSettings.error
                  : stale
                    ? 'Rebuild the briefing after changing its controls.'
                    : !transferConfirmed
                      ? 'Confirm the exclusive workspace handoff before launch.'
                    : launching
                      ? 'Launch accepted. Waiting for the attributed child session…'
                      : 'Nothing starts until you press this button.'}
          </p>
        </div>
      ) : (
        <div className="delegate-lockline">
          <span className="led waiting" aria-hidden="true" />
          Preview only — no child session has been started.
        </div>
      )}
    </>
  )
}
