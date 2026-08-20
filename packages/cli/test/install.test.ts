import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
})
