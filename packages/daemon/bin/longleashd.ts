#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../src/daemon.js'
import { resolveRelayUrl } from '../src/config.js'
import { hostPairing } from '../src/pairing-host.js'
import { terminalQr } from '../src/terminal-qr.js'
import { findCandidates, noAddressReason, vpnWarning } from '../demo/lan.js'

const here = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(here, '../../app/dist')

const roots = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
if (roots.length === 0) {
  console.error('\nUsage: longleashd <project-directory> [more directories…]')
  console.error('Agents may only ever work inside the directories you list.\n')
  process.exit(1)
}

// Set LONGLEASH_RELAY_URL once and it is remembered; `off` forgets it.
const dataDir = process.env.LONGLEASH_DATA ?? join(homedir(), '.longleash')
const relay = resolveRelayUrl(process.env.LONGLEASH_RELAY_URL, dataDir)
if (relay?.source === 'remembered') {
  console.log(`Relay: ${relay.url} (remembered — LONGLEASH_RELAY_URL=off forgets it)`)
}

/**
 * A LAN address is what a phone dials on the same network. It is NOT required to run:
 * with a relay configured the daemon only ever dials OUT, and pairing already points at
 * the relay-served app. Refusing to start without one grounded the whole product over a
 * capability it was not going to use — which is exactly what USB tethering triggers,
 * because macOS then holds only 192.0.0.2 (the iOS service-continuity range).
 */
const candidates = findCandidates()
const best = candidates[0]
if (!best && relay === null) {
  console.error(`\n${noAddressReason()}`)
  console.error('\nWith no relay configured either, there is no way for a phone to reach this')
  console.error('laptop at all. Fix either one:')
  console.error('  • join the same Wi-Fi as your phone, or')
  console.error('  • set a relay once, which also works from anywhere:')
  console.error('      LONGLEASH_RELAY_URL=wss://<your-relay>/ws pnpm start ~\n')
  process.exit(1)
}
if (!best) {
  console.log(noAddressReason())
  console.log('Running through the relay only.')
  console.log('(Same-network pairing is unavailable; everything else works as usual.)\n')
}
/** Bind to loopback when there is no LAN to serve; the relay carries every byte. */
const bindHost = best?.address ?? '127.0.0.1'

const wantedPort = Number(process.env.PORT ?? 4321)

/**
 * Is a LongLeash already listening here? A port collision has two very different
 * meanings and only one of them is an error: a second daemon on the same machine is a
 * mistake worth naming, while some unrelated program on 4321 is merely in the way and
 * should not stop anything.
 */
async function whoHasPort(host: string, port: number): Promise<'longleash' | 'other' | 'free'> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1200),
    })
    const body = (await res.json().catch(() => ({}))) as { name?: string }
    return body.name === 'longleash' ? 'longleash' : 'other'
  } catch (err) {
    // Refused means nobody is there; anything else means something is, just not talking HTTP.
    const code = (err as { cause?: { code?: string } }).cause?.code
    return code === 'ECONNREFUSED' ? 'free' : 'other'
  }
}

const holder = await whoHasPort(bindHost, wantedPort)
if (holder === 'longleash') {
  console.error(`\nLongLeash is already running on ${bindHost}:${wantedPort}.`)
  console.error('Use that one, or stop it first (press q + Enter in its terminal).')
  console.error(`If its terminal is gone:  lsof -t -iTCP:${wantedPort} -sTCP:LISTEN | xargs kill\n`)
  process.exit(1)
}
if (holder === 'other') {
  console.log(`Port ${wantedPort} is taken by something else — using a free port instead.`)
}

/**
 * Start, and never die of a bind failure that has a safe alternative. A LAN address can
 * vanish or be taken between choosing it and binding to it (a network switch mid-command
 * does exactly this); with a relay configured, loopback still serves the whole product.
 */
async function boot(host: string, port: number) {
  return startDaemon({
    allowedRoots: roots,
    host,
    port,
    ...(existsSync(join(APP_DIR, 'index.html')) ? { staticRoot: APP_DIR } : {}),
    denyOutsideRoot: process.env.LONGLEASH_STRICT !== '0',
    // LONGLEASH_ASK_EVERYTHING=1 pre-approves nothing, so even reading a file comes to your phone.
    ...(process.env.LONGLEASH_ASK_EVERYTHING === '1' ? { allowedTools: [] } : {}),
    dataDir,
    log: (line) => console.log(line),
    ...(relay === null ? {} : { relayUrl: relay.url }),
  })
}

const started = await (async () => {
  const firstPort = holder === 'other' ? 0 : wantedPort
  try {
    return { daemon: await boot(bindHost, firstPort), host: bindHost, lan: best !== undefined }
  } catch (err) {
    const code = (err as { code?: string }).code
    console.log(`\nCould not listen on ${bindHost}:${firstPort} (${code ?? 'unknown error'}).`)
    if (relay !== null) {
      console.log('Falling back to loopback — the relay carries everything.\n')
      // `lan: false` matters: every URL printed below must describe where it ACTUALLY
      // listens, or the pairing address would point at an interface it never bound.
      return { daemon: await boot('127.0.0.1', 0), host: '127.0.0.1', lan: false }
    }
    console.error('No relay is configured, so there is no other way in. Set one once:')
    console.error('  LONGLEASH_RELAY_URL=wss://<your-relay>/ws pnpm start ~\n')
    process.exit(1)
  }
})()
const daemon = started.daemon
/** Where it truly listens — not where we hoped to. */
const servedHost = started.host
const servedOnLan = started.lan
/**
 * Where it is serving RIGHT NOW. Mutable because the machine can move between networks
 * while running, and a pairing URL printed afterwards must point at the live address
 * rather than the one chosen at boot.
 */
