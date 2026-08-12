import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Code2, File, Folder, Search, Sparkles, X } from 'lucide-react'
import type { AgentSettingsCatalog, FolderHit } from '../lib/client.js'
import { EXIT, Key, SPRING, useKeyboardInset, useVisualViewportHeight } from './primitives.js'
import { fileName, parentPath } from './format.js'
import type { SessionSettings, WorkspaceMode } from '@longleash/protocol'

const AGENT_NAME = { claude: 'Claude', codex: 'Codex' } as const
const AGENT_DETAIL = { claude: 'Anthropic agent', codex: 'OpenAI agent' } as const
const AGENT_ICON = { claude: Sparkles, codex: Code2 } as const

function StepLabel({ number, children }: { number: number; children: string }) {
  return (
    <div className="step-label">
      <span className="step-number" aria-hidden="true">{number}</span>
      <span>{children}</span>
    </div>
  )
}

function AgentPicker({
  agent,
  onPick,
}: {
  agent: 'claude' | 'codex'
  onPick: (agent: 'claude' | 'codex') => void
}) {
  return (
    <div className="agentpick" role="group" aria-label="Which agent">
      {(['claude', 'codex'] as const).map((option) => {
        const Icon = AGENT_ICON[option]
        const selected = agent === option
        return (
          <Key
            key={option}
            className={`agentoption${selected ? ' picked' : ''}`}
            pressed={selected}
            label={`Use ${AGENT_NAME[option]}`}
            onClick={() => onPick(option)}
          >
            <span className="agenticon" data-agent={option} aria-hidden="true">
              <Icon size={18} strokeWidth={2.1} />
            </span>
            <span className="agentcopy">
              <strong>{AGENT_NAME[option]}</strong>
              <small>{AGENT_DETAIL[option]}</small>
            </span>
            <Check className="agentcheck" size={17} strokeWidth={2.7} aria-hidden="true" />
          </Key>
        )
      })}
    </div>
  )
}

