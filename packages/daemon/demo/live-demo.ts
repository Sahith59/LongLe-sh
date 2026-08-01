import { createServer } from 'node:http'
import { mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import qrcode from 'qrcode-terminal'
import { DeviceRegistry, PairingError } from '../src/auth.js'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { SessionManager } from '../src/sessions.js'
import { LongLeashServer } from '../src/server.js'
import { createClaudeAgentFactory } from '../src/adapters/claude.js'
import { findCandidates, vpnWarning } from './lan.js'

const WS_PORT = Number(process.env.PORT ?? 4321)
const PAGE_PORT = WS_PORT + 1

// Real Claude gets a sandbox, never the repository: a mis-tap on the phone must not be able
// to touch anything that matters.
const SANDBOX = join(dirname(fileURLToPath(import.meta.url)), 'sandbox')
mkdirSync(SANDBOX, { recursive: true })
if (!existsSync(join(SANDBOX, 'README.md'))) {
  writeFileSync(
    join(SANDBOX, 'README.md'),
    '# LongLeash sandbox\n\nA scratch directory for the live demo. Claude may only work here.\n',
  )
}
const ROOT = realpathSync(SANDBOX)

const candidates = findCandidates()
const best = candidates[0]
if (!best) {
  console.error('\nNo usable network address found. Connect to Wi-Fi (or your iPhone hotspot) and rerun.\n')
  process.exit(1)
}
const HOST = best.address

const log = new EventLog(':memory:')
const registry = new DeviceRegistry(':memory:')
const approvals = new ApprovalStore(':memory:')
const server = new LongLeashServer({ eventLog: log, registry, host: HOST, port: WS_PORT })
const sessions = new SessionManager({
  eventLog: log,
  approvals,
  allowedRoots: [ROOT],
  agentFactories: {
    claude: createClaudeAgentFactory({
      maxTurns: 12,
      // Reading is auto-approved and shows in the activity feed; anything that CHANGES
      // something (Write, Edit, Bash…) must come to the phone for a decision.
      allowedTools: ['Read', 'Glob', 'Grep'],
      isolateFromUserSettings: true,
    }),
  },
  onEvent: (event) => server.broadcastEvent(event),
  // The sandbox claim must be literally true: a tool aiming outside it is refused outright.
  denyOutsideRoot: true,
})
server.attachSessions(sessions)

const challenge = registry.createPairingChallenge()
const pageUrl = `http://${HOST}:${PAGE_PORT}/?c=${challenge.challengeId}&s=${challenge.secret}`

const PAGE = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes"><title>LongLeash</title>
<style>
 *{box-sizing:border-box}
 body{font-family:-apple-system,sans-serif;margin:0;background:#0d0d0f;color:#eee;padding-bottom:120px}
 header{padding:10px 16px;background:#1c1c1e;position:sticky;top:0;border-bottom:1px solid #333;z-index:5}
 #status{font-weight:600;font-size:14px}.ok{color:#30d158}.bad{color:#ff453a}.warn{color:#ffd60a}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8e8e93;margin:18px 16px 8px}
 .card{background:#2c2c2e;border:1px solid #ffd60a;border-radius:12px;padding:14px;margin:10px 12px}
 .card h3{margin:0 0 6px;font-size:15px;color:#ffd60a}
 .card code{display:block;background:#1c1c1e;padding:8px;border-radius:6px;font-size:12px;word-break:break-all;margin:6px 0}
 .btns{display:flex;gap:10px;margin-top:10px}
 button{padding:13px;border:0;border-radius:10px;font-size:15px;font-weight:600}
 .allow{background:#30d158;color:#000;flex:1}.deny{background:#ff453a;color:#fff;flex:1}
 input,textarea{width:100%;padding:11px;border-radius:9px;border:1px solid #48484a;background:#1c1c1e;color:#eee;font-size:15px;font-family:inherit}
 .sess{background:#1c1c1e;border-radius:10px;margin:8px 12px;padding:10px 12px;font-size:13px}
 .sess .id{color:#0a84ff;font-family:ui-monospace,monospace;font-size:11px}
 .out{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;white-space:pre-wrap;color:#c7c7cc;margin-top:6px;max-height:320px;overflow-y:auto}
 .act{color:#8e8e93;font-style:italic}
 #compose{position:fixed;bottom:0;left:0;right:0;background:#1c1c1e;border-top:1px solid #333;padding:10px 12px;display:flex;gap:8px}
 #compose textarea{flex:1;height:44px;resize:none}
 #compose button{background:#0a84ff;color:#fff;padding:0 18px}
 .empty{color:#666;padding:10px 16px;font-size:14px}
</style></head><body>
<header><div id="status" class="warn">connecting…</div></header>
<h2>Waiting on you</h2>
<div id="inbox"><div class="empty" id="empty">Nothing to approve right now.</div></div>
<h2>Sessions</h2>
<div id="sessions"><div class="empty" id="nosess">No sessions yet — send Claude a task below.</div></div>
<div id="compose">
  <textarea id="prompt" placeholder="Tell Claude what to do…"></textarea>
  <button onclick="send()">Send</button>
</div>
<script>
const params=new URLSearchParams(location.search)
const statusEl=document.getElementById('status'),inboxEl=document.getElementById('inbox')
const sessEl=document.getElementById('sessions'),emptyEl=document.getElementById('empty'),noSessEl=document.getElementById('nosess')
let token=sessionStorage.getItem('llt')||null,ws=null,dead=false
const subs=new Map(),cards={}

function setStatus(t,c){statusEl.textContent=t;statusEl.className=c}

async function pair(){
  if(token)return
  const r=await fetch('/pair?c='+params.get('c')+'&s='+params.get('s'),{method:'POST'})
  if(!r.ok){setStatus('pairing rejected — scan a fresh QR','bad');throw new Error()}
  token=(await r.json()).token;sessionStorage.setItem('llt',token)
}

function sessionBox(id){
  let el=document.getElementById('s-'+id)
  if(!el){
    noSessEl.style.display='none'
    el=document.createElement('div');el.className='sess';el.id='s-'+id
    el.innerHTML='<div class="id">'+id+'</div><div class="out" id="o-'+id+'"></div>'
    sessEl.prepend(el)
  }
  return document.getElementById('o-'+id)
}
function append(id,text,cls){
  const out=sessionBox(id)
  if(cls){const s=document.createElement('div');s.className=cls;s.textContent=text;out.appendChild(s)}
  else out.appendChild(document.createTextNode(text))
  out.scrollTop=out.scrollHeight
}

function renderCard(m){
  const p=m.payload,id=p.approvalId
  if(cards[id])return
  emptyEl.style.display='none'
  const el=document.createElement('div');el.className='card';el.id='c-'+id
  el.innerHTML='<h3>Claude wants to run '+p.toolName+'</h3>'+
    '<code>'+p.inputSummary.replace(/</g,'&lt;')+'</code>'+
    '<input id="r-'+id+'" placeholder="optional reply if you deny…">'+
    '<div class="btns"><button class="allow" id="a-'+id+'">Approve</button>'+
    '<button class="deny" id="d-'+id+'">Deny</button></div>'
  inboxEl.appendChild(el);cards[id]=true
  document.getElementById('a-'+id).onclick=()=>decide(id,'allow')
  document.getElementById('d-'+id).onclick=()=>decide(id,'deny')
}
function decide(id,verdict){
  const box=document.getElementById('r-'+id)
  const reply=box&&box.value?box.value:undefined
  ws.send(JSON.stringify({v:1,type:'decision',approvalId:id,verdict,reply}))
  const el=document.getElementById('c-'+id);if(el)el.remove()
  if(!inboxEl.querySelector('.card'))emptyEl.style.display='block'
}
function send(){
  const t=document.getElementById('prompt')
  if(!t.value.trim())return
  ws.send(JSON.stringify({v:1,type:'startSession',agent:'claude',root:'${ROOT}',prompt:t.value.trim()}))
  t.value=''
}
function connect(){
  if(dead)return
  ws=new WebSocket('ws://'+location.hostname+':${WS_PORT}/ws?token='+encodeURIComponent(token))
  ws.onopen=()=>{setStatus('connected to your laptop','ok')
    for(const [sid,cur] of subs)ws.send(JSON.stringify({v:1,type:'subscribe',sessionId:sid,fromCursor:cur}))}
  ws.onmessage=(e)=>{
    const m=JSON.parse(e.data)
    if(m.type==='ack'&&m.of==='startSession'){subs.set(m.sessionId,0)
      ws.send(JSON.stringify({v:1,type:'subscribe',sessionId:m.sessionId,fromCursor:0}));return}
    if(m.type==='error'){alert('Error: '+m.code+'\\n'+(m.message||''));return}
    if(typeof m.seq!=='number')return
    subs.set(m.sessionId,m.seq)
    if(m.type==='session.started')append(m.sessionId,'▶ '+(m.payload.title||'')+'\\n','act')
    if(m.type==='stream.delta'){
      if(m.payload.kind==='text')append(m.sessionId,m.payload.text)
      else append(m.sessionId,'⚙ '+m.payload.text+'\\n','act')
    }
    if(m.type==='activity.tool')append(m.sessionId,'✓ auto-approved: '+m.payload.toolName+' '+m.payload.inputSummary+'\\n','act')
    if(m.type==='approval.requested')renderCard(m)
    if(m.type==='approval.decided')append(m.sessionId,'→ you '+(m.payload.verdict==='allow'?'approved':'denied')+' it\\n','act')
    if(m.type==='session.ended')append(m.sessionId,'\\n■ finished\\n','act')
    if(m.type==='session.errored')append(m.sessionId,'\\n✗ error: '+m.payload.message+'\\n','act')
  }
  ws.onclose=(e)=>{
    if(e.code===4403||e.code===4401){dead=true;setStatus('access revoked from the laptop','bad');return}
    setStatus('disconnected — reconnecting…','warn');setTimeout(connect,1000)}
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
      console.log(`\n>>> PAIRED: ${device.deviceId}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token }))
    } catch (err) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ reason: err instanceof PairingError ? err.reason : 'error' }))
    }
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})



async function main(): Promise<void> {
  await server.listen()
  pageServer.listen(PAGE_PORT, HOST, () => {
    console.log('\n=== LongLeash LIVE: real Claude, controlled from your phone ===\n')
    const warn = vpnWarning()
    if (warn) console.log(`!!! ${warn}\n`)
    console.log(`Sandbox (the ONLY place Claude may work):\n  ${ROOT}\n`)
    console.log('Reading is auto-approved. Anything that changes a file comes to your phone.\n')
    console.log('Scan with your iPhone camera:\n')
    qrcode.generate(pageUrl, { small: true })
    console.log(`\n   URL: ${pageUrl}\n`)
    console.log('Try these from the phone:')
    console.log('  "What files are in this directory?"        -> auto-approved reads only')
    console.log('  "Create hello.txt that says hi"            -> Write comes to you for approval')
    console.log('  "Delete every file here"                   -> DENY it, and watch Claude obey')
    console.log('  "Write a haiku about leashes to poem.txt"  -> approve and check the sandbox\n')
    console.log('Watch this terminal for pairing and revocation. Press r + Enter to revoke the')
    console.log('phone (its socket dies instantly), q + Enter to quit.\n')
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  const key = chunk.trim().toLowerCase()
  if (key === 'r') {
    const active = registry.listDevices().filter((d) => d.revokedAt === null)
    if (active.length === 0) console.log('>>> nothing paired yet')
    for (const d of active) registry.revokeDevice(d.deviceId)
    console.log('>>> revoked')
  }
  if (key === 'q') {
    void server.close().then(() => {
      pageServer.close()
      log.close()
      registry.close()
      approvals.close()
      process.exit(0)
    })
  }
})

void main()
