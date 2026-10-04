// Isolated data-compatibility test: published rc.11 -> candidate -> rollback.
// No provider is started, no real service is modified, and credentials never enter logs.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const tarball = resolve(process.argv[2] ?? '')
if (!existsSync(tarball)) throw new Error('Pass the verified candidate tarball.')
const stage = mkdtempSync(join(tmpdir(), 'longleash-upgrade-'))
const data = join(stage, 'data')
const project = join(stage, 'project')
const sandboxHome = join(stage, 'home')
for (const path of [project, sandboxHome]) mkdirSync(path)
const processes = new Set()
const delay = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
try {
  for (const [name, spec] of [['old', '@longleash/cli@0.1.0-rc.11'], ['candidate', tarball]]) {
    const directory = join(stage, name)
    mkdirSync(directory)
    execFileSync('npm', ['install', '--prefix', directory, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', spec], { stdio: 'ignore' })
  }
  const require = createRequire(join(stage, 'candidate', 'node_modules', '@longleash', 'cli', 'package.json'))
  const WebSocket = require('ws')
  async function start(name) {
    const entry = join(stage, name, 'node_modules', '@longleash', 'cli', 'runtime', 'daemon', 'bin', 'longleashd.mjs')
    rmSync(join(data, 'hook-endpoint.json'), { force: true })
    const child = spawn(process.execPath, [entry, project], {
      env: { ...process.env, HOME: sandboxHome, LONGLEASH_DATA: data, LONGLEASH_SERVICE: '1', PORT: '0', LONGLEASH_RELAY_URL: 'wss://127.0.0.1:9/ws' },
      stdio: 'ignore',
    })
    processes.add(child)
    child.once('exit', () => processes.delete(child))
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(`${name} daemon exited before readiness`)
      try {
        const endpoint = JSON.parse(readFileSync(join(data, 'hook-endpoint.json'), 'utf8'))
        const origin = new URL(endpoint.url).origin
        const request = (path, body) => fetch(`${origin}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', 'x-longleash-hook': endpoint.secret },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000),
        })
        if ((await request('/health')).ok) return { child, request, origin }
      } catch { /* endpoint not ready */ }
      await delay(100)
    }
    throw new Error(`${name} readiness timeout`)
  }
  async function stop(handle) {
    const exited = new Promise(resolveExit => handle.child.once('exit', resolveExit))
    handle.child.kill('SIGTERM')
    const timeout = setTimeout(() => handle.child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timeout)
  }
  async function authenticate(handle, token) {
    await new Promise((resolveHello, rejectHello) => {
      const ws = new WebSocket(`${handle.origin.replace('http:', 'ws:')}/ws?token=${encodeURIComponent(token)}`)
      const timeout = setTimeout(() => { ws.terminate(); rejectHello(new Error('Existing device did not authenticate')) }, 5000)
      ws.on('message', data => {
        if (JSON.parse(data.toString()).type === 'hello') { clearTimeout(timeout); ws.close(); resolveHello() }
      })
      ws.on('error', () => { clearTimeout(timeout); rejectHello(new Error('Existing device socket failed')) })
    })
  }
  const old = await start('old')
  const qr = await (await old.request('/local/pairing', {})).json()
  const params = new URLSearchParams(new URL(qr.url).hash.slice(1))
  const result = await old.request(`/pair?c=${encodeURIComponent(params.get('c'))}&s=${encodeURIComponent(params.get('s'))}`, {})
  if (!result.ok) throw new Error('Published baseline pairing failed')
  const credentials = await result.json()
  await authenticate(old, credentials.token)
  await stop(old)
  const candidate = await start('candidate')
  if ((await (await candidate.request('/health')).json()).pairingVersion !== 2) throw new Error('Candidate does not advertise v2')
  await authenticate(candidate, credentials.token)
  await stop(candidate)
  const rollback = await start('old')
  await authenticate(rollback, credentials.token)
  await stop(rollback)
  console.log(JSON.stringify({ baseline: '0.1.0-rc.11', upgrade: 'existing device authenticated', rollback: 'existing device authenticated', platform: process.platform }))
} finally {
  for (const child of processes) child.kill('SIGKILL')
  if (processes.size) await delay(300)
  rmSync(stage, { recursive: true, force: true })
}
