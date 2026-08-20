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
import { dataDir } from './config.js'
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
    <string>run</string>
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
ExecStart=${systemdQuote(paths.wrapper)} run
EnvironmentFile=${systemdQuote(paths.environment)}
WorkingDirectory=${systemdQuote(home)}
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
    if (launchdLoaded(resolved)) requireSuccess(resolved, '/bin/launchctl', ['kickstart', '-k', serviceTarget(resolved)])
    else requireSuccess(resolved, '/bin/launchctl', ['bootstrap', launchDomain(resolved), resolved.paths.definition])
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
      requireSuccess(resolved, '/bin/launchctl', ['bootout', serviceTarget(resolved)])
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
    if (launchdLoaded(resolved)) requireSuccess(resolved, '/bin/launchctl', ['kickstart', '-k', serviceTarget(resolved)])
    else requireSuccess(resolved, '/bin/launchctl', ['bootstrap', launchDomain(resolved), resolved.paths.definition])
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
    if (loaded) requireSuccess(resolved, '/bin/launchctl', ['bootout', serviceTarget(resolved)])
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
  if (wasLoaded) requireSuccess(context, '/bin/launchctl', ['bootout', serviceTarget(context)])
  try {
    writeManagedAtomically(context.paths.definition, content, 0o600, (temporary) => {
      requireSuccess(context, '/usr/bin/plutil', ['-lint', temporary])
    })
    requireSuccess(context, '/bin/launchctl', ['bootstrap', launchDomain(context), context.paths.definition])
  } catch (error) {
    restore(context.paths.definition, previous)
    if (previous !== null && wasLoaded) run(context, '/bin/launchctl', ['bootstrap', launchDomain(context), context.paths.definition])
    throw error
  }
}

function installSystemdService(context: ResolvedContext): void {
  if (!context.paths.environment) throw new Error('The Linux service environment path is missing.')
  const previousUnit = snapshot(context.paths.definition)
  const previousEnvironment = snapshot(context.paths.environment)
  try {
    writeManagedAtomically(context.paths.environment, renderSystemdEnvironment(context.paths, context.env), 0o600)
    writeManagedAtomically(context.paths.definition, renderSystemdUnit(context.paths, context.home), 0o600)
    requireSuccess(context, 'systemctl', ['--user', 'daemon-reload'])
    requireSuccess(context, 'systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
  } catch (error) {
    restore(context.paths.environment, previousEnvironment)
    restore(context.paths.definition, previousUnit)
    run(context, 'systemctl', ['--user', 'daemon-reload'])
    if (previousUnit !== null) run(context, 'systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
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

function environmentQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('Service environment values may not contain control characters.')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
