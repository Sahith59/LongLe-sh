import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  captureConfigSnapshot,
  configPath,
  configuredRoots,
  HOSTED_RELAY,
  loadConfig,
  normalizeRelay,
  normalizeRoots,
  restoreConfigSnapshot,
  saveConfig,
} from './config.js'
import { assertVersion, installPaths, prepareManagedInstall, uninstallManagedRuntime } from './install.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
const VERSION = manifest.version
const runtime = join(packageRoot, 'runtime', 'daemon')
const daemonEntry = join(runtime, 'bin', 'longleashd.mjs')
const hooks = join(runtime, 'hooks')
const devicesEntry = join(runtime, 'bin', 'longleash-devices.mjs')

interface SetupOptions {
  roots: string[]
  relay: string
  yes: boolean
  reuse: boolean
  configureOnly: boolean
  skipHooks: boolean
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VERSION)
    return 0
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    help()
    return 0
  }
  if (command === 'where') {
    console.log(packageRoot)
    return 0
  }
  if (command === 'setup') return setup(parseSetup(args.slice(1)))
  if (command === 'doctor') return doctor(args.includes('--json'))
  if (command === 'hooks') return runHooks(args.slice(1))
  if (command === 'devices') return runNode(devicesEntry, [])
  if (command === 'revoke') return runNode(devicesEntry, ['revoke', ...args.slice(1)])
  if (command === 'update') return update(args[1] ?? 'latest')
  if (command === 'uninstall') return uninstall()
  if (command === 'run') return runDaemon(args.slice(1))
  if (command?.startsWith('-')) {
    console.error(`Unknown option: ${command}\n`)
    help()
    return 2
  }
  return runDaemon(args)
}

function help(): void {
  console.log(`LongLeash ${VERSION}

Usage:
  longleash setup                 configure a stable user-local installation
  longleash run [folders...]      run in the foreground (terminal stays open)
  longleash [folders...]          shorthand for run
  longleash doctor [--json]       report package, config, and daemon health
  longleash hooks [--remove]      install or remove supported provider hooks
  longleash devices               list paired phones
  longleash revoke <id|--all>     revoke paired phone access
  longleash update [version]      atomically install latest or an exact version
  longleash uninstall             remove runtime and hooks; preserve user data
  longleash where                 print the active npm package directory

Setup never starts the daemon. Background service commands arrive in Workstream C.`)
}

function parseSetup(args: string[]): SetupOptions {
  const options: SetupOptions = { roots: [], relay: '', yes: false, reuse: false, configureOnly: false, skipHooks: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--root') {
      const value = args[++i]
      if (!value) throw new Error('--root requires a directory.')
      options.roots.push(value)
    } else if (arg === '--relay') {
      const value = args[++i]
      if (!value) throw new Error('--relay requires hosted, off, or a wss:// URL.')
      options.relay = value
    } else if (arg === '--yes') options.yes = true
    else if (arg === '--reuse-config') options.reuse = true
    else if (arg === '--configure-only') options.configureOnly = true
    else if (arg === '--skip-hooks') options.skipHooks = true
    else throw new Error(`Unknown setup option: ${arg}`)
  }
  return options
}

