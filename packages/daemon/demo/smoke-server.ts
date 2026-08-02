/**
 * Boots a real daemon against throwaway storage and prints a pairing URL as JSON — the
 * harness a browser-level smoke test drives. Not part of the product.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../src/daemon.js'
import { hostPairing } from '../src/pairing-host.js'

const here = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(here, '../../app/dist')
const scratch = process.env.SMOKE_DATA ?? mkdtempSync(join(tmpdir(), 'longleash-smoke-'))
mkdirSync(scratch, { recursive: true })

const daemon = await startDaemon({
  allowedRoots: [scratch],
  host: '127.0.0.1',
  port: Number(process.env.SMOKE_PORT ?? 0),
  staticRoot: APP_DIR,
  dataDir: join(scratch, 'data'),
  ...(process.env.LONGLEASH_RELAY_URL ? { relayUrl: process.env.LONGLEASH_RELAY_URL } : {}),
  log: (line) => console.error(line),
})

const challenge = daemon.registry.createPairingChallenge()
// A second device, paired programmatically: the "remote phone" a relay smoke test plays.
const second = daemon.registry.createPairingChallenge()
const remote = daemon.registry.completePairing({
  challengeId: second.challengeId,
  secret: second.secret,
  deviceName: 'smoke-remote',
})

// With a relay configured, also host a sealed pairing room and emit the relay-origin QR —
// the exact link the bin prints in the one-QR flow.
const relayUrl = process.env.LONGLEASH_RELAY_URL
let relayQr: string | null = null
if (relayUrl) {
  const relayChallenge = daemon.registry.createPairingChallenge()
  hostPairing({
    registry: daemon.registry,
    relayUrl,
    challenge: relayChallenge,
    log: (line) => console.error(`[pair] ${line}`),
  })
  const origin = new URL(relayUrl)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
  origin.pathname = '/'
  relayQr = `${origin.toString()}?c=${relayChallenge.challengeId}&s=${encodeURIComponent(relayChallenge.secret)}`
}

console.log(
  JSON.stringify({
    url: `http://127.0.0.1:${daemon.port}/?c=${challenge.challengeId}&s=${encodeURIComponent(challenge.secret)}`,
    remote: { token: remote.token, relaySecret: remote.relaySecret },
    relayQr,
  }),
)

process.on('SIGTERM', () => {
  void daemon.stop().then(() => process.exit(0))
})
