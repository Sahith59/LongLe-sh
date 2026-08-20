import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const PACKAGE_NAME = '@longleash/cli'
const MARKER = '.longleash-managed-install.json'
const WRAPPER_MARKER = '# Managed by @longleash/cli'

export interface InstallPaths {
  home: string
  releases: string
  current: string
  bin: string
  wrapper: string
}

export function installPaths(env: NodeJS.ProcessEnv = process.env): InstallPaths {
  const home = resolve(env.LONGLEASH_INSTALL_HOME ?? join(homedir(), '.local', 'share', 'longleash'))
  const bin = resolve(env.LONGLEASH_BIN_DIR ?? join(homedir(), '.local', 'bin'))
  assertSafeInstallHome(home, env.LONGLEASH_INSTALL_HOME !== undefined)
  assertSafeInstallPath(bin, env.LONGLEASH_BIN_DIR !== undefined, 'binary directory')
  return { home, releases: join(home, 'releases'), current: join(home, 'current'), bin, wrapper: join(bin, 'longleash') }
}

export function assertVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Invalid LongLeash version: ${value}`)
  }
  return value
}

export function updatePackageSpec(target: string | undefined, currentVersion: string): string {
  const selected = target ?? (currentVersion.includes('-') ? 'rc' : 'latest')
  if (selected === 'latest' || selected === 'rc') return `@longleash/cli@${selected}`
  return `@longleash/cli@${assertVersion(selected)}`
}

export function packageLocation(prefix: string): string {
  return join(prefix, 'node_modules', '@longleash', 'cli')
}

export function verifyInstalledPackage(prefix: string, expectedVersion: string): string {
  const root = packageLocation(prefix)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string; bin?: unknown }
  if (manifest.name !== PACKAGE_NAME || manifest.version !== expectedVersion) {
    throw new Error(`Installed package identity mismatch: expected ${PACKAGE_NAME}@${expectedVersion}.`)
  }
  const cli = join(root, 'bin', 'longleash.mjs')
  const daemon = join(root, 'runtime', 'daemon', 'bin', 'longleashd.mjs')
  const app = join(root, 'runtime', 'app', 'dist', 'index.html')
  for (const path of [cli, daemon, app]) {
    if (!existsSync(path)) throw new Error(`Installed package is incomplete: missing ${path}`)
  }
  return cli
}

export interface PreparedInstall {
  cli: string
  activate(): void
  rollback(): void
}

export function prepareManagedInstall(version: string, env: NodeJS.ProcessEnv = process.env): PreparedInstall {
  assertVersion(version)
  const paths = installPaths(env)
  const localPackage = env.LONGLEASH_PACKAGE_SPEC
  if (localPackage !== undefined && env.LONGLEASH_ALLOW_LOCAL_PACKAGE !== '1') {
    throw new Error('A local package override requires LONGLEASH_ALLOW_LOCAL_PACKAGE=1. It is intended only for isolated release tests.')
  }
  const packageSpec = localPackage ?? `${PACKAGE_NAME}@${version}`
  if (localPackage !== undefined && (!localPackage.endsWith('.tgz') || !existsSync(resolve(localPackage)))) {
    throw new Error('The local package override must point to an existing .tgz tarball.')
  }
  mkdirSync(paths.releases, { recursive: true, mode: 0o700 })
  const releaseLock = acquireInstallLock(paths.home)
  const release = join(paths.releases, version)

  try {
    let installedThisRun = false
    const releaseExists = pathExists(release)
    if (releaseExists && lstatSync(release).isSymbolicLink()) {
      throw new Error(`Refusing symlinked LongLeash release: ${release}`)
    }
    let needsInstall = !releaseExists
    if (!needsInstall) {
      try {
        verifyInstalledPackage(release, version)
      } catch (error) {
        if (isCurrentRelease(paths.current, release)) {
          throw new Error(`The active LongLeash release is incomplete and was preserved for diagnosis: ${String(error)}`)
        }
        safeRemoveRelease(release, paths.releases)
        needsInstall = true
      }
    }

    if (needsInstall) {
      const stage = join(paths.releases, `.${version}-${process.pid}-${randomUUID()}.stage`)
      mkdirSync(stage, { recursive: false, mode: 0o700 })
      const installArgs = [
        'install', '--prefix', stage, '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false',
        '--registry=https://registry.npmjs.org/',
        packageSpec,
      ]
      const installed = spawnSync(
        'npm',
        installArgs,
        { stdio: 'inherit', env },
      )
      if (installed.error || installed.status !== 0) {
        safeRemoveStage(stage, paths.releases)
        throw new Error(`npm could not stage ${PACKAGE_NAME}@${version}. The active version was not changed.`)
      }
      try {
        verifyInstalledPackage(stage, version)
        renameSync(stage, release)
        installedThisRun = true
      } catch (error) {
        safeRemoveStage(stage, paths.releases)
        throw error
      }
    }

    const cli = verifyInstalledPackage(release, version)
    let activated = false
    let lockHeld = true
    const unlock = () => {
      if (!lockHeld) return
      lockHeld = false
      releaseLock()
    }
    return {
      cli,
      activate() {
        const marker = join(paths.home, MARKER)
        const hadWrapper = pathExists(paths.wrapper)
        const hadMarker = pathExists(marker)
        let previousWrapper: string | undefined
        let previousMarker: string | undefined
        let wrapperWritten = false
        let markerWritten = false
        const tempLink = join(paths.home, `.current-${process.pid}-${randomUUID()}`)
        try {
          mkdirSync(paths.bin, { recursive: true, mode: 0o700 })
          if (hadWrapper) {
            if (lstatSync(paths.wrapper).isSymbolicLink()) throw new Error(`Refusing symlinked executable: ${paths.wrapper}`)
            previousWrapper = readFileSync(paths.wrapper, 'utf8')
            if (!previousWrapper.includes(WRAPPER_MARKER)) {
              throw new Error(`Refusing to replace an unmanaged executable: ${paths.wrapper}`)
            }
          }
          if (hadMarker) {
            if (lstatSync(marker).isSymbolicLink()) throw new Error(`Refusing symlinked install marker: ${marker}`)
            previousMarker = readFileSync(marker, 'utf8')
          }
          const activeCli = join(paths.current, 'node_modules', '@longleash', 'cli', 'bin', 'longleash.mjs')
          // Login services do not inherit a shell's PATH. Pin the exact Node executable that
          // successfully verified and installed this release instead of hoping `node` resolves.
          writeExecutableAtomically(paths.wrapper, wrapper(activeCli, process.execPath))
          wrapperWritten = true
          writeFileAtomically(marker, `${JSON.stringify({ schema: 1, package: PACKAGE_NAME }, null, 2)}\n`, 0o600)
          markerWritten = true

          symlinkSync(release, tempLink, 'dir')
          if (pathExists(paths.current) && !lstatSync(paths.current).isSymbolicLink()) {
            throw new Error(`Refusing to replace non-symlink path: ${paths.current}`)
          }
          renameSync(tempLink, paths.current)
          activated = true
        } catch (error) {
          try { rmSync(tempLink, { force: true }) } catch { /* best-effort cleanup */ }
          const restorationFailures: string[] = []
          if (wrapperWritten) {
            try { restoreManagedFile(paths.wrapper, hadWrapper ? previousWrapper : undefined, 0o700) }
            catch (restoreError) { restorationFailures.push(`executable: ${String(restoreError)}`) }
          }
          if (markerWritten) {
            try { restoreManagedFile(marker, hadMarker ? previousMarker : undefined, 0o600) }
            catch (restoreError) { restorationFailures.push(`marker: ${String(restoreError)}`) }
          }
          if (restorationFailures.length > 0) {
            throw new Error(
              `Activation failed (${String(error)}) and automatic restoration was incomplete (${restorationFailures.join('; ')}). Inspect ${paths.home} before retrying.`,
            )
          }
          throw error
        } finally {
          unlock()
        }
      },
      rollback() {
        try {
          if (installedThisRun && !activated && !isCurrentRelease(paths.current, release)) {
            safeRemoveRelease(release, paths.releases)
          }
        } finally {
          unlock()
        }
      },
    }
  } catch (error) {
    releaseLock()
    throw error
  }
}

export function uninstallManagedRuntime(env: NodeJS.ProcessEnv = process.env): { removed: boolean; configPreserved: string } {
  const paths = installPaths(env)
  const marker = join(paths.home, MARKER)
  if (!pathExists(marker)) return { removed: false, configPreserved: resolve(env.LONGLEASH_DATA ?? join(homedir(), '.longleash')) }
  if (lstatSync(marker).isSymbolicLink()) throw new Error(`Refusing symlinked install marker: ${marker}`)
  const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { package?: string }
  if (parsed.package !== PACKAGE_NAME) throw new Error(`Refusing to remove unrecognized install directory: ${paths.home}`)

  if (pathExists(paths.wrapper)) {
    if (lstatSync(paths.wrapper).isSymbolicLink()) throw new Error(`Refusing symlinked executable: ${paths.wrapper}`)
    const wrapperText = readFileSync(paths.wrapper, 'utf8')
    if (!wrapperText.includes(WRAPPER_MARKER)) throw new Error(`Refusing to remove an unmanaged executable: ${paths.wrapper}`)
    rmSync(paths.wrapper)
  }
  rmSync(paths.home, { recursive: true })
  return { removed: true, configPreserved: resolve(env.LONGLEASH_DATA ?? join(homedir(), '.longleash')) }
}

function wrapper(cli: string, node: string): string {
  return `#!/bin/sh\n${WRAPPER_MARKER}\nexec ${shellQuote(node)} ${shellQuote(cli)} "$@"\n`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function writeExecutableAtomically(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o700, flag: 'wx' })
    chmodSync(temp, 0o700)
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* original error wins */ }
    throw error
  }
}

