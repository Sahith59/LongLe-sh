import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { configPath, configuredRoots, dataDir, loadConfig, normalizeRoots } from './config.js'
import { installPaths } from './install.js'

export const SERVICE_LABEL = 'dev.longleash.daemon'
export const SYSTEMD_UNIT = 'longleash.service'
const MANAGED_MARKER = 'Managed by @longleash/cli'

export interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  file: string,
  args: string[],
  options?: SpawnSyncOptionsWithStringEncoding,
) => CommandResult

export interface ServiceContext {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  uid?: number
  runner?: CommandRunner
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void
}

export interface ServicePaths {
  data: string
  logs: string
  stdout: string
  stderr: string
  definition: string
  environment?: string
  wrapper: string
}

export interface ServiceState {
  platform: 'darwin' | 'linux'
  installed: boolean
  loaded: boolean
  active: boolean
  definition: string
  logs: string
  loginOnly: boolean
}

interface ResolvedContext {
  env: NodeJS.ProcessEnv
  platform: 'darwin' | 'linux'
  home: string
  uid: number
  runner: CommandRunner
  signalProcess: (pid: number, signal: NodeJS.Signals) => void
  paths: ServicePaths
}

export function servicePaths(context: ServiceContext = {}): ServicePaths {
  const env = context.env ?? process.env
  const platform = supportedPlatform(context.platform ?? process.platform)
  const home = resolve(context.home ?? homedir())
  const data = dataDir(env)
  const logs = join(data, 'logs')
  const wrapper = installPaths(env).wrapper
  if (platform === 'darwin') {
    return {
      data,
      logs,
      stdout: join(logs, 'daemon.stdout.log'),
      stderr: join(logs, 'daemon.stderr.log'),
      definition: join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
      wrapper,
    }
  }
  return {
    data,
    logs,
    stdout: 'journal',
    stderr: 'journal',
    definition: join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT),
    environment: join(home, '.config', 'longleash', 'service.env'),
    wrapper,
  }
}

export function renderLaunchAgent(paths: ServicePaths, env: NodeJS.ProcessEnv = process.env): string {
  const path = requiredEnvironment(env, 'PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  const home = resolve(env.HOME ?? homedir())
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MANAGED_MARKER} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(paths.wrapper)}</string>
    <string>__service-run</string>
