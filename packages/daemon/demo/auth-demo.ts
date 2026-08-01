import { execSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import qrcode from 'qrcode-terminal'
import { DeviceRegistry, PairingError } from '../src/auth.js'

const PORT = Number(process.env.PORT ?? 4321)

interface Candidate {
  iface: string
  address: string
  label: string
  rank: number
}

/**
 * Not every IPv4 address a Mac holds is reachable from a phone:
 *  - 169.254.x  self-assigned; DHCP failed, nothing routes there
 *  - 192.0.0.x  iOS service-continuity range (RFC 7335); Safari refuses it
 *  - public IPs usually belong to a VPN tunnel, not the LAN
 * Rank what is left so the hotspot subnet wins when it exists.
 */
function findCandidates(): Candidate[] {
  const out: Candidate[] = []
  for (const [iface, nets] of Object.entries(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      const ip = net.address
      if (ip.startsWith('169.254.')) continue
      if (ip.startsWith('192.0.0.')) continue

      if (ip.startsWith('172.20.10.')) {
        out.push({ iface, address: ip, label: 'iPhone hotspot', rank: 0 })
      } else if (ip.startsWith('192.168.') || ip.startsWith('10.')) {
        out.push({ iface, address: ip, label: 'local network', rank: 1 })
      } else if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) {
        out.push({ iface, address: ip, label: 'local network', rank: 1 })
      }
    }
  }
  return out.sort((a, b) => a.rank - b.rank)
}

function vpnWarning(): string | null {
  try {
    const route = execSync('route -n get default 2>/dev/null', { encoding: 'utf8' })
    const iface = /interface:\s*(\S+)/.exec(route)?.[1]
    if (iface?.startsWith('utun') || iface?.startsWith('ipsec')) {
      return `A VPN appears to be active (default route via ${iface}). Full-tunnel VPNs swallow phone-to-laptop traffic — disconnect it for this test.`
    }
  } catch {
    // Diagnostics are best-effort; never block the demo on them.
  }
  return null
}

const candidates = findCandidates()
if (candidates.length === 0) {
  console.error('\nNo usable network address found.')
  console.error('Connect to Wi-Fi, or join your iPhone Personal Hotspot from the Mac, then rerun.\n')
  process.exit(1)
}

const registry = new DeviceRegistry(':memory:')
const challenge = registry.createPairingChallenge()
const pairPath = `/pair?c=${challenge.challengeId}&s=${challenge.secret}`

const page = (title: string, body: string, ok: boolean) => `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:-apple-system,sans-serif;margin:2rem;line-height:1.6}
h1{color:${ok ? '#0a7c3f' : '#b3261e'}}code{background:#eee;padding:2px 6px;border-radius:4px;word-break:break-all}
a{display:inline-block;margin-top:1rem;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none}</style>
</head><body><h1>${title}</h1>${body}</body></html>`

