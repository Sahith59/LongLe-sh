import { readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { SENSITIVE_DIR_NAMES } from './sensitive.js'

export interface FolderHit {
  path: string
  /** Short, readable location for a phone screen — never the full absolute path. */
  label: string
  kind: 'folder' | 'file'
  /** For a file, the folder an agent would work in. */
  parent?: string
}

/**
 * Distance-tolerant matching so a half-remembered or mistyped name still finds its target.
 * Deliberately local and instant: a model is not consulted for every keystroke, and the exact
 * match is shown for confirmation before anything runs.
 */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
      current[j] = value
      if (value < best) best = value
    }
    if (best > cap) return cap + 1
    previous = current
  }
  return previous[b.length] as number
}

/** Every character of the query appearing in order — how people abbreviate names. */
function isSubsequence(query: string, target: string): boolean {
  let index = 0
  for (const char of target) {
    if (char === query[index]) index += 1
    if (index === query.length) return true
  }
  return query.length === 0
}

const MAX_DEPTH = 4
const MAX_RESULTS = 20
const MAX_SCANNED = 20_000
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
  private cache: { at: number; entries: { path: string; kind: 'folder' | 'file' }[] } | null = null

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
    const entries = this.entries()
    const tokens = query
      .toLowerCase()
      .split(/[\s/\\,]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0 && !STOPWORDS.has(token))

    if (tokens.length === 0) {
      return this.roots.map((root) => ({
        path: root,
        label: this.labelFor(root),
        kind: 'folder' as const,
      }))
    }

    const scored: { path: string; kind: 'folder' | 'file'; score: number }[] = []
    for (const entry of entries) {
      const score = this.score(entry.path, tokens)
      // Folders win ties: you work in a folder, a file is a pointer to one.
      if (score > 0) scored.push({ ...entry, score: entry.kind === 'folder' ? score + 5 : score })
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    return scored.slice(0, limit).map((hit) => ({
      path: hit.path,
      label: this.labelFor(hit.path),
      kind: hit.kind,
      ...(hit.kind === 'file' ? { parent: this.labelFor(dirname(hit.path)) } : {}),
    }))
  }

  private score(folder: string, tokens: string[]): number {
    const name = basename(folder).toLowerCase()
    const stem = name.replace(/\.[^.]+$/, '')
    const full = folder.toLowerCase()
    let total = 0
    let matchedName = false

    for (const token of tokens) {
      if (name === token || stem === token) {
        total += 100
        matchedName = true
      } else if (name.startsWith(token)) {
        total += 60
        matchedName = true
      } else if (name.includes(token)) {
        total += 35
        matchedName = true
      } else if (token.length >= 4 && editDistance(token, stem, 2) <= 2) {
        // A typo or a half-remembered name should still find its target.
        total += 28
        matchedName = true
      } else if (token.length >= 4 && isSubsequence(token, name)) {
        total += 20
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
  private entries(): { path: string; kind: 'folder' | 'file' }[] {
    const now = Date.now()
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.entries

    const found: { path: string; kind: 'folder' | 'file' }[] = []
    let scanned = 0

    // Breadth-first on purpose: a scan budget spent depth-first would be exhausted by files
    // buried in one large subtree before top-level projects were ever indexed.
    const queue: { dir: string; depth: number }[] = this.roots.map((root) => ({ dir: root, depth: 1 }))
    while (queue.length > 0 && scanned < MAX_SCANNED) {
      const { dir, depth } = queue.shift() as { dir: string; depth: number }
      if (depth > MAX_DEPTH) continue
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (scanned >= MAX_SCANNED) break
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
        if (SENSITIVE_DIR_NAMES.has(entry.name)) continue
        const child = join(dir, entry.name)
        if (entry.isFile()) {
          scanned += 1
          found.push({ path: child, kind: 'file' })
          continue
        }
        if (!entry.isDirectory()) continue
        // A symlink could point anywhere; only keep it if it still resolves inside a root.
        if (entry.isSymbolicLink() && !this.insideRoot(child)) continue
        scanned += 1
        found.push({ path: child, kind: 'folder' })
        queue.push({ dir: child, depth: depth + 1 })
      }
    }
    this.cache = { at: now, entries: found }
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