async function setup(options: SetupOptions): Promise<number> {
  if (options.configureOnly && process.env.LONGLEASH_INTERNAL_CONFIGURE !== VERSION) {
    throw new Error('--configure-only is an internal transaction step and cannot be invoked directly.')
  }
  let existing: ReturnType<typeof loadConfig>
  try { existing = loadConfig() } catch (error) {
    throw new Error(`${message(error)} Fix or move ${configPath()} before setup.`)
  }

  if (options.reuse) {
    options.roots = configuredRoots(existing)
    options.relay = typeof existing.relayUrl === 'string' ? existing.relayUrl : 'off'
    options.yes = true
  }

  if (options.roots.length === 0 && options.yes) {
    throw new Error('Non-interactive setup requires at least one explicit --root, or --reuse-config.')
  }

  if (!options.yes) {
    if (!input.isTTY || !output.isTTY) {
      throw new Error('Interactive setup needs a terminal. Use --yes with explicit --root and --relay values.')
    }
    const prompt = createInterface({ input, output })
    try {
      console.log('\nLongLeash setup\n')
      console.log('Agents remain on this laptop. Choose only folders where they may work.')
      const rootAnswer = await prompt.question(`Allowed project folder [${process.cwd()}]: `)
      options.roots = [rootAnswer.trim() || process.cwd()]
      console.log('\nConnectivity: hosted works away from home; LAN-only has no internet relay.')
      const relayAnswer = await prompt.question('Relay [hosted / lan / wss://your-relay/ws] (hosted): ')
      options.relay = relayAnswer.trim() || 'hosted'
      const roots = normalizeRoots(options.roots)
      const relay = normalizeRelay(options.relay)
      console.log('\nReview before anything changes:')
      for (const root of roots) console.log(`  allowed root  ${root}`)
      console.log(`  connectivity  ${relay ?? 'LAN-only (no relay)'}`)
      console.log('  service       not installed or started in this workstream')
      const accepted = await prompt.question('\nApply this setup? [y/N] ')
      if (!/^y(?:es)?$/i.test(accepted.trim())) {
        console.log('Nothing changed.')
        return 1
      }
    } finally {
      prompt.close()
    }
  }

  const roots = normalizeRoots(options.roots)
  const relay = normalizeRelay(options.relay || 'hosted')

  if (!options.configureOnly) {
    const configSnapshot = captureConfigSnapshot()
    const prepared = prepareManagedInstall(VERSION)
    const forwarded = [
      'setup', '--configure-only', '--yes',
      ...roots.flatMap((root) => ['--root', root]),
      '--relay', relay ?? 'off',
      '--skip-hooks',
    ]
    const configured = spawnSync(process.execPath, [prepared.cli, ...forwarded], {
      stdio: 'inherit',
      env: { ...process.env, LONGLEASH_INTERNAL_CONFIGURE: VERSION },
    })
    if (configured.error || configured.status !== 0) {
      prepared.rollback()
      restoreConfigSnapshot(configSnapshot)
      throw new Error('The staged package could not be configured. The active version was not changed.')
    }
    try {
      prepared.activate()
    } catch (error) {
      prepared.rollback()
      restoreConfigSnapshot(configSnapshot)
      throw error
    }
    console.log(`\nActivated @longleash/cli ${VERSION}.`)
    if (!options.skipHooks) {
      const hooked = spawnSync(process.execPath, [prepared.cli, 'hooks'], { stdio: 'inherit', env: process.env })
      if (hooked.error || hooked.status !== 0) {
        console.error('Provider hook setup needs attention. The runtime is installed; run `longleash hooks` after fixing the message above.')
      }
    }
    const paths = installPaths()
    if (pathDirectories().includes(paths.bin)) {
      console.log('Open a new terminal if `longleash` is not yet visible in this shell.')
    } else {
      console.log(`\nThe executable is installed at ${paths.wrapper}, but ${paths.bin} is not on PATH.`)
      console.log('Add this line to your shell profile, then open a new terminal:')
      console.log(`  export PATH=${quoteForShell(paths.bin)}:"$PATH"`)
      console.log(`You can use ${paths.wrapper} immediately.`)
    }
    return 0
  }

  const next = { ...existing, cliSchemaVersion: 1, allowedRoots: roots }
  if (relay === null) delete next.relayUrl
  else next.relayUrl = relay
  saveConfig(next)
  console.log(`Saved configuration to ${configPath()}`)

  console.log('LongLeash was not started. Run `longleash run` when you are ready.')
  return 0
}

