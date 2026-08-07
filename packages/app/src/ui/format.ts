import {
  Ban,
  FileSearch,
  FileText,
  Globe,
  ListChecks,
  PencilLine,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

export const ORIGIN_LABEL: Record<string, string> = {
  phone: 'from your phone',
  daemon: 'from the laptop',
  terminal: 'in a terminal',
  vscode: 'in VS Code',
  external: 'outside LongLeash',
  unknown: 'origin unknown',
}

export const STATUS_LABEL: Record<string, string> = {
  running: 'working',
  waiting: 'waiting for you',
  ended: 'finished',
  errored: 'failed',
}

/** Long absolute paths are unreadable on a phone; show the tail that identifies the project. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

export function fileName(label: string): string {
  return label.split('/').filter(Boolean).slice(-1)[0] ?? label
}

export function parentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

/**
 * A glyph per tool, so a scan down the transcript reads as actions rather than as a wall of
 * identical rows. Unknown tools get the generic glyph instead of being hidden or guessed at.
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  Write: PencilLine,
  Edit: PencilLine,
  MultiEdit: PencilLine,
  NotebookEdit: PencilLine,
  Bash: SquareTerminal,
  BashOutput: SquareTerminal,
  KillShell: Ban,
  Glob: FileSearch,
  Grep: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ListChecks,
}

export function toolIcon(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? Wrench
}

/**
 * The adapter sends tool activity as "Name: detail". Splitting it lets the name sit in its own
 * column. An absolute path is collapsed to its last two segments, because on a phone the
 * identifying part of `/Users/you/Desktop/app/src/index.ts` is the end, not the machine prefix.
 * Anything else (a shell command, a search pattern) is left exactly as sent.
 */
export function splitTool(text: string): { name: string; detail: string } {
  const at = text.indexOf(': ')
  if (at === -1) return { name: text.trim(), detail: '' }
  const detail = text.slice(at + 2).trim()
  return {
    name: text.slice(0, at).trim(),
    detail: detail.startsWith('/') && !detail.includes(' ') ? shortPath(detail) : detail,
  }
}

/**
 * Claude Code's permission modes, in words. Shown on a session so that being asked —
 * or not being asked — is never a mystery: an auto-approving session that still pages
 * your phone is a contradiction you can only spot if the mode is visible.
 */
export const MODE_LABEL: Record<string, string> = {
  default: 'asks first',
  acceptEdits: 'auto-accepts edits',
  bypassPermissions: 'auto-approves everything',
  plan: 'planning only',
}
