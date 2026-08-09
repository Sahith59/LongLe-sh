import { describe, it, expect } from 'vitest'
import { detectSurface } from '../hooks/surface.mjs'
import { surfaceOf } from '../src/external.js'

/**
 * Telling a terminal session from one running inside an editor. Detection is deliberately
 * agent-agnostic: VS Code exports these variables to everything it spawns, so this works for
 * Codex and for CLIs we have not integrated with yet, without learning each one's conventions.
 */
describe('where a session is being driven from', () => {
  it('a plain terminal is a terminal', () => {
    expect(detectSurface({ TERM: 'xterm-256color', SHELL: '/bin/zsh' })).toBe('terminal')
    expect(detectSurface({})).toBe('terminal')
  })

  it("uses Claude Code's own answer when it gives one", () => {
    expect(detectSurface({ CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })).toBe('vscode')
    expect(detectSurface({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('terminal')
  })

  it('detects VS Code for ANY agent, with no agent-specific variable present', () => {
    // This is the branch that makes Codex and future CLIs work for free.
    expect(detectSurface({ VSCODE_PID: '4213' })).toBe('vscode')
    expect(detectSurface({ VSCODE_IPC_HOOK: '/tmp/vscode.sock' })).toBe('vscode')
    expect(detectSurface({ __CFBundleIdentifier: 'com.microsoft.VSCode' })).toBe('vscode')
    expect(detectSurface({ TERM_PROGRAM: 'vscode' })).toBe('vscode')
  })

  it('treats VS Code forks as editors too', () => {
    expect(detectSurface({ __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' , TERM_PROGRAM: 'cursor' })).toBe('vscode')
    expect(detectSurface({ __CFBundleIdentifier: 'com.exafunction.windsurf' })).toBe('vscode')
  })

  it('is not fooled by an unrelated terminal emulator', () => {
    expect(detectSurface({ TERM_PROGRAM: 'iTerm.app' })).toBe('terminal')
    expect(detectSurface({ __CFBundleIdentifier: 'com.googlecode.iterm2' })).toBe('terminal')
    expect(detectSurface({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('terminal')
  })

  it('the daemon defaults to terminal for anything it does not recognise', () => {
    // An older hook that reports nothing must not silently become "VS Code".
    expect(surfaceOf(undefined)).toBe('terminal')
    expect(surfaceOf('something-new')).toBe('terminal')
    expect(surfaceOf('vscode')).toBe('vscode')
  })
})