${serviceRoots(paths).map((root) => `    <string>${xml(root)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(home)}</string>
    <key>PATH</key>
    <string>${xml(path)}</string>
    <key>LONGLEASH_DATA</key>
    <string>${xml(paths.data)}</string>
    <key>LONGLEASH_SERVICE</key>
    <string>1</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderr)}</string>
</dict>
</plist>
`
}

export function renderSystemdUnit(paths: ServicePaths, home: string): string {
  if (!paths.environment) throw new Error('The Linux service environment path is missing.')
  return `# ${MANAGED_MARKER}
[Unit]
Description=LongLeash phone control plane
Documentation=https://longleash.dev/docs/background-service
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${systemdQuote(paths.wrapper)} __service-run ${serviceRoots(paths).map(systemdQuote).join(' ')}
EnvironmentFile=${systemdPath(paths.environment)}
WorkingDirectory=${systemdPath(home)}
UMask=0077
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillMode=mixed

[Install]
WantedBy=default.target
`
}

export function renderSystemdEnvironment(paths: ServicePaths, env: NodeJS.ProcessEnv = process.env): string {
  const home = resolve(env.HOME ?? homedir())
  const path = requiredEnvironment(env, 'PATH', '/usr/local/bin:/usr/bin:/bin')
  return `# ${MANAGED_MARKER}
HOME=${environmentQuote(home)}
PATH=${environmentQuote(path)}
LONGLEASH_DATA=${environmentQuote(paths.data)}
LONGLEASH_SERVICE=1
`
}

function serviceRoots(paths: ServicePaths): string[] {
  const roots = normalizeRoots(configuredRoots(loadConfig(configPath({ LONGLEASH_DATA: paths.data }))))
  if (roots.some((root) => /[\u0000-\u001f\u007f-\u009f]/.test(root))) {
    throw new Error('Allowed project folders may not contain control characters in a service definition.')
  }
  return roots
}

export function serviceState(context: ServiceContext = {}): ServiceState {
  const resolved = resolveContext(context)
  const installed = managedDefinitionExists(resolved.paths.definition)
  if (installed && resolved.paths.environment) assertManagedDefinition(resolved.paths.environment)
  if (resolved.platform === 'darwin') {
    const loaded = launchdLoaded(resolved)
    return {
      platform: 'darwin',
      installed,
      loaded,
      active: loaded,
      definition: resolved.paths.definition,
      logs: resolved.paths.logs,
      loginOnly: false,
    }
  }
  const loaded = run(resolved, 'systemctl', ['--user', 'is-enabled', '--quiet', SYSTEMD_UNIT]).status === 0
  const active = run(resolved, 'systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_UNIT]).status === 0
  return {
    platform: 'linux',
    installed,
    loaded,
    active,
    definition: resolved.paths.definition,
    logs: 'journalctl --user-unit longleash.service',
    loginOnly: !lingerEnabled(resolved),
  }
}

/** A matching health response alone can come from a surviving old daemon. */
export function serviceProcessReady(context: ServiceContext = {}): boolean {
  const resolved = resolveContext(context)
  if (!managedDefinitionExists(resolved.paths.definition)) return false
  const lock = join(resolved.paths.data, 'daemon.lock')
  if (!existsSync(lock) || lstatSync(lock).isSymbolicLink()) return false
  let owner: { kind?: unknown; pid?: unknown; token?: unknown }
  try { owner = JSON.parse(readFileSync(lock, 'utf8')) as typeof owner } catch { return false }
  if (owner.kind !== 'longleash-daemon' || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 1 ||
      typeof owner.token !== 'string' || owner.token.length === 0) return false
  const manager = resolved.platform === 'darwin'
    ? run(resolved, '/bin/launchctl', ['print', serviceTarget(resolved)])
    : run(resolved, 'systemctl', ['--user', 'show', '--property=MainPID', '--value', SYSTEMD_UNIT])
  if (manager.status !== 0) return false
  const pid = resolved.platform === 'darwin'
    ? manager.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]
    : manager.stdout.trim()
  if (pid === undefined || Number(pid) !== owner.pid) return false
  try {
    if (lstatSync(lock).isSymbolicLink()) return false
    const current = JSON.parse(readFileSync(lock, 'utf8')) as typeof owner
    return current.kind === owner.kind && current.pid === owner.pid && current.token === owner.token
  } catch { return false }
}

export function installService(context: ServiceContext = {}): ServiceState {
  const resolved = resolveContext(context)
  assertManagedWrapper(resolved.paths.wrapper)
  mkdirSync(resolved.paths.logs, { recursive: true, mode: 0o700 })
  if (resolved.platform === 'darwin') installLaunchAgent(resolved)
  else installSystemdService(resolved)
  return serviceState(context)
}

export function startService(context: ServiceContext = {}): ServiceState {
  const resolved = resolveContext(context)
  assertServiceInstallation(resolved)
  if (resolved.platform === 'darwin') {
    if (launchdLoaded(resolved)) {
      const supervisorPid = launchdJobPid(resolved)
      requireSuccess(resolved, '/bin/launchctl', ['bootout', serviceTarget(resolved)])
      retireOwnedOrphan(resolved, supervisorPid)
    } else {
      retireOwnedOrphan(resolved)
    }
    bootstrapLaunchAgent(resolved)
  } else {
    requireSuccess(resolved, 'systemctl', ['--user', 'start', SYSTEMD_UNIT])
  }
  return serviceState(context)
}

export function stopService(context: ServiceContext = {}): ServiceState {
  const resolved = resolveContext(context)
  if (resolved.platform === 'darwin') {
    const loaded = launchdLoaded(resolved)
    if (loaded) {
      assertManagedDefinition(resolved.paths.definition)
      const supervisorPid = launchdJobPid(resolved)
      requireSuccess(resolved, '/bin/launchctl', ['bootout', serviceTarget(resolved)])
      retireOwnedOrphan(resolved, supervisorPid)
    } else if (managedDefinitionExists(resolved.paths.definition)) {
      retireOwnedOrphan(resolved)
    }
  } else if (run(resolved, 'systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_UNIT]).status === 0) {
    assertManagedDefinition(resolved.paths.definition)
    requireSuccess(resolved, 'systemctl', ['--user', 'stop', SYSTEMD_UNIT])
  }
  return serviceState(context)
}

export function restartService(context: ServiceContext = {}): ServiceState {
  const resolved = resolveContext(context)
  assertServiceInstallation(resolved)
  if (resolved.platform === 'darwin') {
    if (launchdLoaded(resolved)) {
      const supervisorPid = launchdJobPid(resolved)
      requireSuccess(resolved, '/bin/launchctl', ['bootout', serviceTarget(resolved)])
      retireOwnedOrphan(resolved, supervisorPid)
    } else {
      retireOwnedOrphan(resolved)
    }
    bootstrapLaunchAgent(resolved)
  } else {
    requireSuccess(resolved, 'systemctl', ['--user', 'restart', SYSTEMD_UNIT])
  }
  return serviceState(context)
}

export function uninstallService(context: ServiceContext = {}): ServiceState {
  const resolved = resolveContext(context)
  const installed = managedDefinitionExists(resolved.paths.definition)
  if (resolved.platform === 'darwin') {
    const loaded = launchdLoaded(resolved)
    if (loaded && !installed) {
      throw new Error(`Refusing to stop an unowned launchd job without a managed definition: ${resolved.paths.definition}`)
    }
    if (loaded) {
      const supervisorPid = launchdJobPid(resolved)
      requireSuccess(resolved, '/bin/launchctl', ['bootout', serviceTarget(resolved)])
      retireOwnedOrphan(resolved, supervisorPid)
    } else if (installed) {
      retireOwnedOrphan(resolved)
    }
    if (installed) rmSync(resolved.paths.definition)
  } else {
    if (installed) {
      const disabled = run(resolved, 'systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
      if (disabled.status !== 0 && run(resolved, 'systemctl', ['--user', 'is-enabled', '--quiet', SYSTEMD_UNIT]).status === 0) {
        throw commandError('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], disabled)
      }
      rmSync(resolved.paths.definition)
    }
    if (resolved.paths.environment && managedFileExists(resolved.paths.environment)) {
      assertManagedDefinition(resolved.paths.environment)
      rmSync(resolved.paths.environment)
    }
    requireSuccess(resolved, 'systemctl', ['--user', 'daemon-reload'])
    run(resolved, 'systemctl', ['--user', 'reset-failed', SYSTEMD_UNIT])
  }
  return serviceState(context)
}

export function showServiceLogs(follow: boolean, context: ServiceContext = {}): number {
  const resolved = resolveContext(context)
  if (resolved.platform === 'darwin') {
    mkdirSync(resolved.paths.logs, { recursive: true, mode: 0o700 })
    for (const path of [resolved.paths.stdout, resolved.paths.stderr]) {
      if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
    }
    return passthrough(resolved, '/usr/bin/tail', [...(follow ? ['-f'] : []), '-n', '200', resolved.paths.stdout, resolved.paths.stderr])
  }
  return passthrough(resolved, 'journalctl', ['--user-unit', SYSTEMD_UNIT, '-n', '200', '--no-pager', ...(follow ? ['--follow'] : [])])
}

function installLaunchAgent(context: ResolvedContext): void {
  const content = renderLaunchAgent(context.paths, context.env)
  const previous = snapshot(context.paths.definition)
  const wasLoaded = launchdLoaded(context)
  if (wasLoaded && previous === null) {
    throw new Error(`Refusing to replace an unowned launchd job without a managed definition: ${context.paths.definition}`)
  }
  if (wasLoaded) {
    const supervisorPid = launchdJobPid(context)
    requireSuccess(context, '/bin/launchctl', ['bootout', serviceTarget(context)])
    retireOwnedOrphan(context, supervisorPid)
  } else if (previous !== null) {
    retireOwnedOrphan(context)
  }
  try {
    writeManagedAtomically(context.paths.definition, content, 0o600, (temporary) => {
      requireSuccess(context, '/usr/bin/plutil', ['-lint', temporary])
    })
    bootstrapLaunchAgent(context)
  } catch (error) {
    restore(context.paths.definition, previous)
    if (previous !== null && wasLoaded) run(context, '/bin/launchctl', ['bootstrap', launchDomain(context), context.paths.definition])
    throw error
  }
}

/**
 * launchd occasionally returns EIO while replacing a per-user job even though the plist is
 * valid. That failure can mean either that bootstrap succeeded but its acknowledgement raced,
 * or that launchd retained a stale registration after bootout. Check the real job state first,
 * then clear and retry only LongLeash's already-verified managed label. The retry is deliberately
 * bounded so a genuinely broken definition still reaches the installer's rollback path.
 */
function bootstrapLaunchAgent(context: ResolvedContext): void {
  const args = ['bootstrap', launchDomain(context), context.paths.definition]
  const first = run(context, '/bin/launchctl', args)
  if (first.status === 0 || launchdLoaded(context)) return

  run(context, '/bin/launchctl', ['bootout', serviceTarget(context)])
  const retry = run(context, '/bin/launchctl', args)
  if (retry.status === 0 || launchdLoaded(context)) return

  const failure = commandError('/bin/launchctl', args, retry)
  const firstDetail = (first.stderr || first.stdout).trim().replace(/\s+/g, ' ').slice(0, 240)
  throw new Error(
    `${failure.message} launchd still rejected the managed job after one stale-state recovery attempt` +
    `${firstDetail ? ` (first response: ${firstDetail})` : ''}. Run \`longleash service logs\` for daemon output.`,
  )
}

function installSystemdService(context: ResolvedContext): void {
  if (!context.paths.environment) throw new Error('The Linux service environment path is missing.')
  const previousUnit = snapshot(context.paths.definition)
  const previousEnvironment = snapshot(context.paths.environment)
  const wasEnabled = run(context, 'systemctl', ['--user', 'is-enabled', '--quiet', SYSTEMD_UNIT]).status === 0
  const wasActive = run(context, 'systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_UNIT]).status === 0
  try {
    writeManagedAtomically(context.paths.environment, renderSystemdEnvironment(context.paths, context.env), 0o600)
    writeManagedAtomically(context.paths.definition, renderSystemdUnit(context.paths, context.home), 0o600)
    requireSuccess(context, 'systemctl', ['--user', 'daemon-reload'])
    if (wasActive) {
      // enable --now does not restart an already-running unit. Without this explicit restart an
      // update can report healthy while the old daemon binary remains in memory.
      if (!wasEnabled) requireSuccess(context, 'systemctl', ['--user', 'enable', SYSTEMD_UNIT])
      requireSuccess(context, 'systemctl', ['--user', 'restart', SYSTEMD_UNIT])
    } else {
      requireSuccess(context, 'systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
    }
  } catch (error) {
    restore(context.paths.environment, previousEnvironment)
    restore(context.paths.definition, previousUnit)
    run(context, 'systemctl', ['--user', 'daemon-reload'])
    if (previousUnit !== null) {
      if (wasEnabled) run(context, 'systemctl', ['--user', 'enable', SYSTEMD_UNIT])
      else run(context, 'systemctl', ['--user', 'disable', SYSTEMD_UNIT])
      if (wasActive) run(context, 'systemctl', ['--user', 'restart', SYSTEMD_UNIT])
      else run(context, 'systemctl', ['--user', 'stop', SYSTEMD_UNIT])
    }
    throw error
  }
}

function resolveContext(context: ServiceContext): ResolvedContext {
  const env = context.env ?? process.env
  const platform = supportedPlatform(context.platform ?? process.platform)
  const home = resolve(context.home ?? homedir())
  const uid = context.uid ?? process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid! < 0) throw new Error('Could not determine the current user id for the service manager.')
  return {
    env,
    platform,
    home,
    uid: uid!,
    runner: context.runner ?? defaultRunner,
    signalProcess: context.signalProcess ?? ((pid, signal) => process.kill(pid, signal)),
    paths: servicePaths({ env, platform, home }),
  }
}

function supportedPlatform(platform: NodeJS.Platform): 'darwin' | 'linux' {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Background services are supported on macOS and systemd Linux, not ${platform}. Use \`longleash run\` instead.`)
  }
  return platform
}

function defaultRunner(file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8' }): CommandResult {
  const result = spawnSync(file, args, { ...options, encoding: 'utf8' })
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? ''),
  }
}

function run(context: ResolvedContext, file: string, args: string[]): CommandResult {
  return context.runner(file, args, { encoding: 'utf8', env: context.env })
}

function requireSuccess(context: ResolvedContext, file: string, args: string[]): CommandResult {
  const result = run(context, file, args)
  if (result.status !== 0) throw commandError(file, args, result)
  return result
}

function commandError(file: string, args: string[], result: CommandResult): Error {
  const detail = (result.stderr || result.stdout).trim().replace(/\s+/g, ' ').slice(0, 400)
  return new Error(`${file} ${args.join(' ')} failed${detail ? `: ${detail}` : '.'}`)
}

function passthrough(context: ResolvedContext, file: string, args: string[]): number {
  const result = spawnSync(file, args, { stdio: 'inherit', env: context.env })
  return result.status ?? 1
}

function launchDomain(context: ResolvedContext): string {
  return `gui/${context.uid}`
}

function serviceTarget(context: ResolvedContext): string {
  return `${launchDomain(context)}/${SERVICE_LABEL}`
}

function launchdLoaded(context: ResolvedContext): boolean {
  return run(context, '/bin/launchctl', ['print', serviceTarget(context)]).status === 0
}

function launchdJobPid(context: ResolvedContext): number | null {
  const result = run(context, '/bin/launchctl', ['print', serviceTarget(context)])
  if (result.status !== 0) return null
  const pid = Number(result.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1])
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null
}

