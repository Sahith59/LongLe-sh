import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import qrcode from 'qrcode-terminal'
import { DeviceRegistry, PairingError } from '../src/auth.js'
import { EventLog } from '../src/eventlog.js'
import { ApprovalStore } from '../src/approvals.js'
import { SessionManager, SessionError } from '../src/sessions.js'
import { LongLeashServer } from '../src/server.js'
import type { AgentFactory, AgentRunRequest, PermissionDecision } from '../src/agent.js'
import { findCandidates, vpnWarning } from './lan.js'

const WS_PORT = Number(process.env.PORT ?? 4321)
const PAGE_PORT = WS_PORT + 1
const PROJECT_ROOT = realpathSync(process.cwd())

const candidates = findCandidates()
const best = candidates[0]
if (!best) {
  console.error('\nNo usable network address found. Connect to Wi-Fi (or your iPhone hotspot) and rerun.\n')
  process.exit(1)
}
const HOST = best.address

/**
 * A scripted stand-in for Claude: it narrates what it is doing and stops dead at each tool
 * that needs permission. Nothing is faked about the waiting — the real SessionManager holds
 * this agent until a decision arrives from the phone.
 */
class ScriptedRun {
  private queue: unknown[] = []
  private waiter: (() => void) | null = null
  private finished = false

  private readonly tag: string

  constructor(private readonly request: AgentRunRequest) {
    this.tag = request.sessionId.slice(0, 10)
  }

  start(): { events: AsyncIterable<never>; interrupt: () => Promise<void> } {
    void this.run()
    return {
      events: this.iterate(),
      interrupt: async () => this.stop(),
    }
  }

  private async run(): Promise<void> {
    const say = (text: string) => this.push(text)
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

    await wait(600)
    say('Reading the project structure…')
    this.request.onAutoApprovedTool('Read', { file_path: 'package.json' })
    await wait(900)
    say('\nFound a TypeScript monorepo. I want to add a feature file.')

    console.log(`\n>>> [${this.tag}] BLOCKED, waiting for your phone to approve "Write"`)
    const write = await this.ask('Write', { file_path: 'src/feature.ts', content: '// 240 lines' })
    if (write.behavior === 'allow') {
      say('\n\nWrote src/feature.ts.')
      console.log(`>>> [${this.tag}] APPROVED — agent continued`)
    } else {
      say(`\n\nSkipping the write. You said: "${write.message}"`)
      console.log(`>>> [${this.tag}] DENIED — agent received your reply: "${write.message}"`)
    }

    await wait(900)
    say('\nNow I would like to run the test suite.')
    console.log(`\n>>> [${this.tag}] BLOCKED AGAIN, waiting on "Bash: pnpm test"`)
    const bash = await this.ask('Bash', { command: 'pnpm test' })
    if (bash.behavior === 'allow') {
      say('\n\nRunning pnpm test…\n97 tests passed.')
      console.log(`>>> [${this.tag}] APPROVED — agent continued`)
    } else {
      say(`\n\nNot running tests. You said: "${bash.message}"`)
      console.log(`>>> [${this.tag}] DENIED — agent received your reply: "${bash.message}"`)
    }

    await wait(700)
    say('\n\nDone. That is the whole loop: I work, I ask, you decide from anywhere.')
    this.stop()
  }

  private async ask(name: string, input: unknown): Promise<PermissionDecision> {
    return this.request.canUseTool(name, input)
  }

