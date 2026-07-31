import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import qrcode from 'qrcode-terminal'
import { DeviceRegistry, PairingError } from '../src/auth.js'

const PORT = Number(process.env.PORT ?? 4321)

function lanAddress(): string | null {
  const interfaces = networkInterfaces()
  for (const name of ['en0', 'en1']) {
    for (const net of interfaces[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  for (const nets of Object.values(interfaces)) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return null
}

const ip = lanAddress()
if (!ip) {
  console.error('No LAN address found — is Wi-Fi on?')
  process.exit(1)
}

const registry = new DeviceRegistry(':memory:')
const challenge = registry.createPairingChallenge()
const pairUrl = `http://${ip}:${PORT}/pair?c=${challenge.challengeId}&s=${challenge.secret}`

const page = (title: string, body: string, ok: boolean) => `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:-apple-system,sans-serif;margin:2rem;line-height:1.6}
h1{color:${ok ? '#0a7c3f' : '#b3261e'}}code{background:#eee;padding:2px 6px;border-radius:4px;word-break:break-all}
a{display:inline-block;margin-top:1rem;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none}</style>
</head><body><h1>${title}</h1>${body}</body></html>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${ip}:${PORT}`)
  const html = (status: number, content: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(content)
  }

  if (url.pathname === '/pair') {
    try {
      const { device, token } = registry.completePairing({
        challengeId: url.searchParams.get('c') ?? '',
        secret: url.searchParams.get('s') ?? '',
        deviceName: (req.headers['user-agent'] ?? 'unknown device').slice(0, 64),
      })
      console.log(`\n>>> PAIRED: ${device.deviceId} ("${device.name.slice(0, 40)}...")`)
      console.log('>>> Press r + Enter here to revoke it, then refresh the phone page.')
      html(200, page('Paired with your laptop', `
        <p>This phone is now device <code>${device.deviceId}</code>.</p>
        <p>The laptop stored only a <em>hash</em> of this token:</p>
        <p><code>${token}</code></p>
        <a href="/whoami?token=${token}">Ask the laptop who I am</a>
        <p style="margin-top:1.5rem;color:#666">Try scanning the QR again in another tab — the challenge is single-use and will be rejected.</p>`, true))
    } catch (err) {
      const reason = err instanceof PairingError ? err.reason : 'error'
      console.log(`\n>>> Pairing attempt REJECTED (${reason})`)
      html(403, page('Pairing rejected', `<p>Reason: <code>${reason}</code></p>
        <p>This is A3 working: challenges are single-use and expire after 5 minutes.</p>`, false))
    }
    return
  }

  if (url.pathname === '/whoami') {
    const device = registry.verifyToken(url.searchParams.get('token') ?? '')
    if (device) {
      console.log(`>>> /whoami OK for ${device.deviceId} (lastSeen updated)`)
      html(200, page('The laptop recognizes you', `
        <p>Device <code>${device.deviceId}</code></p>
        <p>Paired at: ${new Date(device.createdAt).toLocaleTimeString()}</p>
        <p>Last seen: ${new Date(device.lastSeenAt ?? 0).toLocaleTimeString()} (just now — updated by this request)</p>
        <a href="${url.pathname}?token=${url.searchParams.get('token')}">Refresh</a>`, true))
    } else {
      console.log('>>> /whoami REJECTED (unknown or revoked token)')
      html(401, page('Token rejected', `<p>This token is unknown or the device was <strong>revoked</strong>.</p>
        <p>If you just pressed r on the laptop: this is revocation working. The token still exists on your phone — it is simply worthless now.</p>`, false))
    }
    return
  }

  if (url.pathname === '/demo/revoke-all' && req.method === 'POST') {
    for (const device of registry.listDevices()) registry.revokeDevice(device.deviceId)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('revoked\n')
    return
  }

  html(404, page('Not found', '<p>Scan the QR code on the laptop to start.</p>', false))
})

registry.onRevoked((deviceId) => {
  console.log(`>>> Revocation listener fired for ${deviceId} — in the real daemon this drops live sockets.`)
})

server.listen(PORT, ip, () => {
  console.log('\n=== LongLeash pairing: physical phone-to-laptop demo ===')
  console.log('Everything below runs the REAL slice-A3 code over your REAL Wi-Fi.')
  console.log(`Server bound to ${ip}:${PORT} (LAN interface only — never 0.0.0.0).\n`)
  console.log('1. Make sure your phone is on the same Wi-Fi as this laptop.')
  console.log('2. Scan this QR with the iPhone camera and open the link:\n')
  qrcode.generate(pairUrl, { small: true })
  console.log(`   (same thing as a URL: ${pairUrl})\n`)
  console.log('3. Phone pairs -> gets a token -> tap "Ask the laptop who I am".')
  console.log('4. Scan/open the QR link AGAIN -> watch the single-use challenge get rejected.')
  console.log('5. Press r + Enter here -> refresh the phone page -> watch the token die.')
  console.log('   Press q + Enter to quit. Demo state is in-memory only; quitting erases it.\n')
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  const key = chunk.trim().toLowerCase()
  if (key === 'r') {
    const devices = registry.listDevices().filter((d) => d.revokedAt === null)
    if (devices.length === 0) console.log('>>> Nothing to revoke yet — pair the phone first.')
    for (const device of devices) registry.revokeDevice(device.deviceId)
  }
  if (key === 'q') {
    server.close()
    registry.close()
    process.exit(0)
  }
})
