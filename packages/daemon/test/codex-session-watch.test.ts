import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CodexSessionWatcher, inspectCodexTranscript } from '../src/codex-session-watch.js'

const line = (value: unknown) => `${JSON.stringify(value)}\n`

describe('Codex durable-session discovery', () => {
  it('discovers a new VS Code file after startup without requiring another write', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-codex-new-'))
    try {
      const seen: string[] = []
      const watcher = new CodexSessionWatcher({ roots: [root], sessionsRoot: root, onSession: (s) => seen.push(s.sessionId) })
      expect(watcher.scan(true)).toBe(0)
      writeFileSync(join(root, 'new.jsonl'), line({ type: 'session_meta', payload: { id: 'new-chat', cwd: root, source: 'vscode' } }))
      expect(watcher.scan()).toBe(1)
      expect(watcher.scan()).toBe(0)
      expect(seen).toEqual(['new-chat'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reads bounded metadata and the latest user turn from a resumed VS Code session', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-codex-watch-'))
    const sessions = join(root, 'sessions')
    const project = join(root, 'project')
    mkdirSync(sessions)
    mkdirSync(project)
    const path = join(sessions, 'rollout-current.jsonl')
    writeFileSync(path,
      line({ type: 'session_meta', payload: { session_id: 'codex-current', cwd: project, source: 'vscode' } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old task' }] } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the session list ordering today' }] } }),
    )
    expect(inspectCodexTranscript(path, [root])).toMatchObject({
      sessionId: 'codex-current', cwd: project, surface: 'vscode', title: 'Fix the session list ordering today',
      snapshot: [
        { kind: 'user', text: 'old task' },
        { kind: 'user', text: 'Fix the session list ordering today' },
      ],
    })
    expect(inspectCodexTranscript(path, [join(root, 'somewhere-else')])).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })

  it('announces recent sessions once and announces them again only after a write', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-codex-watch-'))
    const sessions = join(root, 'sessions')
    const project = join(root, 'project')
    mkdirSync(sessions)
    mkdirSync(project)
    const path = join(sessions, 'rollout-current.jsonl')
    writeFileSync(path, line({ type: 'session_meta', payload: { session_id: 'current', cwd: project, source: 'vscode' } }))
    const seen: string[] = []
    const watcher = new CodexSessionWatcher({ roots: [root], sessionsRoot: sessions, onSession: (s) => seen.push(s.sessionId) })
    expect(watcher.scan(true)).toBe(1)
    expect(watcher.scan(false)).toBe(0)
    appendFileSync(path, line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new turn' }] } }))
    expect(watcher.scan(false)).toBe(1)
    expect(seen).toEqual(['current', 'current'])
    rmSync(root, { recursive: true, force: true })
  })

  it('restores only a known observed Codex chat after its transcript ages past discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-codex-restore-'))
    const knownId = '01a10e09-3b14-7932-998a-1aaf8de364ea'
    const unknownId = '01a10e09-3b14-7932-998a-1aaf8de364eb'
    const old = new Date(Date.now() - 20 * 60_000)
    try {
      for (const id of [knownId, unknownId]) {
        const path = join(root, `rollout-2026-10-05T17-47-28-${id}.jsonl`)
        writeFileSync(path, line({ type: 'session_meta', payload: { id, cwd: root, source: 'vscode' } }) +
          line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A task' }] } }))
        utimesSync(path, old, old)
      }
      const seen: { sessionId: string; restoredKnown?: boolean; restoredIdle?: boolean }[] = []
      const watcher = new CodexSessionWatcher({
        roots: [root], sessionsRoot: root, now: () => Date.now(), knownNativeIds: [knownId],
        onSession: (session) => seen.push({ sessionId: session.sessionId, restoredKnown: session.restoredKnown, restoredIdle: session.restoredIdle }),
      })
      expect(watcher.scan(true)).toBe(1)
      expect(seen).toEqual([{ sessionId: knownId, restoredKnown: true, restoredIdle: true }])
      expect(watcher.scan()).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('preserves prior durable history for a known chat still inside the recent window', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-codex-recent-'))
    const id = '01a10e09-3b14-7932-998a-1aaf8de364ea'
    try {
      writeFileSync(join(root, `rollout-2026-10-05T17-47-28-${id}.jsonl`),
        line({ type: 'session_meta', payload: { id, cwd: root, source: 'vscode' } }))
      const seen: boolean[] = []
      const watcher = new CodexSessionWatcher({ roots: [root], sessionsRoot: root,
        knownNativeIds: [id], onSession: (session) => seen.push(session.restoredKnown === true) })
      expect(watcher.scan(true)).toBe(1)
      expect(seen).toEqual([true])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('leaves terminal sessions to the synchronous hook path', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-codex-watch-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const path = join(root, 'terminal.jsonl')
    writeFileSync(path, line({ type: 'session_meta', payload: { session_id: 'terminal', cwd: project, source: 'cli' } }))
    expect(inspectCodexTranscript(path, [root])).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })

  it('extracts the latest human prompt from a compacted app-server record', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-codex-watch-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const path = join(root, 'compacted.jsonl')
    writeFileSync(path, line({ type: 'session_meta', payload: { session_id: 'compacted', cwd: project, source: 'vscode' } }) + line({
      type: 'compacted',
      payload: {
        replacement_history: [
          { role: 'user', content: [{ type: 'input_text', text: 'old request' }] },
          { role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] },
          { role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n\n## My request:\nFix the premium session browser' }] },
        ],
      },
    }))
    expect(inspectCodexTranscript(path, [root])?.title).toBe('Fix the premium session browser')
    rmSync(root, { recursive: true, force: true })
  })

  it('makes progress past rejected IDE-only user blocks in oversized compaction records', () => {
    const root = mkdtempSync(join(tmpdir(), 'll-codex-oversized-'))
    try {
      const moduleDir = dirname(fileURLToPath(import.meta.url))
      const source = join(moduleDir, '..', 'src', 'codex-session-watch.ts')
      const inspect = (name: string, history: unknown[]) => {
        const path = join(root, name)
        writeFileSync(path, line({ type: 'session_meta', payload: { session_id: name, cwd: root, source: 'vscode' } }) +
          line({ type: 'compacted', payload: { replacement_history: history, filler: 'x'.repeat(1_200_000) } }))
        const script = `import { inspectCodexTranscript } from ${JSON.stringify(pathToFileURL(source).href)};` +
          `const result = inspectCodexTranscript(${JSON.stringify(path)}, [${JSON.stringify(root)}]);` +
          `console.log(JSON.stringify({ title: result?.title ?? null, blocks: result?.snapshot.length ?? -1 }))`
        const child = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2_500 })
        expect(child.error).toBeUndefined()
        expect(child.status).toBe(0)
        return JSON.parse(child.stdout) as { title: string | null; blocks: number }
      }
      const chrome = { role: 'user', content: [{ type: 'input_text', text: '<ide_opened_file>machine only</ide_opened_file>' }] }
      expect(inspect('only-chrome.jsonl', [chrome])).toEqual({ title: null, blocks: 0 })
      expect(inspect('earlier-real.jsonl', [
        { role: 'user', content: [{ type: 'input_text', text: 'Earlier real task' }] },
        chrome,
      ])).toEqual({ title: 'Earlier real task', blocks: 0 })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
