import { basename, sep } from 'node:path'

/**
 * Folders an agent has no business working in, even when they sit inside an allowed root.
 *
 * Honest caveat: an exclusion list is guesswork and will never be complete. It exists so that
 * pointing LongLeash at a whole home directory is not obviously reckless — it is not a
 * substitute for naming the projects you actually work in.
 */
export const SENSITIVE_DIR_NAMES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.config',
  '.password-store',
  '.1password',
  '.bitwarden',
  '.mozilla',
  '.local',
  'Library',
  'Keychains',
  '.Trash',
  '.cache',
  '.npm',
  '.gem',
  '.cargo',
  'Applications',
  'System',
])

/** True when the path is, or sits inside, a folder we refuse to touch. */
export function isSensitivePath(path: string): boolean {
  const parts = path.split(sep).filter(Boolean)
  return parts.some((part) => SENSITIVE_DIR_NAMES.has(part))
}

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_DIR_NAMES.has(basename(name))
}
