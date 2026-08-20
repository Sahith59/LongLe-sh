import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireInstallLock,
  assertVersion,
  installPaths,
  prepareManagedInstall,
  uninstallManagedRuntime,
  updatePackageSpec,
  verifyInstalledPackage,
} from '../src/install.js'

describe('managed npm installation boundary', () => {
  function createRelease(root: string, version = '1.2.3') {
    const env = {
      ...process.env,
      LONGLEASH_INSTALL_HOME: join(root, 'managed'),
      LONGLEASH_BIN_DIR: join(root, 'bin'),
      LONGLEASH_DATA: join(root, 'data'),
    }
    const paths = installPaths(env)
    const release = join(paths.releases, version)
    const packageRoot = join(release, 'node_modules', '@longleash', 'cli')
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    mkdirSync(join(packageRoot, 'runtime', 'daemon', 'bin'), { recursive: true })
    mkdirSync(join(packageRoot, 'runtime', 'app', 'dist'), { recursive: true })
    mkdirSync(paths.bin, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@longleash/cli', version }))
    writeFileSync(join(packageRoot, 'bin', 'longleash.mjs'), '')
    writeFileSync(join(packageRoot, 'runtime', 'daemon', 'bin', 'longleashd.mjs'), '')
    writeFileSync(join(packageRoot, 'runtime', 'app', 'dist', 'index.html'), '')
    return { env, paths, release }
  }

  function createLegacyWrapper(root: string, wrapperPath: string): string {
    const checkout = join(root, 'legacy checkout')
    mkdirSync(join(checkout, 'scripts'), { recursive: true })
    writeFileSync(join(checkout, 'scripts', 'longleash.sh'), '#!/usr/bin/env bash\n')
    const content = `#!/usr/bin/env bash\n# Created by the LongLeash installer. The three values below are the settings; the behaviour\n# lives in $LONGLEASH_DIR/scripts/longleash.sh and updates with the code.\nset -euo pipefail\nexport LONGLEASH_DIR="${checkout}"\nexport LONGLEASH_DEFAULT_ROOTS="${root}"\nexport LONGLEASH_DEFAULT_RELAY="wss://app.longleash.dev/ws"\nexec bash "$LONGLEASH_DIR/scripts/longleash.sh" "$@"\n`
    writeFileSync(wrapperPath, content, { mode: 0o755 })
    return content
  }
  it('accepts exact versions but not tags, ranges, commands, or package specs', () => {
    expect(assertVersion('1.2.3')).toBe('1.2.3')
    expect(assertVersion('1.2.3-rc.4')).toBe('1.2.3-rc.4')
    for (const unsafe of ['latest', '^1.2.3', '../file.tgz', '1.2.3 && touch x', '@other/pkg']) {
      expect(() => assertVersion(unsafe)).toThrow('Invalid LongLeash version')
    }
  })

  it('keeps prerelease updates on rc while stable builds follow latest', () => {
    expect(updatePackageSpec(undefined, '0.1.0-rc.3')).toBe('@longleash/cli@rc')
    expect(updatePackageSpec(undefined, '0.1.0')).toBe('@longleash/cli@latest')
    expect(updatePackageSpec('rc', '0.1.0')).toBe('@longleash/cli@rc')
    expect(updatePackageSpec('0.1.0-rc.1', '0.1.0-rc.3')).toBe('@longleash/cli@0.1.0-rc.1')
    expect(() => updatePackageSpec('next', '0.1.0')).toThrow('Invalid LongLeash version')
  })

  it('verifies package identity and required runtime files before activation', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'longleash-prefix-'))
    const root = join(prefix, 'node_modules', '@longleash', 'cli')
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(root, 'runtime', 'daemon', 'bin'), { recursive: true })
    mkdirSync(join(root, 'runtime', 'app', 'dist'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@longleash/cli', version: '1.2.3' }))
    writeFileSync(join(root, 'bin', 'longleash.mjs'), '')
    writeFileSync(join(root, 'runtime', 'daemon', 'bin', 'longleashd.mjs'), '')
    writeFileSync(join(root, 'runtime', 'app', 'dist', 'index.html'), '')
    expect(verifyInstalledPackage(prefix, '1.2.3')).toBe(join(root, 'bin', 'longleash.mjs'))
    expect(() => verifyInstalledPackage(prefix, '1.2.4')).toThrow('identity mismatch')
  })

  it('refuses to remove an executable it does not own', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-uninstall-'))
    const env = {
      ...process.env,
      LONGLEASH_INSTALL_HOME: join(root, 'managed'),
      LONGLEASH_BIN_DIR: join(root, 'bin'),
      LONGLEASH_DATA: join(root, 'data'),
    }
    const paths = installPaths(env)
    mkdirSync(paths.home, { recursive: true })
    mkdirSync(paths.bin, { recursive: true })
    writeFileSync(join(paths.home, '.longleash-managed-install.json'), JSON.stringify({ schema: 1, package: '@longleash/cli' }))
    writeFileSync(paths.wrapper, '#!/bin/sh\necho user-owned\n')
    expect(() => uninstallManagedRuntime(env)).toThrow('unmanaged executable')
    expect(readFileSync(paths.wrapper, 'utf8')).toContain('user-owned')
  })

  it('serializes installers and recovers only a recognized dead-owner lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-lock-'))
    const release = acquireInstallLock(root)
    expect(() => acquireInstallLock(root)).toThrow('already running')
    release()

    writeFileSync(join(root, '.install.lock'), JSON.stringify({ package: '@longleash/cli', pid: 99_999_999 }))
    const releaseRecovered = acquireInstallLock(root)
    releaseRecovered()
  })

  it('restores managed files when activation refuses an unsafe current path', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-activate-'))
    const env = {
      ...process.env,
      LONGLEASH_INSTALL_HOME: join(root, 'managed'),
      LONGLEASH_BIN_DIR: join(root, 'bin'),
    }
    const paths = installPaths(env)
    const release = join(paths.releases, '1.2.3')
    const packageRoot = join(release, 'node_modules', '@longleash', 'cli')
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    mkdirSync(join(packageRoot, 'runtime', 'daemon', 'bin'), { recursive: true })
    mkdirSync(join(packageRoot, 'runtime', 'app', 'dist'), { recursive: true })
    mkdirSync(paths.bin, { recursive: true })
    mkdirSync(paths.current, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@longleash/cli', version: '1.2.3' }))
    writeFileSync(join(packageRoot, 'bin', 'longleash.mjs'), '')
    writeFileSync(join(packageRoot, 'runtime', 'daemon', 'bin', 'longleashd.mjs'), '')
    writeFileSync(join(packageRoot, 'runtime', 'app', 'dist', 'index.html'), '')
    const oldWrapper = '#!/bin/sh\n# Managed by @longleash/cli\necho old\n'
    const oldMarker = JSON.stringify({ package: '@longleash/cli', previous: true })
    writeFileSync(paths.wrapper, oldWrapper)
    writeFileSync(join(paths.home, '.longleash-managed-install.json'), oldMarker)

    const prepared = prepareManagedInstall('1.2.3', env)
    expect(() => prepared.activate()).toThrow('non-symlink path')
    prepared.rollback()

    expect(readFileSync(paths.wrapper, 'utf8')).toBe(oldWrapper)
    expect(readFileSync(join(paths.home, '.longleash-managed-install.json'), 'utf8')).toBe(oldMarker)
    expect(existsSync(join(paths.home, '.install.lock'))).toBe(false)
    expect(existsSync(release)).toBe(true)
  })

  it('pins the verified Node executable in the managed wrapper for login services', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-node-path-'))
    const env = {
      ...process.env,
      LONGLEASH_INSTALL_HOME: join(root, 'managed'),
      LONGLEASH_BIN_DIR: join(root, 'bin'),
    }
    const paths = installPaths(env)
    const release = join(paths.releases, '1.2.3')
    const packageRoot = join(release, 'node_modules', '@longleash', 'cli')
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    mkdirSync(join(packageRoot, 'runtime', 'daemon', 'bin'), { recursive: true })
    mkdirSync(join(packageRoot, 'runtime', 'app', 'dist'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@longleash/cli', version: '1.2.3' }))
    writeFileSync(join(packageRoot, 'bin', 'longleash.mjs'), '')
    writeFileSync(join(packageRoot, 'runtime', 'daemon', 'bin', 'longleashd.mjs'), '')
    writeFileSync(join(packageRoot, 'runtime', 'app', 'dist', 'index.html'), '')

    prepareManagedInstall('1.2.3', env).activate()
    const executable = readFileSync(paths.wrapper, 'utf8')
    expect(executable).toContain(`exec '${process.execPath}'`)
    expect(executable).not.toContain('exec node ')
  })

  it('migrates the exact legacy installer wrapper and restores it on uninstall', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-legacy-migrate-'))
    const { env, paths } = createRelease(root)
    const legacy = createLegacyWrapper(root, paths.wrapper)

    const activation = prepareManagedInstall('1.2.3', env).activate()
    expect(activation.migratedLegacyWrapper).toBe(true)
    expect(readFileSync(paths.wrapper, 'utf8')).toContain('# Managed by @longleash/cli')
    const marker = JSON.parse(readFileSync(join(paths.home, '.longleash-managed-install.json'), 'utf8'))
    expect(marker.legacyWrapper).toEqual({ content: legacy, mode: 0o755 })

    const removed = uninstallManagedRuntime(env)
    expect(removed.legacyWrapperRestored).toBe(true)
    expect(readFileSync(paths.wrapper, 'utf8')).toBe(legacy)
    expect(statSync(paths.wrapper).mode & 0o777).toBe(0o755)
    expect(existsSync(paths.home)).toBe(false)
  })

  it('preserves the legacy rollback record across managed updates', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-legacy-update-'))
    const first = createRelease(root, '1.2.3')
    const legacy = createLegacyWrapper(root, first.paths.wrapper)
    prepareManagedInstall('1.2.3', first.env).activate()
    createRelease(root, '1.2.4')
    expect(prepareManagedInstall('1.2.4', first.env).activate().migratedLegacyWrapper).toBe(false)

    const marker = JSON.parse(readFileSync(join(first.paths.home, '.longleash-managed-install.json'), 'utf8'))
    expect(marker.legacyWrapper.content).toBe(legacy)
  })

  it('refuses a lookalike legacy wrapper and leaves it untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-legacy-lookalike-'))
    const { env, paths } = createRelease(root)
    const lookalike = '#!/usr/bin/env bash\n# Created by the LongLeash installer.\necho user-owned\n'
    writeFileSync(paths.wrapper, lookalike, { mode: 0o755 })

    const prepared = prepareManagedInstall('1.2.3', env)
    expect(() => prepared.activate()).toThrow('unmanaged executable')
    prepared.rollback()
    expect(readFileSync(paths.wrapper, 'utf8')).toBe(lookalike)
  })

  it('restores the legacy wrapper if activation fails after replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'longleash-legacy-rollback-'))
    const { env, paths } = createRelease(root)
    const legacy = createLegacyWrapper(root, paths.wrapper)
    mkdirSync(paths.current, { recursive: true })

    const prepared = prepareManagedInstall('1.2.3', env)
    expect(() => prepared.activate()).toThrow('non-symlink path')
    prepared.rollback()
    expect(readFileSync(paths.wrapper, 'utf8')).toBe(legacy)
    expect(statSync(paths.wrapper).mode & 0o777).toBe(0o755)
    expect(existsSync(join(paths.home, '.longleash-managed-install.json'))).toBe(false)
  })
})