const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  const host = req.headers.host ?? `${candidates[0]?.address}:${PORT}`
  const url = new URL(req.url ?? '/', `http://${host}`)
  const html = (status: number, content: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(content)
  }

  if (url.pathname === '/ping') {
    console.log(`>>> /ping reached from ${req.socket.remoteAddress} — the phone CAN see this laptop.`)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('LongLeash is reachable from this device.\n')
    return
  }

  if (url.pathname === '/pair') {
    try {
      const { device, token } = registry.completePairing({
        challengeId: url.searchParams.get('c') ?? '',
        secret: url.searchParams.get('s') ?? '',
        deviceName: (req.headers['user-agent'] ?? 'unknown device').slice(0, 64),
      })
      console.log(`\n>>> PAIRED: ${device.deviceId} (from ${req.socket.remoteAddress})`)
      console.log('>>> Press r + Enter here to revoke it, then refresh the phone page.')
      html(200, page('Paired with your laptop', `
        <p>This phone is now device <code>${device.deviceId}</code>.</p>
        <p>The laptop stored only a <em>hash</em> of this token:</p>
        <p><code>${token}</code></p>
        <a href="/whoami?token=${token}">Ask the laptop who I am</a>
        <p style="margin-top:1.5rem;color:#666">Now reload this page — the challenge is single-use and must be rejected.</p>`, true))
    } catch (err) {
      const reason = err instanceof PairingError ? err.reason : 'error'
      console.log(`\n>>> Pairing attempt REJECTED (${reason}) from ${req.socket.remoteAddress}`)
      html(403, page('Pairing rejected', `<p>Reason: <code>${reason}</code></p>
        <p>This is slice A3 working: pairing challenges are single-use and expire after 5 minutes.</p>`, false))
    }
    return
  }

  if (url.pathname === '/whoami') {
    const token = url.searchParams.get('token') ?? ''
    const device = registry.verifyToken(token)
    if (device) {
      console.log(`>>> /whoami OK for ${device.deviceId} (lastSeen updated)`)
      html(200, page('The laptop recognizes you', `
        <p>Device <code>${device.deviceId}</code></p>
        <p>Paired at: ${new Date(device.createdAt).toLocaleTimeString()}</p>
        <p>Last seen: ${new Date(device.lastSeenAt ?? 0).toLocaleTimeString()} (updated by this request)</p>
        <a href="/whoami?token=${token}">Refresh</a>`, true))
    } else {
      console.log(`>>> /whoami REJECTED (unknown or revoked token) from ${req.socket.remoteAddress}`)
      html(401, page('Token rejected', `<p>This token is unknown or the device was <strong>revoked</strong>.</p>
        <p>If you just pressed r on the laptop, this is revocation working: the token still sits on your phone, it is simply worthless now.</p>`, false))
    }
    return
  }

  if (url.pathname === '/demo/revoke-all' && req.method === 'POST') {
    for (const device of registry.listDevices()) registry.revokeDevice(device.deviceId)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('revoked\n')
    return
  }

  html(404, page('Not found', '<p>Scan the QR code shown on the laptop to start.</p>', false))
}

const servers: Server[] = []
let listening = 0

console.log('\n=== LongLeash pairing: physical phone-to-laptop demo ===')
console.log('Runs the REAL slice-A3 code over your REAL network.\n')

const warning = vpnWarning()
if (warning) console.log(`!!! ${warning}\n`)

for (const candidate of candidates) {
  const server = createServer(handler)
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use on ${candidate.address}.`)
      console.error(`Another demo may still be running. Try: PORT=4322 pnpm demo:auth\n`)
      process.exit(1)
    }
    console.error(`Could not bind ${candidate.address}: ${err.message}`)
  })
  server.listen(PORT, candidate.address, () => {
    listening += 1
    if (listening === candidates.length) announce()
  })
  servers.push(server)
}

function announce(): void {
  const best = candidates[0]
  if (!best) return
  const bestUrl = `http://${best.address}:${PORT}${pairPath}`

  console.log(`Listening on ${candidates.length} address(es) — LAN interfaces only, never 0.0.0.0:`)
  for (const c of candidates) console.log(`   ${c.address}:${PORT}   (${c.iface}, ${c.label})`)

  console.log(`\nSTEP 1 — connectivity check. Open this on your phone first:`)
  console.log(`   http://${best.address}:${PORT}/ping`)
  console.log('   Expect "LongLeash is reachable". If it hangs, the network is blocking')
  console.log('   phone-to-laptop traffic — join your iPhone Personal Hotspot from the Mac')
  console.log('   over WI-FI (not USB) and rerun this.\n')

  console.log('STEP 2 — scan this QR with the iPhone camera:\n')
  qrcode.generate(bestUrl, { small: true })
  console.log(`   URL: ${bestUrl}\n`)

  if (candidates.length > 1) {
    console.log('   If that address does not work, try the others:')
    for (const c of candidates.slice(1)) console.log(`   http://${c.address}:${PORT}${pairPath}`)
    console.log('')
  }

  console.log('STEP 3 — pair, then tap "Ask the laptop who I am".')
  console.log('STEP 4 — reload the pairing page: the single-use challenge must be rejected.')
  console.log('STEP 5 — press r + Enter here, then refresh the phone: the token dies.')
  console.log('         Press q + Enter to quit. State is in-memory only.\n')
}

registry.onRevoked((deviceId) => {
  console.log(`>>> Revocation listener fired for ${deviceId} — in the real daemon this drops live sockets.`)
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  const key = chunk.trim().toLowerCase()
  if (key === 'r') {
    const active = registry.listDevices().filter((d) => d.revokedAt === null)
    if (active.length === 0) console.log('>>> Nothing to revoke yet — pair the phone first.')
    for (const device of active) registry.revokeDevice(device.deviceId)
  }
  if (key === 'q') {
    for (const server of servers) server.close()
    registry.close()
    process.exit(0)
  }
})