/** Retire only a daemon proved to be an orphan from this managed installation. */
function retireOwnedOrphan(context: ResolvedContext, formerSupervisorPid: number | null = null): void {
  const lock = join(context.paths.data, 'daemon.lock')
  if (!existsSync(lock) || lstatSync(lock).isSymbolicLink()) return
  let owner: { kind?: unknown; pid?: unknown; token?: unknown }
  try { owner = JSON.parse(readFileSync(lock, 'utf8')) as typeof owner } catch { return }
  if (owner.kind !== 'longleash-daemon' || !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) <= 1 || owner.pid === process.pid ||
      typeof owner.token !== 'string' || owner.token.length === 0) return
  const pid = owner.pid as number
  const token = owner.token
  const home = installPaths(context.env).home
  const daemonPath = new RegExp(`(?:^|\\s)${escapeRegex(home)}/(?:current|releases/[^/\\s]+)/node_modules/@longleash/cli/runtime/daemon/bin/longleashd\\.mjs(?:\\s|$)`)
  const cliPath = new RegExp(`(?:^|\\s)${escapeRegex(home)}/(?:current|releases/[^/\\s]+)/node_modules/@longleash/cli/bin/longleash\\.mjs\\s+run(?:\\s|$)`)
  const formerSupervisorVerified = (ppid: number): boolean => {
    if (formerSupervisorPid === null || ppid !== formerSupervisorPid) return false
    const parent = run(context, '/bin/ps', ['-ww', '-p', String(ppid), '-o', 'uid=', '-o', 'command='])
    if (parent.status !== 0) return false
    const match = parent.stdout.trim().match(/^(\d+)\s+(.+)$/s)
    return match !== null && Number(match[1]) === context.uid &&
      /^(?:\S*\/)?node\s/.test(match[2] ?? '') && cliPath.test(match[2] ?? '')
  }
  const verified = (): boolean => {
    if (!existsSync(lock) || lstatSync(lock).isSymbolicLink()) return false
    let current: { kind?: unknown; pid?: unknown; token?: unknown }
    try { current = JSON.parse(readFileSync(lock, 'utf8')) as typeof current } catch { return false }
    if (current.kind !== 'longleash-daemon' || current.pid !== pid || current.token !== token) return false
    const result = run(context, '/bin/ps', ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'ppid=', '-o', 'command='])
    if (result.status !== 0) return false
    const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/s)
    if (match === null || Number(match[1]) !== context.uid ||
      (Number(match[2]) !== 1 && !formerSupervisorVerified(Number(match[2]))) ||
      !/^(?:\S*\/)?node\s/.test(match[3] ?? '') || !daemonPath.test(match[3] ?? '')) return false
    try {
      const afterPs = JSON.parse(readFileSync(lock, 'utf8')) as typeof current
      return !lstatSync(lock).isSymbolicLink() && afterPs.kind === 'longleash-daemon' && afterPs.pid === pid && afterPs.token === token
    } catch { return false }
  }
  // launchd may return from bootout just before the former CLI child is reparented.
  for (let attempt = 0; attempt < 5 && !verified(); attempt += 1) pause(100)
  if (!verified()) return
  if (!signalOwnedProcess(context, pid, 'SIGTERM')) return
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!verified()) return
    pause(100)
  }
  if (verified() && !signalOwnedProcess(context, pid, 'SIGKILL')) return
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!verified()) return
    pause(100)
  }
  throw new Error(`Verified orphan LongLeash daemon ${pid} did not exit after bounded shutdown.`)
}