let servingHost = servedHost
let servingPort = daemon.port

/** The relay's app origin: where a phone can live even when this laptop is unreachable. */
function relayAppOrigin(wsUrl: string): string {
  const parsed = new URL(wsUrl)
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  parsed.pathname = '/'
  return parsed.toString()
}

/**
 * One QR, one flow: with a relay configured it points at the relay-served app — pairing
 * completes through a sealed room, and the same address then works from anywhere in the
 * world. Without a relay it points at this laptop's LAN address, as always.
 */
function freshPairingUrl(): string {
  const challenge = daemon.registry.createPairingChallenge()
  if (relay !== null) {
    hostPairing({ registry: daemon.registry, relayUrl: relay.url, challenge, log: (line) => console.log(`[pair] ${line}`) })
    return `${relayAppOrigin(relay.url)}?c=${challenge.challengeId}&s=${encodeURIComponent(challenge.secret)}`
  }
  return `http://${servingHost}:${servingPort}/?c=${challenge.challengeId}&s=${encodeURIComponent(challenge.secret)}`
}

const url = freshPairingUrl()

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
const preApproved = process.env.LONGLEASH_ASK_EVERYTHING === '1' ? [] : ['Read', 'Glob', 'Grep']
console.log(
  preApproved.length === 0
    ? 'Approvals: EVERY tool asks your phone first.'
    : `Approvals: ${preApproved.join(', ')} run without asking (they only read); everything that`,
)
if (preApproved.length > 0) {
  console.log('changes something asks your phone. Auto-approved tools still appear in the')
  console.log('activity feed. Run with LONGLEASH_ASK_EVERYTHING=1 to be asked about everything.\n')
} else {
  console.log('')
}
console.log('Agents may work only in:')
for (const root of roots) console.log(`  ${resolve(root)}`)
console.log(
  servedOnLan && best
    ? `\nListening on ${servedHost}:${daemon.port} (${best.iface}, ${best.label})`
    : `\nListening on ${servedHost}:${daemon.port} (no local network — relay only)`,
)
console.log(
  relay !== null
    ? `Relay: ${relay.url} — your phone can reach this laptop from anywhere.`
    : 'Relay: not configured (LAN only). Set LONGLEASH_RELAY_URL once to enable remote access — it is remembered.',
)
console.log('\nScan this with your phone, then add it to your home screen:\n')
console.log(terminalQr(url))
console.log(`\n  ${url}\n`)
if (relay !== null && servedOnLan) {
  console.log(`(LAN fallback for pairing at home: http://${servedHost}:${daemon.port}/?c=…&s=… — same code)`)
}
/**
 * Follow the machine onto whatever network it lands on.
 *
 * A laptop that moves — home Wi-Fi to a phone hotspot, a cable pulled, a hotspot
 * appearing — keeps a listener bound to an address that has ceased to exist, so a phone
 * on the NEW network finds nothing and the only cure was restarting the daemon. Watching
 * for the change costs one interface read every few seconds and keeps the local path
 * alive across the move. The relay never needed this; it dials out and reconnects itself.
 */
const NETWORK_WATCH_MS = 5000
const networkWatch = setInterval(() => {
  const nextBest = findCandidates()[0]
  const nextHost = nextBest?.address ?? '127.0.0.1'
  if (nextHost === servingHost) return
  const was = servingHost
  servingHost = nextHost
  void daemon.server
    .rebind(nextHost)
    .then((port) => {
      servingPort = port
      console.log(`\nNetwork changed: ${was} -> ${nextHost}. Now serving ${nextHost}:${port}.`)
      console.log(
        nextBest
          ? 'Press n + Enter for a pairing QR on this network.'
          : 'No local network now — the relay carries everything.',
      )
    })
    .catch((err: unknown) => {
      console.log(`\nNetwork changed but rebinding failed (${String(err)}).`)
      console.log(relay !== null ? 'The relay is unaffected.' : 'Restart the daemon to recover.')
    })
}, NETWORK_WATCH_MS)
networkWatch.unref?.()

console.log('Press n + Enter for a fresh pairing QR, r + Enter to revoke every device, q + Enter to quit.\n')

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  const key = chunk.trim().toLowerCase()
  if (key === 'n') {
    const next = freshPairingUrl()
    console.log('\nScan this with your phone:\n')
    console.log(terminalQr(next))
    console.log(`\n  ${next}\n`)
  }
  if (key === 'r') {
    const active = daemon.registry.listDevices().filter((d) => d.revokedAt === null)
    for (const device of active) daemon.registry.revokeDevice(device.deviceId)
    console.log(`>>> revoked ${active.length} device(s); their live connections are cut`)
  }
  if (key === 'q') {
    clearInterval(networkWatch)
    void daemon.stop().then(() => process.exit(0))
  }
})

const shutdown = () => {
  clearInterval(networkWatch)
  void daemon.stop().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
