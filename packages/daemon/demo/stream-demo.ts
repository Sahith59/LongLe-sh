import { createServer } from 'node:http'
import qrcode from 'qrcode-terminal'
import { DeviceRegistry, PairingError } from '../src/auth.js'
import { EventLog } from '../src/eventlog.js'
import { LongLeashServer } from '../src/server.js'
import { findCandidates, vpnWarning } from './lan.js'

const WS_PORT = Number(process.env.PORT ?? 4321)
const PAGE_PORT = WS_PORT + 1
const SESSION = 'demo-session'

const candidates = findCandidates()
const best = candidates[0]
if (!best) {
  console.error('\nNo usable network address found. Connect to Wi-Fi (or your iPhone hotspot) and rerun.\n')
  process.exit(1)
}
const HOST = best.address

const log = new EventLog(':memory:')
const registry = new DeviceRegistry(':memory:')
const server = new LongLeashServer({ eventLog: log, registry, host: HOST, port: WS_PORT })

const challenge = registry.createPairingChallenge()
const pageUrl = `http://${HOST}:${PAGE_PORT}/?c=${challenge.challengeId}&s=${challenge.secret}`

const PAGE = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>LongLeash live stream</title>
<style>
 body{font-family:-apple-system,sans-serif;margin:0;background:#111;color:#eee}
 header{padding:12px 16px;background:#1c1c1e;position:sticky;top:0;border-bottom:1px solid #333}
 #status{font-weight:600}
 .ok{color:#30d158}.bad{color:#ff453a}.warn{color:#ffd60a}
 #meta{font-size:13px;color:#888;margin-top:4px}
 #events{padding:8px 16px;font-family:ui-monospace,Menlo,monospace;font-size:14px}
 .ev{padding:6px 0;border-bottom:1px solid #222}
 .seq{color:#0a84ff;margin-right:8px}
 .sys{color:#ffd60a}
</style></head><body>
<header>
  <div id="status" class="warn">connecting…</div>
  <div id="meta">events received: <span id="count">0</span> · cursor: <span id="cursor">0</span></div>
</header>
<div id="events"></div>
<script>
const params = new URLSearchParams(location.search)
const statusEl = document.getElementById('status')
const countEl = document.getElementById('count')
const cursorEl = document.getElementById('cursor')
const eventsEl = document.getElementById('events')
let cursor = 0, count = 0, token = sessionStorage.getItem('llt') || null, ws = null, revoked = false

function setStatus(text, cls){ statusEl.textContent = text; statusEl.className = cls }
function addLine(html, cls){
  const div = document.createElement('div')
  div.className = 'ev ' + (cls || '')
  div.innerHTML = html
  eventsEl.prepend(div)
}

async function pair(){
  if (token) return token
  const res = await fetch('/pair?c=' + params.get('c') + '&s=' + params.get('s'), { method:'POST' })
  if (!res.ok) { setStatus('pairing rejected — scan a fresh QR', 'bad'); throw new Error('pair failed') }
  const data = await res.json()
  token = data.token
  sessionStorage.setItem('llt', token)
  addLine('<span class="sys">paired as ' + data.deviceId + '</span>')
  return token
}

function connect(){
  if (revoked) return
  ws = new WebSocket('ws://' + location.hostname + ':${WS_PORT}/ws?token=' + encodeURIComponent(token))
  ws.onopen = () => {
    setStatus('connected — live', 'ok')
    ws.send(JSON.stringify({ v:1, type:'subscribe', sessionId:'${SESSION}', fromCursor: cursor }))
    addLine('<span class="sys">subscribed from cursor ' + cursor + '</span>')
  }
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'gap') { addLine('<span class="sys">GAP: ' + msg.reason + ' — resyncing</span>'); cursor = 0; ws.send(JSON.stringify({ v:1, type:'subscribe', sessionId:'${SESSION}', fromCursor:0 })); return }
    if (msg.type === 'error') { addLine('<span class="sys">error: ' + msg.code + '</span>'); return }
    if (typeof msg.seq === 'number') {
      cursor = msg.seq; count++
      cursorEl.textContent = cursor; countEl.textContent = count
      const text = msg.payload && msg.payload.text ? msg.payload.text : JSON.stringify(msg.payload)
      addLine('<span class="seq">#' + msg.seq + '</span>' + text.replace(/</g,'&lt;'))
    }
  }
  ws.onclose = (e) => {
    if (e.code === 4403) { revoked = true; setStatus('REVOKED by the laptop — access cut', 'bad'); addLine('<span class="sys">socket closed with code 4403 (device revoked)</span>'); return }
    if (e.code === 4401) { revoked = true; setStatus('unauthorized', 'bad'); return }
    setStatus('disconnected — retrying, will resume at cursor ' + cursor, 'warn')
    setTimeout(connect, 1000)
  }
}

pair().then(connect).catch(()=>{})
</script></body></html>`

const pageServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PAGE_PORT}`)

  if (url.pathname === '/pair' && req.method === 'POST') {
    try {
      const { device, token } = registry.completePairing({
        challengeId: url.searchParams.get('c') ?? '',
        secret: url.searchParams.get('s') ?? '',
        deviceName: (req.headers['user-agent'] ?? 'browser').slice(0, 64),
      })
      console.log(`\n>>> PAIRED: ${device.deviceId} (from ${req.socket.remoteAddress})`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token, deviceId: device.deviceId }))
    } catch (err) {
      const reason = err instanceof PairingError ? err.reason : 'error'
      console.log(`>>> pairing rejected (${reason})`)
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ reason }))
    }
    return
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})

