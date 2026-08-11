import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { File, Folder, Search } from 'lucide-react'
import type { FolderHit } from '../lib/client.js'
import { EXIT, Key, SPRING, useKeyboardInset } from './primitives.js'
import { fileName, parentPath } from './format.js'

const DISMISS_DISTANCE = 110
const DISMISS_VELOCITY = 500

const AGENT_NAME = { claude: 'Claude', codex: 'Codex' } as const

function AgentPicker({
  agent,
  onPick,
}: {
  agent: 'claude' | 'codex'
  onPick: (agent: 'claude' | 'codex') => void
}) {
  return (
    <div className="agentpick" role="group" aria-label="Which agent">
      {(['claude', 'codex'] as const).map((option) => (
        <Key
          key={option}
          className={agent === option ? 'picked' : ''}
          aria-pressed={agent === option}
          onClick={() => onPick(option)}
        >
          {AGENT_NAME[option]}
        </Key>
      ))}
    </div>
  )
}

export function NewSessionSheet({
  open,
  roots,
  folders,
  connected,
  onSearch,
  onStart,
  onClose,
}: {
  open: boolean
  roots: string[]
  folders: FolderHit[]
  connected: boolean
  onSearch: (query: string) => void
  onStart: (dir: string, prompt: string, agent: 'claude' | 'codex') => boolean
  onClose: () => void
}) {
  const keyboard = useKeyboardInset(open)
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
            {...(keyboard > 0
              ? { style: { bottom: keyboard, maxHeight: `calc(100dvh - ${keyboard + 10}px)` } }
              : {})}
            role="dialog"
            aria-modal="true"
            aria-label="Start a new session"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%', transition: EXIT }}
            transition={SPRING}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > DISMISS_DISTANCE || info.velocity.y > DISMISS_VELOCITY) onClose()
            }}
          >
            <div className="sheet-in">
              <div className="grab" aria-hidden="true" />
              <SheetBody
                roots={roots}
                folders={folders}
                connected={connected}
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
  onSearch,
  onStart,
  onClose,
}: {
  roots: string[]
  folders: FolderHit[]
  connected: boolean
  onSearch: (query: string) => void
  onStart: (dir: string, prompt: string, agent: 'claude' | 'codex') => boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<FolderHit | null>(null)
  const [prompt, setPrompt] = useState('')
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude')
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
        <p className="sub">{AGENT_NAME[agent]} runs in this folder and asks before it touches anything else.</p>
        <AgentPicker agent={agent} onPick={setAgent} />

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

        <textarea
          ref={promptRef}
          className="field"
          style={{ marginTop: 12 }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`What should ${AGENT_NAME[agent]} do?`}
          aria-label={`Task for ${AGENT_NAME[agent]}`}
        />

        <Key
          className="primary wide"
          disabled={!prompt.trim() || !connected}
          onClick={() => {
            const dir = chosen.kind === 'file' ? parentPath(chosen.path) : chosen.path
            const task =
              chosen.kind === 'file'
                ? `In the file ${fileName(chosen.label)}: ${prompt.trim()}`
                : prompt.trim()
            if (onStart(dir, task, agent)) {
              setPrompt('')
              onClose()
            }
          }}
        >
          {connected ? 'Start session' : 'Waiting for your laptop…'}
        </Key>
      </>
    )
  }

  return (
    <>
      <h2>Start a session</h2>
      <p className="sub">Choose the agent, then name a folder the way you'd say it out loud.</p>
      <AgentPicker agent={agent} onPick={setAgent} />

      <div className="searchwrap">
        <Search className="glyph" size={17} strokeWidth={2.2} aria-hidden="true" />
        <input
          className="field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="FD_Engineer, or test in downloads"
          aria-label="Find a folder"
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      {folders.length === 0 ? (
        <p className="small dim" style={{ margin: '14px 2px 0' }}>
          {query.trim() ? 'Nothing on your laptop matches that.' : 'Type a name, or pick a root below.'}
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
    </>
  )
}