export function NewSessionSheet({
  open,
  roots,
  folders,
  connected,
  settingsCatalog,
  starting = false,
  startError,
  onSearch,
  onStart,
  onClose,
}: {
  open: boolean
  roots: string[]
  folders: FolderHit[]
  connected: boolean
  settingsCatalog?: AgentSettingsCatalog
  starting?: boolean
  startError?: string
  onSearch: (query: string) => void
  onStart: (
    dir: string,
    prompt: string,
    agent: 'claude' | 'codex',
    options: { workspaceMode: WorkspaceMode; settings?: SessionSettings },
  ) => boolean
  onClose: () => void
}) {
  const keyboard = useKeyboardInset(open)
  const viewportHeight = useVisualViewportHeight(open)
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
            className="sheet"
            style={{
              ...(keyboard > 0 ? { bottom: keyboard } : {}),
              ...(viewportHeight === null
                ? {}
                : { maxHeight: `${Math.max(180, viewportHeight - 8)}px` }),
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Start a new session"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%', transition: EXIT }}
            transition={SPRING}
          >
            <div className="sheetbar">
              <div className="grab" aria-hidden="true" />
              <button type="button" className="sheetclose" onClick={onClose} aria-label="Close new session">
                <X size={19} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
            <div className="sheet-in">
              <SheetBody
                roots={roots}
                folders={folders}
                connected={connected}
                {...(settingsCatalog === undefined ? {} : { settingsCatalog })}
                starting={starting}
                {...(startError === undefined ? {} : { startError })}
                onSearch={onSearch}
                onStart={onStart}
                onClose={onClose}
              />
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  )
}

function SheetBody({
  roots,
  folders,
  connected,
  settingsCatalog,
  starting,
  startError,
  onSearch,
  onStart,
  onClose,
}: {
  roots: string[]
  folders: FolderHit[]
  connected: boolean
  settingsCatalog?: AgentSettingsCatalog
  starting: boolean
  startError?: string
  onSearch: (query: string) => void
  onStart: (
    dir: string,
    prompt: string,
    agent: 'claude' | 'codex',
    options: { workspaceMode: WorkspaceMode; settings?: SessionSettings },
  ) => boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<FolderHit | null>(null)
  const [prompt, setPrompt] = useState('')
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('auto')
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [effort, setEffort] = useState('')
  const [thinking, setThinking] = useState('')
  const [thinkingBudget, setThinkingBudget] = useState('10000')
  const promptRef = useRef<HTMLTextAreaElement | null>(null)

  // Search as you type, debounced: nobody should have to recall an absolute path from memory.
  useEffect(() => {
    if (chosen) return
    const timer = setTimeout(() => onSearch(query), 180)
    return () => clearTimeout(timer)
  }, [query, chosen, onSearch])

  // Once a folder is picked, the next thing you want is the keyboard on the task box.
  useEffect(() => {
    if (chosen) promptRef.current?.focus()
  }, [chosen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (roots.length === 0) {
    return (
      <>
        <h2>Start a session</h2>
        <StepLabel number={1}>Choose an agent</StepLabel>
        <AgentPicker agent={agent} onPick={setAgent} />
        <p className="sub">No project directories are configured on the laptop.</p>
      </>
    )
  }

  if (chosen) {
    const workingIn = chosen.kind === 'file' ? (chosen.parent ?? chosen.label) : chosen.label
    return (
      <>
        <h2>Start a session</h2>
        <p className="sub">Review the agent and project, then describe the task.</p>
        <StepLabel number={1}>Agent</StepLabel>
        <AgentPicker agent={agent} onPick={setAgent} />

        <StepLabel number={2}>Project</StepLabel>
        <div className="chosen">
          <span className="fico">
            {chosen.kind === 'file' ? (
              <File size={16} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Folder size={16} strokeWidth={2} aria-hidden="true" />
            )}
          </span>
          <span className="body">
            <span className="k">Working in</span>
            <span className="v" title={workingIn}>
              {workingIn}
            </span>
          </span>
          <button
            type="button"
            className="tap"
            onClick={() => {
              setChosen(null)
              setQuery('')
            }}
          >
            Change
          </button>
        </div>

        {chosen.kind === 'file' ? (
          <p className="small dim" style={{ margin: '10px 2px 0' }}>
            The task will name <span className="mono">{fileName(chosen.label)}</span> so
            {' '}{AGENT_NAME[agent]} starts on that file.
          </p>
        ) : null}

        <label className="step-label" htmlFor="new-session-task">
          <span className="step-number" aria-hidden="true">3</span>
          <span>Task for {AGENT_NAME[agent]}</span>
        </label>
        <textarea
          id="new-session-task"
          ref={promptRef}
          className="field"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`What should ${AGENT_NAME[agent]} do?`}
          aria-label={`Task for ${AGENT_NAME[agent]}`}
          rows={3}
          onFocus={(event) => {
            const field = event.currentTarget
            setTimeout(() => field.scrollIntoView({ block: 'center' }), 80)
          }}
        />

        <StepLabel number={4}>Workspace</StepLabel>
        <div className="workspacepick" role="group" aria-label="Parallel workspace behavior">
          <button
            type="button"
            className={`workspaceoption${workspaceMode === 'auto' ? ' picked' : ''}`}
            aria-pressed={workspaceMode === 'auto'}
            onClick={() => setWorkspaceMode('auto')}
          >
            <strong>Safe parallel</strong>
            <small>Uses this checkout when free; creates an isolated Git branch when busy.</small>
          </button>
          <button
            type="button"
            className={`workspaceoption${workspaceMode === 'shared' ? ' picked' : ''}`}
            aria-pressed={workspaceMode === 'shared'}
            onClick={() => setWorkspaceMode('shared')}
          >
            <strong>Same checkout</strong>
            <small>Starts only when no other agent owns these files.</small>
          </button>
        </div>

        <details className="session-settings">
          <summary>Model &amp; reasoning</summary>
          <p>Optional. Defaults follow the provider installed on your laptop.</p>
          <div className="settingsgrid">
            <label>
              <span>Model</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">Provider default</option>
                {(settingsCatalog?.[agent].models ?? (agent === 'claude'
                  ? ['sonnet', 'opus', 'haiku']
                  : ['gpt-5.6', 'gpt-5.4', 'gpt-5.3-codex'])).map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                <option value="__custom__">Custom model ID…</option>
              </select>
            </label>
            {model === '__custom__' ? (
              <label>
                <span>Custom model ID</span>
                <input
                  type="text"
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                  placeholder={agent === 'claude' ? 'provider model alias' : 'model id'}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
            ) : null}
            <label>
              <span>Effort</span>
              <select value={effort} onChange={(event) => setEffort(event.target.value)}>
                <option value="">Provider default</option>
                {(settingsCatalog?.[agent].efforts ?? ['low', 'medium', 'high', 'xhigh', 'max']).map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            {agent === 'claude' ? (
              <label>
                <span>Thinking</span>
                <select value={thinking} onChange={(event) => setThinking(event.target.value)}>
                  <option value="">Provider default</option>
                  <option value="adaptive">Adaptive</option>
                  <option value="disabled">Off</option>
                  <option value="fixed">Fixed budget</option>
                </select>
              </label>
            ) : null}
            {agent === 'claude' && thinking === 'fixed' ? (
              <label>
                <span>Thinking tokens</span>
                <input
                  type="number"
                  min={1024}
                  max={128000}
                  step={1024}
                  value={thinkingBudget}
                  onChange={(event) => setThinkingBudget(event.target.value)}
                  inputMode="numeric"
                />
              </label>
            ) : null}
          </div>
          <small className="settingsnote">Approval and sandbox safety remain managed by LongLeash.</small>
        </details>

        <Key
          className="primary wide"
          disabled={
            !prompt.trim() ||
            !connected || starting ||
            (model === '__custom__' && customModel.trim() === '') ||
            (agent === 'claude' && thinking === 'fixed' && (
              !Number.isInteger(Number(thinkingBudget)) ||
              Number(thinkingBudget) < 1024 ||
              Number(thinkingBudget) > 128000
            ))
          }
          onClick={() => {
            const dir = chosen.kind === 'file' ? parentPath(chosen.path) : chosen.path
            const task =
              chosen.kind === 'file'
                ? `In the file ${fileName(chosen.label)}: ${prompt.trim()}`
                : prompt.trim()
            const parsedBudget = Number.parseInt(thinkingBudget, 10)
            const selectedModel = model === '__custom__' ? customModel.trim() : model
            const settings: SessionSettings = {
              ...(selectedModel === '' ? {} : { model: selectedModel }),
              ...(effort === '' ? {} : { effort: effort as SessionSettings['effort'] }),
              ...(agent !== 'claude' || thinking === ''
                ? {}
                : {
                    thinking: thinking === 'fixed'
                      ? { mode: 'fixed' as const, budgetTokens: parsedBudget }
                      : { mode: thinking as 'adaptive' | 'disabled' },
                  }),
            }
            if (onStart(dir, task, agent, {
              workspaceMode,
              ...(Object.keys(settings).length === 0 ? {} : { settings }),
            })) return
          }}
        >
          {starting ? 'Preparing a safe checkout…' : connected ? 'Start session' : 'Waiting for your laptop…'}
        </Key>
        {startError ? <p className="start-error" role="alert">{startError}</p> : null}
      </>
    )
  }

  return (
    <>
      <h2>Start a session</h2>
      <p className="sub">Pick who should work, then find the project on your laptop.</p>
      <StepLabel number={1}>Choose an agent</StepLabel>
      <AgentPicker agent={agent} onPick={setAgent} />

      <label className="step-label" htmlFor="new-session-folder">
        <span className="step-number" aria-hidden="true">2</span>
        <span>Find a project</span>
      </label>
      <p className="field-hint">Type any part of the folder or file name.</p>
      <div className="searchwrap">
        <Search className="glyph" size={17} strokeWidth={2.2} aria-hidden="true" />
        <input
          id="new-session-folder"
          type="search"
          className="field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && folders[0]) {
              event.preventDefault()
              setChosen(folders[0])
            }
          }}
          onFocus={(event) => {
            const field = event.currentTarget
            setTimeout(() => field.scrollIntoView({ block: 'center' }), 80)
          }}
          placeholder="e.g. AgentMem-OS"
          aria-label="Find a folder"
          enterKeyHint="search"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      {folders.length === 0 ? (
        <p className="folder-empty" role="status">
          {query.trim()
            ? 'No match inside the locations LongLeash is currently allowed to use.'
            : 'Type a name, or choose an allowed location below.'}
        </p>
      ) : (
        <ul className="folders">
          {folders.map((folder) => (
            <li key={folder.path}>
              <button type="button" className="folderbtn" onClick={() => setChosen(folder)}>
                <span className="fico">
                  {folder.kind === 'file' ? (
                    <File size={15} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Folder size={15} strokeWidth={2} aria-hidden="true" />
                  )}
                </span>
                <span className="fl" title={folder.label}>
                  {folder.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="scopehint">
        Searching {roots.length === 1 ? '1 allowed location' : `${roots.length} allowed locations`}:
        {' '}{roots.map((root) => fileName(root)).join(', ')}.
        {' '}Start LongLeash with another folder path to add it.
      </p>
    </>
  )
}
