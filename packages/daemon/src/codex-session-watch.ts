import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { titleFrom, type Surface } from './external.js'

export interface ObservedCodexSession {
  sessionId: string
  cwd: string
  transcriptPath: string
  surface: Surface
  title?: string
}

interface WatchOptions {
  roots: string[]
  sessionsRoot?: string
  now?: () => number
  pollMs?: number
  initialRecentMs?: number
  onSession: (session: ObservedCodexSession) => void
}

const MAX_HEAD = 256 * 1024
const MAX_TAIL = 1024 * 1024
// A compacted app-server turn can place the latest human prompt tens of MB before EOF. This
// larger window is used once per newly discovered active transcript, then never again.
const MAX_INITIAL_TAIL = 64 * 1024 * 1024

function readSlice(path: string, offset: number, length: number): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Parse bounded head/tail slices; a resumed Codex transcript may be hundreds of MB. */
export function inspectCodexTranscript(
  path: string,
  roots: string[],
  maxTailBytes = MAX_INITIAL_TAIL,
): ObservedCodexSession | null {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  try {
    const firstLine = readSlice(path, 0, Math.min(size, MAX_HEAD)).split('\n')[0]
    if (!firstLine) return null
    const meta = JSON.parse(firstLine) as {
      type?: unknown
      payload?: { session_id?: unknown; id?: unknown; cwd?: unknown; source?: unknown; originator?: unknown }
    }
    if (meta.type !== 'session_meta' || !meta.payload) return null
    const sessionId = typeof meta.payload.session_id === 'string'
      ? meta.payload.session_id
      : typeof meta.payload.id === 'string' ? meta.payload.id : null
    const cwd = typeof meta.payload.cwd === 'string' ? meta.payload.cwd : null
    if (sessionId === null || cwd === null || !roots.some((root) => inside(root, cwd))) return null

    // Terminal Codex is announced synchronously by our hook. Watching it here as well can race
    // that authoritative path and create an observation-only shell before the hook arrives.
    // This fallback exists specifically for the sealed VS Code/app-server conversation that
    // can remain open across an install without producing another SessionStart event.
    if (meta.payload.source !== 'vscode' && meta.payload.originator !== 'codex_vscode') return null
    const surface: Surface = 'vscode'
    const tailOffset = Math.max(0, size - maxTailBytes)
    const tailText = readSlice(path, tailOffset, size - tailOffset)
    const lines = tailText.split('\n')
    if (tailOffset > 0) lines.shift() // first tail line may begin in the middle of JSON
    let title: string | undefined
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!line?.includes('"role":"user"')) continue
      try {
        const record = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> }
        if (record.type !== 'response_item' || record.payload?.type !== 'message' || record.payload.role !== 'user') continue
        const content = record.payload.content
        if (!Array.isArray(content)) continue
        const text = content
          .filter((item): item is { type: string; text: string } =>
            !!item && typeof item === 'object' &&
            (item as { type?: unknown }).type === 'input_text' &&
            typeof (item as { text?: unknown }).text === 'string')
          .map((item) => item.text)
          .join('\n')
        title = titleFrom(text) ?? undefined
        if (title !== undefined) break
      } catch {
        // A partial/corrupt record is ignored; the next complete write repairs discovery.
      }
    }
    // Codex app-server periodically compacts its entire context into one very large record.
    // Parsing that 20–60 MB JSON object would multiply memory use. Extract only the final user
    // text string from the bounded tail and let the shared human-text cleaner remove IDE chrome.
    if (title === undefined) title = titleFrom(latestUserText(tailText) ?? '') ?? undefined
    return { sessionId, cwd, transcriptPath: path, surface, ...(title === undefined ? {} : { title }) }
  } catch {
    return null
  }
}

/**
 * Hooks cannot announce a conversation that was already open before installation. Codex's
 * own durable session file can: observing a write is enough to place that conversation in
 * the list without scraping its TUI or copying an unbounded transcript.
 */
export class CodexSessionWatcher {
  private readonly options: Required<Pick<WatchOptions, 'pollMs' | 'initialRecentMs'>> & WatchOptions
  private readonly mtimes = new Map<string, number>()
  private readonly known = new Map<string, ObservedCodexSession>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: WatchOptions) {
    this.options = { pollMs: 3_000, initialRecentMs: 5 * 60_000, ...options }
  }

  start(): () => void {
    this.scan(true)
    this.timer = setInterval(() => this.scan(false), this.options.pollMs)
    this.timer.unref?.()
    return () => this.stop()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  scan(initial = false): number {
    const root = this.options.sessionsRoot ?? join(homedir(), '.codex', 'sessions')
    const now = this.options.now?.() ?? Date.now()
    let observed = 0
    for (const path of jsonlFiles(root)) {
      let modified: number
      try {
        modified = statSync(path).mtimeMs
      } catch {
        continue
      }
      const previous = this.mtimes.get(path)
      this.mtimes.set(path, modified)
      const changed = previous !== undefined && modified > previous
      const recentlyActive = initial && now - modified <= this.options.initialRecentMs
      if (!changed && !recentlyActive) continue
      const previousSession = this.known.get(path)
      const inspected = inspectCodexTranscript(
        path,
        this.options.roots,
        previousSession === undefined ? MAX_INITIAL_TAIL : MAX_TAIL,
      )
      const session = inspected === null
        ? null
        : inspected.title === undefined && previousSession?.title !== undefined
          ? { ...inspected, title: previousSession.title }
          : inspected
      if (session === null) continue
      this.known.set(path, session)
      this.options.onSession(session)
      observed += 1
    }
    return observed
  }
}

/** Decode one JSON string without parsing the surrounding compacted context object. */
function jsonStringAt(source: string, quoteAt: number): string | null {
  if (source[quoteAt] !== '"') return null
  let escaped = false
  for (let index = quoteAt + 1; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      try {
        return JSON.parse(source.slice(quoteAt, index + 1)) as string
      } catch {
        return null
      }
    }
  }
  return null
}

/** Find the latest real user message inside a normal or compacted Codex tail. */
function latestUserText(source: string): string | null {
  let before = source.length
  while (before > 0) {
    const roleAt = source.lastIndexOf('"role":"user"', before)
    if (roleAt < 0) return null
    const textKey = source.indexOf('"text":', roleAt)
    const nextRole = source.indexOf('"role":', roleAt + 1)
    if (textKey >= 0 && (nextRole < 0 || textKey < nextRole)) {
      const quoteAt = source.indexOf('"', textKey + 7)
      const text = quoteAt < 0 ? null : jsonStringAt(source, quoteAt)
      if (text !== null && titleFrom(text) !== null) return text
    }
    before = roleAt
  }
  return null
}

function jsonlFiles(root: string): string[] {
  const out: string[] = []
  const visit = (directory: string): void => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  visit(root)
  return out
}