let burstCounter = 0

async function main(): Promise<void> {
  await server.listen()
  pageServer.listen(PAGE_PORT, HOST, () => {
    console.log('\n=== LongLeash live streaming: slice A4 demo ===')
    console.log('Real WebSocket server, real auth, real event log — over your real network.\n')
    const warn = vpnWarning()
    if (warn) console.log(`!!! ${warn}\n`)
    console.log(`Page  : http://${HOST}:${PAGE_PORT}   (${best.iface}, ${best.label})`)
    console.log(`Socket: ws://${HOST}:${WS_PORT}/ws\n`)
    console.log('Scan this with your iPhone camera:\n')
    qrcode.generate(pageUrl, { small: true })
    console.log(`\n   URL: ${pageUrl}\n`)
    console.log('THEN, in this terminal:')
    console.log('  type anything + Enter  -> appears on your phone INSTANTLY')
    console.log('  b + Enter              -> burst of 25 events (try this with the phone offline!)')
    console.log('  r + Enter              -> revoke the device: the live socket is cut immediately')
    console.log('  q + Enter              -> quit\n')
    console.log('THE KEY TEST — catch-up after disconnect:')
    console.log('  1. Put the phone in airplane mode (page says "disconnected")')
    console.log('  2. Press b here a few times while it is offline')
    console.log('  3. Turn airplane mode off -> the phone reconnects and replays')
    console.log('     EVERY missed event from its cursor, in order, with none lost.\n')
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  const input = chunk.replace(/\n$/, '')
  const key = input.trim().toLowerCase()

  if (key === 'q') {
    void server.close().then(() => {
      pageServer.close()
      log.close()
      registry.close()
      process.exit(0)
    })
    return
  }
  if (key === 'r') {
    const active = registry.listDevices().filter((d) => d.revokedAt === null)
    if (active.length === 0) {
      console.log('>>> nothing paired yet')
      return
    }
    for (const device of active) registry.revokeDevice(device.deviceId)
    console.log('>>> revoked — the phone socket should die instantly')
    return
  }
  if (key === 'b') {
    burstCounter += 1
    for (let i = 1; i <= 25; i++) {
      server.publish(SESSION, { type: 'stream.delta', payload: { kind: 'text', text: `burst ${burstCounter} line ${i}` } })
    }
    console.log(`>>> published 25 events (log now holds ${log.latestSeq(SESSION)})`)
    return
  }
  if (input.length > 0) {
    const event = server.publish(SESSION, { type: 'stream.delta', payload: { kind: 'text', text: input } })
    console.log(`>>> published seq ${event.seq} to ${server.connectionCount()} live connection(s)`)
  }
})

void main()
