import { readdirSync, realpathSync } from 'node:fs'
import { basename, join, sep } from 'node:path'

export interface FolderHit {
  path: string
  /** Short, readable location for a phone screen — never the full absolute path. */
  label: string
}

const MAX_DEPTH = 4
const MAX_RESULTS = 20
const MAX_SCANNED = 4000
const CACHE_TTL_MS = 10_000

/** Directories that are never a project and only add noise to a picker. */
const SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'Library',
  '__pycache__',
  'venv',
  '.venv',
])

/** Words people naturally type that carry no meaning for matching. */
const STOPWORDS = new Set(['folder', 'directory', 'dir', 'in', 'the', 'my', 'on', 'under', 'inside', 'at'])

/**
 * Lets someone pick a project by name instead of typing an absolute path — the difference
 * between usable and useless when you are away from the machine. Matching is deterministic and
 * local: no model is consulted, so results are instant and the exact folder is shown before
 * anything runs.
 */
export class FolderIndex {
  private readonly roots: string[]
  private cache: { at: number; folders: string[] } | null = null

  constructor(roots: string[]) {
    this.roots = roots.map((root) => {
      try {
        return realpathSync(root)
      } catch {
        return root
      }
    })
  }

  search(query: string, limit = MAX_RESULTS): FolderHit[] {
    const folders = this.folders()
    const tokens = query
      .toLowerCase()
      .split(/[\s/\\,]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0 && !STOPWORDS.has(token))

    if (tokens.length === 0) {
      return this.roots.map((root) => ({ path: root, label: this.labelFor(root) }))
    }

    const scored: { path: string; score: number }[] = []
    for (const folder of folders) {
      const score = this.score(folder, tokens)
      if (score > 0) scored.push({ path: folder, score })
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    return scored.slice(0, limit).map((hit) => ({ path: hit.path, label: this.labelFor(hit.path) }))
  }

  private score(folder: string, tokens: string[]): number {
    const name = basename(folder).toLowerCase()
    const full = folder.toLowerCase()
    let total = 0
    let matchedName = false

    for (const token of tokens) {
      if (name === token) {
        total += 100
        matchedName = true
      } else if (name.startsWith(token)) {
        total += 60
        matchedName = true
      } else if (name.includes(token)) {
        total += 35
        matchedName = true
      } else if (full.includes(token)) {
        // A location word like "desktop" or "downloads" narrows without naming the folder.
        total += 12
      } else {
        return 0
      }
    }

    // Something has to match the folder's own name, or "in downloads" alone would match
    // every folder under Downloads.
    if (!matchedName) return 0
    // Prefer shallower results: a top-level project beats a deeply nested namesake.
    return total - folder.split(sep).length
  }

  private labelFor(path: string): string {
    for (const root of this.roots) {
      if (path === root) return basename(root)
      if (path.startsWith(root + sep)) {
        const relative = path.slice(root.length + 1)
        return `${basename(root)}/${relative}`
      }
    }
    return path
  }

  /** Walk the allowed roots, bounded in depth and count so a huge tree cannot stall the daemon. */
  private folders(): string[] {
    const now = Date.now()
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.folders

    const found: string[] = []
    let scanned = 0

    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH || scanned > MAX_SCANNED) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (scanned > MAX_SCANNED) return
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
        const child = join(dir, entry.name)
        // A symlink could point anywhere; only keep it if it still resolves inside a root.
        if (entry.isSymbolicLink() && !this.insideRoot(child)) continue
        scanned += 1
        found.push(child)
        walk(child, depth + 1)
      }
    }

    for (const root of this.roots) walk(root, 1)
    this.cache = { at: now, folders: found }
    return found
  }

  private insideRoot(path: string): boolean {
    let resolved: string
    try {
      resolved = realpathSync(path)
    } catch {
      return false
    }
    return this.roots.some((root) => resolved === root || resolved.startsWith(root + sep))
  }
}
