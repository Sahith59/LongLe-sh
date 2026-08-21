import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  installService,
  renderLaunchAgent,
  renderSystemdEnvironment,
  renderSystemdUnit,
  restartService,
  servicePaths,
  serviceState,
  startService,
  stopService,
  uninstallService,
  type CommandRunner,
  type ServiceContext,
} from '../src/service.js'

function fixture(platform: 'darwin' | 'linux') {
  const root = mkdtempSync(join(tmpdir(), `longleash-service-${platform}-`))
  const home = join(root, 'home')
  const env = {
    ...process.env,
    HOME: home,
    PATH: '/safe/bin:/usr/bin:/bin',
    LONGLEASH_DATA: join(root, 'data'),
    LONGLEASH_INSTALL_HOME: join(root, 'install'),
    LONGLEASH_BIN_DIR: join(root, 'bin'),
  }
  const paths = servicePaths({ platform, home, env })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(paths.wrapper, '#!/bin/sh\n# Managed by @longleash/cli\nexit 0\n', { mode: 0o700 })
  let loaded = false
  let active = false
  let linger = false
  const calls: string[] = []
  const runner: CommandRunner = (file, args) => {
    const call = `${file} ${args.join(' ')}`
    calls.push(call)
    if (file === '/usr/bin/plutil') return { status: 0, stdout: '', stderr: '' }
    if (file === '/bin/launchctl') {
      if (args[0] === 'print') return { status: loaded ? 0 : 113, stdout: '', stderr: '' }
      if (args[0] === 'bootstrap') loaded = true
      if (args[0] === 'bootout') loaded = false
      return { status: 0, stdout: '', stderr: '' }
    }
    if (file === 'systemctl') {
      if (args.includes('is-enabled')) return { status: loaded ? 0 : 1, stdout: '', stderr: '' }
      if (args.includes('is-active')) return { status: active ? 0 : 3, stdout: '', stderr: '' }
      if (args.includes('enable')) { loaded = true; active = true }
      if (args.includes('disable')) { loaded = false; active = false }
      if (args.includes('start') || args.includes('restart')) active = true
      if (args.includes('stop')) active = false
      return { status: 0, stdout: '', stderr: '' }
    }
    if (file === 'loginctl') return { status: 0, stdout: linger ? 'yes\n' : 'no\n', stderr: '' }
    return { status: 127, stdout: '', stderr: `unexpected command: ${call}` }
  }
  const context: ServiceContext = { platform, home, uid: 501, env, runner }
  return { root, home, env, paths, context, calls, setLoaded: (value: boolean) => { loaded = value }, setLinger: (value: boolean) => { linger = value } }
}

