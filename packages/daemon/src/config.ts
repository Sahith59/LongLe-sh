import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeRelayUrl } from './relay-bridge.js'

export interface ResolvedRelay {
  url: string
  /** Whether this start was told the URL, or remembered it from a previous one. */
  source: 'flag' | 'remembered'
}

interface StoredConfig {
  relayUrl?: string
  [key: string]: unknown
}

/**
 * The relay URL, remembered. Typing LONGLEASH_RELAY_URL=wss://… before every start
 * is setup, not usage — so the first start writes it down and every later start
 * finds it in ~/.longleash/config.json. Passing a new URL replaces it; passing
 * `off` forgets it and runs LAN-only from then on.
 */
export function resolveRelayUrl(given: string | undefined, dataDir: string): ResolvedRelay | null {
  const path = join(dataDir, 'config.json')

  if (given !== undefined && given.trim().toLowerCase() === 'off') {
    const config = load(path)
    delete config.relayUrl
    save(path, config)
    return null
  }

  if (given !== undefined && given.trim() !== '') {
    const url = normalizeRelayUrl(given.trim())
    save(path, { ...load(path), relayUrl: url })
    return { url, source: 'flag' }
  }

  const remembered = load(path).relayUrl
  return typeof remembered === 'string' && remembered !== ''
    ? { url: remembered, source: 'remembered' }
    : null
}

function load(path: string): StoredConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as StoredConfig) : {}
  } catch {
    // Missing or corrupt: never refuse to start over a config file.
    return {}
  }
}

function save(path: string, config: StoredConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
}
