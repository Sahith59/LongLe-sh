/**
 * Where a session is being driven from: a plain terminal, or inside VS Code.
 *
 * Shared by every agent's hook, and deliberately agent-agnostic. VS Code exports these
 * variables to ANYTHING it spawns, so this works for Codex, and for whatever CLI we support
 * next, without needing to learn that agent's private conventions first. An agent-specific
 * signal is only ever a refinement on top.
 *
 * Why it matters: a person running four sessions needs to know which one is the terminal on
 * their left monitor and which is the editor on their right. Without it, the inbox is four
 * identical rows and every decision starts with "which one is this?"
 */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {'vscode' | 'terminal'}
 */
export function detectSurface(env) {
  // Agent-specific, and the most precise signal available: Claude Code distinguishes its
  // VS Code extension from a shell that merely happens to be running inside VS Code.
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? ''
  if (/vscode|extension/i.test(entrypoint)) return 'vscode'
  /**
   * The editor's own name for itself. This is the signal that catches the VS Code forks:
   * Cursor ships bundle id `com.todesktop.230313mzl4w4u92`, which contains nothing
   * recognisable, so matching on the bundle id alone silently classifies it as a terminal.
   * `TERM_PROGRAM` is what it actually sets.
   */
  if (/^(vscode|cursor|windsurf|vscodium|trae|positron)/i.test(env.TERM_PROGRAM ?? '')) return 'vscode'

  // Agent-agnostic. VS Code (and every fork of it) sets these for each child process it
  // creates, which is why this branch covers CLIs we have never integrated with.
  if (env.VSCODE_PID || env.VSCODE_IPC_HOOK || env.VSCODE_CWD) return 'vscode'

  const bundle = (env.__CFBundleIdentifier ?? '').toLowerCase()
  if (bundle.includes('vscode') || bundle.includes('vscodium') || bundle.includes('windsurf')) {
    return 'vscode'
  }

  return 'terminal'
}