  private push(text: string): void {
    this.queue.push({ type: 'text', text })
    this.wake()
  }
  private stop(): void {
    this.finished = true
    this.wake()
  }
  private wake(): void {
    this.waiter?.()
    this.waiter = null
  }
  private async *iterate(): AsyncGenerator<never> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift() as never
      if (this.finished) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

/** One independent run per session, so concurrent sessions never share state. */
const scriptedAgentFactory: AgentFactory = (request) => new ScriptedRun(request).start()

const log = new EventLog(':memory:')
const registry = new DeviceRegistry(':memory:')
const approvals = new ApprovalStore(':memory:')
const server = new LongLeashServer({ eventLog: log, registry, host: HOST, port: WS_PORT })
const sessions = new SessionManager({
  eventLog: log,
  approvals,
  allowedRoots: [PROJECT_ROOT],
  agentFactories: { claude: scriptedAgentFactory },
  onEvent: (event) => server.broadcastEvent(event),
})
server.attachSessions(sessions)

const challenge = registry.createPairingChallenge()
const pageUrl = `http://${HOST}:${PAGE_PORT}/?c=${challenge.challengeId}&s=${challenge.secret}`

const PAGE = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>LongLeash approvals</title>
<style>
 body{font-family:-apple-system,sans-serif;margin:0;background:#111;color:#eee}
 header{padding:12px 16px;background:#1c1c1e;position:sticky;top:0;border-bottom:1px solid #333;z-index:5}
 #status{font-weight:600}.ok{color:#30d158}.bad{color:#ff453a}.warn{color:#ffd60a}
 #inbox{padding:0 12px}
 .card{background:#2c2c2e;border:1px solid #48484a;border-radius:12px;padding:14px;margin:12px 0}
 .card h3{margin:0 0 4px;font-size:16px;color:#ffd60a}
 .card code{background:#1c1c1e;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
 .btns{display:flex;gap:10px;margin-top:12px}
 button{flex:1;padding:14px;border:0;border-radius:10px;font-size:16px;font-weight:600}
 .allow{background:#30d158;color:#000}.deny{background:#ff453a;color:#fff}
 input{width:100%;padding:10px;margin-top:10px;border-radius:8px;border:1px solid #48484a;background:#1c1c1e;color:#eee;font-size:15px}
 #stream{padding:8px 16px;font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap;color:#c7c7cc}
 .empty{color:#666;padding:16px;text-align:center}
</style></head><body>
<header><div id="status" class="warn">connecting…</div></header>
<div id="inbox"><div class="empty" id="empty">No approvals waiting. Watch the agent work below.</div></div>
<div id="stream"></div>
<script>
const params = new URLSearchParams(location.search)
const statusEl=document.getElementById('status'), inboxEl=document.getElementById('inbox')
const streamEl=document.getElementById('stream'), emptyEl=document.getElementById('empty')
let token=sessionStorage.getItem('llt')||null, ws=null, dead=false
const subs=new Map()  // sessionId -> cursor: several agents can run at once
const cards={}

function setStatus(t,c){statusEl.textContent=t;statusEl.className=c}

async function pair(){
  if(token) return
  const res=await fetch('/pair?c='+params.get('c')+'&s='+params.get('s'),{method:'POST'})
  if(!res.ok){setStatus('pairing rejected — scan a fresh QR','bad');throw new Error()}
  const d=await res.json(); token=d.token; sessionStorage.setItem('llt',token)
}

function renderCard(ev){
  const p=ev.payload, id=p.approvalId
  if(cards[id]) return
  emptyEl.style.display='none'
  const el=document.createElement('div'); el.className='card'; el.id='c-'+id
  el.innerHTML='<h3>Approval needed</h3><div>The agent wants to run:</div>'+
    '<div style="margin:8px 0"><code>'+p.inputSummary.replace(/</g,'&lt;')+'</code></div>'+
    '<input id="r-'+id+'" placeholder="optional reply if you deny…">'+
    '<div class="btns"><button class="allow" id="a-'+id+'">Approve</button>'+
    '<button class="deny" id="d-'+id+'">Deny</button></div>'
  inboxEl.appendChild(el); cards[id]=true
  document.getElementById('a-'+id).onclick=()=>decide(id,'allow')
  document.getElementById('d-'+id).onclick=()=>decide(id,'deny')
}

function decide(id,verdict){
  const reply=(document.getElementById('r-'+id)||{}).value||''
  ws.send(JSON.stringify({v:1,type:'decision',approvalId:id,verdict,reply:reply||undefined}))
  const el=document.getElementById('c-'+id); if(el) el.remove()
  if(inboxEl.querySelectorAll('.card').length===0) emptyEl.style.display='block'
}

function connect(){
  if(dead) return
  ws=new WebSocket('ws://'+location.hostname+':${WS_PORT}/ws?token='+encodeURIComponent(token))
  ws.onopen=()=>{ setStatus('connected — watching the agent','ok')
    for(const [sid,cur] of subs) ws.send(JSON.stringify({v:1,type:'subscribe',sessionId:sid,fromCursor:cur})) }
  ws.onmessage=(e)=>{
    const m=JSON.parse(e.data)
    if(m.type==='ack'&&m.of==='startSession'){ subs.set(m.sessionId,0)
      ws.send(JSON.stringify({v:1,type:'subscribe',sessionId:m.sessionId,fromCursor:0})); return }
    if(m.type==='error'){ streamEl.textContent+='\\n[error: '+m.code+'] '+(m.message||''); return }
    if(typeof m.seq==='number'){
      subs.set(m.sessionId,m.seq)
      if(m.type==='stream.delta') streamEl.textContent+=m.payload.text
      if(m.type==='approval.requested') renderCard(m)
      if(m.type==='activity.tool') streamEl.textContent+='\\n[auto-approved: '+m.payload.toolName+']\\n'
      if(m.type==='session.ended') setStatus('agent finished','ok')
    }
  }
  ws.onclose=(e)=>{ if(e.code===4403||e.code===4401){dead=true;setStatus('access revoked','bad');return}
    setStatus('disconnected — retrying, will resume where each session left off','warn'); setTimeout(connect,1000) }
}

pair().then(()=>{ connect()
  document.title='LongLeash'
}).catch(()=>{})
window.startAgent=()=>ws.send(JSON.stringify({v:1,type:'startSession',agent:'claude',root:'${PROJECT_ROOT}',prompt:'add a feature'}))
</script>
<div style="padding:16px"><button style="width:100%;background:#0a84ff;color:#fff" onclick="startAgent()">Start the agent</button></div>
</body></html>`

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

  // Prove the security boundary before inviting anyone in.
  console.log('\n=== LongLeash approvals: slice A5 demo ===')
  console.log('A scripted agent runs under the real SessionManager and genuinely blocks on you.\n')
  try {
    await sessions.startSession({ agent: 'claude', cwd: '/etc', prompt: 'should never run' })
    console.log('!!! SECURITY CHECK FAILED — /etc was allowed')
  } catch (err) {
    if (err instanceof SessionError) {
      console.log(`Security check: starting an agent in /etc was REFUSED (${err.reason}). Only`)
      console.log(`${PROJECT_ROOT} and its subdirectories are allowlisted.\n`)
    }
  }

  pageServer.listen(PAGE_PORT, HOST, () => {
    const warn = vpnWarning()
    if (warn) console.log(`!!! ${warn}\n`)
    console.log('Scan this with your iPhone camera:\n')
    qrcode.generate(pageUrl, { small: true })
    console.log(`\n   URL: ${pageUrl}\n`)
    console.log('On the phone: tap "Start the agent" at the bottom.')
    console.log('  1. It narrates its work, and an auto-approved Read shows in the feed.')
    console.log('  2. It STOPS and asks to Write a file — this terminal says it is blocked.')
    console.log('     Approve or Deny from the phone (type a reply first to steer a Deny).')
    console.log('  3. It stops again for "pnpm test" — decide that one differently.')
    console.log('  4. Watch this terminal: it prints exactly what your phone decided.\n')
    console.log('Try leaving an approval unanswered for a while — the agent waits patiently,')
    console.log('exactly as it would while you are out. Press q + Enter to quit.\n')
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  if (chunk.trim().toLowerCase() === 'q') {
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
