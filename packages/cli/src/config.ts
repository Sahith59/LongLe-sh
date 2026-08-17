import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const HOSTED_RELAY = 'wss://app.longleash.dev/ws'

export interface CliConfig {
  cliSchemaVersion?: number
  allowedRoots?: string[]
  relayUrl?: string
  [key: string]: unknown
}

interface FileSnapshot {
  content: Buffer | null
  mode: number
}

export interface ConfigSnapshot {
  path: string
  config: FileSnapshot
  previous: FileSnapshot
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.LONGLEASH_DATA ?? join(homedir(), '.longleash'))
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'config.json')
}

export function loadConfig(path = configPath()): CliConfig {
  if (!pathExists(path)) return {}
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked configuration: ${path}`)
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Configuration is not a JSON object: ${path}`)
  }
  return parsed as CliConfig
}

export function normalizeRoots(values: string[]): string[] {
  const roots = [...new Set(values.map((value) => realpathSync(resolve(value))))]
  if (roots.length === 0) throw new Error('At least one allowed project directory is required.')
  for (const root of roots) {
    if (!lstatSync(root).isDirectory()) throw new Error(`Allowed root is not a directory: ${root}`)
    if (root === '/') throw new Error('Refusing to allow the entire filesystem. Choose project folders instead.')
  }
  return roots
}

export function normalizeRelay(value: string): string | null {
  const normalized = value.trim()
  if (normalized === '' || normalized === 'hosted') return HOSTED_RELAY
  if (normalized.toLowerCase() === 'off' || normalized.toLowerCase() === 'lan') return null
  const url = new URL(normalized)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Relay URLs must use wss://. Plain ws:// is accepted only for loopback development.')
  }
  url.hash = ''
  url.search = ''
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws'
  if (url.pathname !== '/ws') throw new Error('Relay URL path must be /ws.')
  return url.toString().replace(/\/$/, '')
}

export function saveConfig(next: CliConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (pathExists(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlinked configuration: ${path}`)
  }
  const temp = createTemporaryFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o600, 'tmp')
  try {
    if (pathExists(path)) {
      const backup = `${path}.previous`
      if (pathExists(backup) && lstatSync(backup).isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlinked configuration backup: ${backup}`)
      }
      writeBytesAtomically(backup, readFileSync(path), statSync(path).mode & 0o777)
    }
    renameSync(temp, path)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best-effort cleanup */ }
    throw error
  }
}

export function captureConfigSnapshot(path = configPath()): ConfigSnapshot {
  return {
    path,
    config: captureFile(path),
    previous: captureFile(`${path}.previous`),
  }
}

export function restoreConfigSnapshot(snapshot: ConfigSnapshot): void {
  const previous = `${snapshot.path}.previous`
  assertNotSymlink(snapshot.path)
  assertNotSymlink(previous)
  restoreFile(previous, snapshot.previous)
  restoreFile(snapshot.path, snapshot.config)
}

export function configuredRoots(config: CliConfig): string[] {
  return Array.isArray(config.allowedRoots)
    ? config.allowedRoots.filter((root): root is string => typeof root === 'string' && root !== '')
    : []
}

function captureFile(path: string): FileSnapshot {
  if (!pathExists(path)) return { content: null, mode: 0o600 }
  assertNotSymlink(path)
  return { content: readFileSync(path), mode: statSync(path).mode & 0o777 }
}

function assertNotSymlink(path: string): void {
  if (pathExists(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing symlinked configuration transaction path: ${path}`)
  }
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function restoreFile(path: string, snapshot: FileSnapshot): void {
  if (snapshot.content === null) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeBytesAtomically(path, snapshot.content, snapshot.mode)
}

function writeBytesAtomically(path: string, content: string | Buffer, mode: number): void {
  const temp = createTemporaryFile(path, content, mode, 'atomic')
  try {
    renameSync(temp, path)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best-effort cleanup */ }
    throw error
  }
}

function createTemporaryFile(path: string, content: string | Buffer, mode: number, suffix: string): string {
  const temp = `${path}.${randomUUID()}.${suffix}`
  const fd = openSync(temp, 'wx', mode)
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    return temp
  } catch (error) {
    try { closeSync(fd) } catch { /* original error wins */ }
    try { unlinkSync(temp) } catch { /* original error wins */ }
    throw error
  }
}
