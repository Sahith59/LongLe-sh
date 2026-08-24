import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSessionWatcher, inspectCodexTranscript } from '../src/codex-session-watch.js'

const line = (value: unknown) => `${JSON.stringify(value)}\n`

describe('Codex durable-session discovery', () => {
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
})
