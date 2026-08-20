import { normalizeRoots } from './config.js'

export type AllowedRootAnswer =
  | { ok: true; root: string }
  | { ok: false; message: string }

export function resolveAllowedRootAnswer(answer: string, defaultRoot: string): AllowedRootAnswer {
  const trimmed = answer.trim()
  if (/^(?:y|yes|n|no)$/i.test(trimmed)) {
    return {
      ok: false,
      message: `This question needs a folder path. Press Enter to use ${defaultRoot}, or type another existing folder.`,
    }
  }

  try {
    const [root] = normalizeRoots([trimmed || defaultRoot])
    if (!root) throw new Error('At least one allowed project directory is required.')
    return { ok: true, root }
  } catch (error) {
    return {
      ok: false,
      message: `That folder cannot be used: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