function writeFileAtomically(path: string, content: string, mode: number): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode, flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* original error wins */ }
    throw error
  }
}

function restoreManagedFile(path: string, content: string | undefined, mode: number): void {
  if (content === undefined) rmSync(path, { force: true })
  else writeFileAtomically(path, content, mode)
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function assertSafeInstallHome(path: string, explicitlyConfigured: boolean): void {
  assertSafeInstallPath(path, explicitlyConfigured, 'install directory')
}

function assertSafeInstallPath(path: string, explicitlyConfigured: boolean, label: string): void {
  const home = resolve(homedir())
  const resolved = resolve(path)
  if (resolved === '/' || resolved === home || resolved === dirname(home)) {
    throw new Error(`Unsafe LongLeash ${label}: ${resolved}`)
  }
  if (relative(home, resolved).startsWith(`..${sep}`) && !explicitlyConfigured) {
    throw new Error(`Default ${label} escaped the user home: ${resolved}`)
  }
}

function safeRemoveStage(path: string, releases: string): void {
  const rel = relative(releases, path)
  if (!rel.startsWith('.') || rel.includes(sep)) throw new Error(`Refusing unsafe stage cleanup: ${path}`)
  rmSync(path, { recursive: true, force: true })
}

function safeRemoveRelease(path: string, releases: string): void {
  const rel = relative(releases, path)
  if (rel === '' || rel.startsWith('..') || basename(path) !== rel) throw new Error(`Refusing unsafe release cleanup: ${path}`)
  rmSync(path, { recursive: true, force: true })
}

function isCurrentRelease(current: string, release: string): boolean {
  try { return resolve(dirname(current), readlinkSync(current)) === release } catch { return false }
}

export function acquireInstallLock(home: string): () => void {
  const path = join(home, '.install.lock')
  const token = randomUUID()
  const create = () => {
    const fd = openSync(path, 'wx', 0o600)
    try { writeFileSync(fd, `${JSON.stringify({ package: PACKAGE_NAME, pid: process.pid, token })}\n`) } finally { closeSync(fd) }
  }
  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked install lock: ${path}`)
    let owner: { package?: string; pid?: number } = {}
    try { owner = JSON.parse(readFileSync(path, 'utf8')) as typeof owner } catch { /* invalid locks are not trusted */ }
    if (owner.package !== PACKAGE_NAME || !Number.isSafeInteger(owner.pid)) {
      throw new Error(`Unrecognized install lock requires manual inspection: ${path}`)
    }
    if (processAlive(owner.pid!)) throw new Error(`Another LongLeash setup is already running as process ${owner.pid}.`)
    rmSync(path)
    create()
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8')) as { token?: string }
      if (owner.token === token) rmSync(path)
    } catch { /* a missing lock already means released */ }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
