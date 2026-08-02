/**
 * Eyes-on demo of the Phase B2 security model. Spins up the real relay, the daemon's real
 * RelayLink, and a simulated phone using the real envelope — then shows the same message from
 * three perspectives: what the phone sent, what the relay carried, what the daemon received.
 * Ends by tampering with a frame in flight to show it dies instead of being trusted.
 *
 *   pnpm --filter @longleash/daemon demo:relay
 */
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { RelayServer } from '@longleash/relay/src/server.js'
import { deriveRelayIdentity, open, seal } from '@longleash/protocol'
import { RelayLink } from '../src/relay-link.js'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── 1. The relay — logging everything it is ABLE to know ────────────────────
const relayLog: string[] = []
const relay = new RelayServer({
  host: '127.0.0.1',
  port: 0,
  log: (line) => relayLog.push(line),
})
const port = await relay.listen()
console.log(bold('\n1. Relay running.'), dim(`ws://127.0.0.1:${port}/ws — knows nothing yet`))

// ── 2. Pairing: one secret, shared over the LAN, never shown to the relay ───
const pairingSecret = randomBytes(32).toString('base64url')
const identity = await deriveRelayIdentity(pairingSecret)
console.log(bold('\n2. Pairing secret minted') + dim(' (travels over your Wi-Fi only):'))
console.log(`   secret    ${cyan(pairingSecret)}`)
console.log(`   room tag  ${cyan(identity.roomTag)} ${dim('← derived one-way; the relay sees ONLY this')}`)

// ── 3. The daemon joins its room ────────────────────────────────────────────
const daemonInbox: string[] = []
const link = new RelayLink({
  url: `ws://127.0.0.1:${port}/ws`,
  secret: pairingSecret,
  onMessage: (plaintext) => daemonInbox.push(plaintext),
})
link.start()
while (link.status !== 'connected') await wait(20)
console.log(bold('\n3. Daemon joined the room as host.'))

// ── 4. The "phone": raw websocket + the same envelope code the app will use ─
const phone = new WebSocket(`ws://127.0.0.1:${port}/ws`)
const phoneInbox: string[] = []
const relaySaw: string[] = []
phone.on('message', (raw) => {
  const message = JSON.parse(String(raw)) as { type?: string; payload?: string }
  if (message.type === 'frame' && message.payload) {
    relaySaw.push(message.payload)
    void open(identity, message.payload).then((text) => {
      if (text !== null) phoneInbox.push(text)
    })
  }
})
await new Promise<void>((resolve) => phone.once('open', () => resolve()))
phone.send(JSON.stringify({ v: 1, type: 'join', room: identity.roomTag, role: 'guest' }))
await wait(150)
console.log(bold('4. Phone joined as guest.'))

// ── 5. Phone → daemon, through the relay ────────────────────────────────────
const secretMessage = '{"type":"startSession","prompt":"fix the login bug","root":"~/app"}'
const sealed = await seal(identity, secretMessage)
phone.send(JSON.stringify({ v: 1, type: 'frame', payload: sealed }))
while (daemonInbox.length === 0) await wait(20)

console.log(bold('\n5. One message, three perspectives:'))
console.log(`   phone sent     ${green(secretMessage)}`)
console.log(`   relay carried  ${red(sealed.slice(0, 58) + '…')} ${dim('(all it ever has)')}`)
console.log(`   daemon read    ${green(daemonInbox[0] ?? '')}`)

// ── 6. Daemon → phone, same story backwards ─────────────────────────────────
link.send('{"type":"approval.requested","toolName":"Write"}')
while (phoneInbox.length === 0) await wait(20)
console.log(bold('\n6. And backwards:'), green(phoneInbox[0] ?? ''))

// ── 7. Tampering: flip ONE character of the ciphertext in flight ────────────
const tampered = sealed.slice(0, 30) + (sealed[30] === 'A' ? 'B' : 'A') + sealed.slice(31)
phone.send(JSON.stringify({ v: 1, type: 'frame', payload: tampered }))
await wait(300)
console.log(bold('\n7. Tampered frame') + ` (one character flipped): ${
  daemonInbox.length === 1 ? green('dropped by the daemon — never surfaced ✓') : red('SURFACED — BUG')
}`)

// ── 8. What the relay knew, in total ────────────────────────────────────────
console.log(bold('\n8. Everything the relay logged all along:'))
for (const line of relayLog) console.log(`   ${dim(line)}`)
console.log(
  dim('   …roles and counts. No names, no tokens, no paths, no text. The room tag is not\n') +
  dim('   reversible, and the payloads it carried are the red ciphertext above.'),
)

phone.close()
link.stop()
await relay.close()
console.log(bold(green('\nDone. This is the property the whole of Phase B stands on.\n')))