function signalOwnedProcess(context: ResolvedContext, pid: number, signal: NodeJS.Signals): boolean {
  try {
    context.signalProcess(pid, signal)
    return true
  } catch (error) {
    // The verified child may exit between the final ps and kill syscall.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function lingerEnabled(context: ResolvedContext): boolean {
  const result = run(context, 'loginctl', ['show-user', String(context.uid), '--property=Linger', '--value'])
  return result.status === 0 && result.stdout.trim().toLowerCase() === 'yes'
}

function assertManagedWrapper(path: string): void {
  if (!existsSync(path)) throw new Error(`Managed LongLeash executable is missing: ${path}. Run \`longleash setup\` first.`)
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked LongLeash executable: ${path}`)
  if (!readFileSync(path, 'utf8').includes(MANAGED_MARKER)) throw new Error(`Refusing unmanaged LongLeash executable: ${path}`)
}

function assertManagedDefinition(path: string): void {
  if (!managedFileExists(path)) throw new Error(`LongLeash background service is not installed: ${path}`)
  if (!readFileSync(path, 'utf8').includes(MANAGED_MARKER)) throw new Error(`Refusing unmanaged service definition: ${path}`)
}

function assertServiceInstallation(context: ResolvedContext): void {
  assertManagedDefinition(context.paths.definition)
  if (context.paths.environment) assertManagedDefinition(context.paths.environment)
  assertManagedWrapper(context.paths.wrapper)
}

function managedDefinitionExists(path: string): boolean {
  if (!managedFileExists(path)) return false
  assertManagedDefinition(path)
  return true
}

function managedFileExists(path: string): boolean {
  if (!existsSync(path)) return false
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked service path: ${path}`)
  return true
}