async function runDaemon(explicitRoots: string[]): Promise<number> {
  if (!existsSync(daemonEntry)) throw new Error('The npm package is incomplete: daemon runtime is missing.')
  const config = loadConfig()
  const roots = normalizeRoots(explicitRoots.length > 0 ? explicitRoots : configuredRoots(config))
  const child = spawn(process.execPath, [daemonEntry, ...roots], { stdio: 'inherit', env: process.env })
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
  })
}

async function doctor(json: boolean): Promise<number> {
  let config: ReturnType<typeof loadConfig> = {}
  let configError: string | null = null
  try { config = loadConfig() } catch (error) { configError = message(error) }
  const endpointPath = join(process.env.LONGLEASH_DATA ?? join(homedir(), '.longleash'), 'hook-endpoint.json')
  let daemon: { reachable: boolean; build?: string } = { reachable: false }
  try {
    const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8')) as { url?: string; secret?: string }
    if (endpoint.url && endpoint.secret) {
      const response = await fetch(endpoint.url.replace(/\/hook$/, '/health'), {
        headers: { 'x-longleash-hook': endpoint.secret },
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) {
        const health = await response.json() as { build?: string }
        daemon = { reachable: true, ...(health.build ? { build: health.build } : {}) }
      }
    }
  } catch { /* absence or refusal is a health result, not a crash */ }

  const report = {
    package: { name: '@longleash/cli', version: VERSION, root: packageRoot },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    config: {
      path: configPath(),
      valid: configError === null,
      error: configError,
      allowedRoots: configuredRoots(config),
      relay: typeof config.relayUrl === 'string' ? config.relayUrl : 'off',
    },
    daemon,
  }
  if (json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`\nLongLeash ${VERSION}`)
    console.log(`  package      ${packageRoot}`)
    console.log(`  node         ${process.version} (${process.platform} ${process.arch})`)
    console.log(`  config       ${configError ?? (configuredRoots(config).length > 0 ? 'valid' : 'not configured')}`)
    console.log(`  relay        ${report.config.relay}`)
    console.log(`  daemon       ${daemon.reachable ? `reachable · build ${daemon.build ?? 'unknown'}` : 'not running'}`)
    console.log('')
  }
  return configError === null ? 0 : 1
}

async function runHooks(args: string[]): Promise<number> {
  const remove = args.includes('--remove')
  let failed = false
  if (commandAvailable('claude') || remove) failed = (await runNode(join(hooks, 'install-hooks.mjs'), remove ? ['--remove'] : [])) !== 0 || failed
  if (commandAvailable('codex') || remove) failed = (await runNode(join(hooks, 'install-codex-hooks.mjs'), remove ? ['--remove'] : [])) !== 0 || failed
  return failed ? 1 : 0
}

async function update(target: string): Promise<number> {
  const spec = target === 'latest' ? '@longleash/cli@latest' : `@longleash/cli@${assertVersion(target)}`
  const child = spawn('npm', [
    'exec', '--yes', '--registry=https://registry.npmjs.org/', `--package=${spec}`,
    '--', 'longleash', 'setup', '--reuse-config', '--yes',
  ], {
    stdio: 'inherit', env: process.env,
  })
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}

async function uninstall(): Promise<number> {
  const hooksRemoved = await runHooks(['--remove'])
  if (hooksRemoved !== 0) throw new Error('Provider hooks could not be removed safely. The managed runtime was preserved.')
  const result = uninstallManagedRuntime()
  console.log(result.removed ? 'Removed the managed LongLeash runtime and executable.' : 'No managed LongLeash runtime was installed.')
  console.log(`Preserved settings, paired devices, and audit data in ${result.configPreserved}.`)
  return 0
}

function commandAvailable(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0
}

function pathDirectories(): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((path) => resolve(path))
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function runNode(entry: string, args: string[]): Promise<number> {
  const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit', env: process.env })
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`\nLongLeash: ${message(error)}\n`)
  process.exitCode = 1
}
