import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tarball = resolve(process.argv[2] ?? '')
if (!existsSync(tarball)) throw new Error('Usage: node scripts/smoke-tarball.mjs <package.tgz>')

const sandbox = mkdtempSync(join(tmpdir(), 'longleash-tarball-'))
const home = join(sandbox, 'home')
const project = join(sandbox, 'project')
const installHome = join(home, '.local', 'share', 'longleash')
const binDir = join(home, '.local', 'bin')
const data = join(home, '.longleash')
const app = join(sandbox, 'consumer')
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
mkdirSync(app, { recursive: true })
execFileSync('npm', ['init', '--yes'], { cwd: app, stdio: 'ignore' })
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', tarball], { cwd: app, stdio: 'inherit' })
execFileSync('npm', ['ls', '--all', '--omit=dev'], { cwd: app, stdio: 'ignore' })

const direct = join(app, 'node_modules', '.bin', 'longleash')
const env = {
  ...process.env,
  HOME: home,
  LONGLEASH_DATA: data,
  LONGLEASH_INSTALL_HOME: installHome,
  LONGLEASH_BIN_DIR: binDir,
  LONGLEASH_PACKAGE_SPEC: tarball,
  LONGLEASH_ALLOW_LOCAL_PACKAGE: '1',
}
const run = (file, args, expected = 0) => {
  const result = spawnSync(file, args, { env, encoding: 'utf8' })
  if (result.status !== expected) {
    throw new Error(`${file} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result.stdout
}

const version = run(direct, ['--version']).trim()
run(direct, ['--help'])
const doctor = JSON.parse(run(direct, ['doctor', '--json']))
if (doctor.package.version !== version || doctor.daemon.reachable !== false) throw new Error('Doctor smoke report is inconsistent.')

run(direct, ['setup', '--yes', '--root', project, '--relay', 'off', '--skip-hooks'])
const managed = join(binDir, 'longleash')
if (!existsSync(managed)) throw new Error('Managed longleash wrapper was not installed.')
if ((statSync(managed).mode & 0o111) === 0) throw new Error('Managed wrapper is not executable.')
const config = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
if (config.allowedRoots?.[0] !== realpathSync(project) || 'relayUrl' in config) throw new Error('Managed setup wrote an unexpected configuration.')
if ((statSync(join(data, 'config.json')).mode & 0o777) !== 0o600) throw new Error('Configuration permissions are not 0600.')
if (run(managed, ['--version']).trim() !== version) throw new Error('Managed wrapper does not run the staged version.')

if (process.env.LONGLEASH_SMOKE_DAEMON === '1') {
  await exercisePackagedDaemon(managed, project, env)
}

// Idempotence: a second setup reuses the verified release and leaves the same config valid.
run(managed, ['setup', '--yes', '--root', project, '--relay', 'off', '--skip-hooks'])

// Failure atomicity: an unsafe activation target must restore config and keep the old wrapper usable.
const current = join(installHome, 'current')
const activeRelease = realpathSync(current)
const configBeforeFailure = readFileSync(join(data, 'config.json'), 'utf8')
const wrapperBeforeFailure = readFileSync(managed, 'utf8')
rmSync(current)
mkdirSync(current)
run(direct, ['setup', '--yes', '--root', project, '--relay', 'hosted', '--skip-hooks'], 1)
if (readFileSync(join(data, 'config.json'), 'utf8') !== configBeforeFailure) throw new Error('Failed activation did not restore configuration.')
if (readFileSync(managed, 'utf8') !== wrapperBeforeFailure) throw new Error('Failed activation did not restore the managed wrapper.')
rmSync(current, { recursive: true })
symlinkSync(activeRelease, current, 'dir')
if (run(managed, ['--version']).trim() !== version) throw new Error('Rollback did not preserve the active release.')

run(managed, ['uninstall'])
if (existsSync(managed) || existsSync(installHome)) throw new Error('Uninstall left the managed runtime behind.')
if (!existsSync(join(data, 'config.json'))) throw new Error('Uninstall deleted user data without permission.')

console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, node: process.version, version, lifecycle: 'passed' }))
rmSync(sandbox, { recursive: true, force: true })

async function exercisePackagedDaemon(executable, root, baseEnv) {
  const child = spawn(executable, ['run', root], {
    env: {
      ...baseEnv,
      PORT: '0',
      // A deliberately unreachable TLS relay exercises startup without allowing a real external
      // connection. Push notification VAPID subjects correctly reject insecure HTTP origins.
      LONGLEASH_RELAY_URL: 'wss://127.0.0.1:9/ws',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  const deadline = setTimeout(() => child.kill('SIGTERM'), 20_000)
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })
  try {
    await new Promise((resolveReady, rejectReady) => {
      const poll = setInterval(() => {
        if (output.includes('Press n + Enter')) {
          clearInterval(poll)
          child.stdin.write('q\n')
          resolveReady()
        }
      }, 50)
      child.once('error', (error) => { clearInterval(poll); rejectReady(error) })
      child.once('exit', (code) => {
        if (!output.includes('Press n + Enter')) {
          clearInterval(poll)
          rejectReady(new Error(`Packaged daemon exited before readiness with code ${code}. Output withheld because it contains a pairing secret.`))
        }
      })
    })
    const code = await exited
    if (code !== 0) throw new Error(`Packaged daemon did not stop cleanly (code ${code}). Output withheld because it contains a pairing secret.`)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}