function snapshot(path: string): { content: string; mode: number } | null {
  if (!managedFileExists(path)) return null
  assertManagedDefinition(path)
  return { content: readFileSync(path, 'utf8'), mode: lstatSync(path).mode & 0o777 }
}

function restore(path: string, previous: { content: string; mode: number } | null): void {
  if (previous === null) rmSync(path, { force: true })
  else writeManagedAtomically(path, previous.content, previous.mode)
}

function writeManagedAtomically(path: string, content: string, mode: number, validate?: (temporary: string) => void): void {
  if (!content.includes(MANAGED_MARKER)) throw new Error('Refusing to write an unmarked service definition.')
  if (managedFileExists(path)) assertManagedDefinition(path)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode, flag: 'wx' })
    chmodSync(temporary, mode)
    validate?.(temporary)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] || fallback
  if (/[\0\r\n]/.test(value)) throw new Error(`Unsafe ${name} value for background service.`)
  return value
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function systemdQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('Service paths may not contain control characters.')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

/**
 * Scalar path directives do not use ExecStart's command-line tokenizer. A quote after the `=`
 * is therefore part of the path on systemd, which turns `"/home/user"` into a relative path.
 * Keep the path unquoted and use unit-file escapes for characters that carry syntax.
 */
function systemdPath(value: string): string {
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('Service paths may not contain control characters.')
  }
  return value
    .replace(/%/g, '%%')
    .replace(/\\/g, '\\x5c')
    .replace(/ /g, '\\x20')
    .replace(/\t/g, '\\x09')
    .replace(/"/g, '\\x22')
    .replace(/'/g, '\\x27')
}

function environmentQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('Service environment values may not contain control characters.')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
