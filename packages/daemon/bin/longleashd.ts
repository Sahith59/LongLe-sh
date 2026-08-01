#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import qrcode from 'qrcode-terminal'
import { startDaemon } from '../src/daemon.js'
import { findCandidates, vpnWarning } from '../demo/lan.js'

const here = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(here, '../../app/dist')

const roots = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
if (roots.length === 0) {
  console.error('\nUsage: longleashd <project-directory> [more directories…]')
  console.error('Agents may only ever work inside the directories you list.\n')
  process.exit(1)
}

const candidates = findCandidates()
const best = candidates[0]
if (!best) {
  console.error('\nNo usable network address. Connect to Wi-Fi (or your phone hotspot) and retry.\n')
  process.exit(1)
}

const daemon = await startDaemon({
  allowedRoots: roots,
  host: best.address,
  port: Number(process.env.PORT ?? 4321),
  ...(existsSync(join(APP_DIR, 'index.html')) ? { staticRoot: APP_DIR } : {}),
  denyOutsideRoot: process.env.LONGLEASH_STRICT !== '0',
})

const challenge = daemon.registry.createPairingChallenge()
const url = `http://${best.address}:${daemon.port}/?c=${challenge.challengeId}&s=${encodeURIComponent(challenge.secret)}`

console.log('\n=== LongLeash ===\n')
const warn = vpnWarning()
if (warn) console.log(`!!! ${warn}\n`)
if (!existsSync(join(APP_DIR, 'index.html'))) {
  console.log('The web app is not built yet — run `pnpm --filter @longleash/app build` first.\n')
}
if (daemon.posture.gateWeakened) {
  console.log(`Note: your Claude Code settings pre-approve ${daemon.posture.allowRuleCount} pattern(s),`)
  console.log('e.g. ' + daemon.posture.examples.join(', '))
  console.log('Those commands run WITHOUT asking your phone. They still appear in the activity')
  console.log('feed, so nothing runs invisibly — but remove them from ~/.claude/settings.json')
  console.log('if you want every action to come to you.\n')
}
if (daemon.orphansClosed > 0) {
  console.log(`Closed ${daemon.orphansClosed} approval(s) left pending by a previous run.\n`)
}
console.log('Agents may work only in:')
for (const root of roots) console.log(`  ${resolve(root)}`)
console.log(`\nListening on ${best.address}:${daemon.port} (${best.iface}, ${best.label})`)
console.log('\nScan this with your phone, then add it to your home screen:\n')
qrcode.generate(url, { small: true })
console.log(`\n  ${url}\n`)
console.log('Press r + Enter to revoke every paired device, q + Enter to quit.\n')

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  const key = chunk.trim().toLowerCase()
  if (key === 'r') {
    const active = daemon.registry.listDevices().filter((d) => d.revokedAt === null)
    for (const device of active) daemon.registry.revokeDevice(device.deviceId)
    console.log(`>>> revoked ${active.length} device(s); their live connections are cut`)
  }
  if (key === 'q') {
    void daemon.stop().then(() => process.exit(0))
  }
})

const shutdown = () => {
  void daemon.stop().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