describe('macOS per-user service lifecycle', () => {
  it('installs, controls, and removes only its own launch agent while preserving data', () => {
    const f = fixture('darwin')
    const sentinel = join(f.paths.data, 'sessions.db')
    mkdirSync(f.paths.data, { recursive: true })
    writeFileSync(sentinel, 'keep')

    expect(installService(f.context)).toMatchObject({ installed: true, loaded: true, active: true })
    expect(lstatSync(f.paths.definition).mode & 0o777).toBe(0o600)
    const plist = readFileSync(f.paths.definition, 'utf8')
    expect(plist).toContain('Managed by @longleash/cli')
    expect(plist).toContain(f.paths.wrapper)
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).not.toContain('token')

    expect(stopService(f.context).active).toBe(false)
    expect(startService(f.context).active).toBe(true)
    expect(restartService(f.context).active).toBe(true)
    expect(uninstallService(f.context)).toMatchObject({ installed: false, loaded: false })
    expect(existsSync(sentinel)).toBe(true)
    expect(f.calls.some((call) => call.includes('bootstrap gui/501'))).toBe(true)
    expect(f.calls.some((call) => call.includes('kickstart -k gui/501/dev.longleash.daemon'))).toBe(true)
  })

  it('refuses an unmanaged, symlinked, or loaded-but-unowned launch agent', () => {
    const unmanaged = fixture('darwin')
    mkdirSync(join(unmanaged.home, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(unmanaged.paths.definition, '<plist/>')
    expect(() => serviceState(unmanaged.context)).toThrow('unmanaged service definition')
    expect(() => installService(unmanaged.context)).toThrow('unmanaged service definition')

    const symlinked = fixture('darwin')
    mkdirSync(join(symlinked.home, 'Library', 'LaunchAgents'), { recursive: true })
    const target = join(symlinked.root, 'foreign.plist')
    writeFileSync(target, '<plist/>')
    symlinkSync(target, symlinked.paths.definition)
    expect(() => installService(symlinked.context)).toThrow('symlinked service path')

    const loaded = fixture('darwin')
    loaded.setLoaded(true)
    expect(() => installService(loaded.context)).toThrow('unowned launchd job')
    expect(() => stopService(loaded.context)).toThrow('not installed')
    expect(() => uninstallService(loaded.context)).toThrow('unowned launchd job')
  })

  it('rolls back the definition when launchd rejects activation', () => {
    const f = fixture('darwin')
    const failing: CommandRunner = (file, args) => {
      if (file === '/usr/bin/plutil') return { status: 0, stdout: '', stderr: '' }
      if (file === '/bin/launchctl' && args[0] === 'print') return { status: 113, stdout: '', stderr: '' }
      if (file === '/bin/launchctl' && args[0] === 'bootstrap') return { status: 5, stdout: '', stderr: 'rejected' }
      return { status: 0, stdout: '', stderr: '' }
    }
    expect(() => installService({ ...f.context, runner: failing })).toThrow('bootstrap')
    expect(existsSync(f.paths.definition)).toBe(false)
  })

  it('recovers once from a stale launchd registration without touching another label', () => {
    const f = fixture('darwin')
    let bootstrapAttempts = 0
    let loaded = false
    const calls: string[] = []
    const recovering: CommandRunner = (file, args) => {
      calls.push(`${file} ${args.join(' ')}`)
      if (file === '/usr/bin/plutil') return { status: 0, stdout: '', stderr: '' }
      if (file === '/bin/launchctl' && args[0] === 'print') {
        return { status: loaded ? 0 : 113, stdout: '', stderr: '' }
      }
      if (file === '/bin/launchctl' && args[0] === 'bootstrap') {
        bootstrapAttempts += 1
        if (bootstrapAttempts === 1) return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
        loaded = true
        return { status: 0, stdout: '', stderr: '' }
      }
      if (file === '/bin/launchctl' && args[0] === 'bootout') {
        expect(args).toEqual(['bootout', 'gui/501/dev.longleash.daemon'])
        return { status: 3, stdout: '', stderr: 'No such process' }
      }
      return { status: 127, stdout: '', stderr: 'unexpected command' }
    }

    expect(installService({ ...f.context, runner: recovering })).toMatchObject({ loaded: true, active: true })
    expect(bootstrapAttempts).toBe(2)
    expect(calls.filter((call) => call.includes(' bootout '))).toEqual([
      '/bin/launchctl bootout gui/501/dev.longleash.daemon',
    ])
  })

  it('accepts a bootstrap acknowledgement race when launchd reports the managed job loaded', () => {
    const f = fixture('darwin')
    let loaded = false
    let bootstrapAttempts = 0
    const racing: CommandRunner = (file, args) => {
      if (file === '/usr/bin/plutil') return { status: 0, stdout: '', stderr: '' }
      if (file === '/bin/launchctl' && args[0] === 'print') {
        return { status: loaded ? 0 : 113, stdout: '', stderr: '' }
      }
      if (file === '/bin/launchctl' && args[0] === 'bootstrap') {
        bootstrapAttempts += 1
        loaded = true
        return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }

    expect(installService({ ...f.context, runner: racing })).toMatchObject({ loaded: true, active: true })
    expect(bootstrapAttempts).toBe(1)
  })
})

describe('Linux systemd user-service lifecycle', () => {
  it('uses a user unit with bounded restart behavior and preserves user data on uninstall', () => {
    const f = fixture('linux')
    const sentinel = join(f.paths.data, 'events.db')
    mkdirSync(f.paths.data, { recursive: true })
    writeFileSync(sentinel, 'keep')

    expect(installService(f.context)).toMatchObject({ installed: true, loaded: true, active: true, loginOnly: true })
    expect(lstatSync(f.paths.definition).mode & 0o777).toBe(0o600)
    expect(lstatSync(f.paths.environment!).mode & 0o777).toBe(0o600)
    const unit = readFileSync(f.paths.definition, 'utf8')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('StartLimitBurst=5')
    expect(unit).toContain(`ExecStart="${f.paths.wrapper}" run`)
    expect(unit).toContain(`EnvironmentFile=${f.paths.environment}`)
    expect(unit).toContain(`WorkingDirectory=${f.home}`)
    expect(unit).not.toMatch(/sudo|root/i)
    expect(readFileSync(f.paths.environment!, 'utf8')).not.toMatch(/TOKEN|SECRET|KEY=/)

    expect(stopService(f.context).active).toBe(false)
    expect(startService(f.context).active).toBe(true)
    f.setLinger(true)
    expect(restartService(f.context)).toMatchObject({ active: true, loginOnly: false })
    expect(uninstallService(f.context)).toMatchObject({ installed: false, loaded: false, active: false })
    expect(existsSync(sentinel)).toBe(true)
  })

  it('escapes scalar systemd paths without turning quotes into literal path characters', () => {
    const f = fixture('linux')
    const spacedHome = join(f.root, 'home with spaces')
    const env = { ...f.env, HOME: spacedHome }
    const paths = servicePaths({ platform: 'linux', home: spacedHome, env })
    const unit = renderSystemdUnit(paths, spacedHome)

    expect(unit).toContain('EnvironmentFile=')
    expect(unit).toContain('\\x20')
    expect(unit).not.toContain('EnvironmentFile="')
    expect(unit).not.toContain('WorkingDirectory="')
  })

  it('refuses to start when the managed environment boundary is missing', () => {
    const f = fixture('linux')
    installService(f.context)
    writeFileSync(f.paths.environment!, 'HOME=/tmp\n')
    expect(() => startService(f.context)).toThrow('unmanaged service definition')
  })

  it('does not stop an active systemd unit it cannot prove it owns', () => {
    const f = fixture('linux')
    installService(f.context)
    uninstallService(f.context)
    const activeRunner: CommandRunner = (file, args) => {
      if (file === 'systemctl' && args.includes('is-active')) return { status: 0, stdout: '', stderr: '' }
      if (file === 'systemctl' && args.includes('is-enabled')) return { status: 1, stdout: '', stderr: '' }
      if (file === 'loginctl') return { status: 0, stdout: 'no\n', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    }
    expect(() => stopService({ ...f.context, runner: activeRunner })).toThrow('not installed')
  })

  it('restarts an active unit when setup installs a verified update', () => {
    const f = fixture('linux')
    installService(f.context)
    const callsBeforeUpdate = f.calls.length

    installService(f.context)
    const updateCalls = f.calls.slice(callsBeforeUpdate)
    expect(updateCalls).toContain('systemctl --user restart longleash.service')
    expect(updateCalls).not.toContain('systemctl --user enable --now longleash.service')
  })

  it('restores the prior enabled-but-stopped state when an update fails', () => {
    const f = fixture('linux')
    installService(f.context)
    stopService(f.context)
    const calls: string[] = []
    const failing: CommandRunner = (file, args) => {
      const call = `${file} ${args.join(' ')}`
      calls.push(call)
      if (file === 'systemctl' && args.includes('is-enabled')) return { status: 0, stdout: '', stderr: '' }
      if (file === 'systemctl' && args.includes('is-active')) return { status: 3, stdout: '', stderr: '' }
      if (file === 'systemctl' && args.includes('enable') && args.includes('--now')) {
        return { status: 1, stdout: '', stderr: 'activation failed' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }

    expect(() => installService({ ...f.context, runner: failing })).toThrow('activation failed')
    expect(calls).toContain('systemctl --user enable longleash.service')
    expect(calls).toContain('systemctl --user stop longleash.service')
    expect(calls).not.toContain('systemctl --user restart longleash.service')
  })
})

describe('service definition escaping and input boundaries', () => {
  it('escapes paths and rejects environment control characters', () => {
    const f = fixture('darwin')
    const custom = { ...f.paths, wrapper: '/tmp/A&B<daemon>', data: '/tmp/data&more' }
    expect(renderLaunchAgent(custom, { HOME: f.home, PATH: '/a&b' })).toContain('/tmp/A&amp;B&lt;daemon&gt;')
    expect(() => renderLaunchAgent(f.paths, { HOME: f.home, PATH: '/bin\nEVIL=1' })).toThrow('Unsafe PATH')

    const linux = fixture('linux')
    expect(renderSystemdUnit({ ...linux.paths, wrapper: '/tmp/a%b"c' }, linux.home)).toContain('/tmp/a%%b\\"c')
    expect(() => renderSystemdEnvironment(linux.paths, { HOME: linux.home, PATH: '/bin\nEVIL=1' })).toThrow('Unsafe PATH')
  })
})
